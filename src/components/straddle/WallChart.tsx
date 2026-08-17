/**
 * N straddles on one time axis.
 *
 * ── The scaling problem this exists to solve ──
 *
 * Measured on the live backend, 2026-08-17: NIFTY traded 113–149, CRUDEOIL
 * 92–176, SENSEX 630–761, BANKNIFTY 309–890. Put those four on a shared rupee
 * axis and NIFTY and CRUDEOIL are two flat lines pinned to the floor while
 * BANKNIFTY owns the pane — a chart that technically shows four straddles and
 * legibly shows one.
 *
 * So PERCENT is the default and the point: each leg is drawn as its change from
 * its own session baseline, which makes the four directly comparable and gives
 * every one of them the full height of the pane. Zero is drawn, because on a
 * percent chart the sign is the reading.
 *
 * ABSOLUTE is offered anyway — but one leg per pane. "How much premium is
 * BANKNIFTY actually carrying" is a real question percent cannot answer, and it
 * is a question about ONE contract, so that mode gives each its own chart rather
 * than pretending four rupee scales can share an axis.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { LineSeries, LineStyle, type IPriceLine, type ISeriesApi } from 'lightweight-charts';
import { createBaseChart, fitContentPadded, stamp, type BaseChart } from '@/lib/chartBase';
import { istClockSeconds } from '@/lib/chartTheme';
import { cn } from '@/lib/cn';

export interface WallPoint {
  time: number;
  value: number;
  /**
   * The SAME instant in the other unit, pre-formatted.
   *
   * Carried on the point rather than looked up because the tooltip needs it and
   * the chart has no way back from a percentage to the premium it came from. On
   * a percent chart the note is the premium in rupees; on a rupee chart it is
   * the percent. Whichever unit the axis is in, the reader gets the other one
   * without switching modes — which is the question a normalised chart otherwise
   * cannot answer at all.
   */
  note?: string;
}

export interface WallSeries {
  key: string;
  label: string;
  colour: string;
  data: WallPoint[];
}

interface Props {
  series: WallSeries[];
  height: string;
  /** `%` formats the axis with a sign and pins a zero line; `abs` is rupees. */
  unit: '%' | 'abs';
  caption: string;
}

interface TipRow {
  key: string;
  label: string;
  colour: string;
  value: number;
  note?: string;
}

interface Tip {
  x: number;
  y: number;
  /** Plot width, so the flip threshold is relative rather than a magic number. */
  width: number;
  time: number;
  rows: TipRow[];
}

