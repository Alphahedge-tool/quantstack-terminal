/**
 * The chrome around every canvas chart: toolbar, readout row, inset plot.
 *
 * Pairs with `lib/chartBase.ts` — that file makes every chart LOOK the same,
 * this one makes every chart WORK the same. Interval switch on the left, series
 * toggles doubling as the legend on the right, a reserved readout row, and the
 * plot inset from the panel edge. A chart component supplies its series
 * descriptors and its readout content and gets the rest.
 *
 * ── Why the readout is a reserved row ──
 *
 * Not an overlay in the plot's top-left corner, which is where TradingView puts
 * it: there is a left price scale there on these charts, and the overlay landed
 * on both the axis labels and the pane caption. Not a pointer-following tooltip
 * either — at one-second resolution a tooltip covers the exact bars being
 * compared. And reserved rather than shown-on-hover, because a row that appears
 * under the pointer would shove the plot down 22px every time the pointer
 * entered it.
 */

import { useCallback, type ReactNode } from 'react';
import { Crosshair, Maximize2 } from 'lucide-react';
import { SegmentedControl } from '@/components/ui/Field';
import type { IntervalOption } from '@/lib/chartBase';
import { cn } from '@/lib/cn';

/** One toggleable series, as the legend and the toggles both need it. */
export interface SeriesToggle {
  key: string;
  label: string;
  /** A CSS colour — normally a `var(--series-*)` from the token ladder. */
  colour: string;
}

interface Props {
  intervals: readonly IntervalOption[];
  interval: string;
  onIntervalChange: (value: string) => void;

  toggles: SeriesToggle[];
  visible: Record<string, boolean>;
  onToggle: (key: string) => void;

  /**
   * Controls that sit BEFORE the interval switch — currently the compare
   * picker. Ahead of the interval rather than beside the toggles because it
   * changes what the chart is showing, not how finely it is sampled, and the
   * eye reads the toolbar left to right as subject-then-resolution.
   */
  leading?: ReactNode;
  /** Rendered in the readout row. Null shows the hover hint instead. */
  readout: ReactNode;
  /** Incidental counts shown beside the interval switch; hidden when dense. */
  meta?: ReactNode;
  onFit: () => void;

  /**
   * The FLOOR for the plot, as a CSS length — see `LayoutSpec.minHeight`.
   *
   * The frame fills its parent and the canvas takes whatever is left below the
   * toolbar and the readout, so this is only the height at which the pane stops
   * shrinking. lightweight-charts is created with `autoSize`, which watches the
   * host element, so the canvas follows the box without being told a number.
   */
  height: number | string;
  /**
   * Narrow mode, for a slot in a multi-chart layout.
   *
   * Sheds the meta counter and the chips' words. The interval switch and the
   * toggles STAY: a small chart is not a chart that needs fewer controls, and
   * hiding them behind an overflow menu is how a grid layout becomes worse than
   * the single one it replaced.
   */
  dense?: boolean;
  hostRef: React.Ref<HTMLDivElement>;
  className?: string;
}

