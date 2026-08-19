/**
 * The straddle session chart — up to four panes, one time axis.
 *
 * ── Why one chart and not three ──
 *
 * The SVG `LineChart` this replaced takes ONE y-axis by construction, so
 * premium, IV and the synthetic future had to be three stacked charts. Each
 * carried its own time axis, its own zoom state and its own crosshair: panning
 * to 11:40 on the premium chart left the other two showing the open.
 *
 * lightweight-charts gives what that arrangement was working around — panes
 * that SHARE a time scale and a crosshair while keeping separate price scales.
 * So the honesty argument (never overlay two units on one axis) is preserved,
 * and the cost (three disconnected viewports) is not paid:
 *
 *   Pane 0  straddle premium as candles + bid/ask + the median overlay, rupees
 *           ATM implied volatility,                        LEFT scale, percent
 *   Pane 1  synthetic future + spot,                             index points
 *   Pane 2  straddle MINUS the median — only while comparing,         rupees
 *
 * IV shares pane 0 with premium because reading them together is the entire
 * job — a premium that rose on vol and one that rose on a move in the
 * underlying are different events, and telling them apart means seeing both
 * lines cross the same minute. It keeps its own scale on the left, so the two
 * never share a number line, and the axis is tinted to the series.
 *
 * It briefly had a pane of its own. That is the more defensible arrangement on
 * paper — a series' shape should not be set by a neighbour's autoscale — and it
 * was worse to use: the two lines you most need to read together ended up in
 * two boxes with a divider between them, and every other pane got shorter to
 * pay for it.
 *
 * Spot and the synthetic future genuinely share a unit, so those two overlay.
 *
 * ── The vs-median pane ──
 *
 * The overlay in pane 0 answers "where is today against a typical session at
 * this DTE" only by eye, and by eye is not good enough when the two lines run
 * within a few rupees of each other for an hour. Pane 3 plots the DIFFERENCE
 * against a zero line, so below-the-median is a filled region rather than a
 * judgement about which of two lines is on top — and the moment it crosses is a
 * position on the time axis rather than something you have to hunt for.
 *
 * ── Why the raw series, not a decimated one ──
 *
 * The engine walks at 1-second bars, ~22k points a session. The SVG chart had
 * to min/max decimate that down to ~900 or the path string became half a
 * megabyte. Here the points are bucketed into OHLC candles at the selected
 * interval instead: the wick carries the bucket's true high and low rather than
 * a sampled approximation, and changing the interval re-aggregates from the
 * full data instead of resampling something already thrown away.
 *
 * Structure and paint come from `lib/chartBase.ts`; chrome from `ChartFrame`.
 * This file describes only what is actually the straddle chart's own: which
 * series, on which scale, in which pane.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BaselineSeries,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  createSeriesMarkers,
  type BaselineData,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';
import { ChartFrame, Field, ReadoutTime, Tick, type SeriesToggle } from '@/components/chart/ChartFrame';
import { Select } from '@/components/ui/Field';
import {
  MINUTE_INTERVALS,
  SECOND_INTERVALS,
  bucketOf,
  candleData,
  createBaseChart,
  finite,
  fitContentPadded,
  lineData,
  num,
  pointAt,
  stamp,
  stylePaneScale,
  toneFor,
  type BaseChart,
} from '@/lib/chartBase';
import { alphaOf, istClockSeconds } from '@/lib/chartTheme';
import type { StraddlePoint } from '@/schemas/market';

export interface RollEvent {
  time: number;
  fromStrike?: number | null;
  toStrike?: number | null;
}

/**
 * A comparison line drawn on the premium scale.
 *
 * Already in POINTS and already on today's timestamps — see `projectToPoints`.
 * The chart deliberately does no unit conversion of its own: anything sharing
 * the premium axis has to arrive in premium's unit, or the axis is lying.
 */
export interface CompareSeries {
  label: string;
  data: Array<{ time: number; value: number; lo: number; hi: number; n: number }>;
}

interface Props {
  points: StraddlePoint[];
  rollEvents?: RollEvent[];
  height?: number | string;
  dense?: boolean;
  className?: string;

  /** The overlay itself. Null when nothing is being compared. */
  compare?: CompareSeries | null;
  /** Compare picker, rendered in the toolbar. Omitted when there is nothing to pick. */
  compareValue?: string;
  compareOptions?: Array<{ value: string; label: string }>;
  onCompareChange?: (value: string) => void;
  /** One line under the picker — sample count and what the numbers mean. */
  compareNote?: string;
  /**
   * Whether the overlay shares the premium axis.
   *
   * `'shared'` for rebased units, `'separate'` for raw — see `compareScaleId`
   * in the mount effect for why raw cannot share without squeezing the candles.
   */
  compareScale?: 'shared' | 'separate';
}

interface Readout {
  time: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  change: number | null;
  changePct: number | null;
  bid: number | null;
  ask: number | null;
  iv: number | null;
  sf: number | null;
  spot: number | null;
  vega: number | null;
  theta: number | null;
  strike: number | null;
  /** The comparison's value at this bar, and today's distance from it. */
  compare: number | null;
  vsCompare: number | null;
  /** That distance as a share of the median, which is the comparable figure
   *  across contracts an order of magnitude apart in premium. */
  vsComparePct: number | null;
  /** The cohort's spread behind that median — see MedianPoint.lo/hi. */
  compareRange: { lo: number; hi: number; n: number } | null;
}

