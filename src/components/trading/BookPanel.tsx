/**
 * The shape every book page shares: a panel whose body is a table, with the
 * loading / error / empty / partial-failure states already wired.
 *
 * Extracted because getting those four states right is most of the work in a
 * book page, and five pages each solving it separately is five chances to leave
 * one out — usually the partial-failure strip, which is the one that silently
 * turns a broker outage into an apparently flat book.
 */

import type { ReactNode } from 'react';
import { Panel, PanelBody, PanelFooter, PanelHeader } from '@/components/ui/Panel';
import { DataTable, type Column } from '@/components/ui/DataTable';
import {
  BrokerErrorStrip,
  EmptyState,
  ErrorState,
  Spinner,
  TableSkeleton,
} from '@/components/ui/States';
import type { BrokerError } from '@/schemas/trading';

interface BookPanelProps<T> {
  title: string;
  icon?: ReactNode;
  rows: T[] | undefined;
  columns: Column<T>[];
  rowKey: (row: T, index: number) => string;
  rowClassName?: (row: T) => string | undefined;
  errors?: BrokerError[];
  isLoading: boolean;
  /** A background refetch. Shown as a small spinner rather than a skeleton —
   *  replacing a populated table with skeletons every poll is worse than the
   *  staleness it advertises. */
  isFetching?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle: string;
  emptyHint?: string;
  actions?: ReactNode;
  footer?: ReactNode;
  initialSort?: { id: string; direction: 'asc' | 'desc' };
  /** Totals row, keyed by column id. See DataTable — it renders in-column. */
  totals?: Record<string, ReactNode>;
}

export function BookPanel<T>({
  title,
  icon,
  rows,
  columns,
  rowKey,
  rowClassName,
  errors = [],
  isLoading,
  isFetching,
  error,
  onRetry,
  emptyTitle,
  emptyHint,
  actions,
  footer,
  initialSort,
  totals,
}: BookPanelProps<T>) {
  const count = rows?.length ?? 0;

  return (
    <Panel flush className="min-h-[20rem]">
      <PanelHeader
        title={title}
        icon={icon}
        subtitle={isLoading ? 'Loading…' : `${count} row${count === 1 ? '' : 's'}`}
        actions={
          <>
            {isFetching && !isLoading ? <Spinner /> : null}
            {actions}
          </>
        }
      />

      {/* Above the table, never instead of it: rows other accounts answered for
          must stay on screen while one account is down. */}
      <BrokerErrorStrip errors={errors} />

      <PanelBody>
        {isLoading ? (
          <TableSkeleton columns={Math.min(columns.length, 6)} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : (
          <DataTable
            rows={rows ?? []}
            columns={columns}
            rowKey={rowKey}
            rowClassName={rowClassName}
            initialSort={initialSort}
            totals={totals}
            empty={<EmptyState title={emptyTitle} hint={emptyHint} />}
          />
        )}
      </PanelBody>

      {footer ? <PanelFooter>{footer}</PanelFooter> : null}
    </Panel>
  );
}
