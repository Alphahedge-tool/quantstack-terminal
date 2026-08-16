/**
 * Payoff chart — inline SVG.
 *
 * ── Why not the app's chart engine ──
 *
 * `lightweight-charts` is already here, and it is the wrong tool: its x-axis is
 * TIME, and this chart's x-axis is an underlying PRICE. The reference terminal
 * uses Highcharts for exactly that reason. Pulling Highcharts in for one panel
 * would add a commercially-licensed ~300kB dependency to a bundle that has one
 * charting engine already, so this draws the curve directly. It is a two-series
 * line chart with rules and a fill — well inside what SVG does without help.
 *
 * ── What it draws ──
 *
 *   expiry curve   solid, filled. P&L if every leg is held to settlement.
 *                  Always available: intrinsic value is arithmetic, not a model.
 *   T+n curve      dashed. P&L at the scenario horizon. Needs an implied vol per
 *                  leg, so it is absent when any leg has none — and its absence
 *                  is stated rather than drawn as a flat line.
 *   sign fill      green above zero, red below. Split exactly at the zero line
 *                  by clipping in pixel space, so the boundary cannot land a
 *                  fraction of a sample off the true crossing.
 *   rules          vertical at spot, each strike and each breakeven; horizontal
 *                  at zero.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import type { Leg, PayoffResult } from '@/lib/options/payoff';

const PAD = { top: 10, right: 12, bottom: 22, left: 54 };

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/**
 * The chart's non-data ink.
 *
 * Named here rather than inlined because the first pass got the level wrong
 * across the board. Grid, axes, strikes and breakevens were all drawn from the
 * recessive end of the token ladder — `--chart-grid` (#262523) and
 * `--text-disabled` — which is the right call for a dense time-series where
 * scaffolding competes with hundreds of marks. This plot has two lines and a
 * handful of rules, so nothing was competing, and the "recessive" choice just
 * made the reference lines invisible on the panel's own background.
 *
 * Each is one rung up, and the type is 10px rather than 9px. The DATA still
 * outranks all of it: the curves are 1.75px in full-strength market colours
 * against 1px rules in border greys.
 */
const INK = {
  grid: 'var(--border-default)',
  axisText: 'var(--text-tertiary)',
  strike: 'var(--border-strong)',
  zero: 'var(--text-tertiary)',
  breakeven: 'var(--text-secondary)',
  crosshair: 'var(--text-primary)',
} as const;

const LABEL_SIZE = 10;

/** Width from the element, height from the caller. A percentage-width SVG with
 *  a fixed viewBox would either letterbox or stretch its type. */
function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** Nice round tick values across a domain. */
function ticks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(v);
  return out;
}

export interface PayoffChartProps {
  payoff: PayoffResult;
  legs: Leg[];
  spot: number;
  /** Label for the dashed curve, e.g. "Now" or "T+7d". */
  horizonLabel: string;
  height?: number;
}

