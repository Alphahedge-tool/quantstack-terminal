/**
 * Inline SVG multi-series line chart.
 *
 * ── Deliberate constraints ──
 *
 * ONE y-axis. Series handed to this component must share a unit, and the API
 * gives no way to say otherwise. Two measures of different scale on one plot
 * (premium and spot, say) produce a chart whose crossings are an artefact of
 * two arbitrary scalings — so those become two charts stacked, not two axes.
 *
 * Colours come from the validated categorical slots in fixed order and are
 * never cycled: past three series the answer is small multiples, not a
 * generated fourth hue.
 *
 * Identity is never carried by colour alone. A legend is always present for two
 * or more series, and the last point of each is directly labelled — so the plot
 * still reads for someone who cannot separate the hues, and on a printout.
 */

import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

export interface Series {
  id: string;
  label: string;
  /** Parallel to `x`; null marks a gap the line should break across rather
   *  than interpolate over. */
  values: Array<number | null>;
}

interface LineChartProps {
  x: number[];
  series: Series[];
  height?: number;
  /** Formats the y value in the tooltip, the axis and the direct labels. */
  formatValue?: (value: number) => string;
  formatX?: (value: number) => string;
  className?: string;
}

const SLOTS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)'];

const PAD = { top: 12, right: 64, bottom: 24, left: 56 };

