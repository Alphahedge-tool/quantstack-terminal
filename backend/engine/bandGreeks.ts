/**
 * Delta-band Vega & Theta on the rolling ATM — ported from Alphahedge's
 * "Vega Analysis" view (App.jsx `loadVegaAnalysis`), extended to theta.
 *
 * The question this answers is not "what is my straddle worth" but "is the
 * OTM wing building vol exposure or bleeding it". Two different things:
 *
 *   1. WHICH LEGS COUNT — every CE and PE whose |delta| falls in [dMin, dMax],
 *      default 0.05–0.60, i.e. the OTM range. The band is a delta band, not a
 *      strike band, so it slides on its own as spot moves and as vol changes
 *      shape. A strike that was 0.45 delta this morning and is 0.75 now has
 *      stopped being an OTM leg and leaves the basket.
 *
 *   2. WHAT IS PLOTTED — per side, Σ(current greek − that leg's OWN entry
 *      greek). Above zero the wing is BUILDING vega; below zero it is
 *      BLEEDING. A leg's entry value is captured the moment it enters the
 *      band and forgotten the moment it leaves, so a leg that comes back
 *      re-baselines at its re-entry value rather than at some stale morning
 *      number it no longer has any relationship to.
 *
 * ── The ATM anchor ───────────────────────────────────────────────────────────
 *
 * The band hangs off the ROLLING ATM, and that ATM is anchored on the
 * SYNTHETIC FUTURE rather than on spot:
 *
 *   F = K + CE − PE     (put-call parity, the market's own forward)
 *
 * Spot is the wrong anchor for an options basket. It carries no basis, so on
 * anything with real carry — every MCX commodity, index futures in a steep
 * month — the strike nearest spot is not the strike the options are actually
 * pricing around, and the whole band ends up shifted one or two strikes off
 * where the market has it. F is what the chain itself says the underlying is
 * worth at expiry, which is the number the deltas in the band are computed
 * against, so anchoring on it keeps the selection self-consistent.
 *
 * F needs a strike to be computed from, so each bar seeds its ATM from the
 * PREVIOUS bar's F (spot on the first bar only), takes ATM ± BAND adjacent
 * strikes as candidates, prices each, and keeps the cheapest — the identical
 * selection rule rollingStraddle.ts uses, so the two agree on which straddle
 * is held. A change in the selected strike is a roll.
 */

import type { Instrument, MarketDataFeed } from '../feeds/types.js';
import { keyOf, normalizeExpiry, type InstrumentKey } from '../feeds/identity.js';
import { FeedError } from '../feeds/errors.js';
import {
  inferStep,
  nearestStrike,
  candidateStrikes,
  advanceQuote,
  type QuoteCursor,
} from '../analytics/syntheticFuture.js';
import { sessionRange, latestTradingDate } from './rollingStraddle.js';

import { logger } from '../lib/logger.js';

const log = logger('bandGreeks');

// ─── Constants ────────────────────────────────────────────────────────────────

/** Adjacent strikes either side of the ATM that are priced as candidates. */
const BAND = 2;

/**
 * One minute, and not negotiable by default.
 *
 * This basket is 60–100 contracts against the straddle's 20–40, and at 1s each
 * contract carries ~23k points PER FIELD — with delta, vega and theta on top of
 * the quote fields that is tens of millions of numbers to move, parse and walk
 * for a single session. At 1m it is 1/60th of that.
 *
 * Nothing is lost. These lines are a slow aggregate over a wide basket: the
 * delta band turns over on the order of minutes, and a wing's vega does not
 * carry information at second resolution the way a straddle's own price does.
 * The session chart keeps 1s because there the tick edge IS the product.
 */
const BAND_INTERVALS = ['1m'] as const;

/** Alphahedge's defaults: the OTM range. */
export const DEFAULT_DELTA_MIN = 0.05;
export const DEFAULT_DELTA_MAX = 0.60;

/**
 * How far out to fetch greeks, in strikes beyond the ATM's own travel.
 *
 * A 0.05-delta leg sits a long way out, and how far depends on vol and on time
 * to expiry — so the window is generous when the band reaches that far and
 * tighter when it does not. The ITM buffer is small on purpose: legs on the
 * wrong side of the money are past 0.60 delta and cannot enter the band, so
 * fetching them is paid-for data that is never summed.
 */