export function PayoffChart({ payoff, legs, spot, horizonLabel, height = 260 }: PayoffChartProps) {
  const [ref, width] = useWidth();
  const [hoverX, setHoverX] = useState<number | null>(null);

  const strikes = useMemo(
    () => [...new Set(legs.map((l) => l.strike).filter((s): s is number => s != null))].sort((a, b) => a - b),
    [legs],
  );

  const geometry = useMemo(() => {
    const innerW = Math.max(0, width - PAD.left - PAD.right);
    const innerH = Math.max(0, height - PAD.top - PAD.bottom);

    /*
     * X domain: the region worth reading, not the whole sampled range.
     *
     * An uncapped strategy loses without bound at the edge of the range, so
     * scaling to the data flattens everything between the breakevens into a
     * single line — on a live book, a NIFTY position with a naked short showed a
     * −12,00,000 tail that compressed a +23,614 tent to two pixels. The focus
     * window is the strikes, breakevens and spot plus a margin; the tails still
     * run off the edge, which is the honest picture of unlimited risk.
     */
    const features = [...strikes, ...payoff.breakevens, spot].filter(Number.isFinite);
    const fLo = features.length ? Math.min(...features) : 0;
    const fHi = features.length ? Math.max(...features) : 1;
    const margin = Math.max((fHi - fLo) * 0.35, spot * 0.02, 1);
    const xLo = fLo - margin;
    const xHi = fHi + margin;

    const inFocus = payoff.samples.filter((s) => s.underlying >= xLo && s.underlying <= xHi);
    const ys = inFocus.flatMap((s) => [
      s.expiry,
      ...(payoff.ivComplete && Number.isFinite(s.current) ? [s.current] : []),
    ]);
    const rawLo = ys.length ? Math.min(...ys) : 0;
    const rawHi = ys.length ? Math.max(...ys) : 0;
    const pad = Math.max((rawHi - rawLo) * 0.18, 1);
    const yLo = rawLo - pad;
    const yHi = rawHi + pad;

    const x = (v: number) => PAD.left + ((v - xLo) / (xHi - xLo || 1)) * innerW;
    const y = (v: number) => PAD.top + ((yHi - v) / (yHi - yLo || 1)) * innerH;

    return { innerW, innerH, xLo, xHi, yLo, yHi, x, y };
  }, [width, height, payoff, strikes, spot]);

  const { innerW, innerH, xLo, xHi, yLo, yHi, x, y } = geometry;

  const paths = useMemo(() => {
    if (innerW <= 0) return { expiryLine: '', expiryArea: '', currentLine: '' };

    const visible = payoff.samples.filter((s) => s.underlying >= xLo && s.underlying <= xHi);
    if (!visible.length) return { expiryLine: '', expiryArea: '', currentLine: '' };

    const line = (pick: (s: (typeof visible)[number]) => number) => {
      let d = '';
      let open = false;
      for (const sample of visible) {
        const v = pick(sample);
        if (!Number.isFinite(v)) {
          open = false;
          continue;
        }
        d += `${open ? 'L' : 'M'}${x(sample.underlying).toFixed(2)},${y(v).toFixed(2)}`;
        open = true;
      }
      return d;
    };

    const expiryLine = line((s) => s.expiry);
    const zero = y(0);
    const first = visible[0];
    const last = visible[visible.length - 1];
    const expiryArea = expiryLine
      ? `${expiryLine}L${x(last.underlying).toFixed(2)},${zero.toFixed(2)}` +
        `L${x(first.underlying).toFixed(2)},${zero.toFixed(2)}Z`
      : '';

    const currentLine = payoff.ivComplete ? line((s) => s.current) : '';

    return { expiryLine, expiryArea, currentLine };
  }, [payoff, innerW, xLo, xHi, x, y]);

  /** Nearest sample to the pointer — the payoff is read at a price, so snapping
   *  to a sample is what makes the readout correspond to the drawn curve. */
  const hovered = useMemo(() => {
    if (hoverX == null || !payoff.samples.length) return null;
    const target = xLo + ((hoverX - PAD.left) / (innerW || 1)) * (xHi - xLo);
    let best = payoff.samples[0];
    for (const sample of payoff.samples) {
      if (Math.abs(sample.underlying - target) < Math.abs(best.underlying - target)) best = sample;
    }
    return best.underlying >= xLo && best.underlying <= xHi ? best : null;
  }, [hoverX, payoff.samples, xLo, xHi, innerW]);

  const zeroY = y(0);
  const profit = 'var(--market-up)';
  const loss = 'var(--market-down)';

  return (
    <div ref={ref} className="relative w-full" style={{ height }}>
      {width > 0 ? (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Strategy payoff across underlying price"
          onMouseMove={(event) =>
            setHoverX(event.clientX - event.currentTarget.getBoundingClientRect().left)
          }
          onMouseLeave={() => setHoverX(null)}
        >
          <defs>
            {/* The sign split. Clipping at the zero line in PIXEL space puts the
                boundary exactly on the axis, rather than at whichever sample
                happened to be nearest the crossing. */}
            <clipPath id="payoff-above">
              <rect x={PAD.left} y={PAD.top} width={innerW} height={Math.max(0, zeroY - PAD.top)} />
            </clipPath>
            <clipPath id="payoff-below">
              <rect
                x={PAD.left}
                y={Math.max(PAD.top, zeroY)}
                width={innerW}
                height={Math.max(0, PAD.top + innerH - zeroY)}
              />
            </clipPath>
            <clipPath id="payoff-plot">
              <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} />
            </clipPath>
          </defs>

          {/* Y grid and labels */}
          {ticks(yLo, yHi, 4).map((v) => (
            <g key={`y${v}`}>
              <line
                x1={PAD.left}
                x2={PAD.left + innerW}
                y1={y(v)}
                y2={y(v)}
                stroke={INK.grid}
                strokeWidth={1}
              />
              <text
                x={PAD.left - 6}
                y={y(v) + 3}
                textAnchor="end"
                fill={INK.axisText}
                className="font-mono"
                style={{ fontSize: LABEL_SIZE }}
              >
                {inr.format(v)}
              </text>
            </g>
          ))}

          {/* X labels */}
          {ticks(xLo, xHi, 5).map((v) => (
            <text
              key={`x${v}`}
              x={x(v)}
              y={height - 6}
              textAnchor="middle"
              fill={INK.axisText}
              className="font-mono"
              style={{ fontSize: LABEL_SIZE }}
            >
              {inr.format(v)}
            </text>
          ))}

          {/* Strikes — where the payoff kinks. */}
          {strikes.map((k) =>
            k >= xLo && k <= xHi ? (
              <line
                key={`k${k}`}
                x1={x(k)}
                x2={x(k)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke={INK.strike}
                strokeWidth={1}
                strokeDasharray="2 3"
              />
            ) : null,
          )}

          {/* Zero — the line every value on this chart is measured against, so
              it is the one rule that reads as structure rather than as grid. */}
          <line
            x1={PAD.left}
            x2={PAD.left + innerW}
            y1={zeroY}
            y2={zeroY}
            stroke={INK.zero}
            strokeWidth={1.25}
          />

          {/* The expiry curve, filled and stroked by sign. */}
          <g clipPath="url(#payoff-plot)">
            <g clipPath="url(#payoff-above)">
              <path d={paths.expiryArea} fill={profit} fillOpacity={0.16} />
              <path d={paths.expiryLine} fill="none" stroke={profit} strokeWidth={1.75} />
            </g>
            <g clipPath="url(#payoff-below)">
              <path d={paths.expiryArea} fill={loss} fillOpacity={0.16} />
              <path d={paths.expiryLine} fill="none" stroke={loss} strokeWidth={1.75} />
            </g>

            {paths.currentLine ? (
              <path
                d={paths.currentLine}
                fill="none"
                stroke="var(--series-sf)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            ) : null}
          </g>

          {/* Breakevens */}
          {payoff.breakevens.map((be) =>
            be >= xLo && be <= xHi ? (
              <g key={`be${be}`}>
                <line
                  x1={x(be)}
                  x2={x(be)}
                  y1={PAD.top}
                  y2={PAD.top + innerH}
                  stroke={INK.breakeven}
                  strokeWidth={1}
                  strokeDasharray="3 3"
                />
                <text
                  x={x(be)}
                  y={PAD.top + 9}
                  textAnchor="middle"
                  fill={INK.breakeven}
                  className="font-mono"
                  style={{ fontSize: LABEL_SIZE }}
                >
                  {inr.format(be)}
                </text>
              </g>
            ) : null,
          )}

          {/* Spot — where you actually are on the curve. */}
          {spot >= xLo && spot <= xHi ? (
            <g>
              <line
                x1={x(spot)}
                x2={x(spot)}
                y1={PAD.top}
                y2={PAD.top + innerH}
                stroke="var(--accent-info)"
                strokeWidth={1.5}
              />
              <text
                x={x(spot)}
                y={PAD.top + innerH - 4}
                textAnchor="middle"
                fill="var(--accent-info-hover)"
                className="font-mono"
                style={{ fontSize: LABEL_SIZE }}
              >
                {inr.format(spot)}
              </text>
            </g>
          ) : null}

          {hovered ? (
            <line
              x1={x(hovered.underlying)}
              x2={x(hovered.underlying)}
              y1={PAD.top}
              y2={PAD.top + innerH}
              stroke={INK.crosshair}
              strokeWidth={1}
              strokeDasharray="2 2"
            />
          ) : null}
        </svg>
      ) : null}

      {hovered ? (
        <div
          className={cn(
            'pointer-events-none absolute top-1 rounded-[var(--radius-sm)] border px-2 py-1',
            'border-[var(--container-border)] bg-[var(--surface-overlay)]',
            'text-[length:var(--type-micro)] leading-snug whitespace-nowrap',
          )}
          style={{
            // Flip to the left of the cursor past the midpoint so the tooltip
            // never runs off the panel.
            left: x(hovered.underlying) > PAD.left + innerW / 2 ? undefined : x(hovered.underlying) + 8,
            right:
              x(hovered.underlying) > PAD.left + innerW / 2
                ? width - x(hovered.underlying) + 8
                : undefined,
          }}
        >
          <div className="qs-num text-[var(--text-primary)]">{inr.format(hovered.underlying)}</div>
          <div className="mt-0.5 flex gap-2">
            <span className="text-[var(--text-tertiary)]">Expiry</span>
            <span
              className="qs-num"
              style={{ color: hovered.expiry >= 0 ? profit : loss }}
            >
              {hovered.expiry >= 0 ? '+' : '−'}
              {inr.format(Math.abs(hovered.expiry))}
            </span>
          </div>
          {payoff.ivComplete && Number.isFinite(hovered.current) ? (
            <div className="flex gap-2">
              <span className="text-[var(--text-tertiary)]">{horizonLabel}</span>
              <span
                className="qs-num"
                style={{ color: hovered.current >= 0 ? profit : loss }}
              >
                {hovered.current >= 0 ? '+' : '−'}
                {inr.format(Math.abs(hovered.current))}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}

      {!payoff.ivComplete ? (
        <div className="pointer-events-none absolute bottom-0 left-[54px] text-[length:var(--type-micro)] text-[var(--status-warning)]">
          {horizonLabel} curve unavailable — no implied vol for every leg
        </div>
      ) : null}
    </div>
  );
}
