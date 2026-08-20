/**
 * Risk-Reversal Skew — the OTM put/call vol difference, in units of ATM vol.
 *
 *   RR    = IV(OTM put) − IV(OTM call)          vol points
 *   SKEW  = RR / IV(ATM) × 100                  % of ATM vol
 *
 * Two numbers because they answer different questions. RR is what the wing
 * actually costs in vol points, which is what a trade is priced in. SKEW divides
 * that by the ATM level, which is what makes the number COMPARABLE: a 3-point
 * risk reversal against 12 vol ATM is a frightened market, the same 3 points
 * against 40 vol ATM is noise. Only the ratio can be read across sessions, or
 * across an event that repriced the whole surface.
 *
 * Positive skew is the normal state of an index: puts bid over calls, because
 * the demand for crash protection is real and one-sided. The information is in
 * the CHANGES — skew steepening into a move is protection being bought; skew
 * collapsing while spot rallies is that protection being given up.
 *
 * ── Which strikes ──────────────────────────────────────────────────────────
 *
 * The wings are chosen by DELTA, not by strike or by distance: 0.25 by default,
 * the market's own convention for a risk reversal. Delta is the only choice that
 * means the same thing on two different days — "25 delta" is a fixed probability
 * of finishing in the money, whereas "500 points out" is a wide wing in a quiet
 * week and an ATM strike in a violent one.
 *
 * A chain does not contain a leg at exactly 0.25 delta, so each bar takes the
 * NEAREST available on each side and reports the delta it actually used. That
 * reported delta is not a footnote: a bar whose "25 delta put" was really 0.34
 * is measuring a different part of the smile, and the panel shows it so the
 * reader can see when the two wings are not symmetric. A leg further than
 * `tolerance` from the target is refused outright — a 0.6-delta leg labelled as
 * a wing would be a fabrication, and no value is better than a wrong one.
 *
 * ── Where the vols come from ───────────────────────────────────────────────
 *
 * Feed first, Black-76 to fill in — the same order, and the same reasons, as
 * rollingStraddle.ts. Nubra publishes IV and greeks for roughly the last three
 * months, so on anything older every delta is absent and a delta-selected
 * basket would come back empty (this is exactly what the Band Greeks panel warns
 * about when it draws nothing). Here the leg's own mid price is inverted for its
 * vol, and its delta comes from that vol — so the widget still answers on old
 * sessions, and `ivSource` / `deltaSource` say which numbers were whose.
 *
 * ── The ATM anchor ─────────────────────────────────────────────────────────
 *
 * Identical to bandGreeks.ts and rollingStraddle.ts, deliberately: ATM is the
 * cheapest straddle among ATM±2 around the synthetic future F = K + CE − PE,
 * each bar seeding from the previous bar's F. ATM IV is then that straddle's own
 * IV — the mean of its two legs' mid IVs, or the vol inverted from the straddle
 * price as a whole. Sharing the rule is the point: the denominator here is the
 * same number the session chart plots as "IV", so a reader can hold the two
 * charts side by side and have them agree.
 *
 * ── 1 minute ───────────────────────────────────────────────────────────────
 *
 * Fixed, like the band greeks and for the same reason. This is a smile
 * measurement across ~34 contracts, and a smile does not carry information at
 * second resolution: the wings quote in steps, so a 1s series of a 0.25-delta IV
 * is mostly the same number repeated with occasional single-tick jumps. 1m is
 * where the shape is legible and the payload is 1/60th.
 */

import type { Instrument, MarketDataFeed } from '../feeds/types.js';
import { keyOf, normalizeExpiry, type InstrumentKey } from '../feeds/identity.js';
import { FeedError } from '../feeds/errors.js';
import {
  inferStep, nearestStrike, candidateStrikes, advanceQuote, ivMidOf,
  type QuoteCursor, type Quote,
} from '../analytics/syntheticFuture.js';
import {
  impliedVol, impliedVolStraddle, black76Greeks, yearsToExpiry,
} from '../analytics/black76.js';
import { sessionRange, latestTradingDate } from './rollingStraddle.js';

import { logger } from '../lib/logger.js';

