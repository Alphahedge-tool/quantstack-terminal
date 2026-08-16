/**
 * Chart-layout picker — the TradingView grid selector.
 *
 * ── Why glyphs and not a labelled select ──
 *
 * The choice IS a shape. "2 across" and "2 stacked" are two words that differ
 * by one, and a user picking between them under time pressure reads the icon,
 * not the text. So each option draws its own arrangement at 14px, and the words
 * live in the tooltip and the accessible name where they cost nothing.
 */

import { cn } from '@/lib/cn';

export type LayoutId = '1' | '2h' | '2v' | '4';

export interface LayoutSpec {
  id: LayoutId;
  label: string;
  /** How many chart slots the layout shows. */
  slots: number;
  /** Grid template for the slot container. */
  className: string;
  /**
   * Chart height for one slot, as a CSS length.
   *
   * Viewport-driven, not a fixed pixel count. Fixed heights left a third of a
   * 1080p window empty below the charts while the plot itself was cramped —
   * and on a laptop the same numbers overflowed. `dvh` rather than `vh` because
   * the mobile toolbar collapse changes `vh` mid-scroll.
   *
   * `CHROME` is what the layout spends before the plot begins: the shell's top
   * bar, the page header, the stat strip, the panel header, the chart toolbar,
   * the readout row and the gaps between them. The two-row layouts subtract a
   * second slot's worth of panel chrome before halving, or the grid would
   * overflow by exactly that much.
   *
   * `clamp` on both ends: the floor keeps a candle readable on a short window,
   * and the ceiling stops a single chart on a tall monitor from stretching into
   * a band of empty plot with the marks squashed against the axis.
   */
  height: string;
  /** The plot is small enough that the toolbar has to shed weight. */
  dense: boolean;
}

/**
 * Fixed vertical cost outside the first plot, measured against the built page:
 * shell top bar 48, main padding 10+10, compound workspace header 64+10,
 * panel header 45 (dense — see `PanelHeader`), chart toolbar 45, readout row
 * 25, plot inset 12, and the shell's STATUS BAR 30.
 *
 * The status bar is the one that bit: it sits below `main` in the shell's
 * column, so it silently takes 30px out of `100dvh` that the plot had already
 * claimed — and because the panel clips, what got cut was the bottom of the
 * chart, which is the time axis. A chart that overflows by less than its own
 * axis height does not look broken, it looks like a chart with no time on it.
 */
const CHROME = 306;
/** What each ADDITIONAL row of slots costs outside its own plot: that slot's
 *  panel header, toolbar, readout row and inset, plus the grid gap above it. */
const ROW_CHROME = 137;

const oneRow = (min: number, max: number) =>
  `clamp(${min}px, calc(100dvh - ${CHROME}px), ${max}px)`;

const twoRows = (min: number, max: number) =>
  `clamp(${min}px, calc((100dvh - ${CHROME + ROW_CHROME}px) / 2), ${max}px)`;

export const LAYOUTS: readonly LayoutSpec[] = [
  {
    id: '1', label: 'Single chart', slots: 1,
    className: 'grid-cols-1', height: oneRow(420, 1100), dense: false,
  },
  {
    id: '2h', label: 'Two side by side', slots: 2,
    className: 'grid-cols-1 xl:grid-cols-2', height: oneRow(400, 1000), dense: true,
  },
  {
    id: '2v', label: 'Two stacked', slots: 2,
    className: 'grid-cols-1', height: twoRows(240, 520), dense: true,
  },
  {
    id: '4', label: 'Four in a grid', slots: 4,
    className: 'grid-cols-1 xl:grid-cols-2', height: twoRows(240, 520), dense: true,
  },
];

/** The cell rectangles each glyph is built from, in a 14×14 box. */
const GLYPHS: Record<LayoutId, Array<[number, number, number, number]>> = {
  '1': [[1, 1, 12, 12]],
  '2h': [
    [1, 1, 5.5, 12],
    [7.5, 1, 5.5, 12],
  ],
  '2v': [
    [1, 1, 12, 5.5],
    [1, 7.5, 12, 5.5],
  ],
  '4': [
    [1, 1, 5.5, 5.5],
    [7.5, 1, 5.5, 5.5],
    [1, 7.5, 5.5, 5.5],
    [7.5, 7.5, 5.5, 5.5],
  ],
};

export function LayoutPicker({
  value,
  onChange,
  className,
}: {
  value: LayoutId;
  onChange: (id: LayoutId) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="Chart layout"
      className={cn(
        'inline-flex h-[var(--control-compact)] items-center gap-0.5 rounded-[var(--control-radius)]',
        'border border-[var(--control-border)] bg-[var(--control-bg)] p-0.5',
        className,
      )}
    >
      {LAYOUTS.map((layout) => {
        const active = layout.id === value;
        return (
          <button
            key={layout.id}
            type="button"
            aria-pressed={active}
            aria-label={layout.label}
            title={layout.label}
            onClick={() => onChange(layout.id)}
            className={cn(
              'flex h-full items-center rounded-[var(--radius-xs)] px-2 transition-colors duration-100',
              active
                ? 'bg-[var(--accent-info-soft)] text-[var(--accent-info)]'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
            )}
          >
            <svg width={14} height={14} viewBox="0 0 14 14" aria-hidden focusable="false">
              {GLYPHS[layout.id].map(([x, y, w, h]) => (
                <rect
                  key={`${x}-${y}`}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={1}
                  // Stroked, not filled: four filled blocks at 14px read as one
                  // dark square, and the whole point of the glyph is the seams.
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.2}
                />
              ))}
            </svg>
          </button>
        );
      })}
    </div>
  );
}
