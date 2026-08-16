/**
 * Panel — the card-on-ground container.
 *
 * The whole system in one component: the panel is DARKER than the ground it
 * sits on, and is lifted by two edges rather than by a shadow (a shadow on a
 * mid-dark ground reads as nothing). The lit top rim and the occlusion halo
 * come from --elevation-container; see tokens.css for why both are needed.
 *
 * The header is a separate slot rather than a `title` prop so a panel can put
 * controls, a filter or a live badge up there without the component growing a
 * prop per case.
 */

import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface PanelProps {
  children: ReactNode;
  className?: string;
  /** Removes the body padding — for panels whose entire body is a table. */
  flush?: boolean;
}

export function Panel({ children, className, flush }: PanelProps) {
  return (
    <section
      className={cn(
        'qs-container flex min-h-0 flex-col overflow-hidden',
        className,
      )}
    >
      {flush ? children : <div className="p-4">{children}</div>}
    </section>
  );
}

interface PanelHeaderProps {
  title: ReactNode;
  /** Sits under the title in secondary text — the count, the timestamp, the
   *  "3 of 12 accounts" caveat. */
  subtitle?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
  icon?: ReactNode;
  /**
   * The single-line variant, for a panel whose body is the point.
   *
   * On a table or a form the header is a section heading and can afford its own
   * block. On a chart panel it is a caption on something that wants every pixel
   * it can get, and the standard header spends ~57px: 24px of padding plus TWO
   * stacked text lines. Dense halves the padding and sets the subtitle inline
   * beside the title instead of beneath it, which is what actually removes the
   * height — the row then measures the tallest control in `actions` (32px) and
   * nothing else, landing at ~45px.
   *
   * Only worth it when the subtitle is short enough to sit on one line with the
   * title. A sentence there will truncate rather than wrap.
   */
  dense?: boolean;
}

export function PanelHeader({ title, subtitle, actions, icon, dense }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        'qs-container-head flex shrink-0 items-center',
        dense ? 'gap-2 px-3 py-1.5' : 'gap-3 px-4 py-3',
      )}
    >
      {icon ? (
        <span
          className={cn(
            'flex shrink-0 items-center justify-center rounded-[var(--radius-sm)]',
            'bg-[var(--surface-raised)] text-[var(--accent-info)]',
            dense ? 'size-6' : 'size-7',
          )}
        >
          {icon}
        </span>
      ) : null}

      {/* Baseline alignment, not centre: inline, the title and the subtitle are
          two type sizes on one line, and centring them would leave the smaller
          one floating off the shared baseline. */}
      <div className={cn('min-w-0 flex-1', dense && 'flex items-baseline gap-2')}>
        <h2
          className={cn(
            'truncate text-[length:var(--type-control)] font-semibold leading-tight',
            'text-[var(--text-primary)]',
            dense && 'shrink-0',
          )}
        >
          {title}
        </h2>
        {subtitle ? (
          <p
            className={cn(
              'truncate text-[length:var(--type-micro)] leading-tight text-[var(--text-tertiary)]',
              dense ? 'min-w-0' : 'mt-0.5',
            )}
          >
            {subtitle}
          </p>
        ) : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Scrollable body for a flush panel. Owns its own overflow so the page never
 *  grows a second scrollbar around it. */
export function PanelBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-auto', className)}>{children}</div>
  );
}

/** Footer rule + muted text, for totals and "last updated" lines. */
export function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <footer
      className={cn(
        'flex shrink-0 items-center gap-3 border-t border-[var(--container-rule)] bg-[var(--container-head)] px-4 py-2',
        'text-[length:var(--type-micro)] text-[var(--text-tertiary)]',
        className,
      )}
    >
      {children}
    </footer>
  );
}