const log = logger('riskReversal');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Adjacent strikes either side of the ATM priced as straddle candidates. */
const BAND = 2;

/** Fixed — see the header. */
const RR_INTERVALS = ['1m'] as const;

/** The market's own risk-reversal convention. */
export const DEFAULT_TARGET_DELTA = 0.25;

/**
 * How far from the target delta a leg may sit and still be used.
 *
 * Wide enough that an ordinary chain — where 0.25 might only be available as
 * 0.21 or 0.29 — always has a wing, tight enough that a chain with a hole in it
 * reports nothing rather than quietly substituting a near-ATM leg. The panel
 * shows the delta actually used, so a reader can see where inside this window
 * each bar landed.
 */
export const DEFAULT_DELTA_TOLERANCE = 0.10;

/**
 * Strikes fetched either side of the ATM's own travel.
 *
 * A 0.25-delta leg is a few strikes out on a weekly and a dozen on a monthly, so
 * the window is sized off the target: the further OTM the target sits, the wider
 * it has to reach. The ITM buffer is small on purpose — a leg on the wrong side
 * of the money is past 0.5 delta and cannot be a wing.
 */
const ITM_BUFFER = 2;
function wingWidth(target: number): number {
  if (target <= 0.10) return 26;
  if (target <= 0.20) return 20;
  return 14;
}

// ─── Result types ─────────────────────────────────────────────────────────────

/** One side's chosen wing at one bar. */
export interface Wing {
  strike: number;
  /** Signed delta as used: positive for calls, negative for puts. */
  delta:  number;
  /** IV in PERCENT, matching StraddlePoint.iv. */
  iv:     number;
  ivSource:    'feed' | 'black76';
  deltaSource: 'feed' | 'black76';
}

export interface RiskReversalPoint {
  time:      number;
  spot:      number;
  /** Put-call parity forward at the selected strike — the ATM anchor. */
  synFuture: number;
  atmStrike: number;
  isRollEvent: boolean;

  /** The denominator. Percent, same definition as the session chart's IV. */
  atmIv:       number | null;
  atmIvSource: 'feed' | 'black76' | null;

  /** Percent. Null when that side had no leg inside the delta tolerance. */
  callIv:    number | null;
  putIv:     number | null;
  /** |delta| actually used, so an asymmetric pick is visible. */
  callDelta: number | null;
  putDelta:  number | null;
  callStrike: number | null;
  putStrike:  number | null;

  /** IV(put) − IV(call), in vol points. */
  rr:   number | null;
  /** rr / atmIv × 100 — the headline. */
  skew: number | null;
}

export interface RiskReversalResult {
  status:   true;
  symbol:   string;
  exchange: string;
  expiry:   string;
  date:     string;
  interval: string;
  step:     number;
  targetDelta: number;
  tolerance:   number;
  legsFetched: number;
  points:      RiskReversalPoint[];
  rollCount:   number;
  /** Fraction of bars that produced a skew — the honest coverage number. */
  coverage:    number | null;
  /** Fraction of the vols used that came from the feed rather than the model. */
  feedIvShare: number | null;
  /** Walk state at the last bar, so a tail can continue the session. */
  resume:      RiskReversalResume;
  timings?:    Record<string, number>;
}

/**
 * What a windowed run needs to continue a session it did not walk.
 *
 * Far smaller than the band greeks' equivalent: this measurement carries no
 * per-leg baselines, so a bar depends on nothing before it except where to seed
 * its ATM search and what the previous strike was.
 */
export interface RiskReversalResume {
  prevStrike: number | null;
  anchor:     number | null;
}

export interface RiskReversalError { status: false; message: string }

type ProgressCb = (stage: string, pct: number, message: string) => void;

// ─── Leg bookkeeping ──────────────────────────────────────────────────────────

interface Leg {
  key:    InstrumentKey;
  name:   string;
  strike: number;
  side:   'CE' | 'PE';
}

/**
 * Feed deltas arrive either as 0.42 or as 42 depending on the stream. Anything
 * outside [-1, 1] is taken as the percent form — no real option delta lives
 * there, so the test cannot misfire on a legitimate value.
 */
