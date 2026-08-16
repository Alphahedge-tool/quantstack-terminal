/**
 * Orders — the day's order book, across every account.
 *
 * Filtered by status rather than paged: an order book is a few hundred rows at
 * most, and the question being asked of it is almost always "what is still
 * working?" rather than "what is row 250?".
 */

import { useMemo, useState } from 'react';
import { ScrollText } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { BookPanel } from '@/components/trading/BookPanel';
import { BrokerCell, ContractCell, SideCell, StatusCell } from '@/components/trading/cells';
import { SegmentedControl } from '@/components/ui/Field';
import type { Column } from '@/components/ui/DataTable';
import { useOrders } from '@/hooks/queries';
import { clockTime, decimal, integer } from '@/lib/format';
import { isExecuted, isWorking, type Order } from '@/schemas/trading';

type Filter = 'all' | 'working' | 'done' | 'failed';

/** Grouped by what the trader is looking for, not by the raw status union —
 *  "is it still working?" is one question across four statuses. The predicates
 *  are shared with the Positions page's order flow so the two cannot disagree
 *  about whether an armed stop counts as working. */
const MATCHERS: Record<Filter, (order: Order) => boolean> = {
  all: () => true,
  working: (o) => isWorking(o.status),
  done: (o) => isExecuted(o.status),
  failed: (o) => o.status === 'REJECTED' || o.status === 'CANCELLED',
};

export function OrdersPage() {
  const query = useOrders();
  const [filter, setFilter] = useState<Filter>('all');

  const orders = query.data?.orders ?? [];
  const rows = useMemo(() => orders.filter(MATCHERS[filter]), [orders, filter]);

  const counts = useMemo(
    () => ({
      all: orders.length,
      working: orders.filter(MATCHERS.working).length,
      done: orders.filter(MATCHERS.done).length,
      failed: orders.filter(MATCHERS.failed).length,
    }),
    [orders],
  );

  const columns: Column<Order>[] = [
    {
      id: 'time',
      header: 'Time',
      cell: (row) => (
        <span className="qs-num text-[var(--text-tertiary)]">
          {clockTime(row.updatedAt ?? row.placedAt)}
        </span>
      ),
      sortValue: (row) => row.updatedAt ?? row.placedAt ?? 0,
      width: '9%',
    },
    {
      id: 'contract',
      header: 'Instrument',
      cell: (row) => <ContractCell contract={row.contract} />,
      sortValue: (row) => row.contract.symbol,
      width: '22%',
    },
    {
      id: 'side',
      header: 'Side',
      cell: (row) => <SideCell side={row.side} />,
      sortValue: (row) => row.side,
    },
    {
      id: 'kind',
      header: 'Type',
      cell: (row) => (
        <span className="text-[length:var(--type-micro)] uppercase tracking-[var(--tracking-label)] text-[var(--text-tertiary)]">
          {row.kind} · {row.product}
        </span>
      ),
      sortValue: (row) => row.kind,
      secondary: true,
    },
    {
      id: 'quantity',
      header: 'Filled / Qty',
      kind: 'num',
      // Fill progress in one cell: two numbers side by side answer "how much of
      // it went through" without the reader subtracting anything.
      cell: (row) => (
        <span>
          <span
            className={
              row.filled === row.quantity
                ? 'text-[var(--status-success)]'
                : 'text-[var(--text-primary)]'
            }
          >
            {integer(row.filled)}
          </span>
          <span className="text-[var(--text-disabled)]"> / {integer(row.quantity)}</span>
        </span>
      ),
      sortValue: (row) => row.quantity,
    },
    {
      id: 'price',
      header: 'Price',
      kind: 'num',
      cell: (row) => decimal(row.price),
      sortValue: (row) => row.price,
    },
    {
      id: 'average',
      header: 'Avg fill',
      kind: 'num',
      cell: (row) => decimal(row.averagePrice),
      sortValue: (row) => row.averagePrice,
      secondary: true,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusCell status={row.status} message={row.message} />,
      sortValue: (row) => row.status,
    },
    {
      id: 'broker',
      header: 'Account',
      cell: (row) => <BrokerCell broker={row.broker} feedId={row.feedId} />,
      sortValue: (row) => row.broker,
      secondary: true,
    },
  ];

  return (
    <>
      <PageHeader title="Orders" subtitle="Today's order book across every connected account" />

      <BookPanel
        title="Order book"
        icon={<ScrollText size={14} />}
        rows={rows}
        columns={columns}
        rowKey={(row, i) => `${row.feedId}:${row.id || i}`}
        errors={query.data?.errors}
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        emptyTitle={filter === 'all' ? 'No orders today' : `No ${filter} orders`}
        emptyHint={
          filter === 'all'
            ? 'Orders placed through any connected account appear here.'
            : 'Try a different filter.'
        }
        initialSort={{ id: 'time', direction: 'desc' }}
        actions={
          <SegmentedControl<Filter>
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All ${counts.all}` },
              { value: 'working', label: `Working ${counts.working}` },
              { value: 'done', label: `Filled ${counts.done}` },
              { value: 'failed', label: `Failed ${counts.failed}` },
            ]}
          />
        }
      />
    </>
  );
}
