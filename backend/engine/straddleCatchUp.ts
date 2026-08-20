/**
 * Incremental refresh of a cached session — the middle step of
 * "cache → catch up → live".
 *
 * A cached session for today ends wherever it happened to be computed. Serving
 * it and then opening the live socket leaves a hole between the two: the chart
 * shows 09:15–11:02 and then jumps to whatever the clock says now, with the
 * intervening ticks missing from both sources. Nothing downstream can recover
 * them — the live feed only ever sends the present.
 *
 * So before the socket opens, the tail is recomputed and appended. This is the
 * same engine over a short window, not a second implementation of the straddle
 * rule: a caught-up bar and a freshly computed bar are the same object.
 *
 * Two details make the seam invisible:
 *
 *   LEAD_IN_MS — the recompute starts a few minutes BEFORE the cached tail, not
 *   at it. advanceQuote carries the last known quote forward, so a window that
 *   begins exactly at the seam gives the cursors nothing to carry and the first
 *   bars of the tail drop out for any contract that did not print in that exact
 *   second. The lead-in bars are computed and then discarded; only their effect
 *   on the cursors survives.
 *
 *   The seam roll — a strike change across the join is a real roll event, and
 *   the tail's own walk usually sees it (its lead-in covers the cached bar).
 *   When the lead-in produced nothing it cannot, so the join is checked
 *   explicitly rather than trusted.
 *
 * Append-only, by design: bars already cached are never revisited, so a feed
 * that revises an old bar will not be picked up until the entry expires or
 * /api/straddle/cache-invalidate is called.
 */

import type { MarketDataFeed } from '../feeds/types.js';
import type { StraddlePoint } from '../analytics/syntheticFuture.js';
import {
  computeRollingStraddle, sessionRange,
  type RollEvent, type RollingStraddleResult,
} from './rollingStraddle.js';
import {
  computeBandGreeks,
  type BandGreekPoint, type BandGreeksResult,
} from './bandGreeks.js';
import {
  computeRiskReversal,
  type RiskReversalPoint, type RiskReversalResult,
} from './riskReversal.js';

import { logger } from '../lib/logger.js';

const log = logger('straddle');
const logBandGreeks = logger('bandGreeks');
const logRiskReversal = logger('riskReversal');

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Quote history fetched before the seam so advanceQuote's cursors start warm. */
const LEAD_IN_MS = 5 * 60_000;

/**
 * Don't bother for a gap smaller than this. A reload seconds after the last one
 * has nothing to gain and would still pay a chain + option-series round trip.
 */
const MIN_GAP_MS = 15_000;

// ── Public shapes ────────────────────────────────────────────────────────────

export interface CatchUp {
  /** The cached session with the tail appended — what goes back into the cache. */
  merged:     RollingStraddleResult;
  /** Only the new bars, so the client can append instead of re-sending 22k points. */
  points:     StraddlePoint[];
  rollEvents: RollEvent[];
  computeMs:  number;
}

interface CatchUpOptions {
  symbol:   string;
  exchange: string;
  expiry:   string;
  date:     string;
  feed:     MarketDataFeed;
  now?:     number;
}

/** Today in IST, as `YYYY-MM-DD`. */
function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Is there anything worth fetching for this cached session?
 *
 * Cheap and side-effect free, so the route can decide whether to tell the
 * client to expect a tail before it commits to computing one.
 */
export function needsCatchUp(
  cached:   Pick<RollingStraddleResult, 'points'> | null | undefined,
  date:     string,
  exchange: string,
  now = Date.now(),
): boolean {
  if (!cached?.points?.length) return false;
  // A past session is closed: its tail is as final as its open.
  if (date !== istToday()) return false;

  const last = cached.points[cached.points.length - 1]?.time;
  if (!Number.isFinite(last)) return false;

  const { start, end } = sessionRange(date, exchange);
  if (now < start) return false;              // pre-open, nothing has traded
  if (last >= end) return false;              // cached session already runs to the close

  return Math.min(now, end) - last > MIN_GAP_MS;
}

/**
 * Recompute the missing tail and merge it into `cached`.
 *
 * Returns null when there is nothing new — an empty window, a tail the engine
 * could not price, or bars that turn out to be no newer than what is cached.
 * Callers treat that as "the cache was already current", not as a failure.
 */
