/**
 * Cross-day aggregation over DayMetrics[] — the actual analysis layer.
 *
 * Everything here answers a question you cannot ask of a single session:
 *
 *   distribution   Is the variance risk premium real on this symbol, and what
 *                  does the left tail look like? Short-vol strategies have a
 *                  wonderful median and a mediocre mean — reporting averages
 *                  alone hides the whole risk, so percentiles are first-class.
 *   byDte          Decay is a function of days-to-expiry and is not linear.
 *                  Expiry day is its own regime.
 *   byWeekday      With weekly expiries the day-of-week effect is strong.
 *   byIvPercentile Rank each day's opening IV against its own trailing window.
 *                  This is the single filter that most improves the tail.
 *   rollRegime     Directional efficiency of the roll sequence separates trend
 *                  days from pin days, and the P&L follows almost mechanically.
 *   middayClassify Days whose straddle is ABOVE its open at 11:00 have a
 *                  different forward distribution. This is a live signal, not
 *                  a post-hoc description.
 *   autocorr       Regimes cluster. Day-independent backtests overstate
 *                  short-vol Sharpe badly; lag-1 autocorrelation says by how
 *                  much you should worry.
 *   equity         Cumulative short-straddle P&L in underlying points, with
 *                  max drawdown — the honest picture of the strategy.
 */

import { DECAY_ANCHORS, type DayMetrics } from './straddleMetrics.js';

// ─── Descriptive statistics ───────────────────────────────────────────────────

export interface Distribution {
  n:      number;
  mean:   number | null;
  median: number | null;
  stdev:  number | null;
  min:    number | null;
  max:    number | null;
  p5:     number | null;
  p25:    number | null;
  p75:    number | null;
  p95:    number | null;
}

const EMPTY_DIST: Distribution = {
  n: 0, mean: null, median: null, stdev: null,
  min: null, max: null, p5: null, p25: null, p75: null, p95: null,
};

/** Linear-interpolated percentile over an already-sorted array. */
function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo  = Math.floor(pos);
  const hi  = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function describe(values: Array<number | null | undefined>): Distribution {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (!xs.length) return { ...EMPTY_DIST };

  const sorted = [...xs].sort((a, b) => a - b);
  const mean   = xs.reduce((s, x) => s + x, 0) / xs.length;
  const varSum = xs.reduce((s, x) => s + (x - mean) ** 2, 0);
  // Sample stdev (n−1). With n=1 there is no dispersion to report.
  const stdev  = xs.length > 1 ? Math.sqrt(varSum / (xs.length - 1)) : null;

  return {
    n: xs.length,
    mean,
    median: percentile(sorted, 0.5),
    stdev,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p5:  percentile(sorted, 0.05),
    p25: percentile(sorted, 0.25),
    p75: percentile(sorted, 0.75),
    p95: percentile(sorted, 0.95),
  };
}

function meanOf(values: Array<number | null | undefined>): number | null {
  const xs = values.filter((v): v is number => v != null && Number.isFinite(v));
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

/** Fraction of days on which selling the straddle at the open made money. */
function winRate(days: DayMetrics[]): number | null {
  if (!days.length) return null;
  return days.filter((d) => d.shortPnlPoints > 0).length / days.length;
}

/** Pearson correlation over paired, finite observations. */
export function correlation(
  a: Array<number | null | undefined>,
  b: Array<number | null | undefined>,
): number | null {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x == null || y == null || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    xs.push(x); ys.push(y);
  }
  if (xs.length < 3) return null;

  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a1 = xs[i] - mx, b1 = ys[i] - my;
    num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}

/** Lag-1 autocorrelation — does today look like yesterday? */
function autocorr1(values: Array<number | null | undefined>): number | null {
  if (values.length < 4) return null;
  return correlation(values.slice(0, -1), values.slice(1));
}

// ─── Bucket summaries ─────────────────────────────────────────────────────────

export interface BucketSummary {
  key:            string;
  n:              number;
  meanIrrRange:   number | null;
  medianIrrRange: number | null;
  meanDecayPct:   number | null;
  meanImpliedPct: number | null;
  meanRealizedPct: number | null;
  winRate:        number | null;
  meanShortPnl:   number | null;
  worstShortPnl:  number | null;
  /** Mean normalised straddle level at each clock anchor. */
  decayCurve:     Array<{ hhmm: string; pct: number | null }>;
}

