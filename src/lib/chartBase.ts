/**
 * The charting base — one construction shared by every canvas chart in the app.
 *
 * ── Why this file exists ──
 *
 * The straddle chart set about forty options: grid colour, crosshair style,
 * price-scale margins, the IST tick formatter, scroll and scale handling. A
 * second chart built beside it would have re-specified all forty from memory,
 * and the two would have diverged on the third or fourth edit — one with a
 * slightly different grid alpha, one still formatting time in UTC. That is how
 * a product ends up with charts that are *nearly* the same, which reads worse
 * than charts that are obviously different.
 *
 * So the construction lives here and the chart components describe only what is
 * actually theirs: which series, on which scale, in which pane. Change the look
 * of every chart in the product by changing this file.
 *
 * Colours still come from `chartTheme`, which reads them off the token ladder —
 * this file decides STRUCTURE, that one decides paint.
 */

import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createTextWatermark,
  type CandlestickData,
  type IChartApi,
  type LineData,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { readChartTheme, istClock, istClockSeconds, type ChartTheme } from '@/lib/chartTheme';

/* ── Time and bucketing ───────────────────────────────────────────────────── */

export const finite = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isFinite(value);

export const stamp = (seconds: number) => seconds as UTCTimestamp;

export const bucketOf = (millis: number, interval: number) =>
  Math.floor(Math.floor(millis / 1000) / interval) * interval;

/** Formats a number for a readout, with the em-dash placeholder for absent
 *  data — never a bare 0, since "no quote" and "a quote of zero" differ. */
export const num = (value: number | null | undefined, digits = 2): string =>
  finite(value) ? value.toFixed(digits) : '—';

/**
 * The direction colour, from a signed change.
 *
 * Shared so no two readouts can disagree about what green means. A zero change
 * is NOT green: `>= 0` would paint every unchanged bar with the up colour,
 * which overstates how often a thing rose. Flat is its own outcome.
 */
export function toneFor(change: number | null | undefined): string {
  if (!finite(change) || change === 0) return 'var(--text-primary)';
  return change > 0 ? 'var(--market-up)' : 'var(--market-down)';
}

/**
 * Bucket a field into a line series, taking the LAST value in each bucket.
 *
 * Last, not mean: these are quoted levels, and the bar's closing quote is a
 * price that actually existed. An average of the bucket is a number no one
 * could have traded at.
 *
 * The library requires strictly ascending, de-duplicated times — a repeat or a
 * step backwards throws and takes the whole chart down, so both are collapsed
 * here rather than trusted from the feed.
 */
export function lineData<T extends { time: number }>(
  points: readonly T[],
  pick: (point: T) => number | null | undefined,
  interval: number,
): LineData<Time>[] {
  const out: LineData<Time>[] = [];
  let previous = -Infinity;
  for (const point of points) {
    const value = pick(point);
    if (!finite(value)) continue;
    const bucket = bucketOf(point.time, interval);
    if (bucket === previous) out[out.length - 1] = { time: stamp(bucket), value };
    else if (bucket > previous) {
      out.push({ time: stamp(bucket), value });
      previous = bucket;
    }
  }
  return out;
}

/** Bucket a field into OHLC. The wick is the bucket's real extreme, which is
 *  the whole reason to aggregate this way rather than sample. */
export function candleData<T extends { time: number }>(
  points: readonly T[],
  pick: (point: T) => number | null | undefined,
  interval: number,
): CandlestickData<Time>[] {
  const out: CandlestickData<Time>[] = [];
  for (const point of points) {
    const value = pick(point);
    if (!finite(value)) continue;
    const bucket = bucketOf(point.time, interval);
    const last = out[out.length - 1];
    if (last && last.time === stamp(bucket)) {
      last.high = Math.max(last.high, value);
      last.low = Math.min(last.low, value);
      last.close = value;
    } else if (!last || bucket > (last.time as number)) {
      out.push({ time: stamp(bucket), open: value, high: value, low: value, close: value });
    }
  }
  return out;
}

/**
 * The raw point behind a crosshair position.
 *
 * The plotted series is bucketed; the readout is not. Someone hovering a bar
 * wants the bid, the greeks, the strike — fields that were never plotted and
 * are the reason they are hovering at all. Binary search rather than a scan,
 * because this runs on every pointer move over up to 22k points.
 */
export function pointAt<T extends { time: number }>(
  points: readonly T[],
  seconds: number,
  interval: number,
): T | null {
  const end = (seconds + interval) * 1000;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (points[mid].time < end) low = mid + 1;
    else high = mid;
  }
  return points[Math.max(0, low - 1)] ?? null;
}

/* ── Intervals ────────────────────────────────────────────────────────────── */

export interface IntervalOption {
  value: string;
  label: string;
}

/**
 * The full ladder, for a series walked at 1-second bars.
 *
 * 1s is offered because a spike that lives for one second is real information
 * on a premium; anything coarser is aggregation the reader chose, not detail
 * the feed lacked.
 */
export const SECOND_INTERVALS: readonly IntervalOption[] = [
  { value: '1', label: '1s' },
  { value: '5', label: '5s' },
  { value: '15', label: '15s' },
  { value: '60', label: '1m' },
  { value: '300', label: '5m' },
];

