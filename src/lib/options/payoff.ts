/**
 * Strategy payoff, greeks and risk — computed from a set of legs.
 *
 * ── What this is for ──
 *
 * The position book knows WHAT you hold. This turns that into what it is worth
 * across a range of underlying prices: the expiry payoff, the value today, the
 * breakevens, the maximum profit and loss, and the aggregate greeks.
 *
 * ── Design notes, and where they came from ──
 *
 * `marketcalls/openalgo` ships a payoff builder plus a 26-item audit of its own
 * payoff graph (`audit/STRATEGY_BUILDER_PAYOFF_FINAL_AUDIT.md`). Several of its
 * P1 findings are traps any implementation walks into, and the ones that shaped
 * this file are called out at the point they apply:
 *
 *   PG-01  a fixed ±10% sample window corrupts breakevens and PoP
 *   PG-04  multi-expiry priced as if it were a single terminal event
 *   PG-25  uniform sampling misses exact strikes and rounds off the kinks
 *   PG-07  exact-grid breakevens emitted twice
 *
 * ── Units ──
 *
 *   prices     rupees per share (not per lot)
 *   quantity   SIGNED units — negative is short. Lots are resolved before here.
 *   iv         decimal (0.13 = 13%), matching black76.ts
 *   greeks     per the black76.ts contract: vega per 1.00 of vol, theta per year
 */

// Extensionless, unlike the backend original this was copied from: the app
// bundles with `moduleResolution: bundler`, which does not resolve the `.js`
// specifier that NodeNext requires. Adding the extension back breaks the build.
// See the note at the top of black76.ts about which copy is authoritative.
import {
  black76Price, black76Greeks, impliedVol, yearsToExpiry,
  type OptionSide, type Greeks,
} from './black76';

// ── Legs ─────────────────────────────────────────────────────────────────────

export type LegKind = 'OPT' | 'FUT';

export interface Leg {
  id: string;
  kind: LegKind;
  /** Signed units. Negative is short. */
  quantity: number;
  /** Price paid/received per share. */
  entryPrice: number;
  /** `YYYY-MM-DD`. */
  expiry: string;
  /** OPT only. */
  strike?: number;
  side?: OptionSide;
  /**
   * Implied vol as a decimal, when known.
   *
   * Null is a real state, not a zero: an option whose IV could not be solved
   * cannot be valued before expiry at all. Curves that need it say so rather
   * than substituting a plausible number — see `PayoffResult.ivComplete`.
   */
  iv: number | null;
  /** For display only. */
  label: string;
}

// ── Valuation ────────────────────────────────────────────────────────────────

export interface Scenario {
  /** Underlying price to value at. */
  spot: number;
  /** Additive shift applied to every leg's IV, in vol points (2 = +2%). */
  ivShiftPts: number;
  /** Calendar days advanced from now. */
  daysElapsed: number;
  /** Valuation instant, before `daysElapsed` is applied. */
  now: number;
}

/**
 * One leg's P&L at a given underlying price.
 *
 * `atExpiry` short-circuits to intrinsic value, which needs no IV at all. That
 * distinction is the reason the expiry curve is always available while the T+n
 * curve may not be: intrinsic is arithmetic, everything else is a model.
 */
