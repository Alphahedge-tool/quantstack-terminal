/**
 * Adaptive significance — deciding what counts as a big move.
 *
 * ── The problem with a fixed percentage ──
 *
 * "Tell me if the OI changes significantly" has no number in it, and any number
 * we invent is wrong somewhere. 5% in 10 minutes is nothing on a far weekly
 * wing that routinely swings 30%, and it is a stampede on a deep ITM strike
 * that moves 0.3% all day. A single threshold across a chain produces exactly
 * two failure modes at once: silence where it matters and spam where it does
 * not — which is how alerting systems get muted and stop being used at all.
 *
 * ── What this does instead ──
 *
 * Each contract is compared against ITS OWN recent behaviour. The monitor keeps
 * a history of window-deltas for the metric; the current delta is scored as a
 * robust z against that distribution, and the alert fires on the z, not on the
 * raw percentage. A 4% move on the quiet strike and a 40% move on the noisy one
 * can both be "significant", which is what the user meant.
 *
 * ── Why MAD and not standard deviation ──
 *
 * The distribution is contaminated by design: the previous spike is in the
 * history, and a couple of large values inflate a standard deviation enough to
 * hide the next one. Median absolute deviation has a 50% breakdown point, so
 * half the history can be outliers before the estimate moves. Scaled by 1.4826
 * it estimates the same sigma as stdev for genuinely normal data, so the
 * z-thresholds below keep their usual meaning.
 *
 * ── The floor ──
 *
 * A contract that has not moved at all has sigma ≈ 0, and any move is then
 * infinitely many sigmas. That is technically true and practically useless: 12
 * contracts of OI appearing on a dead strike is not news. So a z-score is only
 * trusted alongside an absolute floor — the move must be both statistically
 * unusual AND large enough to care about. Both gates, always.
 */

import type { MetricName, Significance } from '../types.js';

/**
 * Deltas needed before z is meaningful.
 *
 * Below this the estimator reports `normal` regardless — a watch created two
 * minutes ago has no idea what normal looks like yet, and guessing produces a
 * burst of alerts in the first minutes of every subscription.
 */
const MIN_SAMPLES = 6;

const Z_NOTABLE     = 2.0;
const Z_SIGNIFICANT = 3.0;
const Z_EXTREME     = 4.5;

/** MAD → sigma, for a normal distribution. */
const MAD_SCALE = 1.4826;

/**
 * Minimum percentage move, per metric, before anything can be significant.
 *
 * These are the "do I care at all" floors, chosen from how each quantity
 * actually behaves intraday:
 *
 *   oi      2%   — OI is slow and monotone-ish within a session; 2% over a
 *                  short window is a real position change.
 *   volume  5%   — volume only ever rises, and rises in bursts.
 *   ltp     1.5% — premiums move constantly; below this is spread noise.
 *   iv      2%   — relative to the IV level, not 2 vol points.
 *   greeks  5%   — delta/gamma/vega/theta are ratios already and jitter with
 *                  every spot tick, so the floor is deliberately high.
 *   pcr     3%
 *   spot    0.2% — an index moving 0.2% in ten minutes is a genuine move.
 */
const PCT_FLOOR: Record<MetricName, number> = {
  oi:     2,
  volume: 5,
  ltp:    1.5,
  iv:     2,
  delta:  5,
  gamma:  5,
  vega:   5,
  theta:  5,
  pcr:    3,
  spot:   0.2,
};

/**
 * Minimum absolute move, per metric.
 *
 * The percentage floor alone is not enough on small bases: 2% of an OI of 300
 * is 6 contracts. This is the second gate, and only metrics with a meaningful
 * absolute scale declare one.
 */
const ABS_FLOOR: Partial<Record<MetricName, number>> = {
  oi:     5_000,      // roughly one meaningful lot-block on an index chain
  volume: 1_000,
  ltp:    0.5,        // half a rupee of premium
  iv:     0.5,        // half a vol point
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Robust sigma of a sample, via scaled MAD.
 *
 * Falls back to the mean absolute deviation when MAD is exactly zero — which
 * happens whenever more than half the history is identical, common for OI that
 * updates in discrete jumps. Without the fallback those contracts would have
 * sigma 0 and every single change would read as infinitely significant.
 */
function robustSigma(xs: number[]): number {
  if (xs.length < 2) return 0;
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  if (mad > 0) return mad * MAD_SCALE;

  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const avgDev = xs.reduce((a, b) => a + Math.abs(b - mean), 0) / xs.length;
  return avgDev;
}

export interface SignificanceInput {
  metric:   MetricName;
  /** Change over the watch's window, absolute units. */
  abs:      number;
  /** The same change as a percentage of the window's starting value. */
  pct:      number;
  /** Past window-deltas for this contract+metric. See series.deltaHistory. */
  history:  number[];
}

/**
 * Score a move against the contract's own recent behaviour.
 *
 * Returns `normal` — meaning "do not fire" — whenever any gate fails: too few
 * samples, below the percentage floor, below the absolute floor, or inside the
 * usual spread of moves. Only a move that clears all four is escalated.
 */
export function scoreSignificance(input: SignificanceInput): Significance {
  const { metric, abs, pct, history } = input;

  const samples = history.length;
  const magnitude = Math.abs(abs);

  const pctFloor = PCT_FLOOR[metric] ?? 2;
  const absFloor = ABS_FLOOR[metric] ?? 0;

  const belowFloor = Math.abs(pct) < pctFloor || magnitude < absFloor;

  if (samples < MIN_SAMPLES || belowFloor) {
    return { z: 0, level: 'normal', samples };
  }

  const sigma = robustSigma(history);
  if (sigma <= 0) {
    // No spread to compare against, but the floors above already passed — so
    // the move is large in absolute terms on a contract that has been static.
    // That is worth exactly one level, never more: without a distribution there
    // is no evidence for "extreme".
    return { z: Z_NOTABLE, level: 'notable', samples };
  }

  const med = median(history);
  const z = Math.abs(abs - med) / sigma;

  const level: Significance['level'] =
      z >= Z_EXTREME     ? 'extreme'
    : z >= Z_SIGNIFICANT ? 'significant'
    : z >= Z_NOTABLE     ? 'notable'
    :                      'normal';

  return { z, level, samples };
}

/** Language for each level, so the alert text escalates with the score. */
export const LEVEL_PHRASE: Record<Significance['level'], string> = {
  normal:      'moved',
  notable:     'moved notably',
  significant: 'moved significantly',
  extreme:     'moved sharply',
};

/** Does this level warrant firing an `auto`-mode watch? */
export function shouldFire(level: Significance['level']): boolean {
  return level !== 'normal';
}