/** Axis ticks on rounded values, not on evenly divided extremes — an axis
 *  reading 1,237 / 1,449 / 1,661 is arithmetically fine and unreadable. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.01; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

export function LineChart({
  x,
  series,
  height = 260,
  formatValue = (v) => v.toFixed(2),
  formatX = (v) => String(v),
  className,
}: LineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Measured rather than fixed so the plot fills whatever column it lands in.
  const [width, setWidth] = useState(720);

  const bounds = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const s of series) {
      for (const v of s.values) {
        if (v === null || !Number.isFinite(v)) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min)) return { min: 0, max: 1 };
    if (min === max) return { min: min - 1, max: max + 1 };
    // A little headroom so the extreme point is not welded to the frame.
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  }, [series]);

  const plotW = Math.max(80, width - PAD.left - PAD.right);
  const plotH = Math.max(60, height - PAD.top - PAD.bottom);

  const scaleX = (i: number) => PAD.left + (x.length <= 1 ? plotW / 2 : (i / (x.length - 1)) * plotW);
  const scaleY = (v: number) =>
    PAD.top + plotH - ((v - bounds.min) / (bounds.max - bounds.min)) * plotH;

  /** Path builder that breaks on nulls instead of bridging them — a bridged gap
   *  invents data that was never received. */
  function pathFor(values: Array<number | null>): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${scaleX(i).toFixed(2)},${scaleY(v).toFixed(2)}`;
      pen = true;
    });
    return d;
  }

  const ticks = niceTicks(bounds.min, bounds.max);

  function onMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || x.length === 0) return;
    const px = event.clientX - rect.left;
    const ratio = (px - PAD.left) / plotW;
    const index = Math.round(ratio * (x.length - 1));
    setHover(Math.max(0, Math.min(x.length - 1, index)));
  }

  if (x.length === 0) return null;

  return (
    <div
      className={cn('relative w-full', className)}
      ref={(node) => {
        if (node && node.clientWidth && node.clientWidth !== width) setWidth(node.clientWidth);
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Line chart: ${series.map((s) => s.label).join(', ')}`}
      >
        {/* Grid — recessive. It locates the marks; it must not compete. */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={PAD.left + plotW}
              y1={scaleY(tick)}
              y2={scaleY(tick)}
              stroke="var(--chart-grid)"
              strokeWidth={1}
            />
            <text
              x={PAD.left - 8}
              y={scaleY(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fill="var(--text-tertiary)"
              fontSize={10}
              fontFamily="var(--font-mono)"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        {/* X labels at the ends only. A label under every point is noise, and
            the tooltip carries the exact value for any point in between. */}
        <text
          x={PAD.left}
          y={height - 6}
          fill="var(--text-tertiary)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {formatX(x[0])}
        </text>
        <text
          x={PAD.left + plotW}
          y={height - 6}
          textAnchor="end"
          fill="var(--text-tertiary)"
          fontSize={10}
          fontFamily="var(--font-mono)"
        >
          {formatX(x[x.length - 1])}
        </text>

        {/* Crosshair under the marks, so it never occludes the data. */}
        {hover !== null ? (
          <line
            x1={scaleX(hover)}
            x2={scaleX(hover)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            stroke="var(--border-strong)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ) : null}

        {series.map((s, index) => {
          const colour = SLOTS[index % SLOTS.length];
          // Explicitly a number: reduce over an Array<number | null> otherwise
          // widens the accumulator to match the element type, and the index
          // this produces is never null.
          const lastIndex = s.values.reduce<number>(
            (acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc),
            -1,
          );
          const lastValue: number | null = lastIndex >= 0 ? (s.values[lastIndex] ?? null) : null;

          return (
            <g key={s.id}>
              <path
                d={pathFor(s.values)}
                fill="none"
                stroke={colour}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />

              {/* Direct label at the series' last point — identity without
                  requiring a trip to the legend, and it survives greyscale. */}
              {lastValue !== null && lastIndex >= 0 ? (
                <>
                  <circle
                    cx={scaleX(lastIndex)}
                    cy={scaleY(lastValue)}
                    r={3}
                    fill={colour}
                    // A surface-coloured ring keeps overlapping end-points from
                    // merging into one blob.
                    stroke="var(--surface-chart)"
                    strokeWidth={2}
                  />
                  <text
                    x={scaleX(lastIndex) + 8}
                    y={scaleY(lastValue)}
                    dominantBaseline="middle"
                    fill="var(--text-secondary)"
                    fontSize={10}
                    fontFamily="var(--font-mono)"
                  >
                    {formatValue(lastValue)}
                  </text>
                </>
              ) : null}

              {/* Hover marker */}
              {hover !== null && s.values[hover] !== null && Number.isFinite(s.values[hover]!) ? (
                <circle
                  cx={scaleX(hover)}
                  cy={scaleY(s.values[hover]!)}
                  r={4}
                  fill={colour}
                  stroke="var(--surface-chart)"
                  strokeWidth={2}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Tooltip. HTML rather than SVG so it can use the app's type tokens and
          wrap normally. */}
      {hover !== null ? (
        <div
          className="pointer-events-none absolute z-[var(--z-tooltip)] min-w-[8rem] rounded-[var(--radius-sm)] border border-[var(--border-strong)] bg-[var(--surface-overlay)] px-2.5 py-2 shadow-[var(--shadow-lg)]"
          style={{
            // Flip to the left of the crosshair past the midpoint so the
            // tooltip never runs off the right edge.
            left: scaleX(hover) > width / 2 ? undefined : scaleX(hover) + 12,
            right: scaleX(hover) > width / 2 ? width - scaleX(hover) + 12 : undefined,
            top: PAD.top,
          }}
        >
          <div className="mb-1 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
            {formatX(x[hover])}
          </div>
          {series.map((s, index) => {
            const value = s.values[hover];
            return (
              <div key={s.id} className="flex items-center justify-between gap-3 py-0.5">
                <span className="flex items-center gap-1.5">
                  <span
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: SLOTS[index % SLOTS.length] }}
                  />
                  {/* Label in text ink, never the series colour — the swatch
                      beside it already carries identity. */}
                  <span className="text-[length:var(--type-micro)] text-[var(--text-secondary)]">
                    {s.label}
                  </span>
                </span>
                <span className="qs-num text-[length:var(--type-micro)] text-[var(--text-primary)]">
                  {value === null || !Number.isFinite(value) ? '—' : formatValue(value)}
                </span>
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Legend — always present for two or more series. */}
      {series.length > 1 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-[56px]">
          {series.map((s, index) => (
            <span key={s.id} className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{ background: SLOTS[index % SLOTS.length] }}
              />
              <span className="text-[length:var(--type-micro)] text-[var(--text-secondary)]">
                {s.label}
              </span>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
