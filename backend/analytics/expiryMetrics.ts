/**
 * Expiry-day metrics — the arithmetic behind the cockpit.
 *
 * Pure functions over one chain snapshot plus the session's own history. No
 * feed, no cache, no clock: everything here takes what it needs as an argument,
 * which is what makes it testable against a recorded session and reusable by
 * the backtest later.
 *
 * ── The question this file exists to answer ──
 *
 * Not "will it go up". The two-stage question:
 *
 *   1. Is the market about to move from COMPRESSION to EXPANSION?
 *   2. Once it expands, which side?
 *
 * Stage 1 is what almost everything here measures. Stage 2 is deliberately
 * thinner — direction on expiry day is a much weaker signal than regime, and a
 * dashboard that presented both with equal confidence would be lying about
 * which one it knows.
 */

import type { OptionSide } from '../assistant/types.js';

/* ── Inputs ───────────────────────────────────────────────────────────────── */

/** One contract, as `chainFeed` publishes it. */
export interface Leg {
  strike: number;
  side: OptionSide;
  ltp?: number;
  iv?: number;
  oi?: number;
  prevOi?: number;
  volume?: number;
  delta?: number;
  gamma?: number;
  vega?: number;
  theta?: number;
}

/** One strike, both sides, as the ladder wants it. */
export interface Rung {
  strike: number;
  call: Leg | null;
  put: Leg | null;
  /** Call OI + put OI. The wall is read off the pair, not off one side. */
  totalOi: number;
  callOi: number;
  putOi: number;
  callOiChange: number;
  putOiChange: number;
  callGex: number;
  putGex: number;
  netGex: number;
  /** What the OI move looks like when read with the price move. */
  callFlow: OiFlow;
  putFlow: OiFlow;
}

/**
 * The four ways OI and price can move together.
 *
 * This is the classic reading and it is an INFERENCE, not an observation — the
 * exchange publishes neither who traded nor which side opened. On an Indian
 * index expiry, where a large share of the option supply comes from retail
 * writing, "writing" is the common case and the label is still a guess. Named
 * `flow` rather than `positioning` for that reason.
 */
export type OiFlow = 'writing' | 'short-covering' | 'long-build' | 'long-unwind' | 'flat';

export function classifyFlow(priceChange: number, oiChange: number, eps = 1e-9): OiFlow {
  if (Math.abs(oiChange) <= eps || Math.abs(priceChange) <= eps) return 'flat';
  if (oiChange > 0) return priceChange > 0 ? 'long-build' : 'writing';
  return priceChange > 0 ? 'short-covering' : 'long-unwind';
}

/* ── The ladder ───────────────────────────────────────────────────────────── */

/**
 * Gamma exposure for one leg, in rupees per 1% move of the underlying.
 *
 * GEX = gamma × OI × spot² × 1%
 *
 * Gamma is per unit of the underlying per unit move, so multiplying by spot²
 * converts it to "money per percent" — the unit that makes strikes at 24,000
 * and 86,000 comparable, and the only one worth summing across a chain.
 *
 * ── There is no lot size in that formula, and there should not be ──
 *
 * The obvious version multiplies by the lot as well, and it is wrong here
 * because this feed already publishes OI in UNITS of the underlying rather than
 * in contracts. Measured on the live chain: NIFTY 24000 CE showed 8,312,330,
 * which is 127,882 lots x 65 — a plausible contract count already multiplied
 * out. Applying the lot again inflated every GEX figure by exactly 65x.
 *
 * The flip level survives that mistake, being the zero crossing of a uniformly
 * scaled profile, which is precisely why it would have gone unnoticed: only the
 * rupee totals were wrong, and nobody has an intuition for what a correct one
 * looks like.
 *
 * ── The sign, which is the part to argue about ──
 *
 * Calls positive, puts negative: the standard dealer-long convention, which
 * assumes the street is long calls and short puts against customer flow. That
 * assumption is imported from US index options and is NOT obviously right on
 * NIFTY, where a great deal of the option supply is retail writing both wings.
 *
 * It is kept anyway, for one reason: consistency beats correctness here. What
 * the cockpit actually uses is the SHAPE — where net GEX changes sign, and
 * whether spot is above or below it — and the shape is unchanged by a global
 * sign flip. The zero crossing is the same level either way. Read the label
 * ("positive gamma" / "negative gamma") as a coordinate, not as a claim about
 * who is hedging what.
 */