function WallChartImpl({ series, height, unit, caption }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<BaseChart | null>(null);
  const linesRef = useRef(new Map<string, ISeriesApi<'Line'>>());
  /** The zero baseline, so it can be removed before being re-added. */
  const zeroRef = useRef<{ series: ISeriesApi<'Line'>; line: IPriceLine } | null>(null);
  /** Series identity, so growth can be told from replacement — see StraddleChart. */
  const drawnRef = useRef({ keys: '', firstBar: 0, count: 0 });

  const [tip, setTip] = useState<Tip | null>(null);

  /*
   * The crosshair handler is installed ONCE, at mount, and reads the current
   * series through refs.
   *
   * Re-subscribing whenever the data changes would drop the crosshair mid-drag —
   * and with a live feed the data changes every second, so the tooltip would
   * vanish under the cursor about as often as it appeared.
   */
  const specsRef = useRef(series);
  specsRef.current = series;
  const noteRef = useRef(new Map<string, Map<number, string>>());
  noteRef.current = useMemo(() => {
    const map = new Map<string, Map<number, string>>();
    for (const s of series) {
      const notes = new Map<number, string>();
      for (const p of s.data) if (p.note) notes.set(p.time, p.note);
      map.set(s.key, notes);
    }
    return map;
  }, [series]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const base = createBaseChart(host, { panes: [{ caption, stretch: 1 }] });
    baseRef.current = base;

    const onCrosshair: Parameters<typeof base.chart.subscribeCrosshairMove>[0] = (param) => {
      // Outside the plot, or between bars: clear rather than freeze. A tooltip
      // left showing the last value the cursor happened to cross reads as the
      // value under the cursor now.
      if (param.time == null || !param.point) {
        setTip(null);
        return;
      }
      const at = typeof param.time === 'number' ? param.time : 0;

      const rows: TipRow[] = [];
      for (const spec of specsRef.current) {
        const api = linesRef.current.get(spec.key);
        if (!api) continue;
        const bar = param.seriesData.get(api) as { value?: number } | undefined;
        if (bar?.value == null || !Number.isFinite(bar.value)) continue;
        rows.push({
          key: spec.key,
          label: spec.label,
          colour: spec.colour,
          value: bar.value,
          note: noteRef.current.get(spec.key)?.get(at),
        });
      }
      if (!rows.length) {
        setTip(null);
        return;
      }
      // Sorted by magnitude so the leader is always the top line — on four
      // series that is the whole reading, and alphabetical order would make it a
      // scan instead of a glance.
      rows.sort((a, b) => b.value - a.value);
      setTip({
        x: param.point.x,
        y: param.point.y,
        // Measured, not assumed. The flip threshold has to be relative to the
        // plot: a fixed pixel cut-off flips too early on a wide monitor and too
        // late in a 2x2 grid cell, and "too late" means the leader row is the
        // first thing clipped off the edge.
        width: host.clientWidth,
        time: at,
        rows,
      });
    };

    base.chart.subscribeCrosshairMove(onCrosshair);

    return () => {
      base.chart.unsubscribeCrosshairMove(onCrosshair);
      setTip(null);
      base.dispose();
      baseRef.current = null;
      linesRef.current.clear();
      zeroRef.current = null;
      drawnRef.current = { keys: '', firstBar: 0, count: 0 };
    };
    // Caption is baked in at creation. Rebuilding on a change is cheaper than
    // reconciling the watermark, and it changes only when the mode does.
  }, [caption]);

  useEffect(() => {
    const base = baseRef.current;
    if (!base) return;
    const lines = linesRef.current;

    /*
     * Series are added and removed to MATCH the incoming set rather than rebuilt
     * wholesale. A leg whose history is still loading arrives empty and then with
     * 22,000 points; tearing the other three down each time that happened would
     * reset their zoom three times over during first load.
     */
    for (const [key, api] of lines) {
      if (!series.some((s) => s.key === key)) {
        if (zeroRef.current?.series === api) zeroRef.current = null;
        base.chart.removeSeries(api);
        lines.delete(key);
      }
    }

    for (const spec of series) {
      let api = lines.get(spec.key);
      if (!api) {
        api = base.chart.addSeries(LineSeries, {
          color: spec.colour,
          lineWidth: 2,
          title: spec.label,
          priceScaleId: 'right',
          priceLineVisible: false,
          priceFormat:
            unit === '%'
              ? { type: 'custom', formatter: (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` }
              : { type: 'price', precision: 2, minMove: 0.05 },
        });
        lines.set(spec.key, api);
      } else {
        api.applyOptions({ color: spec.colour, title: spec.label });
      }
      api.setData(spec.data.map((d) => ({ time: stamp(d.time), value: d.value })));
    }

    /*
     * Zero, on percent only.
     *
     * On a percent chart the sign IS the reading — is this straddle above or
     * below where it opened — and a baseline the eye has to infer from the axis
     * labels makes that a two-step lookup every glance. A price line rather than
     * a series, so it cannot reach the legend or drive autoscaling.
     *
     * Removed before re-adding: `createPriceLine` has no upsert, so re-adding
     * without removing stacks another line on every data change.
     */
    if (unit === '%') {
      if (zeroRef.current) {
        try { zeroRef.current.series.removePriceLine(zeroRef.current.line); }
        catch { /* series already gone */ }
        zeroRef.current = null;
      }
      const host = series[0] ? lines.get(series[0].key) : null;
      if (host) {
        zeroRef.current = {
          series: host,
          line: host.createPriceLine({
            price: 0,
            color: base.theme.border,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            axisLabelVisible: false,
            title: '',
          }),
        };
      }
    }

    /*
     * Viewport: fit on replacement, follow the live edge on growth.
     *
     * The same rule as StraddleChart, and for the same reason — an
     * unconditional fit on every live flush widens the range a bar at a time and
     * the plot appears to crawl leftwards, discarding any pan as it goes.
     */
    const keys = series.map((s) => s.key).join(',');
    const longest = series.reduce((m, s) => Math.max(m, s.data.length), 0);
    const firstBar = series.reduce(
      (m, s) => (s.data.length ? Math.min(m, s.data[0].time) : m),
      Number.POSITIVE_INFINITY,
    );

    const drawn = drawnRef.current;
    const grew = drawn.count > 0 && keys === drawn.keys
      && firstBar === drawn.firstBar && longest >= drawn.count;

    const scale = base.chart.timeScale();
    if (!grew) {
      fitContentPadded(base.chart);
    } else {
      const range = scale.getVisibleLogicalRange();
      const added = longest - drawn.count;
      // Two bars of slack: the gutter and fractional logical positions put `to`
      // slightly past the final index even when the edge is in view.
      if (range && added > 0 && range.to >= drawn.count - 1 - 2) {
        scale.setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      }
    }
    drawnRef.current = { keys, firstBar, count: longest };
  }, [series, unit]);

  return (
    <div className="relative w-full" style={{ height }}>
      <div ref={hostRef} className="absolute inset-0" />
      {tip ? <Tooltip tip={tip} unit={unit} /> : null}
    </div>
  );
}

/**
 * The crosshair tooltip.
 *
 * ── Placement ──
 *
 * Offset from the cursor and FLIPPED near the right edge, because a tooltip that
 * runs off the plot is worse than none — the leader is the row it clips first,
 * and the leader is what the reader came for. `pointer-events-none` so it can
 * never eat the drag that pans the chart.
 *
 * ── Why both units per row ──
 *
 * On the compare pane the axis is percent, which cannot answer "and what is it
 * actually trading at". The note carries the premium, so the tooltip is the one
 * place both readings meet and switching modes is never required to get a level.
 */
function Tooltip({ tip, unit }: { tip: Tip; unit: '%' | 'abs' }) {
  // 190px is the tooltip's own min-width plus its offset; past that point on the
  // right it would overhang the plot.
  const flip = tip.x > tip.width - 190;
  const fmt = (v: number) =>
    unit === '%' ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : v.toFixed(2);

  return (
    <div
      className={cn(
        'pointer-events-none absolute z-10 min-w-36 rounded-[var(--radius-md)]',
        'border border-[var(--border-default)] bg-[var(--surface-overlay)]',
        'px-2.5 py-2 shadow-lg',
      )}
      style={{
        left: flip ? undefined : tip.x + 14,
        transform: flip ? `translateX(calc(${tip.x}px - 100% - 14px))` : undefined,
        top: Math.max(4, tip.y - 12),
      }}
    >
      <p className="qs-num mb-1.5 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
        {istClockSeconds(tip.time)}
      </p>
      <div className="flex flex-col gap-1">
        {tip.rows.map((row) => (
          <div key={row.key} className="flex items-baseline gap-2">
            <span
              className="size-2 shrink-0 translate-y-px rounded-full"
              style={{ backgroundColor: row.colour }}
              aria-hidden="true"
            />
            <span className="qs-label mr-auto text-[var(--text-secondary)]">{row.label}</span>
            <span
              className="qs-num text-[length:var(--type-caption)]"
              style={{
                // Sign-coloured on percent, where the sign is the reading;
                // neutral on rupees, where a premium is not up or down by itself.
                color:
                  unit === '%'
                    ? row.value > 0
                      ? 'var(--market-up)'
                      : row.value < 0
                        ? 'var(--market-down)'
                        : 'var(--text-primary)'
                    : 'var(--text-primary)',
              }}
            >
              {fmt(row.value)}
            </span>
            {row.note ? (
              <span className="qs-num w-14 shrink-0 text-right text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                {row.note}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export const WallChart = memo(WallChartImpl);
