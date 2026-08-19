/**
 * The session tape: straddle premium and ATM IV over spot, with the levels that
 * matter drawn ON the price scale.
 *
 * ── Why these three series and no others ──
 *
 * The whole compression-to-expansion question is a relationship between two
 * lines: what the option market is charging, and how much the underlying is
 * actually moving. Premium falling while spot is quiet is the day working as
 * designed; premium RISING while spot moves is the transition, and it is
 * visible as the moment the two lines stop diverging and start moving together.
 * IV rides along because it says whether an expanding premium is a repricing of
 * risk or just spot arriving at a strike.
 *
 * ── Why the levels are price lines and not markers ──
 *
 * The call wall, the put wall and the gamma flip are LEVELS — they are only
 * meaningful as a height on the spot axis, and the question they answer is
 * "where is spot relative to this". A marker on the time axis would say when
 * they were computed, which nobody is asking.
 */

import { memo, useEffect, useMemo, useRef } from 'react';
import {
  LineSeries, LineStyle,
  type AutoscaleInfo, type IPriceLine, type ISeriesApi, type Time,
} from 'lightweight-charts';
import {
  createBaseChart, fitContentPadded, stamp, stylePaneScale, type BaseChart,
} from '@/lib/chartBase';
import type { ExpiryBar } from '@/schemas/expiry';

export interface TapeLevels {
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  atmStrike: number | null;
}

function ExpiryTapeImpl({
  bars, levels, className,
}: {
  bars: ExpiryBar[];
  levels: TapeLevels;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<BaseChart | null>(null);
  const seriesRef = useRef<{
    straddle: ISeriesApi<'Line'>;
    iv: ISeriesApi<'Line'>;
    spot: ISeriesApi<'Line'>;
  } | null>(null);
  /** Price lines are objects that must be removed, not options that can be
   *  overwritten — kept so each redraw replaces rather than accumulates. */
  const linesRef = useRef<IPriceLine[]>([]);
  /*
   * The levels, readable from inside the autoscale callback.
   *
   * That callback is installed once at mount and runs on every frame, so it
   * cannot close over a prop — a ref is the only thing it can read that stays
   * current without re-creating the series.
   */
  const levelsRef = useRef<TapeLevels>(levels);
  levelsRef.current = levels;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const base = createBaseChart(host, {
      panes: [
        { caption: 'ATM straddle · IV', stretch: 2 },
        { caption: 'Spot · walls · gamma flip', stretch: 3 },
      ],
      leftScale: { visible: true, colour: (t) => t.iv },
    });
    baseRef.current = base;
    const { chart, theme } = base;

    const common = { priceLineVisible: false, lastValueVisible: true } as const;

    const straddle = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Straddle',
      color: theme.up, lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    }, 0);

    const iv = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'left', title: 'ATM IV',
      color: theme.iv, lineWidth: 1,
      priceFormat: { type: 'custom', formatter: (v: number) => `${v.toFixed(2)}%` },
    }, 0);

    /*
     * Spot gets the taller pane, which is the opposite of the straddle chart's
     * ratio and deliberate: this pane carries three horizontal levels as well
     * as a line, and a level is unreadable in a pane too short to show the gap
     * between it and the price.
     */
    const spot = chart.addSeries(LineSeries, {
      ...common, priceScaleId: 'right', title: 'Spot',
      color: theme.spot, lineWidth: 2,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
      /*
       * The scale has to contain the LEVELS, not just the line.
       *
       * Autoscaling to spot alone is what a price pane normally wants and is
       * exactly wrong here: on a quiet stretch the range collapses onto a few
       * points of spot — measured at 24,078.00 to 24,078.75 — and the call
       * wall, the put wall and the gamma flip all sit hundreds of points off
       * screen. The pane then shows a flat line and none of the four things it
       * exists to place that line against.
       *
       * Levels further than 3% away are left out. A stale wall from a distant
       * strike would otherwise crush the plot into a hairline to include a
       * level nobody is trading against.
       */
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const base = original();
        const { callWall, putWall, gammaFlip: flip, atmStrike } = levelsRef.current;
        // `priceRange` is nullable in the library's own type, and it is null
        // before the series has data — dereferencing it there would throw
        // inside a render callback, which takes the whole chart down.
        if (!base?.priceRange) return base;

        const centre = (base.priceRange.minValue + base.priceRange.maxValue) / 2;
        const band = centre * 0.03;
        const levelValues = [callWall, putWall, flip, atmStrike]
          .filter((v): v is number => v != null && Number.isFinite(v)
            && Math.abs(v - centre) <= band);
        if (!levelValues.length) return base;

        const min = Math.min(base.priceRange.minValue, ...levelValues);
        const max = Math.max(base.priceRange.maxValue, ...levelValues);
        // A level drawn exactly on the pane edge is half a line; the 2% margin
        // is what keeps its axis label readable.
        const pad = (max - min) * 0.02 || 1;
        return { priceRange: { minValue: min - pad, maxValue: max + pad } };
      },
    }, 1);

    stylePaneScale(base, 1);
    seriesRef.current = { straddle, iv, spot };

    return () => {
      base.dispose();
      baseRef.current = null;
      seriesRef.current = null;
      linesRef.current = [];
    };
  }, []);

  const data = useMemo(() => {
    const line = (pick: (b: ExpiryBar) => number | null) => {
      const out: Array<{ time: Time; value: number }> = [];
      let previous = -Infinity;
      for (const bar of bars) {
        const value = pick(bar);
        if (value == null || !Number.isFinite(value)) continue;
        const seconds = Math.floor(bar.time / 1000);
        // The library throws on a non-ascending series and takes the whole
        // chart with it; the store can legitimately re-emit the current minute.
        if (seconds <= previous) { out[out.length - 1] = { time: stamp(seconds), value }; continue; }
        previous = seconds;
        out.push({ time: stamp(seconds), value });
      }
      return out;
    };
    return {
      straddle: line((b) => b.straddle),
      iv: line((b) => b.iv),
      spot: line((b) => b.spot),
    };
  }, [bars]);

  useEffect(() => {
    const series = seriesRef.current;
    const base = baseRef.current;
    if (!series || !base) return;

    const grew = data.spot.length > 1;
    series.straddle.setData(data.straddle);
    series.iv.setData(data.iv);
    series.spot.setData(data.spot);

    // Rebuilt on every draw rather than diffed: there are at most four of them,
    // and a level that moved is a level whose old line must not survive.
    for (const line of linesRef.current) series.spot.removePriceLine(line);
    linesRef.current = [];

    const add = (price: number | null, title: string, colour: string, style: LineStyle) => {
      if (price == null || !Number.isFinite(price)) return;
      linesRef.current.push(series.spot.createPriceLine({
        price, title, color: colour, lineWidth: 1, lineStyle: style,
        axisLabelVisible: true,
      }));
    };

    add(levels.callWall, 'call wall', base.theme.ask, LineStyle.Dashed);
    add(levels.putWall, 'put wall', base.theme.bid, LineStyle.Dashed);
    add(levels.gammaFlip, 'γ flip', base.theme.spot, LineStyle.Dotted);
    add(levels.atmStrike, 'ATM', base.theme.compareBand, LineStyle.Dotted);

    if (grew) fitContentPadded(base.chart);
  }, [data, levels]);

  return <div ref={hostRef} className={className} />;
}

export const ExpiryTape = memo(ExpiryTapeImpl);