export async function catchUpStraddle(
  cached: RollingStraddleResult,
  opts:   CatchUpOptions,
): Promise<CatchUp | null> {
  if (!cached.points?.length) return null;

  const now = opts.now ?? Date.now();
  const { start, end } = sessionRange(opts.date, opts.exchange);
  const seam = cached.points[cached.points.length - 1].time;

  const t0   = Date.now();
  const tail = await computeRollingStraddle({
    symbol:   opts.symbol,
    exchange: opts.exchange,
    expiry:   opts.expiry,
    date:     opts.date,
    feed:     opts.feed,
    from:     Math.max(start, seam - LEAD_IN_MS),
    to:       Math.min(now, end),
  });

  // A window with no complete straddle points is the ordinary "nothing new yet"
  // answer during a quiet minute, not an error worth propagating: the cached
  // session is already on the client's screen.
  if (!tail.status) return null;

  const fresh = tail.points.filter((p) => p.time > seam);
  if (!fresh.length) return null;

  // Rolls at or before the seam happened inside the lead-in and are already in
  // the cached list; re-appending them would double-count the day's roll total.
  const freshRolls = tail.rollEvents.filter((r) => r.time > seam);

  // The join itself. The tail's walk normally carries prevStrike across from a
  // lead-in bar and has already flagged this; when it could not, the strike
  // change is still a roll and is recorded here.
  const prev = cached.points[cached.points.length - 1];
  const head = fresh[0];
  if (head.atmStrike !== prev.atmStrike && !head.isRollEvent) {
    head.isRollEvent = true;
    freshRolls.unshift({
      time:          head.time,
      fromStrike:    prev.atmStrike,
      toStrike:      head.atmStrike,
      synFuture:     head.syntheticFuture,
      straddlePrice: head.straddlePrice,
      vegaJump:  head.vega  != null && prev.vega  != null ? head.vega  - prev.vega  : null,
      thetaJump: head.theta != null && prev.theta != null ? head.theta - prev.theta : null,
    });
  }

  const points     = cached.points.concat(fresh);
  const rollEvents = cached.rollEvents.concat(freshRolls);

  // Coverage is a property of the whole session, so it is recounted over the
  // merged array rather than blended from two fractions.
  let greekBars = 0;
  let modelled  = 0;
  for (const p of points) {
    if (p.vega != null || p.theta != null) greekBars++;
    if (p.greekSource === 'black76') modelled++;
  }

  const merged: RollingStraddleResult = {
    ...cached,
    points,
    rollEvents,
    // Baselines belong to the 9:15 open, which lives in the cached half. The
    // tail's own entry* values are its window's first bar and must not win —
    // unless the cached half never had one to begin with.
    entryPrice:    cached.entryPrice    ?? tail.entryPrice,
    entryStraddle: cached.entryStraddle ?? tail.entryStraddle,
    entryVega:     cached.entryVega     ?? tail.entryVega,
    entryTheta:    cached.entryTheta    ?? tail.entryTheta,
    greekCoverage:         points.length ? greekBars / points.length : null,
    greekModelledFraction: greekBars ? modelled / greekBars : null,
    currentStrike: points[points.length - 1].atmStrike,
    lastSpot:      tail.lastSpot ?? cached.lastSpot,
    // The tail visits a handful of strikes around the current spot, so the
    // day's count is the cached one; it only grows if the tail somehow ranged
    // wider than the whole session before it.
    strikesChecked: Math.max(cached.strikesChecked, tail.strikesChecked),
    timings:        tail.timings,
  };

  const computeMs = Date.now() - t0;
  log.info(
    `CATCHUP ${opts.exchange} ${opts.symbol} ${opts.expiry} ${opts.date} — `
    + `+${fresh.length} pts, +${freshRolls.length} rolls, `
    + `${new Date(seam).toISOString()} → ${new Date(points[points.length - 1].time).toISOString()} `
    + `in ${computeMs}ms`,
  );

  return { merged, points: fresh, rollEvents: freshRolls, computeMs };
}

// ── Delta-band vega / theta ──────────────────────────────────────────────────

export interface BandCatchUp {
  merged:    BandGreeksResult;
  points:    BandGreekPoint[];
  computeMs: number;
}

interface BandCatchUpOptions extends CatchUpOptions {
  deltaMin: number;
  deltaMax: number;
}

/**
 * The same top-up for the band greeks panel.
 *
 * One extra moving part: the band's headline series measures each leg against
 * what it was worth when it JOINED the band, which for a leg that came in at
 * 09:20 is not visible from any lead-in window. The cached result carries that
 * state (BandResumeState) and the tail run continues from it — without which
 * every value after the seam would be measured from a fresh baseline and the
 * series would step to zero at the join.
 *
 * Re-walking the lead-in bars on top of the resumed state is safe: joins are
 * guarded on "no baseline yet" and exits delete, so replaying the same bars
 * reproduces the same map rather than disturbing it.
 */