const WING_WIDE   = 24;
const WING_NARROW = 16;
const ITM_BUFFER  = 2;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface BandGreekPoint {
  time:      number;
  spot:      number;
  /** Put-call parity forward at the selected strike — the ATM anchor. */
  synFuture: number;
  atmStrike: number;
  isRollEvent: boolean;

  /** Σ(current − entry) across the band, per side. The headline series. */
  callVega:  number | null;
  putVega:   number | null;
  callTheta: number | null;
  putTheta:  number | null;

  /** Raw current totals, for reading the basket's absolute exposure. */
  callVegaTotal:  number | null;
  putVegaTotal:   number | null;
  callThetaTotal: number | null;
  putThetaTotal:  number | null;

  /** How many legs qualified each side — band-width feedback. */
  callCount: number;
  putCount:  number;
}

/**
 * Everything a windowed run needs to continue a session it did not walk.
 *
 * The band's headline series is Σ(current − entry) per leg, and a leg's entry is
 * whenever it JOINED the band — possibly hours earlier. That baseline cannot be
 * recovered from a short window at any lead-in length, so a tail recompute that
 * started cold would re-baseline every leg at the seam and drop the series to
 * zero there. Carrying this forward is what makes the incremental refresh
 * (straddleCatchUp.ts) produce the same numbers as a full walk.
 *
 * Maps travel as entry arrays so the whole thing survives the JSON round trip
 * through the compute cache.
 */
export interface BandResumeState {
  callEntryVega:  Array<[string, number]>;
  callEntryTheta: Array<[string, number]>;
  putEntryVega:   Array<[string, number]>;
  putEntryTheta:  Array<[string, number]>;
  /** Roll detection across the join. */
  prevStrike: number | null;
  /** The forward the next bar's ATM search seeds from. */
  anchor:     number | null;
  /** Leg names that have ever qualified, so `legsUsed` keeps counting up. */
  used:       string[];
}

export interface BandGreeksResult {
  status:    true;
  symbol:    string;
  exchange:  string;
  expiry:    string;
  date:      string;
  interval:  string;
  step:      number;
  deltaMin:  number;
  deltaMax:  number;
  /** Contracts fetched, and how many ever entered the band. */
  legsFetched: number;
  legsUsed:    number;
  points:      BandGreekPoint[];
  rollCount:   number;
  /** Fraction of bars where at least one leg on either side had a greek. */
  coverage:    number | null;
  /** Walk state at the last bar — see BandResumeState. */
  resume:      BandResumeState;
  timings?:    Record<string, number>;
}

export interface BandGreeksError { status: false; message: string }

type ProgressCb = (stage: string, pct: number, message: string) => void;

// ─── Leg bookkeeping ──────────────────────────────────────────────────────────

interface Leg {
  key:    InstrumentKey;
  name:   string;          // keyOf(key) — the series map key
  strike: number;
  side:   'CE' | 'PE';
}

/**
 * One side's running state: which legs are currently in the band, and what each
 * was worth when it joined.
 *
 * Keyed by leg name rather than by strike so a re-entry after an absence is
 * unambiguous, and `delete` on exit is what implements "forget the baseline" —
 * see the header note on re-baselining.
 */
interface SideState {
  entryVega:  Map<string, number>;
  entryTheta: Map<string, number>;
}