const TOGGLES: SeriesToggle[] = [
  { key: 'straddle', label: 'Straddle', colour: 'var(--market-up)' },
  { key: 'bid', label: 'Bid', colour: 'var(--series-bid)' },
  { key: 'ask', label: 'Ask', colour: 'var(--series-ask)' },
  { key: 'iv', label: 'IV', colour: 'var(--series-iv)' },
  { key: 'sf', label: 'Syn. fut', colour: 'var(--series-sf)' },
  { key: 'spot', label: 'Spot', colour: 'var(--series-vega)' },
];

/**
 * The overlay's toggles, appended only when a comparison is active.
 *
 * The band is separable from the median because the two answer different
 * questions and crowd each other. The median alone is the cleaner read against
 * the candles; the band is what you turn on to ask whether that median is
 * describing agreement or scatter. On a busy session the two dashed edges are
 * genuinely in the way, so they come off without taking the median with them.
 *
 * The swatches are CSS variables, not the resolved literals the canvas needs —
 * these render as DOM, where `var()` is the correct form. They must stay in
 * step with `theme.compare` / `theme.compareBand` by hand.
 */
const COMPARE_TOGGLE: SeriesToggle = {
  key: 'compare',
  label: 'Compare',
  colour: 'var(--text-primary)',
};
const COMPARE_BAND_TOGGLE: SeriesToggle = {
  key: 'compareBand',
  label: 'Hi/Lo band',
  colour: 'var(--text-secondary)',
};
const COMPARE_TOGGLES = [COMPARE_TOGGLE, COMPARE_BAND_TOGGLE];

const ALL_ON: Record<string, boolean> = Object.fromEntries(
  [...TOGGLES, ...COMPARE_TOGGLES].map((t) => [t.key, true]),
);

/**
 * Pane indices, named.
 *
 * `addSeries(..., 2)` is the kind of literal that survives one refactor and
 * then quietly puts spot in the wrong box. The vs-median pane exists only while
 * a comparison is running, which is also why it is last: an index that shifts
 * would move every series above it.
 *
 * There is no PANE_IV — implied vol lives in pane 0 on the left scale, which is
 * a SCALE and not a pane. See the header.
 */
const PANE_PREMIUM = 0;
const PANE_SF = 1;
const PANE_VS = 2;

/**
 * The interval a comparison is only meaningful at.
 *
 * The cohort is pooled minute by minute, so the overlay HAS one value per
 * minute and no more. Drawn against 1-second candles it would be a staircase
 * with 59 flat steps between changes — which does not read as "sampled per
 * minute", it reads as a market that traded once a minute. So turning a
 * comparison on moves the chart to 1m rather than offering a resolution the
 * overlay cannot honour.
 */
const COMPARE_INTERVAL = '60';

