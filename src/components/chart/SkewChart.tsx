/**
 * Risk reversal — the 25-delta put/call volatility skew.
 *
 * ── What the two panes are ──
 *
 *   Pane 0  call IV, put IV, ATM IV        — percent, one axis, they share it
 *   Pane 1  the wing spread (put − call)   — IV points, with a zero line
 *
 * The three vols overlay legitimately: same unit, and the whole point is where
 * the wings sit relative to the middle. The spread gets its own pane not
 * because of units — it is also in IV points — but because it is a DIFFERENCE
 * and lives around zero while the levels live around 9. Sharing an axis would
 * squash it into a flat line against the bottom of the frame.
 *
 * ── The zero line is the chart ──
 *
 * A risk reversal is only meaningful relative to zero: positive means puts are
 * bid over calls, which is the normal state of an equity index and the shape
 * that inverts before it matters. So pane 1 carries an explicit baseline rather
 * than leaving the reader to find zero on the axis.
 *
 * `rr` and `skew` are NOT the same number and the backend publishes both: `rr`
 * is the spread in IV points, `skew` is that spread as a percentage of ATM IV.
 * The normalised one compares across days and underlyings; the raw one is what
 * the wings actually cost. The plot plots `rr` and the readout carries `skew`
 * beside it, so neither is silently substituted for the other.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import { ChartFrame, Field, ReadoutTime, type SeriesToggle } from '@/components/chart/ChartFrame';
import {
  MINUTE_INTERVALS,
  createBaseChart,
  finite,
  fitContentPadded,
  lineData,
  pointAt,
  stylePaneScale,
  toneFor,
  type BaseChart,
} from '@/lib/chartBase';
import { istClockSeconds } from '@/lib/chartTheme';
import type { RiskReversalPoint } from '@/schemas/market';

interface Props {
  points: RiskReversalPoint[];
  height?: number | string;
  dense?: boolean;
  className?: string;
}

const TOGGLES: SeriesToggle[] = [
  { key: 'callIv', label: 'Call IV', colour: 'var(--series-sf)' },
  { key: 'putIv', label: 'Put IV', colour: 'var(--series-ask)' },
  { key: 'atmIv', label: 'ATM IV', colour: 'var(--series-iv)' },
  { key: 'rr', label: 'Skew', colour: 'var(--series-vega)' },
];

const ALL_ON: Record<string, boolean> = Object.fromEntries(TOGGLES.map((t) => [t.key, true]));

interface Readout {
  time: string;
  callIv: number | null;
  putIv: number | null;
  atmIv: number | null;
  rr: number | null;
  skew: number | null;
  callStrike: number | null;
  putStrike: number | null;
}

const pct = (v: number | null) => (finite(v) ? `${v.toFixed(2)}%` : '—');

function SkewChartImpl({ points, height = 520, dense = false, className }: Props) {
  const [interval, setInterval] = useState('60');
  const [visible, setVisible] = useState<Record<string, boolean>>(ALL_ON);
  const [readout, setReadout] = useState<Readout | null>(null);

  const hostRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<BaseChart | null>(null);
  const seriesRef = useRef<Record<string, ISeriesApi<'Line'>> | null>(null);

  const pointsRef = useRef(points);
  const intervalRef = useRef(Number(interval));
  pointsRef.current = points;
  intervalRef.current = Number(interval);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const base = createBaseChart(host, {
      panes: [
        // The vol levels are the subject; the spread derived from them is the
        // reading. 2:1 rather than 3:1 — the spread pane needs enough height
        // for a line that lives in a narrow band around zero to show shape at
        // all.
        { caption: 'Call · Put · ATM implied volatility', stretch: 2 },
        { caption: 'Risk reversal · put IV − call IV', stretch: 1 },
      ],
    });
    const { chart, theme } = base;
    baseRef.current = base;

    const asPercent = { type: 'custom' as const, formatter: (v: number) => `${v.toFixed(2)}%` };
    const common = { priceLineVisible: false, lastValueVisible: true, lineWidth: 2 } as const;

    const callIv = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Call IV', color: theme.sf,
      priceFormat: asPercent,
    });
    const putIv = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Put IV', color: theme.ask,
      priceFormat: asPercent,
    });
    // ATM is the reference the wings are measured against, not a third wing —
    // dotted and thinner so it reads as the baseline it is.
    const atmIv = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'ATM IV', color: theme.iv,
      lineWidth: 1, lineStyle: LineStyle.Dotted, priceFormat: asPercent,
    });

    const rr = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Risk reversal', color: theme.spot,
      priceFormat: { type: 'custom', formatter: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}` },
    }, 1);

    /**
     * The zero line.
     *
     * A price line on the series rather than a fourth plotted series: it is a
     * reference, not a measurement, so it must not appear in the legend, must
     * not be toggleable, and must not participate in the pane's autoscale — all
     * three of which a series would do.
     */
    rr.createPriceLine({
      price: 0,
      color: base.theme.border,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: '',
    });

    stylePaneScale(base, 1);

    seriesRef.current = { callIv, putIv, atmIv, rr };

    const onCrosshair: Parameters<IChartApi['subscribeCrosshairMove']>[0] = (param) => {
      if (!param.time || !param.point) {
        setReadout(null);
        return;
      }
      const seconds = typeof param.time === 'number' ? param.time : 0;
      const raw = pointAt(pointsRef.current, seconds, intervalRef.current);
      setReadout({
        time: istClockSeconds(Math.floor((raw?.time ?? seconds * 1000) / 1000)),
        callIv: raw?.callIv ?? null,
        putIv: raw?.putIv ?? null,
        atmIv: raw?.atmIv ?? null,
        rr: raw?.rr ?? null,
        skew: raw?.skew ?? null,
        callStrike: raw?.callStrike ?? null,
        putStrike: raw?.putStrike ?? null,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshair);
      base.dispose();
      baseRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const aggregated = useMemo(() => {
    const step = Number(interval);
    return {
      callIv: lineData(points, (p) => p.callIv, step),
      putIv: lineData(points, (p) => p.putIv, step),
      atmIv: lineData(points, (p) => p.atmIv, step),
      rr: lineData(points, (p) => p.rr, step),
    };
  }, [points, interval]);

  useEffect(() => {
    const series = seriesRef.current;
    const base = baseRef.current;
    if (!series || !base) return;
    series.callIv.setData(aggregated.callIv);
    series.putIv.setData(aggregated.putIv);
    series.atmIv.setData(aggregated.atmIv);
    series.rr.setData(aggregated.rr);
    fitContentPadded(base.chart);
  }, [aggregated]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const key of Object.keys(series)) {
      series[key].applyOptions({ visible: visible[key] ?? true });
    }
  }, [visible]);

  const toggle = useCallback((key: string) => {
    setVisible((current) => ({ ...current, [key]: !(current[key] ?? true) }));
  }, []);

  const fit = useCallback(() => {
    if (baseRef.current) fitContentPadded(baseRef.current.chart);
  }, []);

  return (
    <ChartFrame
      className={className}
      intervals={MINUTE_INTERVALS}
      interval={interval}
      onIntervalChange={setInterval}
      toggles={TOGGLES}
      visible={visible}
      onToggle={toggle}
      onFit={fit}
      height={height}
      dense={dense}
      hostRef={hostRef}
      meta={`${aggregated.rr.length.toLocaleString('en-IN')} bars · ${points.length.toLocaleString('en-IN')} ticks`}
      readout={
        readout ? (
          <>
            <ReadoutTime>{readout.time}</ReadoutTime>
            {/* Signed, and coloured by sign: positive means puts bid over calls.
                The direction IS the reading here, not a decoration on it. */}
            <span className="qs-num shrink-0" style={{ color: toneFor(readout.rr) }}>
              {finite(readout.rr) ? `${readout.rr > 0 ? '+' : ''}${readout.rr.toFixed(2)}` : '—'}
              {finite(readout.skew) ? ` (${readout.skew > 0 ? '+' : ''}${readout.skew.toFixed(2)}% of ATM)` : ''}
            </span>
            <Field k="call" v={pct(readout.callIv)} />
            <Field k="put" v={pct(readout.putIv)} />
            <Field k="atm" v={pct(readout.atmIv)} />
            {/* The wings are picked per bar by delta, so which strikes they
                landed on changes through the session — worth showing, or a jump
                in the spread looks like a vol move rather than a new pair. */}
            {!dense && finite(readout.callStrike) && finite(readout.putStrike) ? (
              <Field k="wings" v={`${Math.round(readout.putStrike)}p / ${Math.round(readout.callStrike)}c`} />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

export const SkewChart = memo(SkewChartImpl);
