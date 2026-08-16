/**
 * The three states every data surface needs besides "it worked": loading,
 * empty, and failed.
 *
 * Given first-class components because the failure modes are meaningfully
 * different and a generic spinner-or-nothing hides that. In particular an auth
 * failure gets its own treatment — the useful UI when a session expires is a
 * sign-in prompt, not a red error banner the user cannot act on.
 */

import type { ReactNode } from 'react';
import { AlertTriangle, Inbox, KeyRound, Loader2, WifiOff } from 'lucide-react';
import { ApiFailure, SchemaFailure } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from './Button';

export function Spinner({ className }: { className?: string }) {
  return (
    <Loader2
      size={15}
      className={cn('animate-spin text-[var(--text-tertiary)]', className)}
      style={{ animation: 'qs-spin 900ms linear infinite' }}
    />
  );
}

/** Skeleton rows sized to the table they replace, so the layout does not jump
 *  when real data lands. */
export function TableSkeleton({ rows = 6, columns = 5 }: { rows?: number; columns?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-3">
          {Array.from({ length: columns }, (_, c) => (
            <div
              key={c}
              className="qs-skeleton h-4 flex-1"
              // Varying the widths stops the block reading as a solid grey slab.
              style={{ opacity: 1 - r * 0.1, maxWidth: c === 0 ? '22%' : undefined }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="mb-1 text-[var(--text-disabled)]">
        {icon ?? <Inbox size={22} strokeWidth={1.5} />}
      </span>
      <p className="text-[length:var(--type-control)] font-medium text-[var(--text-secondary)]">
        {title}
      </p>
      {hint ? (
        <p className="max-w-sm text-[length:var(--type-caption)] leading-relaxed text-[var(--text-tertiary)]">
          {hint}
        </p>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/**
 * Error state, shaped by what actually went wrong.
 *
 * Three cases worth telling apart: the session expired (act: sign in), the
 * backend is unreachable (act: start it), and everything else (act: retry).
 * Collapsing them into one message makes the user guess which one they have.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const failure = error instanceof ApiFailure ? error : null;

  if (failure?.isAuth) {
    return (
      <EmptyState
        icon={<KeyRound size={22} strokeWidth={1.5} />}
        title="Session expired"
        hint={
          failure.feed
            ? `The ${failure.feed} feed needs you to sign in again before it can answer.`
            : 'Sign in again to restore the broker session.'
        }
        action={
          <Button variant="primary" onClick={onRetry}>
            Retry
          </Button>
        }
      />
    );
  }

  if (failure?.code === 'NETWORK') {
    return (
      <EmptyState
        icon={<WifiOff size={22} strokeWidth={1.5} />}
        title="Backend unreachable"
        hint="qt-backend is not answering on port 3101. Start it with `npm run dev` in the backend directory."
        action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}
      />
    );
  }

  const message =
    error instanceof SchemaFailure
      ? `${error.message} — the backend contract may have changed.`
      : error instanceof Error
        ? error.message
        : 'Something went wrong.';

  return (
    <EmptyState
      icon={<AlertTriangle size={22} strokeWidth={1.5} className="text-[var(--status-danger)]" />}
      title="Could not load"
      hint={message}
      action={onRetry ? <Button onClick={onRetry}>Retry</Button> : undefined}
    />
  );
}

/**
 * Per-broker failures from a book's `errors` array.
 *
 * Deliberately a strip above the table, not a replacement for it: one account
 * being down must not blank rows that other accounts answered for. An empty
 * table that looks like a flat book is the failure this exists to prevent.
 */
export function BrokerErrorStrip({
  errors,
}: {
  errors: Array<{ broker: string; message: string; code: string }>;
}) {
  if (errors.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-[var(--container-rule)] bg-[var(--status-warning-soft)] px-4 py-2">
      <AlertTriangle size={13} className="shrink-0 text-[var(--status-warning)]" />
      {errors.map((e) => (
        <span key={e.broker} className="text-[length:var(--type-micro)] text-[var(--text-secondary)]">
          <b className="font-semibold text-[var(--status-warning)]">{e.broker}</b> unavailable — {e.message}
        </span>
      ))}
    </div>
  );
}