function StraddleChartImpl({
  points, rollEvents = [], height = 520, dense = false, className,
  compare = null, compareValue, compareOptions, onCompareChange, compareNote,
  compareScale = 'shared',
}: Props) {
  const [interval, setInterval] = useState('15');
  const [visible, setVisible] = useState<Record<string, boolean>>(ALL_ON);
  const [readout, setReadout] = useState<Readout | null>(null);

  /**
   * Is a comparison running — from the SELECTION, not from the data.
   *
   * `compare` is null for the ten to thirty seconds the cohort takes to walk,
   * so keying the layout on it would build the chart without the vs-median
   * pane and then rebuild it the moment the data landed, throwing away whatever
   * zoom the reader had set in the meantime. The selection is true from the
   * click, so the pane appears with the toggle and simply fills in.
   */
  const comparing = Boolean(compareValue && compareValue !== 'none');

  const hostRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<BaseChart | null>(null);
  const seriesRef = useRef<{
    straddle: ISeriesApi<'Candlestick'>;
    bid: ISeriesApi<'Line'>;
    ask: ISeriesApi<'Line'>;
    iv: ISeriesApi<'Line'>;
    sf: ISeriesApi<'Line'>;
    spot: ISeriesApi<'Line'>;
    compare: ISeriesApi<'Line'>;
    compareLo: ISeriesApi<'Line'>;
    compareHi: ISeriesApi<'Line'>;
    /** Null whenever no comparison is running — the pane does not exist. */
    vs: ISeriesApi<'Baseline'> | null;
  } | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // The crosshair handler is installed once, at mount, but has to see today's
  // points and today's bucket size. Refs rather than a re-subscribed listener:
  // resubscribing on every data change would drop the crosshair mid-drag.
  const pointsRef = useRef(points);
  const intervalRef = useRef(Number(interval));
  pointsRef.current = points;
  intervalRef.current = Number(interval);

  // Same reason as `pointsRef`: the crosshair handler is installed once and has
  // to see the current comparison without being re-subscribed mid-drag.
  const compareRef = useRef(new Map<number, { lo: number; hi: number; n: number }>());
  compareRef.current = useMemo(
    () => new Map((compare?.data ?? []).map((p) => [p.time, { lo: p.lo, hi: p.hi, n: p.n }])),
    [compare],
  );

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const base = createBaseChart(host, {
      /*
       * Premium is the subject; everything under it is context, and the stretch
       * factors say so before a single number is read. 3:1 with one context
       * pane, 4:1:1 with two — the candles keep two thirds of the chart either
       * way, which is the point of the ratio rather than the numbers in it.
       */
      panes: [
        { caption: 'Straddle premium · ATM IV', stretch: comparing ? 4 : 3 },
        { caption: 'Synthetic future · Spot', stretch: 1 },
        ...(comparing
          ? [{ caption: 'Straddle vs median · below the line is cheap', stretch: 1 }]
          : []),
      ],
      // IV owns the left scale alone, so premium and volatility never share a
      // number line even though they share a pane. The axis is tinted to the
      // series so the reader never has to work out which scale IV is on.
      leftScale: { visible: true, colour: (t) => t.iv },
    });
    const { chart, theme } = base;
    baseRef.current = base;

    /**
     * Which number line the comparison lives on.
     *
     * SHARED ('right') is the point of rebasing — the overlay is already on
     * today's level, so the gap between it and the candles is readable directly
     * and both must be measured against the same axis.
     *
     * SEPARATE is required for raw units, where the cohort traded at genuinely
     * different levels. On 2026-08-14 today's straddle spans ~160–195 while the
     * raw band spans ~167–270; sharing an axis makes the autoscale serve the
     * band and squeezes the actual session into the bottom third of the pane.
     * An overlay scale autoscales independently, so each is drawn at full
     * height. The trade is that an overlay renders no axis of its own — which is
     * honest, because in raw units the two are not on a comparable scale and a
     * second column of numbers would only invite reading a gap that means
     * nothing. The crosshair readout still gives the exact figures.
     */
    const compareScaleId = compareScale === 'separate' ? 'compare' : 'right';

    const common = { priceLineVisible: false, lastValueVisible: true } as const;

    const straddle = chart.addSeries(CandlestickSeries, {
      ...common,
      priceScaleId: 'right',
      title: 'Straddle',
      upColor: theme.up,
      downColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      borderVisible: false,
      // Stated rather than defaulted. Every other series on this chart names
      // its pane, and the one that does not is the one a later edit moves by
      // accident.
    }, PANE_PREMIUM);

    // Bid and ask are thin and dim on purpose: they bracket the mid, and a
    // three-line-thick spread band would out-shout the price it describes.
    const bid = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Bid',
      color: theme.bid, lineWidth: 1, lastValueVisible: false,
    });
    const ask = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Ask',
      color: theme.ask, lineWidth: 1, lastValueVisible: false,
    });
    // Pane 0, LEFT scale — beside the premium it is derived from, on a number
    // line of its own.
    const iv = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'left', title: 'ATM IV',
      color: theme.iv, lineWidth: 2,
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    }, PANE_PREMIUM);

    // The comparison, on the PREMIUM scale — it arrives already in points, so
    // it belongs on the same number line as the candles it is being read
    // against. `lastValueVisible` stays on: the closing gap between today and
    // the median is the single number this overlay exists to produce.
    const compareLine = chart.addSeries(LineSeries, {
      ...common, priceScaleId: compareScaleId, title: 'Compare',
      color: theme.compare, lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });

    /**
     * The cohort's per-minute LOW and HIGH — the band the median came out of.
     *
     * ── Why the band is drawn and not just tooltipped ──
     *
     * The median is one number a minute and it hides its own support. 163 out of
     * a cohort spanning 160–166 is a session type; the same 163 out of 155–182 is
     * the middle of a scatter, and today sitting "above the median" means nothing
     * at all. Drawn, the reader sees which of those they are looking at without
     * having to hover every bar.
     *
     * ── Why two lines and not a fill ──
     *
     * lightweight-charts has no band primitive; an AreaSeries fills to the axis
     * baseline, not to a second series, so it would flood the whole pane. Two
     * thin dashed lines in the median's own hue read as a band and — unlike a
     * fill — leave the candles legible where the band overlaps them, which is
     * most of the session.
     *
     * Both carry `lastValueVisible: false`. Three price tags stacked on the right
     * axis at the same level collide into an unreadable smear, and only the
     * median's closing value is worth a permanent label.
     */
    const bandCommon = {
      ...common, priceScaleId: compareScaleId,
      color: theme.compareBand, lineWidth: 1 as const,
      lineStyle: LineStyle.Dashed,
      lastValueVisible: false, crosshairMarkerVisible: false,
      priceFormat: { type: 'price' as const, precision: 2, minMove: 0.05 },
    };
    const compareLo = chart.addSeries(LineSeries, { ...bandCommon, title: 'Cohort low' });
    const compareHi = chart.addSeries(LineSeries, { ...bandCommon, title: 'Cohort high' });

    // An overlay scale defaults to the full pane height, so the band would run
    // edge to edge and collide with the pane caption. These margins match what
    // `createBaseChart` gives the premium scale, so the two read as one plot
    // rather than as a chart with something pasted over it.
    if (compareScaleId !== 'right') {
      chart.priceScale(compareScaleId).applyOptions({
        scaleMargins: { top: 0.12, bottom: 0.12 },
      });
    }

    // Pane 1. Index points — a different unit and a different order of
    // magnitude from premium, so its own viewport rather than its own axis on
    // a shared one.
    const sf = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Syn. future',
      color: theme.sf, lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    }, PANE_SF);
    const spot = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Spot',
      color: theme.spot, lineWidth: 1, lineStyle: LineStyle.Dotted,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    }, PANE_SF);

    /**
     * Pane 2 — the straddle MINUS the median, against zero.
     *
     * ── Why a baseline series and not a second line ──
     *
     * A baseline series is the one primitive in the library that paints the
     * region between the data and a fixed level, in a different colour on each
     * side of it. That is exactly the claim being made: everything below the
     * line is a session cheaper than a typical one at this DTE, everything
     * above is one carrying more premium. Drawn as a plain line, the reader is
     * back to comparing a curve against an axis tick — which is the work pane 0
     * already makes them do.
     *
     * ── The colours ──
     *
     * Down-red BELOW zero, up-green ABOVE it, matching `toneFor` and the signed
     * "vs median" figure in the readout. It is tempting to invert them — cheap
     * is the buyer's opportunity, so cheap should be green — but colour on this
     * chart already means the SIGN of a number everywhere else, and one series
     * where green means "the number went down" would poison the vocabulary. The
     * caption carries the interpretation instead.
     *
     * `relativeGradient` anchors each gradient to the baseline rather than to
     * the pane edges, so the wash is densest exactly at the crossing.
     */
    const vs = comparing
      ? chart.addSeries(BaselineSeries, {
        ...common,
        priceScaleId: 'right',
        title: 'vs median',
        baseValue: { type: 'price' as const, price: 0 },
        relativeGradient: true,
        topLineColor: theme.up,
        topFillColor1: alphaOf(theme.up, 0.32),
        topFillColor2: alphaOf(theme.up, 0.02),
        bottomLineColor: theme.down,
        bottomFillColor1: alphaOf(theme.down, 0.02),
        bottomFillColor2: alphaOf(theme.down, 0.32),
        lineWidth: 2 as const,
        priceFormat: { type: 'price' as const, precision: 2, minMove: 0.05 },
      }, PANE_VS)
      : null;

    // The zero line is the entire reference, and the autoscale does not always
    // include it — on a session that never crossed, the pane would otherwise be
    // a wash with nothing to be a wash relative to.
    vs?.createPriceLine({
      price: 0,
      color: theme.compareBand,
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: false,
      title: 'median',
    });

    stylePaneScale(base, PANE_SF);
    if (vs) stylePaneScale(base, PANE_VS);

    seriesRef.current = {
      straddle, bid, ask, iv, sf, spot,
      compare: compareLine, compareLo, compareHi, vs,
    };
    markersRef.current = createSeriesMarkers(straddle, []);

    const onCrosshair: Parameters<IChartApi['subscribeCrosshairMove']>[0] = (param) => {
      if (!param.time || !param.point) {
        setReadout(null);
        return;
      }
      const seconds = typeof param.time === 'number' ? param.time : 0;
      const candle = param.seriesData.get(straddle) as CandlestickData<Time> | undefined;
      const raw = pointAt(pointsRef.current, seconds, intervalRef.current);
      const change = candle ? candle.close - candle.open : null;

      const compareBar = param.seriesData.get(compareLine) as { value?: number } | undefined;
      const compareValueAt = typeof compareBar?.value === 'number' ? compareBar.value : null;
      // lo/hi ride on the source array rather than on the series data, because
      // the library keeps only what it plots. Looked up by the bar's own time,
      // which is the same key both sides were built from.
      const spread = compareRef.current.get(seconds) ?? null;

      setReadout({
        // The RAW point's timestamp, not the bucket's — the reader is being
        // shown that point's bid, ask and greeks, so the clock has to name the
        // second those came from.
        time: istClockSeconds(Math.floor((raw?.time ?? seconds * 1000) / 1000)),
        open: candle?.open ?? null,
        high: candle?.high ?? null,
        low: candle?.low ?? null,
        close: candle?.close ?? null,
        change,
        changePct:
          change !== null && candle && candle.open !== 0 ? (change / candle.open) * 100 : null,
        bid: raw?.straddleBid ?? null,
        ask: raw?.straddleAsk ?? null,
        iv: raw?.iv ?? null,
        sf: raw?.syntheticFuture ?? null,
        spot: raw?.spot ?? null,
        vega: raw?.vega ?? null,
        theta: raw?.theta ?? null,
        strike: raw?.atmStrike ?? null,
        compare: compareValueAt,
        // Today MINUS the median: positive means the straddle is holding more
        // premium than a typical session at this DTE had at this minute.
        vsCompare:
          compareValueAt !== null && candle ? candle.close - compareValueAt : null,
        // As a share of the median, which is the figure that compares across
        // contracts: 12 rupees under the median is a rounding error on BANKNIFTY
        // and a third of the premium on a NIFTY weekly at 1 DTE.
        vsComparePct:
          compareValueAt !== null && compareValueAt !== 0 && candle
            ? ((candle.close - compareValueAt) / compareValueAt) * 100
            : null,
        compareRange: spread,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      base.dispose();
      baseRef.current = null;
      seriesRef.current = null;
      markersRef.current = null;
    };
    // Rebuilt when the overlay changes axis, and when a comparison starts or
    // stops: a series' price scale is fixed at creation in lightweight-charts
    // and a pane cannot be added to a live chart without one, so there is
    // nothing to applyOptions in either case. The cost is a lost zoom on a
    // deliberate, infrequent toggle; the data effects below repopulate every
    // series immediately.
  }, [compareScale, comparing]);

  /**
   * The cohort, sanitised once: ascending, unique, finite.
   *
   * A memo rather than three passes inside the draw effect, because three
   * consumers now need the SAME rows — the median line, the hi/lo band, and the
   * vs-median difference. Sorting each separately would be three chances to
   * disagree about which minutes survived, and a difference computed off a
   * different subset from the line it is differencing is a plot of nothing.
   *
   * Ascending-and-unique is a hard requirement the library throws over, and a
   * throw here takes the whole chart down rather than dropping a point.
   */
  const cohort = useMemo(
    () => (compare?.data ?? [])
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
      .sort((a, b) => a.time - b.time)
      .filter((p, i, all) => i === 0 || p.time > all[i - 1].time),
    [compare],
  );

  const aggregated = useMemo(() => {
    const step = Number(interval);
    return {
      candles: candleData(points, (p) => p.straddlePrice, step),
      bid: lineData(points, (p) => p.straddleBid, step),
      ask: lineData(points, (p) => p.straddleAsk, step),
      iv: lineData(points, (p) => p.iv, step),
      sf: lineData(points, (p) => p.syntheticFuture, step),
      spot: lineData(points, (p) => p.spot, step),
    };
  }, [points, interval]);

  /**
   * Today minus the median, minute by minute.
   *
   * Joined on the candle's own bucket time rather than by index: the cohort is
   * one value a minute for the whole session, today's walk stops at the last
   * tick, and after a roll the two can differ by which minutes exist at all.
   * Only minutes BOTH sides have are plotted — an extrapolated difference is
   * the one number on this chart nobody should be reading.
   *
   * `close` rather than the bar's mean or its extreme: the median is a
   * per-minute snapshot, so the closing quote is the comparable quantity, and
   * it is the same value the crosshair readout differences.
   */
  const vsMedian = useMemo(() => {
    if (!cohort.length || !aggregated.candles.length) return [];
    const closes = new Map(aggregated.candles.map((c) => [Number(c.time), c.close]));
    const out: Array<{ time: number; diff: number; pct: number | null }> = [];
    for (const p of cohort) {
      const close = closes.get(p.time);
      if (close === undefined) continue;
      out.push({
        time: p.time,
        diff: close - p.value,
        pct: p.value !== 0 ? ((close - p.value) / p.value) * 100 : null,
      });
    }
    return out;
  }, [cohort, aggregated.candles]);

  /**
   * Where the straddle stands against the median RIGHT NOW, for the toolbar.
   *
   * The crosshair already answers this per bar, but only while the pointer is
   * on the plot — so the state a reader most wants ("is this session cheap?")
   * was the one thing they had to hover to learn, and it vanished the moment
   * they looked away. This is the last bar both series share, which on a live
   * session is the current minute.
   */
  const stance = useMemo(() => {
    const last = vsMedian[vsMedian.length - 1];
    if (!last || !Number.isFinite(last.diff)) return null;
    return {
      diff: last.diff,
      pct: last.pct,
      // Flat is its own outcome and gets neither word: a straddle sitting ON
      // the median is the least interesting thing it can do, and calling it
      // cheap because the difference is -0.01 is noise dressed as a signal.
      label: last.diff < 0 ? 'below median' : last.diff > 0 ? 'above median' : 'at median',
      // The one-word form the chip shows, and the same word the crossing
      // markers print on the plot — one vocabulary for one claim.
      word: last.diff < 0 ? 'cheap' : last.diff > 0 ? 'rich' : 'flat',
    };
  }, [vsMedian]);

  /**
   * What the last render drew, so growth can be told from replacement.
   *
   * The two need completely different viewport handling and they arrive through
   * the same effect: a live flush appends one bar to the series already on
   * screen, while changing contract, interval or session replaces it wholesale.
   */
  const drawnRef = useRef({ firstBar: 0, interval: '', count: 0 });

  useEffect(() => {
    const series = seriesRef.current;
    const base = baseRef.current;
    if (!series || !base) return;

    /*
     * Read the viewport BEFORE the data changes.
     *
     * `setData` preserves the logical range, so afterwards there is no way to
     * tell whether the user had been watching the live edge or had panned back
     * to the morning — and those two want opposite things to happen.
     */
    const scale = base.chart.timeScale();
    const before = scale.getVisibleLogicalRange();
    const drawn = drawnRef.current;
    // Coerced: candle times are the library's branded `Time`, and the identity
    // check below only needs the numeric value.
    const first = Number(aggregated.candles[0]?.time ?? 0);

    /*
     * GREW means the same series with more bars on the end. Anything else — a
     * new contract, a new session, a different interval, or a shorter series
     * than last time — is a replacement.
     */
    const grew =
      drawn.count > 0 &&
      first === drawn.firstBar &&
      interval === drawn.interval &&
      aggregated.candles.length >= drawn.count;

    /*
     * "Was the user at the live edge?" — within a couple of bars of the last
     * one, which is where `RIGHT_PAD_BARS` of gutter already puts them after a
     * fit. Slack rather than an equality test because the gutter, fractional
     * logical positions and a half-visible bar all put `to` slightly past the
     * final index.
     */
    const wasAtEdge =
      before != null && before.to >= drawn.count - 1 - 2;

    series.straddle.setData(aggregated.candles);
    series.bid.setData(aggregated.bid);
    series.ask.setData(aggregated.ask);
    series.iv.setData(aggregated.iv);
    series.sf.setData(aggregated.sf);
    series.spot.setData(aggregated.spot);
    // All three from `cohort`, which is already ordered and de-duplicated.
    series.compare.setData(cohort.map((p) => ({ time: stamp(p.time), value: p.value })));
    // `lo`/`hi` can be absent on a projection built before they existed; a NaN
    // reaching setData is a throw, so they are filtered rather than coerced.
    series.compareLo.setData(
      cohort.filter((p) => Number.isFinite(p.lo)).map((p) => ({ time: stamp(p.time), value: p.lo })),
    );
    series.compareHi.setData(
      cohort.filter((p) => Number.isFinite(p.hi)).map((p) => ({ time: stamp(p.time), value: p.hi })),
    );
    series.vs?.setData(
      vsMedian.map((p): BaselineData<Time> => ({ time: stamp(p.time), value: p.diff })),
    );

    /**
     * Roll markers.
     *
     * A strike roll makes the premium jump, and that jump is a change of
     * INSTRUMENT rather than a move in the market — unmarked, it is the single
     * most misleading feature of this chart. Markers snap to a bucket that
     * actually exists in the candle set, because the library drops a marker
     * whose time has no bar.
     */
    const index = new Map(aggregated.candles.map((c, i) => [c.time as number, i]));
    const step = Number(interval);
    const markers: SeriesMarker<Time>[] = [];
    const seen = new Set<number>();

    // The library draws marker text unconditionally and does not collision-test
    // it, so a cluster of rolls prints its labels on top of each other — an
    // unreadable smear that also hides the premium underneath. About eighteen
    // fit across a wide plot; the rest keep their arrow. Every roll is still
    // MARKED, only the caption is rationed.
    const labelGap = Math.max(1, Math.ceil(aggregated.candles.length / 18));
    let lastLabelled = -Infinity;

    for (const event of rollEvents) {
      const bucket = bucketOf(event.time, step);
      const bar = index.get(bucket);
      if (bar === undefined || seen.has(bucket)) continue;
      seen.add(bucket);

      const label = !dense && bar - lastLabelled >= labelGap && event.toStrike != null;
      if (label) lastLabelled = bar;

      markers.push({
        time: stamp(bucket),
        position: 'aboveBar',
        color: base.theme.roll,
        shape: 'arrowDown',
        text: label ? `roll → ${Math.round(event.toStrike as number)}` : '',
      });
    }
    /**
     * Where the straddle CROSSED the median.
     *
     * The vs-median pane shows the crossings as the moment its fill changes
     * colour, but a reader watching the candles should not have to look down to
     * find out that the thing they are watching just went from rich to cheap.
     * These are the same events, marked on the series they are about.
     *
     * Only the crossings, never the state: a marker on every below-median bar
     * would be a solid line of arrows under half the session, which says
     * nothing the fill does not already say and hides the candles while saying
     * it. A cross is an event, and events are what markers are for.
     */
    if (visible.compare !== false) {
      /*
       * A crossing counts only once the new side HOLDS.
       *
       * A straddle tracking its median sits on the line for whole stretches of
       * the session and flips sign on rounding — the same problem `settledRolls`
       * solves for strike rolls, and the same fix: the next `CROSS_DWELL` bars
       * must agree, or it was noise rather than a change of state. Without it a
       * quiet hour prints forty arrows and the two crossings that mattered are
       * lost among them.
       */
      const CROSS_DWELL = 3;
      let lastCrossLabel = -Infinity;
      for (let i = 1; i < vsMedian.length; i += 1) {
        const previous = vsMedian[i - 1].diff;
        const current = vsMedian[i].diff;
        if (previous === 0 || current === 0) continue;
        const cheap = current < 0;
        if ((previous < 0) === cheap) continue;

        let held = true;
        for (let j = i + 1; j < Math.min(i + CROSS_DWELL, vsMedian.length); j += 1) {
          if ((vsMedian[j].diff < 0) !== cheap) { held = false; break; }
        }
        if (!held) continue;

        const bucket = bucketOf(vsMedian[i].time * 1000, step);
        const bar = index.get(bucket);
        if (bar === undefined) continue;

        // Captions rationed on the same gap the roll labels use, for the same
        // reason: the library does not collision-test marker text.
        const label = !dense && bar - lastCrossLabel >= labelGap;
        if (label) lastCrossLabel = bar;

        markers.push({
          time: stamp(bucket),
          // Below the bar for a drop through the median, above for a rise
          // through it, so the marker sits on the side the price went.
          position: cheap ? 'belowBar' : 'aboveBar',
          color: cheap ? base.theme.down : base.theme.up,
          shape: cheap ? 'arrowDown' : 'arrowUp',
          text: label ? (cheap ? 'cheap' : 'rich') : '',
        });
      }
    }

    // The library requires markers in ascending time, and rolls and crossings
    // are two independently ordered streams.
    markers.sort((a, b) => Number(a.time) - Number(b.time));
    markersRef.current?.setMarkers(markers);

    /*
     * The viewport.
     *
     * This used to be an unconditional `fitContent`, which was fine while the
     * chart only ever loaded finished sessions and became wrong the moment live
     * ticks started flushing into it once a second. Every flush re-fitted: the
     * range widened by a bar, the whole series compressed slightly, and the plot
     * appeared to crawl leftwards — and any pan or zoom the reader had made was
     * discarded a second later.
     *
     * So a fit is now what happens when the series is REPLACED. When it merely
     * grew there are two honest behaviours and which one applies is the reader's
     * choice, expressed by where they left the viewport:
     *
     *   at the live edge  → follow it. Shift by exactly the bars that arrived,
     *                       preserving the zoom, so the newest tick stays in the
     *                       same place on screen instead of the chart rescaling.
     *   panned away       → leave it alone. Someone reading 11:40 does not want
     *                       to be yanked to the close every second, and
     *                       `setData` already preserves the range, so the
     *                       correct action is none.
     */
    if (!grew) {
      fitContentPadded(base.chart);
    } else if (wasAtEdge && before) {
      const added = aggregated.candles.length - drawn.count;
      if (added > 0) {
        scale.setVisibleLogicalRange({ from: before.from + added, to: before.to + added });
      }
    }

    drawnRef.current = {
      firstBar: first,
      interval,
      count: aggregated.candles.length,
    };
  }, [aggregated, rollEvents, interval, dense, cohort, vsMedian, visible.compare]);

  /**
   * Turning a comparison on moves the chart to 1m.
   *
   * Keyed on the SELECTION, not on the data: the overlay refetches on a poll and
   * gets a new array identity each time, which would yank the interval back to
   * 1m every few seconds and make the picker feel broken.
   */
  useEffect(() => {
    if (compareValue && compareValue !== 'none') setInterval(COMPARE_INTERVAL);
  }, [compareValue]);

  useEffect(() => {
    const series = seriesRef.current;
    const base = baseRef.current;
    if (!series || !base) return;
    series.straddle.applyOptions({ visible: visible.straddle });
    series.bid.applyOptions({ visible: visible.bid });
    series.ask.applyOptions({ visible: visible.ask });
    series.iv.applyOptions({ visible: visible.iv });
    series.sf.applyOptions({ visible: visible.sf });
    series.spot.applyOptions({ visible: visible.spot });
    const showCompare = Boolean(compare) && visible.compare !== false;
    series.compare.applyOptions({ visible: showCompare });
    // The band follows the median under one toggle. Separating them would offer
    // "band without its median", which is a chart of two edges around nothing.
    series.compareLo.applyOptions({ visible: showCompare && visible.compareBand !== false });
    series.compareHi.applyOptions({ visible: showCompare && visible.compareBand !== false });
    // The difference is the same claim as the overlay, so it hides with it —
    // but the PANE stays, because removing it would resize every pane above
    // and the toggle is meant to quiet the chart, not rebuild it.
    series.vs?.applyOptions({ visible: showCompare });
    // An axis with nothing on it is a column of stale numbers. IV owns the left
    // scale alone, so hiding the line has to hide the scale with it.
    base.chart.priceScale('left', PANE_PREMIUM).applyOptions({ visible: visible.iv });
  }, [visible, compare]);

  const toggle = useCallback((key: string) => {
    setVisible((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  }, []);

  const fit = useCallback(() => {
    if (baseRef.current) fitContentPadded(baseRef.current.chart);
  }, []);

  return (
    <ChartFrame
      className={className}
      // The sub-minute rungs are removed while comparing rather than disabled:
      // the overlay has one value per minute, and offering 1s promises a
      // resolution it cannot deliver. See COMPARE_INTERVAL.
      intervals={comparing ? MINUTE_INTERVALS : SECOND_INTERVALS}
      interval={interval}
      onIntervalChange={setInterval}
      toggles={comparing ? [...TOGGLES, ...COMPARE_TOGGLES] : TOGGLES}
      visible={visible}
      onToggle={toggle}
      onFit={fit}
      leading={
        compareOptions?.length ? (
          <div className="flex items-center gap-2">
            {dense ? null : (
              <span className="qs-label shrink-0 text-[var(--text-tertiary)]">Compare</span>
            )}
            <Select
              aria-label="Compare against"
              value={compareValue ?? 'none'}
              options={compareOptions}
              onChange={(e) => onCompareChange?.(e.target.value)}
              className={dense ? 'w-32' : 'w-44'}
            />
            {/*
              The answer, without hovering.

              Everything else about the comparison is a shape: two lines in
              pane 0, a filled region in pane 3. Both are read by eye and both
              need a glance. This is the one-line conclusion — which side of the
              median the straddle is on right now, by how much, and in percent —
              and it is the first thing anyone opens this comparison to find
              out. It stays on screen because a reading that requires a hover is
              a reading most sessions never get.

              Tinted with `toneFor`, the same function that colours the signed
              figure in the readout and the same sign convention the vs-median
              pane fills with, so the chip, the pane and the readout cannot tell
              three different stories.
            */}
            {stance ? (
              <span
                className="qs-num flex shrink-0 items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[length:var(--type-micro)] leading-none"
                style={{
                  color: toneFor(stance.diff),
                  // Tint only — no border. A bordered pill is two more pixels of
                  // height on a row whose height comes straight out of the plot,
                  // and the tint plus the direction colour already separate this
                  // from the text beside it.
                  // `color-mix` over the token rather than `alphaOf`, because
                  // this is DOM — the resolved literals exist for the canvas.
                  backgroundColor: 'color-mix(in srgb, ' + toneFor(stance.diff)
                    + ' 14%, transparent)',
                }}
                title={'Straddle ' + stance.label + ' at the last shared minute'}
              >
                {/* The short word, matching what the crossing markers say on the
                    plot. The full phrase is in the tooltip: two words of
                    toolbar buy nothing that the colour and the sign do not
                    already carry. */}
                <span className="uppercase tracking-[var(--tracking-wide)]">{stance.word}</span>
                <span>
                  {stance.diff > 0 ? '+' : ''}
                  {stance.diff.toFixed(2)}
                  {stance.pct !== null
                    ? ' (' + (stance.pct > 0 ? '+' : '') + stance.pct.toFixed(1) + '%)'
                    : ''}
                </span>
              </span>
            ) : null}
            {/* What the overlay IS, next to the control that turned it on. A
                median of five rebased sessions is not self-evident from a line,
                and the sample count is what says whether to trust it. */}
            {compareNote && !dense ? (
              // `basis-0` is what keeps the toolbar one row high. A flex item
              // is placed on a line at its CONTENT width and only shrinks once
              // it is on one — so this sentence, which runs to about sixty
              // characters, was wrapping the whole toolbar and taking 40px out
              // of the plot to do it. At a zero base it claims only the room
              // left over and truncates into it.
              <span
                className="min-w-0 flex-1 basis-0 truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]"
                title={compareNote}
              >
                {compareNote}
              </span>
            ) : null}
          </div>
        ) : null
      }
      height={height}
      dense={dense}
      hostRef={hostRef}
      meta={`${aggregated.candles.length.toLocaleString('en-IN')} bars · ${points.length.toLocaleString('en-IN')} ticks`}
      readout={
        readout ? (
          <>
            <ReadoutTime>{readout.time}</ReadoutTime>

            {/* All four values take the bar's direction, as TradingView does.
                The colour is set once on the group and INHERITED by the numbers;
                the letters override back to tertiary, so O/H/L/C never turn into
                four more coloured things competing with the figures. Direction
                is a property of the BAR, not of each of its four prices — H is
                not independently green. */}
            <span className="qs-num truncate" style={{ color: toneFor(readout.change) }}>
              <Tick k="O" v={num(readout.open)} />
              <Tick k="H" v={num(readout.high)} />
              <Tick k="L" v={num(readout.low)} />
              <Tick k="C" v={num(readout.close)} />
            </span>

            {readout.change !== null ? (
              <span className="qs-num shrink-0" style={{ color: toneFor(readout.change) }}>
                {readout.change > 0 ? '+' : ''}
                {readout.change.toFixed(2)}
                {readout.changePct !== null
                  ? ` (${readout.changePct > 0 ? '+' : ''}${readout.changePct.toFixed(2)}%)`
                  : ''}
              </span>
            ) : null}

            {/* Spread, strike, vega and theta are never plotted — they are why
                someone hovers, and a line each would bury the premium. */}
            {/* The whole point of the overlay, as a number. Signed and coloured
                because "12 rich" and "12 cheap" are opposite conclusions and a
                bare magnitude makes the reader work out which one they have. */}
            {finite(readout.compare) ? (
              <>
                <Field k="median" v={readout.compare.toFixed(2)} />
                {finite(readout.vsCompare) ? (
                  <span className="qs-num shrink-0" style={{ color: toneFor(readout.vsCompare) }}>
                    {readout.vsCompare > 0 ? '+' : ''}
                    {readout.vsCompare.toFixed(2)}
                    {/* The percentage rides along because the rupee figure alone
                        is not comparable between contracts, or between the front
                        expiry and the next one on the same underlying. */}
                    {finite(readout.vsComparePct)
                      ? ' (' + (readout.vsComparePct > 0 ? '+' : '')
                        + readout.vsComparePct.toFixed(1) + '%)'
                      : ''}{' '}
                    vs median
                  </span>
                ) : null}
                {/* The spread the median came out of. Without it a median of
                    five sessions that agreed and five that scattered read the
                    same, and only one of those is worth trading against.

                    Labelled "spread", NOT "range", and the distinction is not
                    pedantry. This is the low and high of five SNAPSHOTS — one
                    per session at this minute, which is all `/api/straddle/
                    history` returns for a past date. A bar's high/low range
                    over the same minute is a strictly wider number, because
                    the rolling straddle jumps ~6% whenever the ATM strike
                    flips and it flips hundreds of times a session. Calling a
                    snapshot spread a range invites it to be compared against
                    tools that quote the real one, and it will always read
                    too tight. See `dteMedian.ts`. */}
                {readout.compareRange && !dense ? (
                  <Field
                    k="spread"
                    v={`${readout.compareRange.lo.toFixed(2)}–${readout.compareRange.hi.toFixed(2)} · ${readout.compareRange.n} sessions`}
                  />
                ) : null}
              </>
            ) : null}

            {finite(readout.bid) && finite(readout.ask) ? (
              <Field k="spread" v={(readout.ask - readout.bid).toFixed(2)} />
            ) : null}
            {finite(readout.strike) ? (
              <Field k="strike" v={String(Math.round(readout.strike))} />
            ) : null}
            {!dense && finite(readout.vega) ? <Field k="vega" v={num(readout.vega)} /> : null}
            {!dense && finite(readout.theta) ? <Field k="theta" v={num(readout.theta)} /> : null}
          </>
        ) : null
      }
    />
  );
}

export const StraddleChart = memo(StraddleChartImpl);
