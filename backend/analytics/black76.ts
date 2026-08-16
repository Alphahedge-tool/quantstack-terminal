/**
 * Black-76 pricer, implied-vol inverter and Greeks — for filling in IV where
 * the feed does not carry it.
 *
 * Nubra publishes iv_bid / iv_ask only for roughly the last three months. Older
 * contracts still have prices, and prices are enough: a straddle quotes a call
 * and a put at the SAME strike, so put-call parity hands over the forward
 * without needing spot, a dividend estimate or a carry curve.
 *
 *   F = K + C − P
 *
 * Black-76 rather than Black-Scholes because NSE index options are European and
 * cash-settled, so it is exact rather than an approximation, and because it
 * prices off that forward — the one input this data gives us for free. Feeding
 * BSM a spot price plus a guessed dividend yield would inject error precisely
 * where it cannot be observed.
 *
 * ── Rates ────────────────────────────────────────────────────────────────────
 * r = 0, by choice, and it is not the compromise it looks like. In Black-76 the
 * rate appears ONLY in the discount factor e^(−rT); d1 and d2 do not contain
 * it, so it cannot bias the root-find. Setting it to zero also makes the
 * forward above exact — `F = K + C − P` is the r=0 case of parity, and it is
 * already what analytics/syntheticFuture.ts computes, so pricer and forward
 * finally agree instead of being off by e^(rT).
 *
 * The cost is a known, bounded offset against a feed that discounts: the whole
 * premium scales by e^(−rT), so IV moves by about that much. At a week to
 * expiry that is ~0.1% relative — invisible. At a quarter it is ~1.7%, or
 * roughly 0.2 vol points. Calibration against the overlap window is what should
 * decide whether that is worth reclaiming.
 */

// ── Normal distribution ──────────────────────────────────────────────────────

/**
 * Hart's rational approximation for the standard normal CDF.
 *
 * Near double precision out to ~7 sigma, degrading to ~9e-9 relative in the
 * continued-fraction branch beyond it — where the probability itself is below
 * 1e-15 and nothing downstream can tell. That accuracy is worth having over
 * Abramowitz-Stegun 7.1.26, whose ~7e-8 ABSOLUTE error swamps the price of a
 * deep-OTM wing outright and leaves the inverter chasing noise.
 */
export function normalCdf(x: number): number {
  const ax = Math.abs(x);
  let p: number;

  if (ax > 37) {
    p = 0;
  } else {
    const e = Math.exp(-ax * ax / 2);
    if (ax < 7.07106781186547) {
      let num = 3.52624965998911e-2 * ax + 0.700383064443688;
      num = num * ax + 6.37396220353165;
      num = num * ax + 33.912866078383;
      num = num * ax + 112.079291497871;
      num = num * ax + 221.213596169931;
      num = num * ax + 220.206867912376;

      let den = 8.83883476483184e-2 * ax + 1.75566716318264;
      den = den * ax + 16.064177579207;
      den = den * ax + 86.7807322029461;
      den = den * ax + 296.564248779674;
      den = den * ax + 637.333633378831;
      den = den * ax + 793.826512519948;
      den = den * ax + 440.413735824752;

      p = e * num / den;
    } else {
      // Continued fraction — the polynomial above loses accuracy past ~7 sigma.
      let cf = ax + 0.65;
      cf = ax + 4 / cf;
      cf = ax + 3 / cf;
      cf = ax + 2 / cf;
      cf = ax + 1 / cf;
      p = e / cf / 2.506628274631;
    }
  }

  return x > 0 ? 1 - p : p;
}

const INV_SQRT_2PI = 0.3989422804014327;

export function normalPdf(x: number): number {
  return INV_SQRT_2PI * Math.exp(-x * x / 2);
}

// ── Time to expiry ───────────────────────────────────────────────────────────

/** IST is UTC+5:30, so a 15:30 IST close is 10:00 UTC. */
const EXPIRY_UTC_HOUR = 10;

export interface TimeBasis {
  /** Days in a year. 365 = ACT/365, the convention theta actually accrues on. */
  daysPerYear?: number;
  /** Expiry instant, hours UTC. Defaults to the 15:30 IST close. */
  expiryHourUtc?: number;
}