function normalizeDelta(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.abs(raw) > 1 ? raw / 100 : raw;
}

/**
 * IV and delta for one leg, feed first and model second.
 *
 * The two are resolved TOGETHER because a modelled delta needs a vol to be
 * computed from, and the only vol available is this leg's own. Mixing sources
 * across the pair is fine and is reported (`ivSource` / `deltaSource`): a feed IV
 * with a modelled delta is the common case on a session where the broker
 * publishes IV but not greeks.
 */
function readLeg(
  quote: Quote, F: number, K: number, T: number, side: 'CE' | 'PE',
): { iv: number; ivSource: 'feed' | 'black76'; delta: number; deltaSource: 'feed' | 'black76' } | null {
  // Percent, matching every other IV this codebase surfaces. The feed publishes
  // a fraction; the model returns one too.
  const fed = ivMidOf(quote);
  let iv: number | null = fed != null && fed > 0 ? fed : null;
  let ivSource: 'feed' | 'black76' = 'feed';

  if (iv == null) {
    const mid = (quote.bid + quote.ask) / 2;
    const solved = impliedVol(mid, F, K, T, side);
    // NaN means the quote admits no implied vol — a stale leg printing below
    // intrinsic, or extrinsic value decayed below what is recoverable. Left
    // absent; a clamp here would be indistinguishable from an observation.
    if (!Number.isFinite(solved) || solved <= 0) return null;
    iv = solved;
    ivSource = 'black76';
  }

  const fedDelta = normalizeDelta(quote.delta);
  let delta: number;
  let deltaSource: 'feed' | 'black76';
  if (fedDelta != null && fedDelta !== 0) {
    delta = fedDelta;
    deltaSource = 'feed';
  } else {
    delta = black76Greeks(F, K, T, iv, side).delta;
    deltaSource = 'black76';
    if (!Number.isFinite(delta) || delta === 0) return null;
  }

  return { iv: iv * 100, ivSource, delta, deltaSource };
}

/**
 * The leg closest to `target` delta on one side, or null if none is close enough.
 *
 * Two filters before the distance test, and both are guards against garbage
 * rather than refinements of the selection:
 *
 *   • Only strikes on the OTM side of the selected ATM are considered. A call
 *     below the money is past 0.5 delta and cannot be a wing; if a bad delta
 *     said otherwise, this is what stops it being believed.
 *   • The tolerance. Beyond it there is no wing at this delta, and the bar says
 *     so instead of naming a leg that is not one.
 */