export function legPnl(leg: Leg, underlying: number, scenario: Scenario, atExpiry: boolean): number {
  const qty = leg.quantity;

  if (leg.kind === 'FUT') {
    // A future has no optionality: its value is linear in the underlying at
    // every horizon, so expiry and T+n are the same line.
    return (underlying - leg.entryPrice) * qty;
  }

  if (leg.strike == null || !leg.side) return 0;

  if (atExpiry) {
    const intrinsic = leg.side === 'CE'
      ? Math.max(underlying - leg.strike, 0)
      : Math.max(leg.strike - underlying, 0);
    return (intrinsic - leg.entryPrice) * qty;
  }

  if (leg.iv == null) return NaN;

  const t = yearsToExpiry(
    scenario.now + scenario.daysElapsed * 86_400_000,
    leg.expiry.replace(/-/g, ''),
  );
  // Past its own expiry inside a multi-leg strategy: this leg has settled and
  // is worth intrinsic, while the others are still live. Collapsing the whole
  // strategy to expiry here is openalgo's PG-04.
  if (!(t > 0)) {
    const intrinsic = leg.side === 'CE'
      ? Math.max(underlying - leg.strike, 0)
      : Math.max(leg.strike - underlying, 0);
    return (intrinsic - leg.entryPrice) * qty;
  }

  const sigma = Math.max(1e-4, leg.iv + scenario.ivShiftPts / 100);
  const value = black76Price(underlying, leg.strike, t, sigma, leg.side);
  return (value - leg.entryPrice) * qty;
}

export function totalPnl(legs: Leg[], underlying: number, scenario: Scenario, atExpiry: boolean): number {
  let sum = 0;
  for (const leg of legs) {
    const v = legPnl(leg, underlying, scenario, atExpiry);
    if (!Number.isFinite(v)) return NaN;
    sum += v;
  }
  return sum;
}

// ── Sampling ─────────────────────────────────────────────────────────────────

export interface PayoffSample {
  underlying: number;
  /** P&L if held to expiry. Always available — intrinsic needs no model. */
  expiry: number;
  /** P&L at the scenario horizon. NaN when any leg's IV is unknown. */
  current: number;
}

export interface PayoffResult {
  samples: PayoffSample[];
  /** Ascending, de-duplicated. */
  breakevens: number[];
  /** May be Infinity for an uncapped strategy. */
  maxProfit: number;
  maxLoss: number;
  /** Net premium: positive = credit received, negative = debit paid. */
  netPremium: number;
  /** False when at least one option leg has no IV, so `current` is unusable. */
  ivComplete: boolean;
  range: [number, number];
}

/**
 * The price range to plot over.
 *
 * NOT a fixed ±10% of spot. That is openalgo's PG-01, and it is a correctness
 * bug rather than a cosmetic one: a strategy whose strikes or breakevens sit
 * outside the window has them silently cropped, and the max-profit, max-loss
 * and breakeven figures are then computed from a truncated curve.
 *
 * The window is instead the union of a proportional band, every strike, and a
 * volatility-scaled move, with padding so the curve never ends exactly on a
 * feature.
 */
export function priceRange(legs: Leg[], spot: number, atmIv: number, years: number): [number, number] {
  const strikes = legs.map((l) => l.strike).filter((s): s is number => s != null && s > 0);

  // Two standard deviations of the lognormal, when a vol is available.
  const sigma = atmIv > 0 && years > 0 ? atmIv * Math.sqrt(years) : 0;
  const band = sigma > 0 ? spot * 2 * sigma : spot * 0.15;

  const lo = Math.min(spot * 0.85, spot - band, ...strikes);
  const hi = Math.max(spot * 1.15, spot + band, ...strikes);

  const pad = (hi - lo) * 0.06;
  return [Math.max(0, lo - pad), hi + pad];
}

/** Ascending, de-duplicated to a tolerance. */
function uniqueSorted(values: number[], tol = 1e-6): number[] {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const out: number[] = [];
  for (const v of sorted) {
    if (!out.length || Math.abs(v - out[out.length - 1]) > tol) out.push(v);
  }
  return out;
}

/**
 * Where the expiry payoff crosses zero.
 *
 * Found by scanning the sampled curve for sign changes and interpolating. The
 * expiry payoff is piecewise-linear in the underlying, so linear interpolation
 * between two samples that straddle zero is EXACT, not an approximation —
 * provided every strike is a sample point, which `computePayoff` guarantees.
 */