export function gexOf(leg: Leg | null, spot: number): number {
  if (!leg || !Number.isFinite(leg.gamma) || !Number.isFinite(leg.oi)) return 0;
  if (!(spot > 0)) return 0;
  const magnitude = (leg.gamma as number) * (leg.oi as number) * spot * spot * 0.01;
  return leg.side === 'CE' ? magnitude : -magnitude;
}

/** Build the strike ladder from a flat list of legs. */
export function buildLadder(legs: Leg[], spot: number): Rung[] {
  const byStrike = new Map<number, { call: Leg | null; put: Leg | null }>();
  for (const leg of legs) {
    const row = byStrike.get(leg.strike) ?? { call: null, put: null };
    if (leg.side === 'CE') row.call = leg;
    else row.put = leg;
    byStrike.set(leg.strike, row);
  }

  const out: Rung[] = [];
  for (const [strike, { call, put }] of byStrike) {
    const callOi = call?.oi ?? 0;
    const putOi = put?.oi ?? 0;
    // `prevOi` is the PREVIOUS SESSION's close, which is what the feed
    // publishes — so this is the day's build, not the last minute's. The
    // minute-to-minute delta comes from the recorded series instead, in
    // `oiMigration`.
    const callOiChange = callOi - (call?.prevOi ?? callOi);
    const putOiChange = putOi - (put?.prevOi ?? putOi);
    const callGex = gexOf(call, spot);
    const putGex = gexOf(put, spot);

    out.push({
      strike,
      call,
      put,
      callOi,
      putOi,
      totalOi: callOi + putOi,
      callOiChange,
      putOiChange,
      callGex,
      putGex,
      netGex: callGex + putGex,
      // Price change is not known from one snapshot; the caller fills these in
      // from the series where it has one. `flat` is the honest default.
      callFlow: 'flat',
      putFlow: 'flat',
    });
  }
  return out.sort((a, b) => a.strike - b.strike);
}

/* ── Walls and the flip ───────────────────────────────────────────────────── */

export interface Walls {
  /** Strike carrying the most call OI — the level the market is treating as a ceiling. */
  callWall: number | null;
  putWall: number | null;
  /** Highest combined OI. Where a pin, if there is one, tends to sit. */
  maxPain: number | null;
  callWallOi: number;
  putWallOi: number;
}

export function wallsOf(ladder: Rung[]): Walls {
  let callWall: number | null = null;
  let putWall: number | null = null;
  let maxPain: number | null = null;
  let bestCall = 0;
  let bestPut = 0;
  let bestTotal = 0;

  for (const rung of ladder) {
    if (rung.callOi > bestCall) { bestCall = rung.callOi; callWall = rung.strike; }
    if (rung.putOi > bestPut) { bestPut = rung.putOi; putWall = rung.strike; }
    if (rung.totalOi > bestTotal) { bestTotal = rung.totalOi; maxPain = rung.strike; }
  }
  return { callWall, putWall, maxPain, callWallOi: bestCall, putWallOi: bestPut };
}

/**
 * The level where cumulative net gamma changes sign.
 *
 * Walked from the lowest strike up, accumulating net GEX, and reported at the
 * crossing — linearly interpolated between the two strikes that straddle it,
 * because the flip is a level and not a listed strike, and rounding it to the
 * nearest 50 would put it exactly where the eye already is.
 *
 * Null when the profile never crosses: an all-positive or all-negative chain is
 * a real state, and inventing a level for it would be worse than saying there
 * is not one.
 */
export function gammaFlip(ladder: Rung[]): number | null {
  let cumulative = 0;
  let previousStrike: number | null = null;
  let previousCumulative = 0;

  for (const rung of ladder) {
    const next = cumulative + rung.netGex;
    if (previousStrike !== null && ((cumulative <= 0 && next > 0) || (cumulative >= 0 && next < 0))) {
      const span = rung.strike - previousStrike;
      const travelled = Math.abs(cumulative) / (Math.abs(cumulative) + Math.abs(next) || 1);
      return previousStrike + span * travelled;
    }
    previousCumulative = cumulative;
    cumulative = next;
    previousStrike = rung.strike;
  }
  void previousCumulative;
  return null;
}

/* ── The straddle, the vol and the move ───────────────────────────────────── */

export function nearestStrike(price: number, strikes: number[]): number | null {
  let best: number | null = null;
  let gap = Infinity;
  for (const strike of strikes) {
    const d = Math.abs(strike - price);
    if (d < gap) { gap = d; best = strike; }
  }
  return best;
}

