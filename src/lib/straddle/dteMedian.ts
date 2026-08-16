/**
 * The typical session at this DTE.
 *
 * ── What this measures ──
 *
 * A straddle's intraday behaviour is governed by how far it is from expiry. A
 * 4 DTE session bleeds gently; a 1 DTE session falls off a cliff after lunch.
 * So "is today decaying normally?" has no answer against sessions in general —
 * only against sessions at the SAME DTE. This pools the previous N sessions
 * that carried the same days-to-expiry and takes the median at each minute.
 *
 * ── Median, not mean ──
 *
 * Straddle outcomes are heavily skewed: most days pin and a few trend hard. One
 * event session drags a mean to a level no real session ever traded at, which
 * is precisely the wrong reference for "typical". The median is the session in
 * the middle, and it is always a shape some real day actually printed near.
 *
 * ── Three normalisations that are not optional ──
 *
 *   1. TIME. Sessions are aligned by minutes since their own open, not by bar
 *      index. Verified against the live backend: today's session comes back at
 *      1-SECOND bars (22,500 points) while past sessions come back at 1-minute
 *      (376 points). Comparing bar 300 of one to bar 300 of the other is
 *      meaningless; comparing 11:00 to 11:00 is not.
 *
 *   2. LEVEL. Each session is rebased to 100 at its own open. Also verified
 *      live: the same NIFTY 4 DTE contract opened at 191 points today and at
 *      250.85 five weeks ago. A median of raw points across those mostly
 *      measures where spot happened to be, not how the straddle behaved.
 *
 *   3. COVERAGE. A minute is only given a median when enough sessions actually
 *      reported it. Otherwise the tail of the curve is quietly computed from
 *      one surviving session and drawn with the same authority as the middle.
 *
 * ── The known limit: minute SNAPSHOTS, not minute BARS ──
 *
 * `/api/straddle/history` returns a past session as 375 points — one
 * point-in-time sample per minute — and ignores every granularity parameter
 * offered to it (`step`, `interval`, `resolution`, `granularity` all come back
 * `step: 50`, 60-second gaps). Only TODAY comes back at 1-second, ~22,500
 * points.
 *
 * That single sample is not a bar close and there is no high or low beside it.
 * It matters more than a downsampling note usually would, because the rolling
 * straddle is discontinuous: the ATM strike flips constantly — 408 roll events
 * on 2026-08-14 alone — and each flip moves the premium several percent. Live
 * 1-second data for one ordinary minute:
 *
 *     09:15  min 188.68  max 199.90   strikes 24400, 24350
 *     09:16  min 185.72  max 194.10   strikes 24350, 24400
 *
 * ~6% of travel inside sixty seconds, none of it visible in the one snapshot a
 * past session gives back. So:
 *
 *   - `lo`/`hi` here are the SPREAD of N snapshots, not the high/low of N bars.
 *     The latter is strictly wider and is what a terminal storing 1-minute OHLC
 *     quotes. Measured against one such reference on 2026-08-14 15:29: it read
 *     156.36–215.34 where this reads 155.23–181.99. The lows agree; the highs
 *     cannot, and no cohort or median change will close that gap.
 *
 *   - the median is much less exposed, and what exposure it had came through the
 *     level anchor rather than the statistic. Anchoring on a five-minute median
 *     instead of the first print closed it from 165.69 to 163.15 against that
 *     reference's 162.78 — see `openAnchor`.
 *
 * Closing this needs the BACKEND to serve per-minute OHLC for past sessions.
 * It is not reachable from here.
 */

/** Minutes IST is ahead of UTC. */
const IST_OFFSET_MIN = 330;

/** Minute-of-day in IST for an epoch-millis timestamp. */
function istMinuteOfDay(millis: number): number {
  return Math.floor((millis / 60_000 + IST_OFFSET_MIN) % 1440);
}