function findBreakevens(samples: PayoffSample[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!Number.isFinite(a.expiry) || !Number.isFinite(b.expiry)) continue;

    if (a.expiry === 0) out.push(a.underlying);
    if (a.expiry < 0 !== b.expiry < 0 && a.expiry !== 0 && b.expiry !== 0) {
      const t = -a.expiry / (b.expiry - a.expiry);
      out.push(a.underlying + t * (b.underlying - a.underlying));
    }
  }
  const last = samples[samples.length - 1];
  if (last && last.expiry === 0) out.push(last.underlying);
  // De-duplicated: a crossing that lands exactly on a sample is otherwise
  // emitted by both the equality test and the sign test (openalgo PG-07).
  return uniqueSorted(out);
}

export interface PayoffOptions {
  /** Uniform samples across the range, before strikes are unioned in. */
  steps?: number;
  /** ATM IV for the range calculation. Decimal. */
  atmIv?: number;
  /**
   * P&L already BOOKED on legs of this strategy that are now closed.
   *
   * A squared-off leg has no exposure, so it contributes nothing to the curve's
   * shape and is rightly excluded from `legs`. Its money is real, though: close
   * two legs for −5,467 and the strategy is 5,467 worse off at every future
   * price. Dropping it made the panel's "P&L NOW" disagree with the position
   * book's total, and — worse — put the breakevens in the wrong place, since a
   * strategy carrying a booked loss must travel further to get back to zero.
   *
   * Added to every sample, so the whole curve shifts vertically and the
   * breakevens, max profit and max loss all move with it.
   */
  realised?: number;
}

/**
 * Sample the strategy across the price range.
 *
 * The sample set is the uniform grid UNIONED with every strike and breakeven.
 * Uniform-only sampling rounds the corners off a payoff — an Iron Condor's kinks
 * visibly soften and its plateau reads as a curve (openalgo PG-25). The kinks
 * are the strategy's defining feature, and they occur exactly at the strikes.
 */
export function computePayoff(
  legs: Leg[],
  scenario: Scenario,
  options: PayoffOptions = {},
): PayoffResult {
  const active = legs.filter((l) => l.quantity !== 0);
  const steps = Math.max(16, options.steps ?? 240);

  const nearestYears = Math.min(
    ...active.map((l) => yearsToExpiry(scenario.now, l.expiry.replace(/-/g, ''))).filter((t) => t > 0),
  );
  const years = Number.isFinite(nearestYears) ? nearestYears : 0;

  const [lo, hi] = priceRange(active, scenario.spot, options.atmIv ?? 0, years);
  const strikes = active.map((l) => l.strike).filter((s): s is number => s != null);

  const step = (hi - lo) / steps;
  const grid = Array.from({ length: steps + 1 }, (_, i) => lo + i * step);
  const xs = uniqueSorted([...grid, ...strikes, scenario.spot]);

  const ivComplete = active.every((l) => l.kind !== 'OPT' || l.iv != null);
  const booked = options.realised ?? 0;

  const samples: PayoffSample[] = xs.map((underlying) => ({
    underlying,
    expiry: totalPnl(active, underlying, scenario, true) + booked,
    current: ivComplete ? totalPnl(active, underlying, scenario, false) + booked : NaN,
  }));

  const breakevens = findBreakevens(samples);

  // Re-sample at the breakevens so the plotted curve passes exactly through
  // zero. Without this the fill between profit and loss regions meets the axis
  // a fraction of a step late (openalgo PG-08).
  if (breakevens.length) {
    const merged = uniqueSorted([...xs, ...breakevens]);
    if (merged.length !== xs.length) {
      samples.length = 0;
      for (const underlying of merged) {
        samples.push({
          underlying,
          expiry: totalPnl(active, underlying, scenario, true) + booked,
          current: ivComplete ? totalPnl(active, underlying, scenario, false) + booked : NaN,
        });
      }
    }
  }

  const finite = samples.map((s) => s.expiry).filter(Number.isFinite);
  let maxProfit = finite.length ? Math.max(...finite) : 0;
  let maxLoss = finite.length ? Math.min(...finite) : 0;

  // An unbounded strategy has to say so. The sampled maximum is just the value
  // at the window edge, and reporting it as "max profit" understates a long
  // call by whatever the window happened to be — the same class of error as
  // PG-01, one step downstream.
  const slope = netSlope(active);
  if (slope.up > 0) maxProfit = Infinity;
  if (slope.down > 0) maxLoss = -Infinity;

  return {
    samples,
    breakevens,
    maxProfit,
    maxLoss,
    netPremium: netPremium(active),
    ivComplete,
    range: [lo, hi],
  };
}