export interface AtmView {
  strike: number | null;
  callLtp: number | null;
  putLtp: number | null;
  straddle: number | null;
  callIv: number | null;
  putIv: number | null;
  iv: number | null;
  /** Put IV − call IV, in vol points. Positive = puts bid, the usual state. */
  skew: number | null;
  /** K + CE − PE, the market's own forward. */
  syntheticFuture: number | null;
}

export function atmView(ladder: Rung[], reference: number): AtmView {
  const strike = nearestStrike(reference, ladder.map((r) => r.strike));
  const rung = ladder.find((r) => r.strike === strike);
  const empty: AtmView = {
    strike, callLtp: null, putLtp: null, straddle: null,
    callIv: null, putIv: null, iv: null, skew: null, syntheticFuture: null,
  };
  if (!rung) return empty;

  const call = rung.call?.ltp ?? null;
  const put = rung.put?.ltp ?? null;
  const callIv = rung.call?.iv ?? null;
  const putIv = rung.put?.iv ?? null;

  return {
    strike,
    callLtp: call,
    putLtp: put,
    straddle: call != null && put != null ? call + put : null,
    callIv,
    putIv,
    // The straddle's vol is the average of the two legs when both are quoted —
    // one leg alone is a wing quote wearing an ATM label.
    iv: callIv != null && putIv != null ? (callIv + putIv) / 2 : callIv ?? putIv,
    skew: callIv != null && putIv != null ? putIv - callIv : null,
    syntheticFuture: call != null && put != null && strike != null
      ? strike + call - put
      : null,
  };
}

/**
 * What the option market says the day is worth, as a percentage of spot.
 *
 * The ATM straddle IS the expected move, near enough: at the money the straddle
 * prices the mean absolute deviation to expiry, and on expiry day "to expiry"
 * is "by 15:30". Traders quote it raw for exactly that reason, and the 0.7979
 * (√(2/π)) refinement that converts it to a one-standard-deviation figure is
 * not applied here — it would make the number smaller than the one every desk
 * is actually quoting to each other.
 */
export function expectedMovePct(straddle: number | null, spot: number | null): number | null {
  if (straddle == null || spot == null || !(spot > 0)) return null;
  return (straddle / spot) * 100;
}

/**
 * Realized volatility over a window of spot observations, annualised.
 *
 * Close-to-close log returns, scaled by the number of samples in a trading
 * year at this sampling rate. Annualised so it can be read against IV without
 * a conversion in the reader's head — the whole point of showing them together
 * is "is the market paying for more movement than it is getting".
 */
export function realizedVolPct(
  spots: readonly number[],
  samplesPerYear = 252 * 375,
): number | null {
  if (spots.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < spots.length; i += 1) {
    const a = spots[i - 1];
    const b = spots[i];
    if (!(a > 0) || !(b > 0)) continue;
    returns.push(Math.log(b / a));
  }
  if (returns.length < 2) return null;

  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance * samplesPerYear) * 100;
}

/* ── Regime ───────────────────────────────────────────────────────────────── */

export type Regime =
  | 'pin'          // spot sits on the ATM, premium bleeding out
  | 'compression'  // premium and vol falling, spot quiet
  | 'expansion'    // premium and vol rising together
  | 'trend'        // spot moving persistently, ATM migrating with it
  | 'whipsaw'      // premium transferring back and forth between the sides
  | 'unknown';

/** One minute of the session, as the store records it. */
export interface ExpiryBar {
  time: number;
  spot: number | null;
  atmStrike: number | null;
  straddle: number | null;
  iv: number | null;
  skew: number | null;
  syntheticFuture: number | null;
  netGex: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  callOi: number | null;
  putOi: number | null;
  volume: number | null;
  expectedMovePct: number | null;
  realizedVolPct: number | null;
}

const pct = (now: number | null, then: number | null): number | null =>
  now != null && then != null && then !== 0 ? ((now - then) / Math.abs(then)) * 100 : null;

/** Change over the last `minutes` bars, as a percentage. */
export function changePct(bars: readonly ExpiryBar[], pick: (b: ExpiryBar) => number | null, minutes: number): number | null {
  if (bars.length < 2) return null;
  const last = bars[bars.length - 1];
  const cutoff = last.time - minutes * 60_000;
  let anchor: ExpiryBar | null = null;
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].time <= cutoff) { anchor = bars[i]; break; }
  }
  return pct(pick(last), pick(anchor ?? bars[0]));
}

