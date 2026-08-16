/**
 * Badge / Pill — small status carriers.
 *
 * Every one uses the `-soft` alpha wash behind the full-strength text colour.
 * That pairing is what keeps a pill legible on any rung of the surface ladder:
 * a baked background hex would be right on one surface and muddy on the next.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { direction } from '@/lib/format';

export type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'warning';

const TONES: Record<Tone, string> = {
  neutral: 'text-[var(--text-secondary)] bg-[var(--surface-raised)]',
  accent: 'text-[var(--accent-info)] bg-[var(--accent-info-soft)]',
  success: 'text-[var(--status-success)] bg-[var(--status-success-soft)]',
  danger: 'text-[var(--status-danger)] bg-[var(--status-danger-soft)]',
  warning: 'text-[var(--status-warning)] bg-[var(--status-warning-soft)]',
};

export function Badge({
  children,
  tone = 'neutral',
  mono,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-[var(--radius-xs)] px-1.5 py-0.5',
        'text-[length:var(--type-micro)] font-semibold uppercase leading-tight',
        'tracking-[var(--tracking-label)] whitespace-nowrap',
        mono && 'font-mono tabular-nums normal-case tracking-normal',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A number that colours itself by sign. Zero is neutral — treating it as a gain
 * is a small lie that shows up in every flat book.
 */
export function DeltaPill({
  value,
  children,
  className,
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const tone: Tone =
    direction(value) === 'up' ? 'success' : direction(value) === 'down' ? 'danger' : 'neutral';
  return (
    <Badge tone={tone} mono className={className}>
      {children}
    </Badge>
  );
}

/** Plain coloured text for the same idea, used inside dense table cells where a
 *  filled pill on every row would be too much ink. */
export function DeltaText({
  value,
  children,
  className,
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
}) {
  const dir = direction(value);
  return (
    <span
      className={cn(
        'qs-num',
        dir === 'up' && 'text-[var(--market-up)]',
        dir === 'down' && 'text-[var(--market-down)]',
        dir === 'flat' && 'text-[var(--text-secondary)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The connection dot used in the top bar and status bar. */
export function StatusDot({
  tone = 'neutral',
  pulse,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  className?: string;
}) {
  const colour =
    tone === 'success'
      ? 'var(--status-success)'
      : tone === 'danger'
        ? 'var(--status-danger)'
        : tone === 'warning'
          ? 'var(--status-warning)'
          : tone === 'accent'
            ? 'var(--accent-info)'
            : 'var(--text-tertiary)';

  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={{
        backgroundColor: colour,
        boxShadow: `0 0 6px ${colour}`,
        animation: pulse ? 'qs-pulse 2s ease-in-out infinite' : undefined,
      }}
    />
  );
}