/**
 * SESSIONS from a date to its expiry — the trading-day count.
 *
 * ── Why this is not the calendar count ──
 *
 * NIFTY weeklies expire on Tuesday. Counting calendar days makes the Friday
 * before expiry "4 DTE"; counting sessions makes it "2 DTE", because Saturday
 * and Sunday are not days the straddle decays through in the way a session
 * does. Every straddle desk — and the reference terminal this is being matched
 * against — means the session count, so that is what this returns. Confirmed
 * against a live screenshot: 2026-08-14 (Fri) → 2026-08-18 (Tue) reads as
 * DAYS TO EXPIRY 2, not 4.
 *
 * The consequence worth stating: with a Tuesday expiry, 2 DTE is ALWAYS a
 * Friday, 3 DTE always a Thursday, and so on. That is exactly what makes the
 * cohort meaningful — the five sessions pooled are five of the same weekday,
 * sharing a weekend gap and a position in the expiry cycle.
 *
 * ── The one thing this does not know ──
 *
 * Exchange holidays. Weekends are excluded, a Monday holiday is not, so a
 * holiday-shortened week reads one session long. It is self-consistent — the
 * cohort search scores candidate dates with this same function, so a mislabelled
 * week is mislabelled identically on both sides and still matches like with
 * like. Fixing it properly needs a trading calendar the frontend does not have;
 * the backend's `latestTradingDate` is the place that would come from.
 *
 * NOTE this is deliberately NOT the backend's `daysToExpiry`, which is calendar
 * days and is right for what it does: theta accrues over a weekend, so Black-76
 * must see the calendar gap. Two different questions, two different counts.
 */