/**
 * Years from a timestamp to expiry, as Black-76 wants it.
 *
 * Calendar time, not trading time, matching the reasoning already recorded in
 * straddleMetrics.daysToExpiry: theta accrues over a weekend, and a trading-day
 * count makes Friday and Monday look identical when they are not.
 *
 * Intraday precision is not optional. On expiry day a whole-day count reads T
 * as either one day or zero for the entire session, and IV computed from it is
 * wrong by a factor that grows without bound as 15:30 approaches.
 */
export function yearsToExpiry(tsMs: number, expiry: string, basis: TimeBasis = {}): number {
  const raw = String(expiry).replace(/-/g, '');
  if (raw.length !== 8) return NaN;

  const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  const hour = basis.expiryHourUtc ?? EXPIRY_UTC_HOUR;
  const expiryMs = Date.parse(`${iso}T${String(hour).padStart(2, '0')}:00:00Z`);
  if (!Number.isFinite(expiryMs)) return NaN;

  const perYear = (basis.daysPerYear ?? 365) * 86_400_000;
  return (expiryMs - tsMs) / perYear;
}

// ── Pricing ──────────────────────────────────────────────────────────────────

export type OptionSide = 'CE' | 'PE';

interface Ds { d1: number; d2: number; sqrtT: number }

function ds(F: number, K: number, T: number, sigma: number): Ds {
  const sqrtT = Math.sqrt(T);
  const v = sigma * sqrtT;
  const d1 = (Math.log(F / K) + v * v / 2) / v;
  return { d1, d2: d1 - v, sqrtT };
}

/**
 * Undiscounted Black-76 price (r = 0).
 *
 * At T <= 0 or sigma <= 0 this is intrinsic value, which is the correct limit
 * and keeps the inverter's bracket endpoints well defined.
 */
export function black76Price(
  F: number, K: number, T: number, sigma: number, side: OptionSide,
): number {
  if (!(T > 0) || !(sigma > 0) || !(F > 0) || !(K > 0)) {
    return side === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  }
  const { d1, d2 } = ds(F, K, T, sigma);
  return side === 'CE'
    ? F * normalCdf(d1) - K * normalCdf(d2)
    : K * normalCdf(-d2) - F * normalCdf(-d1);
}

/** Call + put at one strike. Monotone in sigma, which the inverter relies on. */
export function black76Straddle(F: number, K: number, T: number, sigma: number): number {
  return black76Price(F, K, T, sigma, 'CE') + black76Price(F, K, T, sigma, 'PE');
}

// ── Implied volatility ───────────────────────────────────────────────────────

const SIGMA_MIN = 1e-4;      // 0.01%
const SIGMA_MAX = 5;         // 500% — far past anything NIFTY has printed
const SIGMA_TOL = 1e-10;
const MAX_ITER  = 128;

/** NSE quotes options in 5-paise steps, so this is the finest real price signal. */
const TICK = 0.05;

/**
 * Reject an inversion when one tick of price moves vol by more than this.
 *
 * Not a numerical guard — an identifiability one. An option far enough OTM, or
 * close enough to expiry, has a straddle price that IS its intrinsic value to
 * within a rounding error, and no volatility can be recovered from it: the
 * verification run found cases with 5.7e-14 of extrinsic value and vega of
 * 2.4e-11, where the inverter happily returned a figure that was off by six vol
 * points. Requiring vega >= TICK / this makes those return NaN instead, which
 * is the honest answer. At 1 minute to expiry an ATM NIFTY straddle still
 * carries vega ~27, so nothing a trader would look at is caught by it.
 */
const MAX_VOL_UNCERTAINTY = 0.01;         // 1 vol point
const MIN_VEGA = TICK / MAX_VOL_UNCERTAINTY;

/**
 * Brenner-Subrahmanyam: the closed-form ATM straddle vol.
 *
 * Only used as the inverter's starting guess, where being within a few percent
 * saves iterations. It assumes F = K exactly, and an ATM strike snapped to a
 * 50-point grid can sit 25 points off a 350-point straddle — 7% of premium,
 * well past what should be shipped as an answer.
 */
export function approxStraddleVol(straddle: number, F: number, T: number): number {
  if (!(T > 0) || !(F > 0) || !(straddle > 0)) return NaN;
  return 1.2533141373155003 * straddle / (F * Math.sqrt(T));
}