/**
 * Classify the session, from the last stretch of bars.
 *
 * ── Why the thresholds are where they are ──
 *
 * Expiry-day premium decays on its own: a straddle losing 2-3% over fifteen
 * minutes at midday is doing nothing but running out of time, and calling that
 * "compression" as if it were information would light the panel up all day. So
 * compression requires decay FASTER than that AND a quiet spot, and expansion
 * requires the straddle to be rising — which on expiry day means the move is
 * outrunning theta, and theta is running at its fastest.
 *
 * The order of the tests is deliberate: expansion is checked first because it
 * is the state that costs money to miss, and a bar that qualifies as both
 * expansion and trend is an expansion.
 */
export function classifyRegime(bars: readonly ExpiryBar[]): { regime: Regime; note: string } {
  if (bars.length < 6) return { regime: 'unknown', note: 'not enough of the session yet' };

  const straddle15 = changePct(bars, (b) => b.straddle, 15);
  const iv15 = changePct(bars, (b) => b.iv, 15);
  const spot15 = changePct(bars, (b) => b.spot, 15);
  const last = bars[bars.length - 1];

  const moved = spot15 != null ? Math.abs(spot15) : 0;
  const atmMoved = bars.slice(-15).some((b) => b.atmStrike !== last.atmStrike);

  if (straddle15 != null && straddle15 > 4 && moved > 0.15) {
    return {
      regime: 'expansion',
      note: `straddle +${straddle15.toFixed(1)}% and spot ${spot15!.toFixed(2)}% over 15m — premium is outrunning theta`,
    };
  }
  if (moved > 0.35 && atmMoved) {
    return {
      regime: 'trend',
      note: `spot ${spot15!.toFixed(2)}% over 15m with the ATM migrating`,
    };
  }
  if (straddle15 != null && straddle15 < -6 && moved < 0.15) {
    return {
      regime: 'compression',
      note: `straddle ${straddle15.toFixed(1)}% over 15m on a quiet tape`,
    };
  }
  if (moved < 0.1 && last.atmStrike != null && last.spot != null
      && Math.abs(last.spot - last.atmStrike) / last.spot < 0.001) {
    return { regime: 'pin', note: 'spot sitting on the ATM strike' };
  }
  if (iv15 != null && straddle15 != null && Math.abs(straddle15) < 3 && moved > 0.2) {
    return { regime: 'whipsaw', note: 'spot moving, premium going nowhere — the sides are trading places' };
  }
  return { regime: 'unknown', note: 'no clean read' };
}

/* ── Pressure ─────────────────────────────────────────────────────────────── */

export interface PressureComponent {
  key: string;
  label: string;
  /** 0-100, already normalised. */
  score: number;
  /** The raw figure, for the tooltip — a score with no units is unauditable. */
  detail: string;
}

export interface Pressure {
  score: number;
  components: PressureComponent[];
}

/** Map a value onto 0-100 with a soft knee at `full`. */
const ramp = (value: number, full: number): number =>
  Math.max(0, Math.min(100, (value / full) * 100));

/**
 * The composite: how close is this session to changing state?
 *
 * ── Read it as a thermometer, not a signal ──
 *
 * Every component is a rate of change, normalised against what an ordinary
 * expiry-day minute looks like, and averaged with weights that are a judgement
 * rather than a fit. Until the recorder has enough sessions to normalise each
 * component against its own historical distribution — which is the whole point
 * of recording — these constants are informed guesses and the score's absolute
 * level means little. Its MOVEMENT is what to watch: 20 → 70 over ten minutes
 * is the event, not the 70.
 *
 * Minutes-to-expiry is deliberately absent as an input and present as context
 * everywhere else: a 10% IV expansion at 10:00 and at 14:45 are not the same
 * event, and folding time into the score would hide which one you are looking
 * at rather than tell you.
 */