function pickWing(
  legs: Leg[],
  ts: number,
  atmStrike: number,
  F: number,
  T: number,
  side: 'CE' | 'PE',
  target: number,
  tolerance: number,
  seriesByKey: Map<string, import('../feeds/types.js').OptionSeries>,
  cursors: Map<string, QuoteCursor>,
): Wing | null {
  let best: Wing | null = null;
  let bestGap = Infinity;

  for (const leg of legs) {
    const otm = side === 'CE' ? leg.strike >= atmStrike : leg.strike <= atmStrike;
    if (!otm) continue;

    const quote = advanceQuote(leg.name, seriesByKey, cursors, ts);
    if (!(quote.bid > 0) || !(quote.ask > 0)) continue;

    const read = readLeg(quote, F, leg.strike, T, side);
    if (!read) continue;

    const gap = Math.abs(Math.abs(read.delta) - target);
    if (gap > tolerance || gap >= bestGap) continue;

    bestGap = gap;
    best = {
      strike: leg.strike,
      delta:  read.delta,
      iv:     read.iv,
      ivSource:    read.ivSource,
      deltaSource: read.deltaSource,
    };
  }

  return best;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export async function computeRiskReversal(
  opts: {
    symbol:    string;
    exchange?: string;
    expiry?:   string;
    date?:     string;
    /** |delta| of the wings. Defaults to the 0.25 convention. */
    targetDelta?: number;
    tolerance?:   number;
    feed:      MarketDataFeed;
    intervals?: readonly string[];
    /** Window override in epoch ms, clamped to the session. Used by the tail walk. */
    from?:     number;
    to?:       number;
    resume?:   RiskReversalResume;
  },
  onProgress?: ProgressCb,
): Promise<RiskReversalResult | RiskReversalError> {
  const prog     = onProgress ?? (() => {});
  const symbol   = opts.symbol.trim().toUpperCase();
  const exchange = (opts.exchange || 'NSE').toUpperCase();
  const date     = opts.date || latestTradingDate();
  const session  = sessionRange(date, exchange);
  const start    = opts.from != null ? Math.max(session.start, opts.from) : session.start;
  const end      = opts.to   != null ? Math.min(session.end,   opts.to)   : session.end;
  if (start >= end) {
    return { status: false, message: 'Requested window is outside the trading session' };
  }
  const feed      = opts.feed;
  const intervals = opts.intervals?.length ? opts.intervals : RR_INTERVALS;

  const target    = clamp01(opts.targetDelta ?? DEFAULT_TARGET_DELTA, DEFAULT_TARGET_DELTA);
  const tolerance = clamp01(opts.tolerance   ?? DEFAULT_DELTA_TOLERANCE, DEFAULT_DELTA_TOLERANCE);

  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, from: number) => { timings[stage] = Date.now() - from; };

  // ── 1. Refdata → expiry + chain ──────────────────────────────────────────
  prog('refdata', 10, `Loading ${symbol} option chain…`);
  const tRef = Date.now();
  const expiries = await feed.expiries(symbol, exchange, date);
  mark('refdata', tRef);
  if (!expiries.length) return { status: false, message: `No option expiries for ${exchange} ${symbol}` };

  const wanted = normalizeExpiry(opts.expiry);
  const expiry = wanted && expiries.includes(wanted) ? wanted : expiries[0];

  const rows = await feed.chain(symbol, exchange, date, expiry);
  if (!rows.length) return { status: false, message: 'No option rows for selected expiry' };

  // ── 2. Spot series ───────────────────────────────────────────────────────
  const spotCandidates = await feed.underlyings(symbol, exchange, date, expiry);
  if (!spotCandidates.length) {
    return { status: false, message: `No underlying instrument for ${exchange} ${symbol}` };
  }

  prog('spot', 20, `Fetching ${spotCandidates[0].label} spot…`);
  const tSpot = Date.now();
  const spot = await loadSpot(feed, spotCandidates, intervals, start, end);
  mark('spot', tSpot);

  if (!spot.points.length) {
    const tried = spotCandidates.map((c) => c.label).join(', ');
    return {
      status: false,
      message: (spot.error as Error)?.message
        || `No spot data for ${exchange} ${symbol} — tried ${tried}`,
    };
  }
  let resolvedInterval = spot.interval;
  const spotPoints = spot.points;

  // ── 3. Strike universe ───────────────────────────────────────────────────
  const strikes  = [...new Set(rows.map((r) => r.key.strike!))].sort((a, b) => a - b);
  const step     = inferStep(strikes);
  const rowByKey = new Map(rows.map((r) => [`${r.key.strike}|${r.key.side}`, r]));

  // How far the ATM travels, from spot. A bracket for deciding what to FETCH
  // only — the per-bar anchor is the forward, unknown until quotes are in hand.
  let minAtm = Infinity, maxAtm = -Infinity;
  for (const pt of spotPoints) {
    const atm = nearestStrike(pt.spot, strikes, step);
    if (atm < minAtm) minAtm = atm;
    if (atm > maxAtm) maxAtm = atm;
  }
  if (!Number.isFinite(minAtm)) return { status: false, message: 'Could not locate an ATM strike' };

  minAtm -= BAND * step;
  maxAtm += BAND * step;

  const wing = wingWidth(target);
  const legs: Leg[] = [];
  for (const row of rows) {
    const strike = row.key.strike!;
    const side   = row.key.side!;
    const inWindow = side === 'CE'
      ? strike >= minAtm - ITM_BUFFER * step && strike <= maxAtm + wing * step
      : strike <= maxAtm + ITM_BUFFER * step && strike >= minAtm - wing * step;
    if (!inWindow) continue;
    legs.push({ key: row.key, name: keyOf(row.key), strike, side });
  }
  if (!legs.length) return { status: false, message: 'No CE/PE contracts in the wing window' };

  // ── 4. Fetch quotes + delta ──────────────────────────────────────────────
  prog('options', 35, `Fetching ${legs.length} option series…`);
  const tSeries = Date.now();
  // Only delta: this measurement needs vols and one greek, and every extra
  // greek is another full series per contract — see SeriesRequest.greeks.
  const fetchSeries = (interval: string) => feed.optionSeries({
    keys: legs.map((l) => l.key), interval, from: start, to: end, greeks: ['delta'],
  });

  let { series: seriesByKey } = await fetchSeries(resolvedInterval);
  if (!seriesByKey.size && resolvedInterval !== '1m') {
    const fallback = await fetchSeries('1m');
    if (fallback.series.size) { seriesByKey = fallback.series; resolvedInterval = '1m'; }
  }
  mark('optionSeries', tSeries);

  if (!seriesByKey.size) {
    return { status: false, message: `No option series for ${exchange} ${symbol} ${expiry}` };
  }
  prog('series', 60, `Got ${seriesByKey.size} series — measuring skew…`);

  // ── 5. Walk ──────────────────────────────────────────────────────────────
  const tWalk = Date.now();
  const ceLegs = legs.filter((l) => l.side === 'CE');
  const peLegs = legs.filter((l) => l.side === 'PE');

  // One cursor per contract, shared by the ATM pass and the wing pass: both walk
  // forward through the same series at the same timestamps, which is what keeps
  // the session linear rather than quadratic.
  const cursors = new Map<string, QuoteCursor>();

  const points: RiskReversalPoint[] = [];
  let prevStrike: number | null = opts.resume?.prevStrike ?? null;
  let anchor = opts.resume?.anchor ?? spotPoints[0].spot;
  let rollCount = 0;
  let covered = 0;
  let ivsUsed = 0;
  let ivsFromFeed = 0;

  const spotLen = spotPoints.length;
  for (let si = 0; si < spotLen; si++) {
    if (si > 0 && si % Math.max(1, Math.floor(spotLen / 4)) === 0) {
      prog('compute', 60 + Math.floor((si / spotLen) * 30), `Bar ${si}/${spotLen}…`);
    }
    const pt = spotPoints[si];
    const T  = yearsToExpiry(pt.ts, expiry);

    // ── The rolling ATM: cheapest straddle among ATM±2 around the forward ──
    const atmSeed = nearestStrike(anchor, strikes, step);
    let best: {
      strike: number; mid: number; synFuture: number;
      ivMid: number | null;
    } | null = null;

    for (const strike of candidateStrikes(atmSeed, strikes, step, BAND)) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (!ce || !pe) continue;

      const ceQ = advanceQuote(keyOf(ce.key), seriesByKey, cursors, pt.ts);
      const peQ = advanceQuote(keyOf(pe.key), seriesByKey, cursors, pt.ts);
      const bid = ceQ.bid + peQ.bid;
      const ask = ceQ.ask + peQ.ask;
      if (bid <= 0 || ask <= 0) continue;

      const callLtp = (ceQ.bid + ceQ.ask) / 2;
      const putLtp  = (peQ.bid + peQ.ask) / 2;
      const mid     = (bid + ask) / 2;

      // The session chart's own ATM IV rule, quoted rather than reinvented:
      // mean of the two legs' mid IVs, or whichever one published.
      const ceIv = ivMidOf(ceQ);
      const peIv = ivMidOf(peQ);
      const ivMid = ceIv != null && peIv != null ? ((ceIv + peIv) / 2) * 100
        : ceIv != null ? ceIv * 100
          : peIv != null ? peIv * 100
            : null;

      if (!best || mid < best.mid) {
        best = { strike, mid, synFuture: strike + callLtp - putLtp, ivMid };
      }
    }

    if (!best) continue;      // nothing two-sided in the band yet

    anchor = best.synFuture;
    const isRollEvent = prevStrike !== null && prevStrike !== best.strike;
    if (isRollEvent) rollCount++;
    prevStrike = best.strike;

    // ── ATM IV, feed then model ───────────────────────────────────────────
    let atmIv: number | null = null;
    let atmIvSource: 'feed' | 'black76' | null = null;
    if (best.ivMid != null && best.ivMid > 0) {
      atmIv = best.ivMid;
      atmIvSource = 'feed';
    } else {
      const sigma = impliedVolStraddle(best.mid, best.synFuture, best.strike, T);
      if (Number.isFinite(sigma) && sigma > 0) {
        atmIv = sigma * 100;
        atmIvSource = 'black76';
      }
    }

    // ── The wings ─────────────────────────────────────────────────────────
    const call = pickWing(ceLegs, pt.ts, best.strike, best.synFuture, T, 'CE', target, tolerance, seriesByKey, cursors);
    const put  = pickWing(peLegs, pt.ts, best.strike, best.synFuture, T, 'PE', target, tolerance, seriesByKey, cursors);

    for (const w of [call, put]) {
      if (!w) continue;
      ivsUsed++;
      if (w.ivSource === 'feed') ivsFromFeed++;
    }

    const rr = call && put ? put.iv - call.iv : null;
    // Division only where the denominator is a real observation. An ATM IV the
    // engine could not recover leaves the ratio absent rather than infinite.
    const skew = rr != null && atmIv != null && atmIv > 0 ? (rr / atmIv) * 100 : null;
    if (skew != null) covered++;

    points.push({
      time:      pt.ts,
      spot:      pt.spot,
      synFuture: best.synFuture,
      atmStrike: best.strike,
      isRollEvent,
      atmIv,
      atmIvSource,
      callIv:     call?.iv ?? null,
      putIv:      put?.iv  ?? null,
      callDelta:  call ? Math.abs(call.delta) : null,
      putDelta:   put  ? Math.abs(put.delta)  : null,
      callStrike: call?.strike ?? null,
      putStrike:  put?.strike  ?? null,
      rr,
      skew,
    });
  }

  if (!points.length) return { status: false, message: 'No bars had a two-sided ATM straddle' };

  mark('walk', tWalk);
  timings.total = Date.now() - t0;
  log.info(
    `${exchange} ${symbol} ${expiry} ${date} @${resolvedInterval} — `
    + `${points.length} pts, Δ${target}±${tolerance}, ${legs.length} legs, ${rollCount} rolls, `
    + `coverage ${Math.round((covered / points.length) * 100)}%, `
    + `feed IV ${ivsUsed ? Math.round((ivsFromFeed / ivsUsed) * 100) : 0}% | `
    + Object.entries(timings).map(([k, v]) => `${k} ${v}ms`).join(' · '),
  );

  return {
    status: true,
    symbol, exchange, expiry, date,
    interval: resolvedInterval,
    step,
    targetDelta: target,
    tolerance,
    legsFetched: legs.length,
    points,
    rollCount,
    coverage:    points.length ? covered / points.length : null,
    feedIvShare: ivsUsed ? ivsFromFeed / ivsUsed : null,
    resume: { prevStrike, anchor },
    timings,
  };
}

function clamp01(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

// ─── Spot loading ─────────────────────────────────────────────────────────────

/**
 * Same fallback chain as rollingStraddle: candidates in order, intervals in
 * order, and an AUTH failure rethrown rather than absorbed so the route can
 * still answer with a login redirect.
 */
async function loadSpot(
  feed: MarketDataFeed,
  candidates: Instrument[],
  intervals: readonly string[],
  start: number,
  end: number,
): Promise<{ points: Array<{ ts: number; spot: number }>; interval: string; error: unknown }> {
  let error: unknown = null;
  let fault: FeedError | null = null;

  for (const ref of candidates) {
    for (const interval of intervals) {
      try {
        const { candles } = await feed.candles({ key: ref.key, interval, from: start, to: end });
        const points = candles
          .map((c) => ({ ts: c.ts, spot: c.c }))
          .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
          .sort((a, b) => a.ts - b.ts);
        if (points.length) return { points, interval, error: null };
      } catch (err) {
        error ??= err;
        if (err instanceof FeedError && err.code === 'AUTH') throw err;
        if (err instanceof FeedError && err.countsAsFailure) fault ??= err;
      }
    }
  }
  if (fault) throw fault;
  return { points: [], interval: intervals[0], error };
}
