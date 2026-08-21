/**
 * Per-metric time series with window queries.
 *
 * ── Why not just keep an array of ticks ──
 *
 * The monitor asks one question, constantly: "what was this metric worth
 * `window` ago?" A NIFTY chain is ~80 strikes × 2 sides × 6 metrics, sampled
 * every second — around a million points an hour. Storing those as objects is
 * a GC problem during exactly the hours the terminal must not stutter, which is
 * the same reasoning behind engine/ringBuffer.ts.
 *
 * So each series is two Float64Arrays (timestamps, values) in a fixed-capacity
 * ring. Lookups are a binary search over a circular buffer rather than a filter
 * over an array, so a window query costs O(log n) and allocates nothing.
 *
 * ── Interpolation ──
 *
 * `at(t)` interpolates between the two samples bracketing `t` rather than
 * taking the nearest. OI is a step function and price is not, but the
 * difference only shows up at the boundary of a window, where "nearest" makes
 * a 10-minute delta silently become an 11-minute one whenever sampling jitters.
 * Interpolating keeps the window honest to what was asked for.
 */

/** Samples per series. 3600 at 1/s is an hour — longer than any live window. */
const DEFAULT_CAPACITY = Number(process.env.QT_ASSISTANT_SERIES_CAP || 3_600);

/**
 * Samples a series allocates before it has any.
 *
 * The ring used to allocate its full capacity on the first write, which meant
 * one 56 KB pair of Float64Arrays per (contract, metric) the moment a chain
 * published — 180 MB for a single NIFTY expiry, most of it holding an hour of
 * room for series that were seconds old. Starting small and doubling costs one
 * copy per doubling (twelve, total, to reach the cap) and keeps a young series
 * proportional to what it actually holds.
 */
const INITIAL_CAPACITY = 128;

