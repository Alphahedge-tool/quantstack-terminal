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
   * The FLOOR for one slot's plot, as a CSS length — not its height.
   *
   * The page fills the viewport by flexing (see `StraddlePage`), so the plot
   * takes whatever is left after the chrome above it, measured by the browser
   * rather than estimated here. This is only the point below which the pane
   * stops shrinking and the page starts scrolling instead — a candle has to
   * stay readable on a short window.
   *
   * It used to be `clamp(min, calc(100dvh - CHROME), max)` with CHROME a hand
   * counted 294px: shell bar plus page header plus panel header plus toolbar
   * plus readout plus insets plus status bar. Every one of those numbers was
   * right when it was written and wrong the moment any of them changed by a
   * pixel — and the error only ever went one way, because understating the
   * chrome clips the time axis, so the constant had to be padded to be safe.
   * The padding was the height being given up.
   */
  minHeight: string;
  /** The plot is small enough that the toolbar has to shed weight. */
  dense: boolean;
}

/*
 * The row floors: a plot floor plus 110px of pane chrome — panel header ~37,
 * chart toolbar 41, readout row 20, plot inset 8.
 *
 * That 110 is the last estimate in this file and the only one that is safe to
 * get wrong. It no longer sets a HEIGHT; it sets the point at which the page
 * starts scrolling rather than squeezing, so erring high scrolls a few pixels
 * early — the harmless direction. The old `CHROME` constant sized the plot
 * itself, where the same error clipped the time axis off the bottom of the
 * chart and there was no way to tell from looking at it.
 *
 * They are written out rather than computed.
 *
 * Tailwind reads class names as TEXT — it never runs this file — so a template
 * literal like `grid-rows-[repeat(${n},minmax(${f}px,1fr))]` produces a class
 * that exists in the DOM and in no stylesheet, and the grid silently falls back
 * to auto rows. The arithmetic is therefore done here in prose instead:
 *
 *   single    440 + 110 = 550
 *   side/side 420 + 110 = 530
 *   stacked   260 + 110 = 370
 *
 * `minmax(floor, 1fr)` does two jobs. The `1fr` shares out whatever height the
 * container has — that is what makes the plot fill a tall window without anyone
 * computing a number. The floor stops the sharing before a pane gets too short
 * to read: past that the grid outgrows its container and `main` scrolls, which
 * is right, because a clipped chart loses its time axis while a scrolled one
 * loses nothing.
 *
 * A bare `1fr` would do neither job: its automatic minimum is the content's, so
 * a chart canvas would refuse to shrink at all and the page would scroll on
 * every window.
 */

export const LAYOUTS: readonly LayoutSpec[] = [
  {
    id: '1', label: 'Single chart', slots: 1,
    className: 'grid-cols-1 grid-rows-[minmax(550px,1fr)]',
    minHeight: '440px', dense: false,
  },
  {
    // Two columns from `xl` up, so below that they stack — and a stacked pair
    // needs two rows, not one row of double height.
    id: '2h', label: 'Two side by side', slots: 2,
    className: 'grid-cols-1 grid-rows-[repeat(2,minmax(530px,1fr))] '
      + 'xl:grid-cols-2 xl:grid-rows-[minmax(530px,1fr)]',
    minHeight: '420px', dense: true,
  },
  {
    id: '2v', label: 'Two stacked', slots: 2,
    className: 'grid-cols-1 grid-rows-[repeat(2,minmax(370px,1fr))]',
    minHeight: '260px', dense: true,
  },
  {
    id: '4', label: 'Four in a grid', slots: 4,
    className: 'grid-cols-1 grid-rows-[repeat(4,minmax(370px,1fr))] '
      + 'xl:grid-cols-2 xl:grid-rows-[repeat(2,minmax(370px,1fr))]',
    minHeight: '260px', dense: true,
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
