/**
 * Per-day straddle metrics — collapse one session's StraddlePoint[] into a
 * single "day fingerprint" row.
 *
 * A full session is ~23k points. A 250-day backtest is ~5.8M points, which
 * neither fits comfortably in RAM nor tells you anything on its own. The
 * analysis that matters is cross-day, so every day is reduced HERE to a few
 * dozen numbers and the tick array is discarded by the caller.
 *
 * What the numbers mean:
 *
 *   impliedMovePct    Straddle mid at the open ÷ synthetic future. This is the
 *                     move the market sold you for the day.
 *   realizedRangePct  (high − low) of the synthetic future ÷ open. What the
 *                     market actually delivered.
 *   irrRange          implied ÷ realized. > 1 means the option seller won the
 *                     day. This single ratio is the verdict on the session.
 *   decayPath         Straddle mid normalised to its 9:15 value, sampled at
 *                     fixed IST clock times so days are directly comparable
 *                     regardless of bar count or interval.
 *   directionalEff.   |net strike drift| ÷ gross drift over all rolls. Near 1
 *                     is a trend day (every roll the same way); near 0 is a
 *                     pin day (rolls cancelling out). Roll COUNT alone does
 *                     not separate these — a chop day rolls constantly and is
 *                     harmless.
 *
 * All P&L is per 1 unit of the underlying (index points), NOT per lot. Lot
 * sizing is a presentation concern and varies by symbol and by year.
 */

import type { StraddlePoint } from './syntheticFuture.js';
import type { RollingStraddleResult } from '../engine/rollingStraddle.js';