export function pressureOf(bars: readonly ExpiryBar[]): Pressure {
  const components: PressureComponent[] = [];
  const push = (key: string, label: string, score: number, detail: string) =>
    components.push({ key, label, score: Math.round(score), detail });

  const straddle5 = changePct(bars, (b) => b.straddle, 5) ?? 0;
  const iv5 = changePct(bars, (b) => b.iv, 5) ?? 0;
  const spot5 = changePct(bars, (b) => b.spot, 5) ?? 0;
  const last = bars[bars.length - 1];

  // Premium RISING is the event. Decay is the default state of the day and
  // scores zero rather than negative — this is a measure of pressure, not of
  // direction, and a fast decay is not "negative pressure".
  push('straddle', 'Straddle expansion', ramp(Math.max(0, straddle5), 6),
    `${straddle5 >= 0 ? '+' : ''}${straddle5.toFixed(1)}% over 5m`);

  push('iv', 'IV acceleration', ramp(Math.max(0, iv5), 8),
    `${iv5 >= 0 ? '+' : ''}${iv5.toFixed(1)}% over 5m`);

  push('spot', 'Spot acceleration', ramp(Math.abs(spot5), 0.4),
    `${spot5 >= 0 ? '+' : ''}${spot5.toFixed(2)}% over 5m`);

  // Realized outrunning implied is the cleanest statement that the market is
  // paying for less movement than it is getting.
  const rv = last?.realizedVolPct ?? null;
  const iv = last?.iv ?? null;
  const gap = rv != null && iv != null && iv > 0 ? (rv - iv) / iv : null;
  push('rvIv', 'Realized vs implied', gap != null ? ramp(Math.max(0, gap), 1) : 0,
    gap != null ? `RV ${rv!.toFixed(1)} vs IV ${iv!.toFixed(1)}` : 'no vol pair');

  // Spot on the wrong side of the flip is the condition under which hedging
  // amplifies a move instead of damping it.
  const flip = last?.gammaFlip ?? null;
  const spot = last?.spot ?? null;
  const below = flip != null && spot != null && spot < flip;
  push('gamma', 'Below gamma flip', below ? 70 : 0,
    flip != null && spot != null
      ? `spot ${spot.toFixed(0)} vs flip ${flip.toFixed(0)}`
      : 'no flip level');

  // An ATM that has moved is a market that has already left where it was.
  const atmMoves = new Set(bars.slice(-15).map((b) => b.atmStrike).filter((s) => s != null)).size - 1;
  push('atm', 'ATM migration', ramp(Math.max(0, atmMoves), 3), `${Math.max(0, atmMoves)} strike(s) in 15m`);

  const weights: Record<string, number> = {
    straddle: 1.4, iv: 1.2, spot: 1, rvIv: 1, gamma: 0.8, atm: 0.9,
  };
  const total = components.reduce((s, c) => s + c.score * (weights[c.key] ?? 1), 0);
  const divisor = components.reduce((s, c) => s + (weights[c.key] ?? 1), 0) || 1;

  return { score: Math.round(total / divisor), components };
}

/* ── OI migration ─────────────────────────────────────────────────────────── */

export interface Migration {
  side: OptionSide;
  /** Where the wall was `minutes` ago, and where it is now. */
  from: number | null;
  to: number | null;
  /** Positive = the wall moved up the strike ladder. */
  steps: number;
}

/**
 * Has the wall moved, and which way?
 *
 * The single most useful thing OI says intraday: a call wall stepping up is the
 * market moving its own ceiling, which is a different claim from "24,500 has
 * the most OI" and a far more actionable one.
 */
export function oiMigration(bars: readonly ExpiryBar[], minutes = 30): Migration[] {
  if (bars.length < 2) return [];
  const last = bars[bars.length - 1];
  const cutoff = last.time - minutes * 60_000;
  let anchor = bars[0];
  for (let i = bars.length - 1; i >= 0; i -= 1) {
    if (bars[i].time <= cutoff) { anchor = bars[i]; break; }
  }

  const step = (a: number | null, b: number | null) => {
    if (a == null || b == null) return 0;
    return Math.sign(b - a);
  };

  return [
    { side: 'CE' as OptionSide, from: anchor.callWall, to: last.callWall, steps: step(anchor.callWall, last.callWall) },
    { side: 'PE' as OptionSide, from: anchor.putWall, to: last.putWall, steps: step(anchor.putWall, last.putWall) },
  ];
}

/** Minutes from a timestamp to the 15:30 IST close. */
export function minutesToExpiry(now: number, expiry: string): number | null {
  const raw = expiry.replace(/-/g, '');
  if (raw.length !== 8) return null;
  const close = Date.parse(
    `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T10:00:00Z`,
  );
  if (!Number.isFinite(close)) return null;
  return Math.round((close - now) / 60_000);
}