export function ChartFrame({
  intervals, interval, onIntervalChange,
  toggles, visible, onToggle,
  leading, readout, meta, onFit, height, dense = false, hostRef, className,
}: Props) {
  const handleInterval = useCallback(
    (value: string) => onIntervalChange(value),
    [onIntervalChange],
  );

  return (
    // `min-h-0` on a flex child is what allows it to be SHORTER than its
    // content. Without it the toolbar, the readout and the plot's own floor
    // add up to a minimum the parent cannot override, and the panel grows past
    // the grid row instead of fitting inside it.
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      {/*
        One row of toolbar, and the plot gets the rest.

        `py-1` rather than `py-2`: the tallest thing on this row is a 32px
        control, and the padding around it was buying nothing but height at the
        direct expense of the canvas — which is the only part of a chart panel
        anyone is looking at.

        Still `flex-wrap`, because a genuinely narrow pane has to degrade to a
        second line rather than clip its controls. What changed is that nothing
        on the row can FORCE that wrap any more: the one variable-width item —
        the compare note — is laid out at a zero base size and truncates (see
        `leading` in StraddleChart), so the row wraps only when the controls
        themselves stop fitting.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-1">
        {leading}
        <SegmentedControl
          value={interval}
          options={intervals.map((i) => ({ value: i.value, label: i.label }))}
          onChange={handleInterval}
        />

        {!dense && meta ? (
          <span className="qs-num text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
            {meta}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          {/* Toggles double as the legend, so identity and control are the same
              affordance rather than two lists to keep in sync. Dense drops to
              swatches alone — the tooltip and the accessible name keep the word,
              and the readout below names every series anyway. */}
          {toggles.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => onToggle(item.key)}
              aria-pressed={visible[item.key] ?? true}
              aria-label={`Toggle ${item.label}`}
              title={`Toggle ${item.label}`}
              className={cn(
                'flex items-center rounded-[var(--radius-xs)] py-1',
                'text-[length:var(--type-micro)] transition-colors duration-100',
                'hover:bg-[var(--surface-hover)]',
                dense ? 'px-1' : 'gap-1.5 px-1.5',
                visible[item.key] ?? true
                  ? 'text-[var(--text-secondary)]'
                  : 'text-[var(--text-disabled)] opacity-50',
              )}
            >
              <span
                className="size-2 shrink-0 rounded-[2px]"
                style={{
                  background: item.colour,
                  opacity: (visible[item.key] ?? true) ? 1 : 0.35,
                }}
              />
              {dense ? null : item.label}
            </button>
          ))}

          <button
            type="button"
            onClick={onFit}
            title="Fit the whole session"
            className="flex size-7 items-center justify-center rounded-[var(--radius-xs)] text-[var(--text-tertiary)] transition-colors duration-100 hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
          >
            <Maximize2 size={13} />
          </button>
        </div>
      </div>

      {/* `truncate` and not `flex-wrap` — a second line would resize the plot
          mid-read. 20px is the tightest this row goes while still clearing the
          descenders on a 10px micro face; below that the figures start looking
          clipped, which on a row of prices reads as a rendering fault. */}
      <div className="flex h-5 shrink-0 items-center gap-x-3 overflow-hidden whitespace-nowrap border-b border-[var(--border-subtle)] px-3 text-[length:var(--type-micro)]">
        {readout ?? (
          <span className="flex items-center gap-1 text-[var(--text-tertiary)]">
            <Crosshair size={11} /> Hover for the tick behind a bar
          </span>
        )}
      </div>

      {/* The plot is inset from the panel edge. Mounted flush, the canvas draws
          its axes hard against its own boundary and reads as something that
          overflowed its container rather than something placed in it. The
          horizontal inset matches the toolbar's `px-3`, so the price axis and
          the interval switch start on one line. */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-2">
        <div ref={hostRef} style={{ minHeight: height }} className="min-h-0 w-full flex-1" />
      </div>
    </div>
  );
}

/* ── Readout parts ────────────────────────────────────────────────────────── */

/**
 * A key/value pair set at two levels of emphasis.
 *
 * The key is scaffolding — a word that never changes, which a reader stops
 * seeing after the first look — and the value is the payload. Rendered at one
 * weight the row reads as a string of equal tokens the eye has to parse; split,
 * the numbers are the only bright things and the keys become the ruler under
 * them.
 */
export function Field({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <span className="qs-num shrink-0">
      <span className="text-[var(--text-tertiary)]">{k}</span>
      <span className="ml-1" style={{ color: tone ?? 'var(--text-secondary)' }}>
        {v}
      </span>
    </span>
  );
}

/** The same split, packed for an OHLC group where the keys are single letters
 *  and the colour is set once on the group. */
export function Tick({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-[var(--text-tertiary)]">{k}</span>
      <span className="mr-2 ml-1">{v}</span>
    </>
  );
}

/** The clock that anchors a readout — every other figure in the row is
 *  "…at this instant", so it is not a caption and does not get caption ink. */
export function ReadoutTime({ children }: { children: ReactNode }) {
  return <span className="qs-num shrink-0 text-[var(--text-secondary)]">{children}</span>;
}