export class MetricSeries {
  private ts:  Float64Array;
  private val: Float64Array;
  /** Current allocation. Doubles on demand up to `maxCap`. */
  private cap: number;
  private readonly maxCap: number;
  private head = 0;    // next write slot
  private len  = 0;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.maxCap = Math.max(1, capacity);
    this.cap    = Math.min(INITIAL_CAPACITY, this.maxCap);
    this.ts     = new Float64Array(this.cap);
    this.val    = new Float64Array(this.cap);
  }

  /**
   * Double the ring, preserving logical order.
   *
   * The copy re-linearises: afterwards the samples sit at 0..len-1 with the
   * write head just past them, which is the same layout a young ring already
   * has, so `indexOf` needs no special case for a grown buffer.
   */
  private grow(): void {
    const next = Math.min(this.cap * 2, this.maxCap);
    if (next <= this.cap) return;

    const ts  = new Float64Array(next);
    const val = new Float64Array(next);
    for (let i = 0; i < this.len; i++) {
      const slot = this.indexOf(i);
      ts[i]  = this.ts[slot];
      val[i] = this.val[slot];
    }
    this.ts   = ts;
    this.val  = val;
    this.cap  = next;
    this.head = this.len;
  }

  get size(): number { return this.len; }

  /** Oldest timestamp still held, or 0 when empty. */
  get oldest(): number {
    if (!this.len) return 0;
    return this.ts[this.indexOf(0)];
  }

  get newest(): number {
    if (!this.len) return 0;
    return this.ts[this.indexOf(this.len - 1)];
  }

  get latest(): number | null {
    if (!this.len) return null;
    return this.val[this.indexOf(this.len - 1)];
  }

  /** Logical index i (0 = oldest) → physical slot. */
  private indexOf(i: number): number {
    const start = this.len === this.cap ? this.head : 0;
    return (start + i) % this.cap;
  }

  /**
   * Append a sample.
   *
   * Out-of-order and duplicate timestamps are dropped rather than inserted: the
   * feed occasionally republishes a packet, and admitting a backwards timestamp
   * would break the binary search's ordering invariant for every later query.
   */
  push(t: number, v: number): void {
    if (!Number.isFinite(t) || !Number.isFinite(v)) return;
    if (this.len && t <= this.newest) return;

    // Full but not yet at its ceiling: take the copy now rather than start
    // evicting samples the series has room to keep.
    if (this.len === this.cap && this.cap < this.maxCap) this.grow();

    this.ts[this.head]  = t;
    this.val[this.head] = v;
    this.head = (this.head + 1) % this.cap;
    if (this.len < this.cap) this.len++;
  }

  /** Largest logical index whose timestamp is <= t, or -1. */
  private floorIndex(t: number): number {
    let lo = 0;
    let hi = this.len - 1;
    let hit = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ts[this.indexOf(mid)] <= t) { hit = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return hit;
  }

  /**
   * Value at time `t`, interpolated. Null when `t` predates the buffer.
   *
   * Returning null rather than the oldest value is deliberate: a watch whose
   * window reaches further back than the data can support must report "not
   * enough history yet", not a delta measured against an arbitrary starting
   * point. The latter fires spuriously every time a watch is created.
   */
  at(t: number): number | null {
    if (!this.len) return null;
    if (t >= this.newest) return this.latest;
    if (t < this.oldest)  return null;

    const i = this.floorIndex(t);
    if (i < 0) return null;
    if (i === this.len - 1) return this.val[this.indexOf(i)];

    const iA = this.indexOf(i);
    const iB = this.indexOf(i + 1);
    const tA = this.ts[iA];
    const tB = this.ts[iB];
    if (tB === tA) return this.val[iB];

    const w = (t - tA) / (tB - tA);
    return this.val[iA] + (this.val[iB] - this.val[iA]) * w;
  }

  /**
   * Change over `windowMs`, as of now.
   *
   * Null when the series cannot cover the window — see `at()`. `from` is the
   * interpolated value at the window's start, not the oldest sample.
   */
  delta(windowMs: number, now = Date.now()): { from: number; to: number; abs: number; pct: number } | null {
    const to = this.latest;
    if (to == null) return null;
    const from = this.at(now - windowMs);
    if (from == null) return null;

    const abs = to - from;
    // Guard the zero base: a contract whose OI was 0 and is now 5000 has an
    // infinite percentage change, and shipping Infinity into a comparison makes
    // every threshold fire. Reported as 0% with a non-zero abs, so absolute
    // thresholds still work and percentage ones correctly decline to fire.
    const pct = from === 0 ? 0 : (abs / Math.abs(from)) * 100;
    return { from, to, abs, pct };
  }

  /**
   * Rolling window-deltas, for the significance estimator.
   *
   * Samples the series at `count` evenly spaced points and returns the
   * window-delta at each, which is the distribution the current delta is
   * compared against. Evenly spaced rather than per-sample because adjacent
   * window-deltas overlap almost entirely and would make the sample look far
   * more consistent than it is, deflating sigma and firing on noise.
   */
  deltaHistory(windowMs: number, count = 20, now = Date.now()): number[] {
    const out: number[] = [];
    if (this.len < 3) return out;

    const span = this.newest - this.oldest;
    if (span < windowMs * 2) return out;

    // Step by a full window so successive samples share no data.
    const step = windowMs;
    for (let i = 1; i <= count; i++) {
      const end = now - i * step;
      if (end - windowMs < this.oldest) break;
      const a = this.at(end - windowMs);
      const b = this.at(end);
      if (a == null || b == null) continue;
      out.push(b - a);
    }
    return out;
  }

  /** Every sample in the window, oldest first — for series cards. */
  window(windowMs: number, now = Date.now()): Array<{ ts: number; v: number }> {
    const cutoff = now - windowMs;
    const out: Array<{ ts: number; v: number }> = [];
    for (let i = 0; i < this.len; i++) {
      const slot = this.indexOf(i);
      if (this.ts[slot] < cutoff) continue;
      out.push({ ts: this.ts[slot], v: this.val[slot] });
    }
    return out;
  }
}

/**
 * Every series the monitor holds, keyed `chainKey|strike|side|metric`.
 *
 * A flat map rather than a nested structure: the evaluation loop looks up by
 * fully-qualified key and never iterates a subtree, so nesting would only add
 * indirection. Series are created on first write and dropped with their chain.
 */
export class SeriesStore {
  private readonly map = new Map<string, MetricSeries>();

  static key(chainKey: string, strike: number | null, side: string | null, metric: string): string {
    return `${chainKey}|${strike ?? '-'}|${side ?? '-'}|${metric}`;
  }

  get(key: string): MetricSeries | undefined { return this.map.get(key); }

  ensure(key: string): MetricSeries {
    let s = this.map.get(key);
    if (!s) { s = new MetricSeries(); this.map.set(key, s); }
    return s;
  }

  push(key: string, t: number, v: number): void {
    this.ensure(key).push(t, v);
  }

  /** Drop every series belonging to a chain that is no longer subscribed. */
  dropChain(chainKey: string): void {
    const prefix = `${chainKey}|`;
    for (const k of this.map.keys()) if (k.startsWith(prefix)) this.map.delete(k);
  }

  get size(): number { return this.map.size; }
}
