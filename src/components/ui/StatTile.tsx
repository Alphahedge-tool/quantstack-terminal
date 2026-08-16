/**
 * StatTile — one headline number with its label.
 *
 * The value is set in mono at display weight because these are read by glancing
 * from across a desk, and the label sits ABOVE it in the micro-label style.
 * Label-above rather than below: when tiles wrap onto two rows, a trailing label
 * ends up visually closer to the tile beneath it than to its own number.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { direction } from '@/lib/format';

interface StatTileProps {
  label: string;
  value: ReactNode;
  /** Secondary line under the value — a comparison, a count, a source. */
  detail?: ReactNode;
  /** When present, colours the value by sign. */
  signedBy?: number | null;
  icon?: ReactNode;
  className?: string;
}

export function StatTile({ label, value, detail, signedBy, icon, className }: StatTileProps) {
  const dir = signedBy === undefined ? 'flat' : direction(signedBy);

  const tone =
    signedBy === undefined
      ? 'text-[var(--text-primary)]'
      : dir === 'up'
        ? 'text-[var(--market-up)]'
        : dir === 'down'
          ? 'text-[var(--market-down)]'
          : 'text-[var(--text-primary)]';

  const valueClass = cn(
    'truncate font-mono text-[length:var(--type-title)] font-semibold tabular-nums',
    'leading-tight tracking-[var(--tracking-tight)]',
    tone,
  );

  return (
    <div
      className={cn('qs-container flex min-w-0 flex-col justify-between gap-3 p-4', className)}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="qs-label truncate">{label}</span>
        {icon ? <span className="shrink-0 text-[var(--text-disabled)]">{icon}</span> : null}
      </div>

      <div className="min-w-0">
        <div className={valueClass}>{value}</div>
        {detail ? (
          <div className="mt-1 truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
            {detail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The responsive row these live in. Declared once so every page's tile strip
 *  breaks at the same widths. */
export function StatGrid({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-[var(--container-gap)] md:grid-cols-3 xl:grid-cols-4">
      {children}
    </div>
  );
}