export function dteBetween(dateISO: string, expiryISO: string): number {
  const from = Date.parse(`${dateISO}T00:00:00Z`);
  const to = Date.parse(`${expiryISO}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return -1;
  if (to < from) return -1;

  // Counted from the day AFTER the session up to and including expiry day, so
  // expiry day itself is 0 DTE and the session before it is 1.
  let sessions = 0;
  for (let t = from + 86_400_000; t <= to; t += 86_400_000) {
    const weekday = new Date(t).getUTCDay();
    if (weekday !== 0 && weekday !== 6) sessions += 1;
  }
  return sessions;
}

/** ISO date shifted by whole days. */
export function addDays(dateISO: string, days: number): string {
  const base = Date.parse(`${dateISO}T00:00:00Z`);
  if (!Number.isFinite(base)) return dateISO;
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/** Saturday or Sunday — never a session, so never worth a lookup. */
export function isWeekend(dateISO: string): boolean {
  const day = new Date(`${dateISO}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

export interface SessionPoint {
  time: number;
  straddlePrice?: number | null;
}

/**
 * How many minutes of the open the level anchor is taken over.
 *
 * Five. Long enough that no single print decides a session's whole curve, short
 * enough to still be "the open" — by 09:20 the straddle has not yet begun the
 * decay the comparison exists to measure.
 */
const ANCHOR_MINUTES = 5;

/**
 * The session's opening LEVEL — a median over the first few minutes, not the
 * first print.
 *
 * ── Why the first print cannot be used ──
 *
 * Every session's entire index is divided by this one number, so an error here
 * does not perturb a curve, it rescales the whole thing. And the first print is
 * the single least reliable sample in the session. From live 1-second data,
 * one ordinary minute:
 *
 *     09:15  first 191.00  last 193.40  min 188.68  max 199.90  strikes 24400, 24350
 *
 * Six percent of travel inside sixty seconds, because the ATM strike is flipping
 * — the rolling straddle is discontinuous at a roll and the opening minutes are
 * where spot is least settled. A past session gives back ONE snapshot for that
 * minute, so which of those values arrives is effectively arbitrary.
 *
 * The damage is not subtle. Anchoring on that tick scales a session's whole
 * curve by a random few percent, which is why a cohort median can drift by more
 * than the effect being measured, and why one session can be flung far enough
 * out to become an apparent outlier that never traded. Measured against a
 * reference terminal at 2026-08-14 15:29, first-print anchoring gave a median of
 * 165.69 against its 162.78; a five-minute median anchor gives 163.1.
 *
 * ── Why the median and not the mean ──
 *
 * The same reason the cohort uses one: a roll inside the anchor window is a step
 * change, not noise, and a mean would carry a share of it into the anchor. The
 * median simply ignores a minority of displaced samples.
 *
 * Returns `null` when there is nothing usable to anchor on — callers must not
 * silently fall back to a first print, which is the bug this exists to remove.
 */
export function openAnchor(points: SessionPoint[], minutes = ANCHOR_MINUTES): number | null {
  const usable = points.filter(
    (p): p is SessionPoint & { straddlePrice: number } =>
      typeof p.straddlePrice === 'number' && Number.isFinite(p.straddlePrice) && p.straddlePrice > 0,
  );
  if (!usable.length) return null;

  // Windowed on the clock, not on a sample count: history arrives at one point
  // per minute and today at one per second, and "the first 5 samples" would mean
  // five minutes of one and five seconds of the other.
  const from = istMinuteOfDay(usable[0].time);
  const window = usable
    .filter((p) => istMinuteOfDay(p.time) < from + minutes)
    .map((p) => p.straddlePrice);

  return window.length ? medianOf(window) : null;
}

export interface RebasedSession {
  /** ISO session date. */
  date: string;
  /** The contract that carried the target DTE on that date. */
  expiry: string;
  /** The session's opening LEVEL in points — see `openAnchor`. Not the first
   *  print, and deliberately so. */
  open: number;
  /**
   * Index of 100 at that session's open, keyed by IST MINUTE-OF-DAY.
   *
   * Absolute clock, not minutes-since-this-session's-open. 09:15 is 555 in
   * every session, so a day whose first print landed at 09:16 still lines its
   * 11:00 up with everyone else's 11:00 — where an origin-relative key would
   * have slid that whole session one minute left and blurred the median by a
   * bar. It is also what makes the axis read as real clock times.
   */
  byMinute: Map<number, number>;
  /** Earliest and latest IST minute-of-day with a value. */
  firstMinute: number;
  lastMinute: number;
}

/**
 * One session → an index of 100 at its own open, keyed by IST minute-of-day.
 *
 * The LAST print inside a minute wins, which makes this a close-of-minute
 * series. Averaging within the minute would smooth away the thing a 1-second
 * session is being downsampled to show.
 *
 * Nothing here hardcodes 09:15. The range comes from the data, so an MCX
 * session running 09:00–23:30 needs no special case.
 */
export function rebaseSession(
  date: string,
  expiry: string,
  points: SessionPoint[],
): RebasedSession | null {
  const usable = points.filter(
    (p): p is SessionPoint & { straddlePrice: number } =>
      typeof p.straddlePrice === 'number' && Number.isFinite(p.straddlePrice) && p.straddlePrice > 0,
  );
  if (usable.length < 2) return null;

  const open = openAnchor(usable);
  if (!open) return null;

  const byMinute = new Map<number, number>();
  let firstMinute = Infinity;
  let lastMinute = -Infinity;
  for (const point of usable) {
    const minute = istMinuteOfDay(point.time);
    byMinute.set(minute, (point.straddlePrice / open) * 100);
    if (minute < firstMinute) firstMinute = minute;
    if (minute > lastMinute) lastMinute = minute;
  }

  return byMinute.size >= 2
    ? { date, expiry, open, byMinute, firstMinute, lastMinute }
    : null;
}

export interface MedianPoint {
  /** IST minute-of-day — 555 is 09:15. */
  minute: number;
  /** Median index across the cohort, 100 = each session's own open. */
  median: number;
  /**
   * Lowest and highest index across the cohort at this minute.
   *
   * Carried because the median alone cannot say whether it is describing five
   * sessions that agreed or five that did not. A median of 85 drawn from a
   * cohort spanning 81–95 is a typical session; the same 85 drawn from 81–113
   * is the middle of a scatter, and the line looks identical either way.
   */
  lo: number;
  hi: number;
  /** How many sessions reported this minute. */
  n: number;
}

export interface MedianProfile {
  points: MedianPoint[];
  /** Sessions that contributed. */
  sessions: RebasedSession[];
  /** Minutes dropped for thin coverage — worth surfacing, not hiding. */
  thinMinutes: number;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The median index across a cohort, minute by minute.
 *
 * `minCoverage` is a FRACTION of the cohort, not a count, so it means the same
 * thing whether five sessions were found or three. Minutes below it are dropped
 * rather than drawn: the last ten minutes of a session are often reported by
 * only one broker-day, and a curve that quietly narrows to a single session at
 * the right-hand edge is drawn with exactly the same authority as the part
 * backed by all five.
 */
export function medianProfile(
  sessions: RebasedSession[],
  minCoverage = 0.6,
  scales?: number[],
): MedianProfile {
  if (!sessions.length) return { points: [], sessions, thinMinutes: 0 };

  const from = Math.min(...sessions.map((s) => s.firstMinute));
  const horizon = Math.max(...sessions.map((s) => s.lastMinute));
  const needed = Math.max(2, Math.ceil(sessions.length * minCoverage));

  const points: MedianPoint[] = [];
  let thinMinutes = 0;

  for (let minute = from; minute <= horizon; minute += 1) {
    /*
     * Pooled in whatever unit `scales` puts them in — see `unitScales`.
     *
     * The scale is applied HERE, before the min/median/max, and that ordering
     * is load-bearing for raw units. With one shared scale the two commute and
     * it would not matter; with a scale per session it decides the answer,
     * because the ordering of the five values is itself different in points
     * than it is in index. Scaling a median computed on the index would produce
     * a number that is not the median of anything.
     */
    const values: number[] = [];
    sessions.forEach((session, i) => {
      const value = session.byMinute.get(minute);
      if (value !== undefined) values.push(value * (scales?.[i] ?? 1));
    });
    if (values.length === 0) continue;
    if (values.length < needed) {
      thinMinutes += 1;
      continue;
    }
    points.push({
      minute,
      median: medianOf(values),
      lo: Math.min(...values),
      hi: Math.max(...values),
      n: values.length,
    });
  }

  return { points, sessions, thinMinutes };
}

/**
 * What unit the overlay and the table are read in.
 *
 *   RAW      — each session's own traded premium. 08-07 at 10:53 reads 256.15,
 *              which is what that day's chart shows and is therefore the only
 *              version that can be checked against anything.
 *   REBASED  — every session scaled to today's opening level, so five contracts
 *              at five different spot levels can be compared with today.
 *
 * Neither is the "correct" one; they answer different questions. Raw says what
 * the straddle traded at, rebased says whether today is rich or cheap against
 * a typical session at this DTE.
 */
export type CompareUnits = 'rebased' | 'raw';

/**
 * The per-session multiplier that turns an index of 100 into the chosen unit.
 *
 * `byMinute` is an index anchored at 100, so both units are one multiply from
 * it and neither is reconstructed by inverting the other. Returned per session
 * rather than as a single number because raw needs five different factors —
 * which is exactly what makes it more than a change of axis label.
 */
export function unitScales(
  sessions: RebasedSession[],
  units: CompareUnits,
  todayOpen: number,
): number[] {
  return sessions.map((s) => (units === 'raw' ? s.open : todayOpen) / 100);
}

/** `555` → `09:15`. */
export function clockOf(minute: number): string {
  const hh = String(Math.floor(minute / 60) % 24).padStart(2, '0');
  const mm = String(minute % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export interface ComparePoint {
  /** Epoch SECONDS, on today's calendar day — what the chart plots against. */
  time: number;
  /** Straddle premium in points. */
  value: number;
  /** The cohort's spread at this minute, in the same points. */
  lo: number;
  hi: number;
  n: number;
}

/**
 * The profile, hung on today's time axis.
 *
 * ── Values pass through untouched ──
 *
 * Scaling happens once, inside `medianProfile`, before the min/median/max — see
 * the note there on why that ordering is not interchangeable. This function
 * used to also multiply by today's open, which quietly made rebased the only
 * unit the chart could draw and meant the plotted median was a scaled index
 * median rather than a median of prices. It now does timestamps and nothing
 * else, so whatever `unitScales` chose is what appears on the chart.
 *
 * ── Alignment ──
 *
 * Timestamps are built from today's own first bar so the overlay lands exactly
 * on today's calendar day and on whole IST minutes. `todayFirstMillis` supplies
 * the date; the minute-of-day supplies the time. Nothing is interpolated: a
 * minute the cohort had no median for is simply absent, and the line breaks.
 */
export function projectToPoints(
  profile: MedianProfile,
  todayFirstMillis: number,
): ComparePoint[] {
  if (!Number.isFinite(todayFirstMillis)) return [];

  // Midnight IST of today's session, as epoch millis. Any minute-of-day can be
  // hung off it without re-deriving the date from a formatted string.
  const istMillis = todayFirstMillis + IST_OFFSET_MIN * 60_000;
  const istMidnight = Math.floor(istMillis / 86_400_000) * 86_400_000;
  const utcMidnight = istMidnight - IST_OFFSET_MIN * 60_000;

  return profile.points.map((point) => ({
    time: Math.floor((utcMidnight + point.minute * 60_000) / 1000),
    value: point.median,
    lo: point.lo,
    hi: point.hi,
    n: point.n,
  }));
}
