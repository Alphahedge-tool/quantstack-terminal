/**
 * Generic LRU (Least Recently Used) cache with per-entry TTL and a byte budget.
 *
 * Uses JS Map insertion-order to track LRU order — O(1) get/set/evict.
 * Thread-safe for Node.js (single-threaded event loop).
 *
 * Designed to cache full computed straddle results (23,400-point arrays)
 * so repeat loads of the same symbol+date never hit the Nubra API again.
 *
 * ── Why counting entries is not enough ──
 *
 * A cache bounded only by entry count is bounded in memory only if every entry
 * is the same size, and these are not: a full NIFTY day is ~22,500 points and a
 * half-hour-old session on a thin contract is a few hundred. Fifty of the
 * former is several gigabytes and fifty of the latter is nothing, so a single
 * capacity number cannot be both safe and useful — set for the big case it
 * wastes the cache, set for the average it runs the process out of heap on a
 * day when someone opens fifty full sessions.
 *
 * So `maxBytes` + `weigh` bound what actually matters. `weigh` is an estimate,
 * not a measurement — V8 gives no way to ask an object's retained size — and it
 * only has to be proportional and roughly right, since it decides when to evict
 * rather than reporting anything to a user.
 */

export interface CacheMeta {
  key:       string;
  cachedAt:  number;   // epoch ms
  expiresIn: number;   // ms remaining
  ttlMs:     number;
}

interface Entry<T> {
  data:  T;
  at:    number;
  ttl:   number;
  /** Estimated retained bytes, from `weigh`. */
  size:  number;
}

export interface LRUOptions<T> {
  /** Hard ceiling on total estimated bytes held. */
  maxBytes?: number;
  /** Estimated retained size of one value. Defaults to 0 (count-only bound). */
  weigh?: (data: T) => number;
}

export class LRUCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly cap:      number;
  private readonly maxBytes: number;
  private readonly weigh:    (data: T) => number;
  /** Running total of `size` across `store`, kept in step with every mutation. */
  private bytesHeld = 0;

  constructor(capacity = 100, opts: LRUOptions<T> = {}) {
    this.cap      = capacity;
    this.maxBytes = opts.maxBytes ?? Infinity;
    this.weigh    = opts.weigh ?? (() => 0);
  }

  /** Drop an entry and keep the byte total honest. Returns whether it existed. */
  private drop(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    this.bytesHeld -= entry.size;
    this.store.delete(key);
    return true;
  }

  /** Get a cached value. Returns null if missing or expired. */
  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // TTL check
    if (Date.now() - entry.at > entry.ttl) {
      this.drop(key);
      return null;
    }

    // Promote to tail (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data;
  }

  /**
   * Store a value, evicting least-recently-used entries until it fits.
   *
   * Both bounds are enforced, and the byte one is what keeps a run of full-day
   * sessions from filling the heap. An entry larger than the whole budget is
   * still stored — it is the one the caller just asked for, and refusing to
   * cache it would mean recomputing it on every request — but it will be the
   * first thing evicted by the next `set`.
   */
  set(key: string, data: T, ttlMs: number): void {
    // Remove existing to re-insert at tail
    this.drop(key);

    const size = this.weigh(data);

    while (
      this.store.size > 0
      && (this.store.size >= this.cap || this.bytesHeld + size > this.maxBytes)
    ) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }

    this.store.set(key, { data, at: Date.now(), ttl: ttlMs, size });
    this.bytesHeld += size;
  }

  /** True if key exists and has not expired. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.drop(key);
  }

  /** Flush everything. */
  clear(): void {
    this.store.clear();
    this.bytesHeld = 0;
  }

  /** Estimated bytes currently held. */
  get bytes(): number {
    return this.bytesHeld;
  }

  /** Number of valid (non-expired) entries. */
  get size(): number {
    return this.store.size;
  }

  /** Metadata for all cached entries (for /api/straddle/cache-status). */
  entries(): CacheMeta[] {
    const now = Date.now();
    return [...this.store.entries()].map(([key, e]) => ({
      key,
      cachedAt:  e.at,
      ttlMs:     e.ttl,
      expiresIn: Math.max(0, e.ttl - (now - e.at)),
    }));
  }
}