/**
 * Invert a price to a volatility by safeguarded Newton (Numerical Recipes
 * `rtsafe`).
 *
 * Plain Newton on vega is the textbook answer and it fails exactly where this
 * data is worst: vega collapses toward zero deep OTM and on expiry afternoon,
 * so the step explodes and the iterate leaves any sensible range. Carrying a
 * bracket and bisecting whenever Newton proposes a point outside it — or is
 * converging too slowly — makes the routine unconditionally convergent while
 * still taking the quadratic step through the well-behaved middle, which is
 * where almost every real quote sits.
 *
 * Convergence is tested on the STEP, not on |price − target|. An absolute price
 * tolerance looks equivalent and is not: where vega is small, a whole range of
 * volatilities reprice to within 1e-8 of each other, so a price-converged
 * iterate can still be vol-points wrong. That was a real defect here, not a
 * hypothetical — the round-trip suite caught it at 6.2e-2 vol.
 *
 * Returns NaN when no solution exists rather than clamping to a bound — see
 * `impliedVolStraddle` for why that distinction is load-bearing.
 */
function invert(
  target: number,
  priceAt: (sigma: number) => number,
  vegaAt: (sigma: number) => number,
  guess: number,
): number {
  let lo = SIGMA_MIN;
  let hi = SIGMA_MAX;

  const fLo = priceAt(lo) - target;
  const fHi = priceAt(hi) - target;
  if (fLo > 0 || fHi < 0) return NaN;
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;

  let sigma = Number.isFinite(guess) && guess > lo && guess < hi
    ? guess
    : (lo + hi) / 2;

  let dxPrev = hi - lo;
  let dx     = dxPrev;
  let f      = priceAt(sigma) - target;
  let df     = vegaAt(sigma);

  for (let i = 0; i < MAX_ITER; i++) {
    // Bisect when the Newton step would leave the bracket, or when it is not
    // at least halving the interval. A zero vega lands here too, since the
    // second test is then trivially true.
    const outside = ((sigma - hi) * df - f) * ((sigma - lo) * df - f) > 0;

    if (outside || Math.abs(2 * f) > Math.abs(dxPrev * df)) {
      dxPrev = dx;
      dx     = (hi - lo) / 2;
      const next = lo + dx;
      if (next === lo) return sigma;      // bracket collapsed to adjacent floats
      sigma = next;
    } else {
      dxPrev = dx;
      dx     = f / df;
      const prev = sigma;
      sigma -= dx;
      if (prev === sigma) return sigma;
    }

    if (Math.abs(dx) < SIGMA_TOL) return sigma;

    f  = priceAt(sigma) - target;
    df = vegaAt(sigma);
    if (f < 0) lo = sigma; else hi = sigma;
  }
  return sigma;
}

/** dPrice/dSigma. Identical for calls and puts; doubled for a straddle. */
export function black76Vega(F: number, K: number, T: number, sigma: number): number {
  if (!(T > 0) || !(sigma > 0) || !(F > 0) || !(K > 0)) return 0;
  const { d1, sqrtT } = ds(F, K, T, sigma);
  return F * normalPdf(d1) * sqrtT;
}

/** Implied vol of a single leg, as a decimal (0.13 = 13%). NaN if unsolvable. */
export function impliedVol(
  premium: number, F: number, K: number, T: number, side: OptionSide,
): number {
  if (!(premium > 0) || !(T > 0) || !(F > 0) || !(K > 0)) return NaN;

  const intrinsic = side === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
  const maximum   = side === 'CE' ? F : K;
  if (premium <= intrinsic || premium >= maximum) return NaN;

  const sigma = invert(
    premium,
    (s) => black76Price(F, K, T, s, side),
    (s) => black76Vega(F, K, T, s),
    approxStraddleVol(premium * 2, F, T),
  );
  if (!Number.isFinite(sigma)) return NaN;
  return black76Vega(F, K, T, sigma) >= MIN_VEGA ? sigma : NaN;
}

/**
 * Implied vol of the straddle as a whole — the number this terminal wants.
 *
 * Inverting the SUM rather than averaging two per-leg inversions is deliberate:
 * vega doubles, so the problem is the best-conditioned inversion available, and
 * a single illiquid leg degrades the answer instead of destroying it. At the
 * money the two approaches agree to well within a vol point anyway.
 *
 * NaN, never a clamp, in the two cases where no answer exists. Stale quotes
 * routinely print a straddle below |F − K|, which is an arbitrage and has no
 * implied vol at all. And a straddle whose extrinsic value has decayed below
 * the tick has no RECOVERABLE vol, whatever the algebra says — see MIN_VEGA.
 * Returning a plausible-looking number in either case would be indistinguishable
 * downstream from a real observation.
 */