/**
 * The ladder for a series the ENGINE already walked at one-minute bars — the
 * band-greeks and risk-reversal baskets.
 *
 * Sub-minute options are deliberately absent rather than disabled. Offering 1s
 * on a 1m series would draw one candle per minute with three empty buckets
 * between, which does not look like missing data — it looks like a market that
 * traded four times an hour. A control that cannot deliver what it promises is
 * worse than a control that is not there.
 */
export const MINUTE_INTERVALS: readonly IntervalOption[] = [
  { value: '60', label: '1m' },
  { value: '300', label: '5m' },
  { value: '900', label: '15m' },
];

/* ── The chart itself ─────────────────────────────────────────────────────── */

export interface BaseChartOptions {
  /** Panes to create, top to bottom, with their relative heights. The first
   *  entry is pane 0; the library creates the rest as series are added to
   *  them. */
  panes: Array<{ caption: string; stretch: number }>;
  /**
   * Left price scale, shown only when a chart puts something on it — an axis
   * with nothing against it is a column of stale numbers.
   *
   * `colour` is a selector over the theme rather than a literal, because the
   * theme is resolved from computed style INSIDE this function. A caller that
   * wanted the axis tinted to its series would otherwise have to read the token
   * ladder a second time on its own, which is the duplication `chartTheme`
   * exists to prevent.
   */
  leftScale?: { visible: boolean; colour?: (theme: ChartTheme) => string };
}

export interface BaseChart {
  chart: IChartApi;
  theme: ChartTheme;
  /** Call on unmount — detaches the pane captions, then removes the chart. */
  dispose: () => void;
}

/**
 * Build a chart with the product's charting look already applied.
 *
 * Pane captions are attached here rather than left to callers because they are
 * the one thing every multi-pane chart needs and the easiest to forget: a
 * second pane with no caption is a mystery plot. They are semibold and set at
 * `paneLabel` because they sit ON the plot with grid lines running behind them
 * — at 11px regular the strokes read straight through the letterforms.
 */
export function createBaseChart(host: HTMLElement, options: BaseChartOptions): BaseChart {
  const theme = readChartTheme();

  const chart = createChart(host, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: theme.surface },
      textColor: theme.text,
      fontFamily: theme.fontFamily,
      fontSize: 11,
      // The pane divider is a real control: the reader is expected to trade
      // detail in one pane for detail in another depending on what they are
      // looking at.
      panes: {
        separatorColor: theme.border,
        separatorHoverColor: theme.roll,
        enableResize: true,
      },
    },
    grid: {
      vertLines: { color: theme.grid, style: LineStyle.Solid },
      horzLines: { color: theme.grid, style: LineStyle.Solid },
    },
    crosshair: {
      // Magnet mode would snap to the nearest bar and quietly change which
      // instant the readout describes. Normal reads where the pointer is.
      mode: CrosshairMode.Normal,
      vertLine: {
        color: theme.crosshair,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: theme.crosshairLabel,
      },
      horzLine: {
        color: theme.crosshair,
        width: 1,
        style: LineStyle.Dashed,
        labelBackgroundColor: theme.crosshairLabel,
      },
    },
    rightPriceScale: {
      borderColor: theme.border,
      textColor: theme.textStrong,
      minimumWidth: 64,
      scaleMargins: { top: 0.12, bottom: 0.1 },
    },
    leftPriceScale: {
      visible: options.leftScale?.visible ?? false,
      borderColor: theme.border,
      textColor: options.leftScale?.colour?.(theme) ?? theme.text,
      minimumWidth: 56,
      scaleMargins: { top: 0.12, bottom: 0.1 },
    },
    timeScale: {
      borderColor: theme.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 6,
      barSpacing: 6,
      minBarSpacing: 0.05,
      // Both formatters, and both from the same helper. lightweight-charts
      // stamps every UTCTimestamp in UTC and offers no timezone option — left
      // alone, an Indian session labels its 09:15 open as 03:45. Override only
      // one of the two and the axis and the crosshair disagree by 5h30m.
      tickMarkFormatter: (time: Time) => istClock(typeof time === 'number' ? time : 0),
    },
    localization: {
      timeFormatter: (time: Time) => istClockSeconds(typeof time === 'number' ? time : 0),
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
  });

  const watermarks = options.panes.map((pane, index) => {
    const api = chart.panes()[index];
    if (!api) return null;
    api.setStretchFactor(pane.stretch);
    return createTextWatermark(api, {
      horzAlign: 'left',
      vertAlign: 'top',
      lines: [
        {
          text: pane.caption,
          color: theme.paneLabel,
          fontSize: 11,
          fontStyle: '600',
          fontFamily: theme.fontFamily,
        },
      ],
    });
  });

  return {
    chart,
    theme,
    dispose: () => {
      watermarks.forEach((w) => w?.detach());
      chart.remove();
    },
  };
}

/**
 * Apply the base look to a price scale created after the chart was built.
 *
 * A pane's own right scale does not exist until a series is added to that pane,
 * so it cannot be styled in the constructor above. Pane 1 also gets deeper
 * margins than pane 0: it is the shorter pane, and the caption sitting in its
 * top-left corner would otherwise overlap the first few marks.
 */
export function stylePaneScale(base: BaseChart, paneIndex: number): void {
  base.chart.priceScale('right', paneIndex).applyOptions({
    borderColor: base.theme.border,
    textColor: base.theme.textStrong,
    scaleMargins: paneIndex === 0 ? { top: 0.12, bottom: 0.1 } : { top: 0.24, bottom: 0.16 },
  });
}