interface SideAggregate {
  vega:  number | null;
  theta: number | null;
  vegaTotal:  number | null;
  thetaTotal: number | null;
  count: number;
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
 * Aggregate one side over the legs currently inside the delta band.
 *
 * Both greeks are summed in ONE pass keyed on the same membership test, so
 * vega and theta always describe the identical basket. Summing them separately
 * would let a leg with vega but no theta shift the two series against each
 * other, and the difference would read as a genuine divergence.
 */
function aggregateSide(
  legs: Leg[],
  ts: number,
  state: SideState,
  seriesByKey: Map<string, import('../feeds/types.js').OptionSeries>,
  cursors: Map<string, QuoteCursor>,
  dMin: number,
  dMax: number,
  used: Set<string>,
): SideAggregate {
  let vega = 0, theta = 0, vegaTotal = 0, thetaTotal = 0;
  let anyVega = false, anyTheta = false, count = 0;

  for (const leg of legs) {
    const q = advanceQuote(leg.name, seriesByKey, cursors, ts);
    const d = normalizeDelta(q.delta);

    // No delta means no way to know whether this leg belongs. Treated as "not
    // in the band" rather than assumed in: a leg silently counted on a guess
    // would move the sum by its whole vega.
    const inBand = d != null && Math.abs(d) >= dMin && Math.abs(d) <= dMax;
    if (!inBand) {
      state.entryVega.delete(leg.name);
      state.entryTheta.delete(leg.name);
      continue;
    }

    count++;
    used.add(leg.name);

    if (q.vega != null) {
      if (!state.entryVega.has(leg.name)) state.entryVega.set(leg.name, q.vega);
      vega += q.vega - state.entryVega.get(leg.name)!;
      vegaTotal += q.vega;
      anyVega = true;
    }
    if (q.theta != null) {
      if (!state.entryTheta.has(leg.name)) state.entryTheta.set(leg.name, q.theta);
      theta += q.theta - state.entryTheta.get(leg.name)!;
      thetaTotal += q.theta;
      anyTheta = true;
    }
  }

  return {
    vega:  anyVega  ? vega  : null,
    theta: anyTheta ? theta : null,
    vegaTotal:  anyVega  ? vegaTotal  : null,
    thetaTotal: anyTheta ? thetaTotal : null,
    count,
  };
}

// ─── Engine ───────────────────────────────────────────────────────────────────

export async function computeBandGreeks(
  opts: {
    symbol:    string;
    exchange?: string;
    expiry?:   string;
    date?:     string;
    deltaMin?: number;
    deltaMax?: number;
    feed:      MarketDataFeed;
    intervals?: readonly string[];
    /**
     * Window override in epoch ms, clamped to the session. Used with `resume` by
     * the incremental refresh to walk only the bars a cached session is missing.
     */
    from?:     number;
    to?:       number;
    /** Walk state to continue from — see BandResumeState. */
    resume?:   BandResumeState;
  },
  onProgress?: ProgressCb,
): Promise<BandGreeksResult | BandGreeksError> {
  const prog     = onProgress ?? (() => {});
  const symbol   = opts.symbol.trim().toUpperCase();
  const exchange = (opts.exchange || 'NSE').toUpperCase();
  const date     = opts.date || latestTradingDate();
  const session   = sessionRange(date, exchange);
  const start     = opts.from != null ? Math.max(session.start, opts.from) : session.start;
  const end       = opts.to   != null ? Math.min(session.end,   opts.to)   : session.end;
  if (start >= end) {
    return { status: false, message: 'Requested window is outside the trading session' };
  }
  const feed      = opts.feed;
  const intervals = opts.intervals?.length ? opts.intervals : BAND_INTERVALS;

  // Ordered, so a caller passing them the wrong way round still gets a band
  // rather than an empty basket.
  const rawMin = opts.deltaMin ?? DEFAULT_DELTA_MIN;
  const rawMax = opts.deltaMax ?? DEFAULT_DELTA_MAX;
  const dMin   = Math.min(rawMin, rawMax);
  const dMax   = Math.max(rawMin, rawMax);

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

  // How far the ATM travels over the session, from spot. Only a bracket for
  // deciding what to FETCH — the per-bar anchor is the synthetic future, which
  // is not known until the quotes are in hand.
  let minAtm = Infinity, maxAtm = -Infinity;
  for (const pt of spotPoints) {
    const atm = nearestStrike(pt.spot, strikes, step);
    if (atm < minAtm) minAtm = atm;
    if (atm > maxAtm) maxAtm = atm;
  }
  if (!Number.isFinite(minAtm)) return { status: false, message: 'Could not locate an ATM strike' };

  // Widen by the candidate band so the ±2 selection never reaches a strike
  // whose series was not fetched.
  minAtm -= BAND * step;
  maxAtm += BAND * step;

  const wing = dMin <= 0.05 ? WING_WIDE : WING_NARROW;
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

  if (!legs.length) return { status: false, message: 'No CE/PE contracts in the delta-band window' };

  // ── 4. Fetch greeks ──────────────────────────────────────────────────────
  prog('options', 35, `Fetching ${legs.length} option series…`);
  const tSeries = Date.now();
  const fetchSeries = (interval: string) => feed.optionSeries({
    keys: legs.map((l) => l.key), interval, from: start, to: end,
    // delta decides band membership, so it is not optional here.
    greeks: ['delta', 'vega', 'theta'],
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
  prog('series', 60, `Got ${seriesByKey.size} series — aggregating band…`);

  // ── 5. Walk ──────────────────────────────────────────────────────────────
  const tWalk = Date.now();
  const ceLegs = legs.filter((l) => l.side === 'CE');
  const peLegs = legs.filter((l) => l.side === 'PE');

  // Quote cursors are shared across the selection pass and the band pass: both
  // walk forward through the same series at the same timestamps, and one cursor
  // per contract is what keeps the whole session linear rather than quadratic.
  const cursors = new Map<string, QuoteCursor>();
  // Continuing a cached session picks these up mid-flight; a cold run starts
  // empty. Everything else about the walk is identical either way.
  const resume = opts.resume;
  const callState: SideState = {
    entryVega:  new Map(resume?.callEntryVega  ?? []),
    entryTheta: new Map(resume?.callEntryTheta ?? []),
  };
  const putState:  SideState = {
    entryVega:  new Map(resume?.putEntryVega  ?? []),
    entryTheta: new Map(resume?.putEntryTheta ?? []),
  };
  const used = new Set<string>(resume?.used ?? []);

  const points: BandGreekPoint[] = [];
  let prevStrike: number | null = resume?.prevStrike ?? null;
  let rollCount = 0;
  let covered = 0;

  // Seeded from spot; every later bar anchors on the previous bar's forward. A
  // resumed run seeds from the session's own last forward instead, which is
  // closer than raw spot even after the lead-in rewind — and it is replaced by
  // this window's first priced bar regardless.
  let anchor = resume?.anchor ?? spotPoints[0].spot;
  const spotLen = spotPoints.length;

  for (let si = 0; si < spotLen; si++) {
    if (si > 0 && si % Math.max(1, Math.floor(spotLen / 4)) === 0) {
      prog('compute', 60 + Math.floor((si / spotLen) * 30), `Bar ${si}/${spotLen}…`);
    }
    const pt = spotPoints[si];

    // ── The rolling ATM: cheapest straddle among ATM±2 around the forward ──
    const atmSeed = nearestStrike(anchor, strikes, step);
    let best: { strike: number; mid: number; synFuture: number } | null = null;

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
      if (!best || mid < best.mid) {
        best = { strike, mid, synFuture: strike + callLtp - putLtp };
      }
    }

    if (!best) continue;      // nothing two-sided in the band yet

    // Next bar anchors here — this is what makes the ATM track the forward
    // rather than spot, without needing a strike before F can be computed.
    anchor = best.synFuture;

    const isRollEvent = prevStrike !== null && prevStrike !== best.strike;
    if (isRollEvent) rollCount++;
    prevStrike = best.strike;

    // ── The delta band, both sides ────────────────────────────────────────
    const ce = aggregateSide(ceLegs, pt.ts, callState, seriesByKey, cursors, dMin, dMax, used);
    const pe = aggregateSide(peLegs, pt.ts, putState,  seriesByKey, cursors, dMin, dMax, used);

    if (ce.vega != null || pe.vega != null || ce.theta != null || pe.theta != null) covered++;

    points.push({
      time:      pt.ts,
      spot:      pt.spot,
      synFuture: best.synFuture,
      atmStrike: best.strike,
      isRollEvent,

      callVega:  ce.vega,
      putVega:   pe.vega,
      callTheta: ce.theta,
      putTheta:  pe.theta,

      callVegaTotal:  ce.vegaTotal,
      putVegaTotal:   pe.vegaTotal,
      callThetaTotal: ce.thetaTotal,
      putThetaTotal:  pe.thetaTotal,

      callCount: ce.count,
      putCount:  pe.count,
    });
  }

  if (!points.length) return { status: false, message: 'No bars had a two-sided ATM straddle' };

  mark('walk', tWalk);
  timings.total = Date.now() - t0;
  log.info(
    `${exchange} ${symbol} ${expiry} ${date} @${resolvedInterval} — `
    + `${points.length} pts, Δ ${dMin}-${dMax}, ${used.size}/${legs.length} legs used, `
    + `${rollCount} rolls, coverage ${Math.round((covered / points.length) * 100)}% | `
    + Object.entries(timings).map(([k, v]) => `${k} ${v}ms`).join(' · '),
  );

  return {
    status: true,
    symbol, exchange, expiry, date,
    interval: resolvedInterval,
    step,
    deltaMin: dMin,
    deltaMax: dMax,
    legsFetched: legs.length,
    legsUsed:    used.size,
    points,
    rollCount,
    coverage: points.length ? covered / points.length : null,
    resume: {
      callEntryVega:  [...callState.entryVega],
      callEntryTheta: [...callState.entryTheta],
      putEntryVega:   [...putState.entryVega],
      putEntryTheta:  [...putState.entryTheta],
      prevStrike,
      anchor,
      used: [...used],
    },
    timings,
  };
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