export function impliedVolStraddle(
  straddle: number, F: number, K: number, T: number,
): number {
  if (!(straddle > 0) || !(T > 0) || !(F > 0) || !(K > 0)) return NaN;
  if (straddle <= Math.abs(F - K) || straddle >= F + K) return NaN;

  const sigma = invert(
    straddle,
    (s) => black76Straddle(F, K, T, s),
    (s) => 2 * black76Vega(F, K, T, s),
    approxStraddleVol(straddle, F, T),
  );
  if (!Number.isFinite(sigma)) return NaN;
  return 2 * black76Vega(F, K, T, sigma) >= MIN_VEGA ? sigma : NaN;
}

// ── Greeks ───────────────────────────────────────────────────────────────────

export interface Greeks {
  /** w.r.t. the forward. */
  delta: number;
  gamma: number;
  /** Per 1.00 of vol (i.e. 100 vol points). Divide by 100 for "per vol point". */
  vega:  number;
  /** Per year. Divide by 365 for per-day decay. */
  theta: number;
}

/**
 * Closed-form Greeks, free once sigma is known.
 *
 * r = 0 simplifies theta considerably: the carry and discount terms vanish and
 * only the variance term survives, which is also why call and put theta are
 * equal here — parity gives C − P = F − K, with no T in it.
 */
export function black76Greeks(
  F: number, K: number, T: number, sigma: number, side: OptionSide,
): Greeks {
  if (!(T > 0) || !(sigma > 0) || !(F > 0) || !(K > 0)) {
    return { delta: 0, gamma: 0, vega: 0, theta: 0 };
  }
  const { d1, sqrtT } = ds(F, K, T, sigma);
  const pdf = normalPdf(d1);

  return {
    delta: side === 'CE' ? normalCdf(d1) : normalCdf(d1) - 1,
    gamma: pdf / (F * sigma * sqrtT),
    vega:  F * pdf * sqrtT,
    theta: -F * pdf * sigma / (2 * sqrtT),
  };
}

/** Greeks in the units a trader reads them in, rather than the raw derivatives. */
export interface StraddleGreeks {
  /** CE + PE. Near zero at the money; the residual left by an off-ATM roll. */
  delta: number;
  gamma: number;
  /** Per VOL POINT (1% of vol), not per 1.00 of vol — feed convention. */
  vega:  number;
  /** Per CALENDAR DAY, not per year. Negative for a long straddle. */
  theta: number;
}

/** A vol expressed in points (18.4) rather than as a decimal (0.184). */
const VOL_POINT = 100;
const DAYS_PER_YEAR = 365;

/**
 * Greeks of a straddle — both legs at one strike — rescaled to feed units.
 *
 * This is the fallback for bars the feed did not publish greeks for. Nubra
 * carries them over roughly the same recent window as iv_bid/iv_ask, so any
 * backtest reaching further back has prices but no greeks, and the vega/theta
 * lines would simply stop — the identical problem `impliedVolStraddle` was
 * written to solve for IV, with the identical solution.
 *
 * The two rescalings are what make a derived greek comparable to a fed one:
 * Black-76 vega is per 1.00 of vol and theta is per year, while every broker
 * greek stream quotes vega per vol point and theta per day. Mixing the
 * conventions in one series would put a 100x step at the splice.
 *
 * Under r = 0 both legs share d1, so call and put vega, gamma and theta are
 * equal and the straddle is simply twice one leg — see black76Greeks.
 */
export function straddleGreeks(
  F: number, K: number, T: number, sigma: number,
): StraddleGreeks | null {
  if (!(T > 0) || !(sigma > 0) || !(F > 0) || !(K > 0)) return null;

  const ce = black76Greeks(F, K, T, sigma, 'CE');
  const pe = black76Greeks(F, K, T, sigma, 'PE');

  return {
    delta: ce.delta + pe.delta,
    gamma: ce.gamma + pe.gamma,
    vega:  (ce.vega + pe.vega) / VOL_POINT,
    theta: (ce.theta + pe.theta) / DAYS_PER_YEAR,
  };
}