/**
 * Net exposure far above and far below every strike.
 *
 * Beyond the outermost strike a payoff is linear, and its slope is the signed
 * quantity of everything still in the money. A non-zero slope means the payoff
 * keeps going in that direction forever.
 */
function netSlope(legs: Leg[]): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const leg of legs) {
    if (leg.kind === 'FUT') { up += leg.quantity; down -= leg.quantity; continue; }
    if (!leg.side) continue;
    // Far above every strike: calls are worth (S − K), puts are worthless.
    if (leg.side === 'CE') up += leg.quantity;
    // Far below: puts gain as S falls.
    else down -= leg.quantity;
  }
  return { up, down };
}

/** Positive = net credit received; negative = net debit paid. */
export function netPremium(legs: Leg[]): number {
  return legs.reduce((sum, l) => sum - l.entryPrice * l.quantity, 0);
}

// ── Greeks ───────────────────────────────────────────────────────────────────

export interface PositionGreeks extends Greeks {
  /** True when every option leg contributed. */
  complete: boolean;
  /** Legs that could not be valued, by label. */
  missing: string[];
}

/**
 * Aggregate greeks, scaled by signed quantity.
 *
 * Additive because they are all first- or second-order derivatives of value
 * with respect to the same variables — a portfolio's delta is the sum of its
 * legs' deltas, weighted by size and sign.
 *
 * Futures contribute delta 1 per unit and nothing else.
 */
export function positionGreeks(legs: Leg[], scenario: Scenario): PositionGreeks {
  const total: Greeks = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  const missing: string[] = [];

  for (const leg of legs) {
    if (leg.quantity === 0) continue;

    if (leg.kind === 'FUT') { total.delta += leg.quantity; continue; }
    if (leg.strike == null || !leg.side) continue;

    if (leg.iv == null) { missing.push(leg.label); continue; }

    const t = yearsToExpiry(
      scenario.now + scenario.daysElapsed * 86_400_000,
      leg.expiry.replace(/-/g, ''),
    );
    if (!(t > 0)) continue;   // settled: no greeks left

    const sigma = Math.max(1e-4, leg.iv + scenario.ivShiftPts / 100);
    const g = black76Greeks(scenario.spot, leg.strike, t, sigma, leg.side);

    total.delta += g.delta * leg.quantity;
    total.gamma += g.gamma * leg.quantity;
    total.vega  += g.vega  * leg.quantity;
    total.theta += g.theta * leg.quantity;
  }

  return { ...total, complete: missing.length === 0, missing };
}

// ── Implied vol backfill ─────────────────────────────────────────────────────

/**
 * Solve each option leg's IV from its live price.
 *
 * Brokers report a position's last traded price but never its IV, so this is
 * how a position book becomes valuable enough to price forward. A leg whose IV
 * cannot be solved keeps `iv: null` — see the note on `Leg.iv` for why that is
 * carried through rather than defaulted.
 */
export function backfillIv(legs: Leg[], marks: Map<string, number>, spot: number, now: number): Leg[] {
  return legs.map((leg) => {
    if (leg.kind !== 'OPT' || leg.strike == null || !leg.side) return leg;

    const mark = marks.get(leg.id);
    if (!(mark != null && mark > 0)) return leg;

    const t = yearsToExpiry(now, leg.expiry.replace(/-/g, ''));
    if (!(t > 0)) return leg;

    const iv = impliedVol(mark, spot, leg.strike, t, leg.side);
    return Number.isFinite(iv) ? { ...leg, iv } : leg;
  });
}
