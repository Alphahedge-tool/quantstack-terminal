/**
 * Delta-band vega and theta.
 *
 * ── What this is measuring ──
 *
 * Not the ATM straddle's greeks — the straddle chart already carries those in
 * its readout. This is the whole basket of strikes whose delta falls inside a
 * window (0.05–0.60 by default), summed per side. It answers "what is the wing
 * exposure doing" rather than "what is this one contract doing", which is why
 * it earns a chart of its own rather than two more lines on the straddle.
 *
 * ── Two panes, and why not one ──
 *
 *   Pane 0  vega  — rupees per volatility point
 *   Pane 1  theta — rupees per day
 *
 * They are both "greeks" and that is where the similarity ends: the units have
 * different denominators, and on this basket they also sit on opposite sides of
 * zero (vega negative, theta positive on the sample session). Overlaid on one
 * axis the crossing where they meet would be pure artefact of two scalings.
 *
 * Calls and puts DO share a unit within each pane, so those overlay — and that
 * is the comparison worth having, since a divergence between the two sides is
 * skew showing up in the exposure.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LineSeries, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { ChartFrame, Field, ReadoutTime, type SeriesToggle } from '@/components/chart/ChartFrame';
import {
  MINUTE_INTERVALS,
  createBaseChart,
  finite,
  lineData,
  num,
  pointAt,
  stylePaneScale,
  type BaseChart,
} from '@/lib/chartBase';
import { istClockSeconds } from '@/lib/chartTheme';
import type { BandGreeksPoint } from '@/schemas/market';

interface Props {
  points: BandGreeksPoint[];
  height?: number | string;
  dense?: boolean;
  className?: string;
}

/**
 * Colour here means SIDE, not direction.
 *
 * Green is the call and red is the put, matching the candles on the straddle
 * chart — which is what makes the two charts feel like one product, and is the
 * usual convention in options tooling. Note it is a different meaning for the
 * same two colours: on a candle, green means "closed up". Inside this chart it
 * means "call", which the legend and the readout both say in words.
 *
 * The theta pane takes blue and yellow instead of repeating green and red, so
 * two panes of paired lines do not read as the same chart drawn twice.
 */
const TOGGLES: SeriesToggle[] = [
  { key: 'callVega', label: 'Call vega', colour: 'var(--market-up)' },
  { key: 'putVega', label: 'Put vega', colour: 'var(--market-down)' },
  { key: 'callTheta', label: 'Call theta', colour: 'var(--series-theta-call)' },
  { key: 'putTheta', label: 'Put theta', colour: 'var(--series-theta-put)' },
];

const ALL_ON: Record<string, boolean> = Object.fromEntries(TOGGLES.map((t) => [t.key, true]));

interface Readout {
  time: string;
  callVega: number | null;
  putVega: number | null;
  callTheta: number | null;
  putTheta: number | null;
  callCount: number | null;
  putCount: number | null;
  strike: number | null;
}

function GreeksChartImpl({ points, height = 520, dense = false, className }: Props) {
  // Opens at 1m, the engine's own bar for this basket — see MINUTE_INTERVALS
  // for why nothing finer is offered.
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
      // An even split, unlike the straddle chart's 3:1. Neither greek is the
      // subject here — the reason to open this chart is the relationship
      // between them, and giving one three times the height would assert a
      // priority the data does not have.
      panes: [
        { caption: 'Band vega · ₹ per vol point', stretch: 1 },
        { caption: 'Band theta · ₹ per day', stretch: 1 },
      ],
    });
    const { chart, theme } = base;
    baseRef.current = base;

    const common = {
      priceLineVisible: false,
      lastValueVisible: true,
      lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    } as const;

    /**
     * Every line solid, at one width.
     *
     * The dotted put lines were doing a job that colour now does on its own:
     * with the pairs at ΔE 37 (theta) apart, a dash pattern adds nothing and
     * costs real legibility, because a dotted line drawn over a grid at 1m
     * resolution breaks up into something the eye reads as a gap in the data
     * rather than as a style.
     */
    const callVega = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Call vega', color: theme.up,
    });
    const putVega = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Put vega', color: theme.down,
    });
    const callTheta = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Call theta', color: theme.thetaCall,
    }, 1);
    const putTheta = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Put theta', color: theme.thetaPut,
    }, 1);

    stylePaneScale(base, 1);

    seriesRef.current = { callVega, putVega, callTheta, putTheta };

    const onCrosshair: Parameters<IChartApi['subscribeCrosshairMove']>[0] = (param) => {
      if (!param.time || !param.point) {
        setReadout(null);
        return;
      }
      const seconds = typeof param.time === 'number' ? param.time : 0;
      const raw = pointAt(pointsRef.current, seconds, intervalRef.current);
      setReadout({
        time: istClockSeconds(Math.floor((raw?.time ?? seconds * 1000) / 1000)),
        callVega: raw?.callVega ?? null,
        putVega: raw?.putVega ?? null,
        callTheta: raw?.callTheta ?? null,
        putTheta: raw?.putTheta ?? null,
        callCount: raw?.callCount ?? null,
        putCount: raw?.putCount ?? null,
        strike: raw?.atmStrike ?? null,
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
      callVega: lineData(points, (p) => p.callVega, step),
      putVega: lineData(points, (p) => p.putVega, step),
      callTheta: lineData(points, (p) => p.callTheta, step),
      putTheta: lineData(points, (p) => p.putTheta, step),
    };
  }, [points, interval]);

  useEffect(() => {
    const series = seriesRef.current;
    const base = baseRef.current;
    if (!series || !base) return;
    series.callVega.setData(aggregated.callVega);
    series.putVega.setData(aggregated.putVega);
    series.callTheta.setData(aggregated.callTheta);
    series.putTheta.setData(aggregated.putTheta);
    base.chart.timeScale().fitContent();
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

  const fit = useCallback(() => baseRef.current?.chart.timeScale().fitContent(), []);

  /** Legs in the basket on this bar. A vega that halves because the band
   *  emptied is a different event from one that halves because vol moved, and
   *  the count is the only thing that separates them. */
  const legs =
    readout && (finite(readout.callCount) || finite(readout.putCount))
      ? `${readout.callCount ?? 0}c / ${readout.putCount ?? 0}p`
      : null;

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
      meta={`${aggregated.callVega.length.toLocaleString('en-IN')} bars · ${points.length.toLocaleString('en-IN')} ticks`}
      readout={
        readout ? (
          <>
            <ReadoutTime>{readout.time}</ReadoutTime>
            <Field k="c.vega" v={num(readout.callVega)} />
            <Field k="p.vega" v={num(readout.putVega)} />
            <Field k="c.theta" v={num(readout.callTheta)} />
            <Field k="p.theta" v={num(readout.putTheta)} />
            {legs ? <Field k="legs" v={legs} /> : null}
            {!dense && finite(readout.strike) ? (
              <Field k="atm" v={String(Math.round(readout.strike))} />
            ) : null}
          </>
        ) : null
      }
    />
  );
}

export const GreeksChart = memo(GreeksChartImpl);