export async function catchUpBandGreeks(
  cached: BandGreeksResult,
  opts:   BandCatchUpOptions,
): Promise<BandCatchUp | null> {
  if (!cached.points?.length) return null;
  // Written before `resume` existed, so it can be missing from a warm cache
  // across a deploy. Without it a tail would silently re-baseline — full
  // recompute is the correct answer, and returning null asks for one.
  if (!cached.resume) return null;

  const now = opts.now ?? Date.now();
  const { start, end } = sessionRange(opts.date, opts.exchange);
  const seam = cached.points[cached.points.length - 1].time;

  const t0   = Date.now();
  const tail = await computeBandGreeks({
    symbol:   opts.symbol,
    exchange: opts.exchange,
    expiry:   opts.expiry,
    date:     opts.date,
    deltaMin: opts.deltaMin,
    deltaMax: opts.deltaMax,
    feed:     opts.feed,
    from:     Math.max(start, seam - LEAD_IN_MS),
    to:       Math.min(now, end),
    resume:   cached.resume,
  });

  if (!tail.status) return null;

  const fresh = tail.points.filter((p) => p.time > seam);
  if (!fresh.length) return null;

  // The join, for the same reason as the straddle seam: the tail's own walk
  // resumed prevStrike, so it normally flags this itself.
  const prev = cached.points[cached.points.length - 1];
  if (fresh[0].atmStrike !== prev.atmStrike && !fresh[0].isRollEvent) {
    fresh[0].isRollEvent = true;
  }

  const points = cached.points.concat(fresh);
  let covered = 0;
  let rolls   = 0;
  for (const p of points) {
    if (p.callVega != null || p.putVega != null || p.callTheta != null || p.putTheta != null) covered++;
    if (p.isRollEvent) rolls++;
  }

  const merged: BandGreeksResult = {
    ...cached,
    points,
    rollCount: rolls,
    coverage:  points.length ? covered / points.length : null,
    // `used` accumulated across both halves, so the count only ever grows.
    legsUsed:  tail.resume.used.length,
    resume:    tail.resume,
    timings:   tail.timings,
  };

  const computeMs = Date.now() - t0;
  logBandGreeks.info(
    `CATCHUP ${opts.exchange} ${opts.symbol} ${opts.expiry} ${opts.date} `
    + `Δ ${opts.deltaMin}-${opts.deltaMax} — +${fresh.length} pts in ${computeMs}ms`,
  );

  return { merged, points: fresh, computeMs };
}

// ── Risk-reversal skew ───────────────────────────────────────────────────────

export interface SkewCatchUp {
  merged:    RiskReversalResult;
  points:    RiskReversalPoint[];
  computeMs: number;
}

interface SkewCatchUpOptions extends CatchUpOptions {
  targetDelta: number;
  tolerance:   number;
}

/**
 * The same top-up for the risk-reversal panel.
 *
 * Simpler than the band greeks' version, and for a structural reason: a skew bar
 * carries no per-leg baselines. Every number in it is measured from that bar's
 * own quotes, so the only state to continue is where the ATM search seeds and
 * what the previous strike was — both of which the lead-in would rebuild anyway.
 * Passing `resume` just makes the first bars of the tail as good as the rest
 * instead of relying on the rewind.
 */
export async function catchUpRiskReversal(
  cached: RiskReversalResult,
  opts:   SkewCatchUpOptions,
): Promise<SkewCatchUp | null> {
  if (!cached.points?.length) return null;

  const now = opts.now ?? Date.now();
  const { start, end } = sessionRange(opts.date, opts.exchange);
  const seam = cached.points[cached.points.length - 1].time;

  const t0   = Date.now();
  const tail = await computeRiskReversal({
    symbol:      opts.symbol,
    exchange:    opts.exchange,
    expiry:      opts.expiry,
    date:        opts.date,
    feed:        opts.feed,
    targetDelta: opts.targetDelta,
    tolerance:   opts.tolerance,
    from:        Math.max(start, seam - LEAD_IN_MS),
    to:          Math.min(now, end),
    resume:      cached.resume,
  });

  if (!tail.status) return null;

  const fresh = tail.points.filter((p) => p.time > seam);
  if (!fresh.length) return null;

  // The join, for the same reason as the straddle seam: the tail's own walk
  // normally carries prevStrike across from a lead-in bar and has flagged this.
  const prev = cached.points[cached.points.length - 1];
  if (fresh[0].atmStrike !== prev.atmStrike && !fresh[0].isRollEvent) {
    fresh[0].isRollEvent = true;
  }

  const points = cached.points.concat(fresh);
  let covered = 0;
  let rolls   = 0;
  for (const p of points) {
    if (p.skew != null) covered++;
    if (p.isRollEvent) rolls++;
  }

  const merged: RiskReversalResult = {
    ...cached,
    points,
    rollCount: rolls,
    coverage:  points.length ? covered / points.length : null,
    // A share over the merged whole would need both halves' denominators, which
    // are not carried; the tail's own share is the more recent and more useful
    // answer to "is this feed IV or model IV right now".
    feedIvShare: tail.feedIvShare ?? cached.feedIvShare,
    resume:      tail.resume,
    timings:     tail.timings,
  };

  const computeMs = Date.now() - t0;
  logRiskReversal.info(
    `CATCHUP ${opts.exchange} ${opts.symbol} ${opts.expiry} ${opts.date} `
    + `Δ${opts.targetDelta} — +${fresh.length} pts in ${computeMs}ms`,
  );

  return { merged, points: fresh, computeMs };
}