function summariseBucket(key: string, days: DayMetrics[]): BucketSummary {
  const irr = days.map((d) => d.irrRange);
  return {
    key,
    n: days.length,
    meanIrrRange:    meanOf(irr),
    medianIrrRange:  describe(irr).median,
    meanDecayPct:    meanOf(days.map((d) => d.decayPct)),
    meanImpliedPct:  meanOf(days.map((d) => d.impliedMovePct)),
    meanRealizedPct: meanOf(days.map((d) => d.realizedRangePct)),
    winRate:         winRate(days),
    meanShortPnl:    meanOf(days.map((d) => d.shortPnlPoints)),
    worstShortPnl:   days.length
      ? Math.min(...days.map((d) => d.shortPnlPoints))
      : null,
    decayCurve: DECAY_ANCHORS.map((hhmm, i) => ({
      hhmm,
      pct: meanOf(days.map((d) => d.decayPath[i]?.pct)),
    })),
  };
}

function groupBy(
  days: DayMetrics[],
  keyOf: (d: DayMetrics) => string | null,
): BucketSummary[] {
  const groups = new Map<string, DayMetrics[]>();
  for (const d of days) {
    const k = keyOf(d);
    if (k == null) continue;
    const list = groups.get(k);
    if (list) list.push(d);
    else groups.set(k, [d]);
  }
  return [...groups.entries()]
    .map(([k, list]) => summariseBucket(k, list))
    .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

// ─── IV percentile conditioning ───────────────────────────────────────────────

/**
 * Rank each day's opening IV against the trailing `window` days of opening IV.
 *
 * Strictly trailing — the current day is excluded from its own reference set,
 * otherwise the rank leaks information that was not available at 9:15 and the
 * resulting "signal" is unusable live. Days without a full lookback get null
 * and drop out of the conditional buckets rather than being ranked against a
 * handful of neighbours.
 */
export function attachIvPercentile(days: DayMetrics[], window = 20): Array<number | null> {
  const out: Array<number | null> = [];
  for (let i = 0; i < days.length; i++) {
    const iv = days[i].ivOpen;
    if (iv == null) { out.push(null); continue; }

    const history: number[] = [];
    for (let j = Math.max(0, i - window); j < i; j++) {
      const h = days[j].ivOpen;
      if (h != null && Number.isFinite(h)) history.push(h);
    }
    if (history.length < Math.min(10, window)) { out.push(null); continue; }

    const below = history.filter((h) => h < iv).length;
    out.push(below / history.length);
  }
  return out;
}

function ivBucketLabel(pct: number | null): string | null {
  if (pct == null) return null;
  if (pct < 0.25) return 'Q1 (lowest IV)';
  if (pct < 0.50) return 'Q2';
  if (pct < 0.75) return 'Q3';
  return 'Q4 (highest IV)';
}

// ─── Equity curve ─────────────────────────────────────────────────────────────

export interface EquityPoint {
  date:       string;
  pnl:        number;   // that day, in underlying points
  cumulative: number;
  drawdown:   number;   // from running peak, in points
}

export interface EquitySummary {
  curve:          EquityPoint[];
  totalPoints:    number;
  maxDrawdown:    number;
  maxDrawdownPct: number | null;   // vs. peak equity
  /** Mean daily P&L ÷ stdev of daily P&L, annualised over 252 sessions. */
  sharpeAnnualised: number | null;
  profitFactor:   number | null;
}

function buildEquity(days: DayMetrics[]): EquitySummary {
  const curve: EquityPoint[] = [];
  let cum = 0, peak = 0, maxDd = 0, maxDdPct: number | null = null;
  let grossWin = 0, grossLoss = 0;

  for (const d of days) {
    const pnl = d.shortPnlPoints;
    cum += pnl;
    if (pnl > 0) grossWin += pnl; else grossLoss += -pnl;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : null;
    }
    curve.push({ date: d.date, pnl, cumulative: cum, drawdown: dd });
  }

  const dist = describe(days.map((d) => d.shortPnlPoints));
  const sharpe = dist.mean != null && dist.stdev != null && dist.stdev > 0
    ? (dist.mean / dist.stdev) * Math.sqrt(252)
    : null;

  return {
    curve,
    totalPoints: cum,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    sharpeAnnualised: sharpe,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

// ─── Top-level report ─────────────────────────────────────────────────────────

export interface BacktestStats {
  n: number;
  dateRange: { from: string; to: string } | null;

  distributions: {
    irrRange:         Distribution;
    impliedMovePct:   Distribution;
    realizedRangePct: Distribution;
    decayPct:         Distribution;
    shortPnlPoints:   Distribution;
    shortMaePoints:   Distribution;
    spreadPctMean:    Distribution;
  };

  winRate: number | null;
  /** Share of days where implied exceeded realized — the premium, day-counted. */
  premiumCaptureRate: number | null;

  byDte:          BucketSummary[];
  byWeekday:      BucketSummary[];
  byIvPercentile: BucketSummary[];
  byRollRegime:   BucketSummary[];
  byExpiryKind:   BucketSummary[];

  /** Every distinct contract the run traded, oldest first. */
  expiriesUsed: Array<{
    expiry: string; expiryISO: string; kind: string; sessions: number;
  }>;

  middayClassifier: {
    /** Straddle still at/above its open at 11:00 — the trend-day tell. */
    aboveOpenAt11: BucketSummary;
    belowOpenAt11: BucketSummary;
  } | null;

  autocorrelation: {
    realizedRangePct: number | null;
    shortPnlPoints:   number | null;
    irrRange:         number | null;
  };

  correlations: {
    /** Trend days (efficiency → 1) should hurt the short straddle. */
    directionalEfficiencyVsShortPnl: number | null;
    ivPercentileVsShortPnl:          number | null;
    impliedMoveVsRealizedRange:      number | null;
  };

  equity: EquitySummary;

  /** Diagnostics that qualify every number above. */
  quality: {
    meanOffAtmFraction: number | null;
    meanSpreadPct:      number | null;
    /**
     * Mean cheapest-of-band strike flips per session. Large relative to
     * rollCount means the engine's selection is churning between near-equally
     * priced adjacent strikes — harmless for pricing, but it is why roll stats
     * are measured on the spot-implied ATM instead.
     */
    meanSelectionFlips: number | null;
    /**
     * Total spread cost of a round trip (enter + exit crossing half the spread
     * on each of two legs), as a share of the mean per-day gross P&L. Mid-based
     * results overstate edge by roughly this much.
     */
    spreadCostShareOfEdge: number | null;
    intervals: Record<string, number>;
  };
}

export function computeBacktestStats(daysIn: DayMetrics[]): BacktestStats {
  // Chronological order is load-bearing: IV percentile, autocorrelation and the
  // equity curve are all sequence-dependent, and the day runner completes days
  // out of order because it fetches them concurrently.
  const days = [...daysIn].sort((a, b) => a.date.localeCompare(b.date));

  if (!days.length) {
    return {
      n: 0,
      dateRange: null,
      distributions: {
        irrRange: EMPTY_DIST, impliedMovePct: EMPTY_DIST, realizedRangePct: EMPTY_DIST,
        decayPct: EMPTY_DIST, shortPnlPoints: EMPTY_DIST, shortMaePoints: EMPTY_DIST,
        spreadPctMean: EMPTY_DIST,
      },
      winRate: null,
      premiumCaptureRate: null,
      byDte: [], byWeekday: [], byIvPercentile: [], byRollRegime: [],
      byExpiryKind: [], expiriesUsed: [],
      middayClassifier: null,
      autocorrelation: { realizedRangePct: null, shortPnlPoints: null, irrRange: null },
      correlations: {
        directionalEfficiencyVsShortPnl: null,
        ivPercentileVsShortPnl: null,
        impliedMoveVsRealizedRange: null,
      },
      equity: buildEquity([]),
      quality: {
        meanOffAtmFraction: null, meanSpreadPct: null, meanSelectionFlips: null,
        spreadCostShareOfEdge: null, intervals: {},
      },
    };
  }

  const ivPct = attachIvPercentile(days);

  // DTE buckets: 0-4 individually, everything beyond as one tail. Past ~4 days
  // out the intraday decay profile stops differentiating.
  const byDte = groupBy(days, (d) =>
    d.dte < 0 ? null : d.dte >= 5 ? '5+' : String(d.dte),
  );

  const byWeekday = groupBy(days, (d) => `${d.weekday}-${d.weekdayName}`);

  const byIvPercentile = groupBy(
    days.map((d, i) => ({ ...d, _ivBucket: ivBucketLabel(ivPct[i]) })),
    (d) => (d as DayMetrics & { _ivBucket: string | null })._ivBucket,
  );

  // Roll regime — the trend/pin split, from the roll sequence alone.
  const byRollRegime = groupBy(days, (d) => {
    if (d.rollCount === 0) return 'A: no rolls (pinned)';
    const eff = d.directionalEfficiency;
    if (eff == null) return null;
    if (eff < 0.34) return 'B: choppy (eff < 0.34)';
    if (eff < 0.67) return 'C: mixed (0.34–0.67)';
    return 'D: trending (eff > 0.67)';
  });

  const byExpiryKind = groupBy(days, (d) =>
    d.expiryKind === 'MONTH' ? 'Monthly' : 'Weekly',
  );

  // Which contracts the run actually traded. Auto-selection is convenient but
  // opaque — without this you cannot tell whether a range rolled through the
  // expiries you expected or silently parked on one.
  const expiryCounts = new Map<string, { expiryISO: string; kind: string; sessions: number }>();
  for (const d of days) {
    const hit = expiryCounts.get(d.expiry);
    if (hit) hit.sessions++;
    else expiryCounts.set(d.expiry, { expiryISO: d.expiryISO, kind: d.expiryKind, sessions: 1 });
  }
  const expiriesUsed = [...expiryCounts.entries()]
    .map(([expiry, v]) => ({ expiry, ...v }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry));

  const idx11 = DECAY_ANCHORS.indexOf('11:00');
  const with11 = days.filter((d) => d.decayPath[idx11]?.pct != null);
  const middayClassifier = with11.length >= 4
    ? {
        aboveOpenAt11: summariseBucket(
          'straddle ≥ open at 11:00',
          with11.filter((d) => (d.decayPath[idx11].pct as number) >= 100),
        ),
        belowOpenAt11: summariseBucket(
          'straddle < open at 11:00',
          with11.filter((d) => (d.decayPath[idx11].pct as number) < 100),
        ),
      }
    : null;

  const meanSpread = meanOf(days.map((d) => d.spreadPctMean));
  const meanGross  = meanOf(days.map((d) => Math.abs(d.shortPnlPoints)));
  // Round trip = 2 legs × 2 sides × half-spread = one full spread, twice over
  // the straddle's own mid.
  const meanOpen   = meanOf(days.map((d) => d.openStraddle));
  const roundTripCost = meanSpread != null && meanOpen != null
    ? (meanSpread / 100) * meanOpen
    : null;

  const intervals: Record<string, number> = {};
  for (const d of days) intervals[d.interval] = (intervals[d.interval] || 0) + 1;

  return {
    n: days.length,
    dateRange: { from: days[0].date, to: days[days.length - 1].date },

    distributions: {
      irrRange:         describe(days.map((d) => d.irrRange)),
      impliedMovePct:   describe(days.map((d) => d.impliedMovePct)),
      realizedRangePct: describe(days.map((d) => d.realizedRangePct)),
      decayPct:         describe(days.map((d) => d.decayPct)),
      shortPnlPoints:   describe(days.map((d) => d.shortPnlPoints)),
      shortMaePoints:   describe(days.map((d) => d.shortMaePoints)),
      spreadPctMean:    describe(days.map((d) => d.spreadPctMean)),
    },

    winRate: winRate(days),
    premiumCaptureRate:
      days.filter((d) => d.irrRange != null && d.irrRange > 1).length / days.length,

    byDte, byWeekday, byIvPercentile, byRollRegime, byExpiryKind,
    expiriesUsed,
    middayClassifier,

    autocorrelation: {
      realizedRangePct: autocorr1(days.map((d) => d.realizedRangePct)),
      shortPnlPoints:   autocorr1(days.map((d) => d.shortPnlPoints)),
      irrRange:         autocorr1(days.map((d) => d.irrRange)),
    },

    correlations: {
      directionalEfficiencyVsShortPnl: correlation(
        days.map((d) => d.directionalEfficiency),
        days.map((d) => d.shortPnlPoints),
      ),
      ivPercentileVsShortPnl: correlation(ivPct, days.map((d) => d.shortPnlPoints)),
      impliedMoveVsRealizedRange: correlation(
        days.map((d) => d.impliedMovePct),
        days.map((d) => d.realizedRangePct),
      ),
    },

    equity: buildEquity(days),

    quality: {
      meanOffAtmFraction: meanOf(days.map((d) => d.offAtmFraction)),
      meanSpreadPct:      meanSpread,
      meanSelectionFlips: meanOf(days.map((d) => d.selectionFlips)),
      spreadCostShareOfEdge:
        roundTripCost != null && meanGross != null && meanGross > 0
          ? roundTripCost / meanGross
          : null,
      intervals,
    },
  };
}
