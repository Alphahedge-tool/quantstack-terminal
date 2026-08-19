/**
 * An empty chart slot: the `+` that turns into a chooser.
 *
 * ── Why a new pane starts empty ──
 *
 * Splitting used to clone the previous slot's chart, on the TradingView logic
 * that you split a pane to change one field of what you were already looking
 * at. That is right when the panes hold the same KIND of chart and differ by
 * symbol. It is wrong here: this workspace has three different analytics over
 * one contract, and the reason to open a second pane is almost always to put a
 * different one of them beside the first. A clone would have to be thrown away
 * before the pane was useful, so the pane asks instead.
 *
 * ── Why the options are listed, not hidden behind the + ──
 *
 * The `+` is the affordance; the list is what it opens onto, and at three
 * options there is nothing to gain by making that a second click. A menu would
 * cost an interaction to tell the user something a 200px panel can just say.
 */

import { Plus } from 'lucide-react';
import { CHART_KINDS, type ChartKind } from './registry';
import { cn } from '@/lib/cn';

export function EmptySlot({
  height,
  onPick,
  className,
}: {
  /** A CSS length, matching what a real chart in this slot would take, so
   *  choosing one does not make the grid jump. */
  height: number | string;
  onPick: (kind: ChartKind) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Fills the pane like a real chart would, so choosing one does not
        // change the panel's height — `height` is only the floor.
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6',
        className,
      )}
      style={{ minHeight: height }}
    >
      <div className="flex flex-col items-center gap-1.5 text-center">
        <span className="flex size-9 items-center justify-center rounded-full border border-dashed border-[var(--border-strong)] text-[var(--text-tertiary)]">
          <Plus size={18} />
        </span>
        <h3 className="text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
          Add a chart
        </h3>
        <p className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          Same contract and session as the pane beside it — pick what to plot.
        </p>
      </div>

      <div className="flex w-full max-w-md flex-col gap-1.5">
        {CHART_KINDS.map((spec) => {
          const Icon = spec.icon;
          return (
            <button
              key={spec.kind}
              type="button"
              onClick={() => onPick(spec.kind)}
              className={cn(
                'group flex items-center gap-3 rounded-[var(--radius-sm)] px-3 py-2 text-left',
                'border border-[var(--container-border)] bg-[var(--surface-raised)]',
                'transition-colors duration-100',
                'hover:border-[var(--border-focus)] hover:bg-[var(--surface-hover)]',
              )}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--surface-panel)] text-[var(--accent-info)]">
                <Icon size={14} />
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
                    {spec.label}
                  </span>
                  {/* Stated up front, not discovered after clicking. These two
                      walk 30–100 option series on a cold contract; a wait you
                      were warned about is a wait, and one you were not is a
                      bug. */}
                  {spec.slow ? (
                    <span className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                      slower first load
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                  {spec.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