// ─── IST helpers ──────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Minutes since IST midnight for an epoch-ms timestamp. */
export function istMinute(ms: number): number {
  const d = new Date(ms + IST_OFFSET_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function istHHMM(ms: number): string {
  const m = istMinute(ms);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Day of week in IST. 0 = Sunday … 6 = Saturday. */
export function istWeekday(dateISO: string): number {
  const [y, m, d] = dateISO.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function hhmmToMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * Calendar days from trade date to expiry. 0 = expiry day.
 *
 * Calendar, not trading, days on purpose: theta accrues over the weekend too,
 * and a trading-day count would make Friday and Monday look identical when
 * their decay profiles are not.
 */
/** `20260811` or `2026-08-11` → `2026-08-11`. */
export function expiryToISO(expiry: string): string {
  const raw = expiry.replace(/-/g, '');
  return raw.length === 8
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : expiry;
}

export type ExpiryKind = 'WEEK' | 'MONTH';

/**
 * Weekly or monthly expiry?
 *
 * Derived from the day's own expiry list — the monthly contract is simply the
 * last one expiring in its calendar month. The reference implementation guesses
 * this from the exchange (`MCX ? 'MONTH' : 'WEEK'`), which mislabels every NSE
 * monthly as a weekly and every MCX weekly as a monthly. The distinction earns
 * its keep: monthlies carry far more open interest and their straddles behave
 * differently from the weekly in the same week.
 *
 * Falls back to WEEK when the list gives nothing to compare against — an
 * unknown is better labelled as the common case than as the rare one.
 */
export function classifyExpiry(expiry: string, allExpiries: string[]): ExpiryKind {
  const norm   = (e: string) => e.replace(/-/g, '');
  const target = norm(expiry);
  const month  = target.slice(0, 6);

  const sameMonth = allExpiries
    .map(norm)
    .filter((e) => e.length === 8 && e.slice(0, 6) === month)
    .sort();

  if (!sameMonth.length) return 'WEEK';
  return sameMonth[sameMonth.length - 1] === target ? 'MONTH' : 'WEEK';
}

export function daysToExpiry(dateISO: string, expiry: string): number {
  const exp = expiry.length === 8
    ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`
    : expiry;
  const a = Date.parse(`${dateISO}T00:00:00Z`);
  const b = Date.parse(`${exp}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return -1;
  return Math.round((b - a) / 86_400_000);
}

// ─── Decay path anchors ───────────────────────────────────────────────────────
//
// Clock times, not bar indices. Two sessions can have wildly different bar
// counts (1s vs 1m, holidays, thin commodities) and comparing bar 300 of one
// day to bar 300 of another is meaningless. Comparing 11:00 to 11:00 is not.

export const DECAY_ANCHORS = [
  '09:20', '09:45', '10:15', '11:00', '12:00',
  '13:00', '14:00', '14:45', '15:15', '15:25',
] as const;

export interface DecaySample {
  hhmm: string;
  /** Straddle mid at this time, as % of the day's opening straddle. */
  pct:  number | null;
  /** Straddle mid in points. */
  abs:  number | null;
}

// ─── Result type ──────────────────────────────────────────────────────────────

export interface DayMetrics {
  // Identity
  date:      string;
  symbol:    string;
  exchange:  string;
  expiry:     string;          // YYYYMMDD, as the engine addresses it
  expiryISO:  string;          // YYYY-MM-DD, for display
  expiryKind: ExpiryKind;      // weekly or the month's final contract
  dte:       number;
  weekday:   number;
  weekdayName: string;
  interval:  string;
  bars:      number;

  // Straddle levels (points)
  openStraddle:   number;
  closeStraddle:  number;
  minStraddle:    number;
  maxStraddle:    number;

  // Underlying levels (synthetic future, points)
  openSynFuture:  number;
  closeSynFuture: number;
  highSynFuture:  number;
  lowSynFuture:   number;
  openStrike:     number;
  closeStrike:    number;

  // Normalised — the comparable numbers
  impliedMovePct:     number;   // opening straddle ÷ opening synthetic future
  realizedRangePct:   number;   // (high − low) ÷ opening synthetic future
  realizedNetMovePct: number;   // |close − open| ÷ opening synthetic future
  irrRange:           number | null;   // implied ÷ realized range
  irrNet:             number | null;   // implied ÷ realized net move
  decayPct:           number;   // (open − close) ÷ open, as %

  decayPath: DecaySample[];

  // Rolls — measured on the true (spot-implied) ATM, with hysteresis
  rollCount:              number;   // confirmed ATM migrations
  netDriftStrikes:        number;   // signed, in strike steps
  grossDriftStrikes:      number;   // absolute, in strike steps
  directionalEfficiency:  number | null;   // |net| ÷ gross
  maxRunSameDirection:    number;
  rollCostPoints:         number;   // Σ straddle repricing across migrations
  /** Engine diagnostic: how often cheapest-of-band flipped the chosen strike. */
  selectionFlips:         number;

  // Volatility
  ivOpen:  number | null;
  ivClose: number | null;
  ivMin:   number | null;
  ivMax:   number | null;

  // Greeks of the rolling straddle, per 1 unit of underlying
  vegaOpen:   number | null;
  vegaClose:  number | null;
  vegaMin:    number | null;
  vegaMax:    number | null;
  thetaOpen:  number | null;
  thetaClose: number | null;
  /**
   * Mean theta across the session, in points per calendar day. The decay the
   * position was being paid, averaged over the day it was actually held —
   * which is not thetaOpen, because rolling resets it every time the ATM moves.
   */
  thetaMean:  number | null;
  /**
   * Realised decay ÷ theta promised at the open.
   *
   * 1.0 means the straddle bled exactly what its theta advertised. Below 1 the
   * seller was underpaid for the day (vol firmed, or the roll kept re-buying
   * premium); above 1 the position decayed faster than the model priced, which
   * on a quiet day is the short straddle's whole edge. This is the theta-side
   * counterpart to irrRange, and it is the number that says whether a decay
   * day was actually a good one rather than merely a green one.
   */
  thetaCapture: number | null;
  /** Fraction of bars carrying greeks, and how much of that was modelled. */
  greekCoverage:         number | null;
  greekModelledFraction: number | null;

  // Microstructure — the reason mid-based backtests overstate edge
  spreadPctMean: number | null;
  spreadPctMax:  number | null;

  // Short-straddle outcome, per 1 unit of underlying
  shortPnlPoints: number;   // open − close  (positive = seller won)
  shortMaePoints: number;   // max adverse excursion
  shortMfePoints: number;   // max favourable excursion

  /** Fraction of bars where the chosen strike was not the raw ATM strike. */
  offAtmFraction: number | null;
}

// ─── Small stats helpers ──────────────────────────────────────────────────────

function safeDiv(a: number, b: number): number | null {
  return Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

// ─── Decay path extraction ────────────────────────────────────────────────────

/**
 * Sample the straddle curve at each clock anchor using the LAST bar at or
 * before that time (carry-forward), matching how the engine's quote cursor
 * behaves. An anchor before the first bar yields null rather than a bogus
 * forward-filled value.
 */
function buildDecayPath(points: StraddlePoint[], openStraddle: number): DecaySample[] {
  const out: DecaySample[] = [];
  let idx = 0;
  let last: StraddlePoint | null = null;

  for (const hhmm of DECAY_ANCHORS) {
    const target = hhmmToMin(hhmm);
    while (idx < points.length && istMinute(points[idx].time) <= target) {
      last = points[idx];
      idx++;
    }
    out.push({
      hhmm,
      abs: last ? last.straddlePrice : null,
      pct: last && openStraddle > 0
        ? (last.straddlePrice / openStraddle) * 100
        : null,
    });
  }
  return out;
}

// ─── Roll statistics ──────────────────────────────────────────────────────────

interface RollStats {
  rollCount: number;
  netDriftStrikes: number;
  grossDriftStrikes: number;
  directionalEfficiency: number | null;
  maxRunSameDirection: number;
  rollCostPoints: number;
  selectionFlips: number;
}

/**
 * How far spot must push past the midpoint between two strikes before the ATM
 * is treated as having migrated, as a fraction of one strike step.
 *
 * Without this, a spot oscillating across a strike boundary produces a
 * "migration" every bar and the whole roll analysis measures quantisation
 * noise. 0.15 of a step on NIFTY is ~7 points — comfortably outside tick
 * chatter, well inside a real trend leg.
 */
const ATM_HYSTERESIS = 0.15;

/**
 * Roll statistics measured on the TRUE ATM strike, not the engine's chosen one.
 *
 * The engine picks the cheapest straddle within ATM±2, and two adjacent strikes
 * routinely price within a rupee of each other — so `isRollEvent` fires tens of
 * times a session as the selection flips back and forth, with net drift ~0 and
 * runs never exceeding 2. That is selection churn, not the underlying moving,
 * and building a trend/pin classifier on it measures the wrong thing entirely.
 *
 * So: migrations are counted on the ATM implied by spot, with hysteresis. The
 * raw selection-flip count is kept separately as an engine diagnostic.
 */
function computeRollStats(points: StraddlePoint[], step: number): RollStats {
  let net = 0, gross = 0, count = 0, cost = 0;
  let run = 0, maxRun = 0, prevDir = 0;
  let flips = 0;

  for (const p of points) if (p.isRollEvent) flips++;

  if (!(step > 0)) {
    return {
      rollCount: 0, netDriftStrikes: 0, grossDriftStrikes: 0,
      directionalEfficiency: null, maxRunSameDirection: 0,
      rollCostPoints: 0, selectionFlips: flips,
    };
  }

  let anchor = Math.round(points[0].spot / step) * step;
  let anchorIdx = 0;

  for (let i = 1; i < points.length; i++) {
    const distanceInSteps = (points[i].spot - anchor) / step;
    // Migration confirmed only once spot clears the half-step boundary by the
    // hysteresis margin.
    if (Math.abs(distanceInSteps) < 0.5 + ATM_HYSTERESIS) continue;

    const moved = Math.round(distanceInSteps);
    if (moved === 0) continue;

    count++;
    net   += moved;
    gross += Math.abs(moved);

    // What the migration cost in straddle terms. A "free" roll (price
    // unchanged) is pure underlying drift; an expensive one means vol was
    // re-bid as the market moved.
    cost += points[i].straddlePrice - points[anchorIdx].straddlePrice;

    const dir = Math.sign(moved);
    if (dir === prevDir) run++;
    else run = 1;
    prevDir = dir;
    if (run > maxRun) maxRun = run;

    anchor += moved * step;
    anchorIdx = i;
  }

  return {
    rollCount: count,
    netDriftStrikes: net,
    grossDriftStrikes: gross,
    directionalEfficiency: gross > 0 ? Math.abs(net) / gross : null,
    maxRunSameDirection: maxRun,
    rollCostPoints: cost,
    selectionFlips: flips,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Collapse one computed session into a comparable day row.
 *
 * Returns null when the session is too thin to characterise (no bars, or no
 * usable opening level) — the caller records it as a skip rather than letting
 * a zero-filled row pollute every aggregate.
 */
export function computeDayMetrics(
  result: RollingStraddleResult,
  /**
   * Every expiry listed for the symbol on that date. Only used to tell a
   * weekly from the month's final contract — pass it when you have it (the
   * backtester does); omitting it labels everything WEEK.
   */
  allExpiries: string[] = [],
): DayMetrics | null {
  const points = result.points;
  if (points.length < 2) return null;

  const first = points[0];
  const last  = points[points.length - 1];

  const openStraddle  = first.straddlePrice;
  const openSynFuture = first.syntheticFuture;
  if (!(openStraddle > 0) || !(openSynFuture > 0)) return null;

  // Single pass for every extremum — the arrays are large enough that
  // repeated Math.max(...map) would both allocate and risk a stack overflow
  // on spread of ~23k elements.
  let minStraddle = Infinity, maxStraddle = -Infinity;
  let highSyn = -Infinity, lowSyn = Infinity;
  let ivMin: number | null = null, ivMax: number | null = null;
  let ivOpen: number | null = null, ivClose: number | null = null;
  const spreadPcts: number[] = [];
  let offAtm = 0, offAtmEligible = 0;

  // Greeks. Accumulated rather than collected into arrays for the same reason
  // the extrema above are: a 23k-point session should not allocate one array
  // per greek just to average it.
  let vegaOpen: number | null = null, vegaClose: number | null = null;
  let vegaMin: number | null = null, vegaMax: number | null = null;
  let thetaOpen: number | null = null, thetaClose: number | null = null;
  let thetaSum = 0, thetaCount = 0;
  let greekBars = 0, modelledGreekBars = 0;

  for (const p of points) {
    if (p.straddlePrice < minStraddle) minStraddle = p.straddlePrice;
    if (p.straddlePrice > maxStraddle) maxStraddle = p.straddlePrice;
    if (p.syntheticFuture > highSyn) highSyn = p.syntheticFuture;
    if (p.syntheticFuture < lowSyn)  lowSyn  = p.syntheticFuture;

    if (p.iv != null && p.iv > 0) {
      if (ivOpen == null) ivOpen = p.iv;
      ivClose = p.iv;
      if (ivMin == null || p.iv < ivMin) ivMin = p.iv;
      if (ivMax == null || p.iv > ivMax) ivMax = p.iv;
    }

    if (p.vega != null && Number.isFinite(p.vega)) {
      if (vegaOpen == null) vegaOpen = p.vega;
      vegaClose = p.vega;
      if (vegaMin == null || p.vega < vegaMin) vegaMin = p.vega;
      if (vegaMax == null || p.vega > vegaMax) vegaMax = p.vega;
    }

    if (p.theta != null && Number.isFinite(p.theta)) {
      if (thetaOpen == null) thetaOpen = p.theta;
      thetaClose = p.theta;
      thetaSum += p.theta;
      thetaCount++;
    }

    if (p.vega != null || p.theta != null) {
      greekBars++;
      if (p.greekSource === 'black76') modelledGreekBars++;
    }

    if (p.straddleBid != null && p.straddleAsk != null && p.straddlePrice > 0) {
      spreadPcts.push(((p.straddleAsk - p.straddleBid) / p.straddlePrice) * 100);
    }

    // The engine picks the CHEAPEST straddle in ATM±band, which is not always
    // the strike nearest spot. Tracking how often they diverge keeps cross-day
    // decay comparisons honest — an off-ATM day carries residual delta.
    if (result.step > 0) {
      offAtmEligible++;
      const rawAtm = Math.round(p.spot / result.step) * result.step;
      if (Math.abs(p.atmStrike - rawAtm) > result.step / 2) offAtm++;
    }
  }

  const closeStraddle  = last.straddlePrice;
  const closeSynFuture = last.syntheticFuture;

  const impliedMovePct     = (openStraddle / openSynFuture) * 100;
  const realizedRangePct   = ((highSyn - lowSyn) / openSynFuture) * 100;
  const realizedNetMovePct = (Math.abs(closeSynFuture - openSynFuture) / openSynFuture) * 100;

  const rolls = computeRollStats(points, result.step);

  // Theta capture — realised decay against what theta advertised.
  //
  // The scaling by elapsed time is not a refinement, it is the difference
  // between a meaningful number and a meaningless one. Theta is quoted per
  // CALENDAR day; an NSE session is 6h15m, or 0.26 of one. Dividing a
  // session's decay by a full day's theta would report every ordinary day as
  // capturing ~25% and make the statistic look like a permanent shortfall.
  //
  // Mean theta rather than the opening value because rolling resets theta each
  // time the ATM migrates, and the position is held at the rolled level, not
  // the 9:15 one.
  const thetaMean = thetaCount ? thetaSum / thetaCount : null;
  const elapsedDays = (last.time - first.time) / 86_400_000;
  const expectedDecay = thetaMean != null && elapsedDays > 0
    ? -thetaMean * elapsedDays          // thetaMean < 0, so this is positive
    : null;
  const thetaCapture = expectedDecay != null && expectedDecay > 0
    ? (openStraddle - closeStraddle) / expectedDecay
    : null;

  return {
    date:        result.date,
    symbol:      result.symbol,
    exchange:    result.exchange,
    // Pinned to YYYYMMDD, which is what this field has always meant and what
    // every cached row on disk already holds. The engine now speaks canonical
    // ISO, so without this newly computed rows would store a different spelling
    // than cached ones — two formats inside one persisted dataset, which only
    // shows up much later as a comparison that silently never matches.
    expiry:      result.expiry.replace(/-/g, ''),
    expiryISO:   expiryToISO(result.expiry),
    expiryKind:  classifyExpiry(result.expiry, allExpiries),
    dte:         daysToExpiry(result.date, result.expiry),
    weekday:     istWeekday(result.date),
    weekdayName: WEEKDAY_NAMES[istWeekday(result.date)],
    interval:    result.interval,
    bars:        points.length,

    openStraddle,
    closeStraddle,
    minStraddle,
    maxStraddle,

    openSynFuture,
    closeSynFuture,
    highSynFuture: highSyn,
    lowSynFuture:  lowSyn,
    openStrike:    first.atmStrike,
    closeStrike:   last.atmStrike,

    impliedMovePct,
    realizedRangePct,
    realizedNetMovePct,
    irrRange: safeDiv(impliedMovePct, realizedRangePct),
    irrNet:   safeDiv(impliedMovePct, realizedNetMovePct),
    decayPct: ((openStraddle - closeStraddle) / openStraddle) * 100,

    decayPath: buildDecayPath(points, openStraddle),

    ...rolls,

    ivOpen, ivClose, ivMin, ivMax,

    vegaOpen, vegaClose, vegaMin, vegaMax,
    thetaOpen, thetaClose,
    thetaMean,
    thetaCapture,
    greekCoverage:         points.length ? greekBars / points.length : null,
    greekModelledFraction: greekBars ? modelledGreekBars / greekBars : null,

    spreadPctMean: mean(spreadPcts),
    spreadPctMax:  spreadPcts.length ? Math.max(...spreadPcts.slice(0, 50_000)) : null,

    shortPnlPoints: openStraddle - closeStraddle,
    shortMaePoints: maxStraddle - openStraddle,
    shortMfePoints: openStraddle - minStraddle,

    offAtmFraction: offAtmEligible > 0 ? offAtm / offAtmEligible : null,
  };
}
