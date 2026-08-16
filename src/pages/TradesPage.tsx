/**
 * Trades — the fill tape.
 *
 * Newest first by default. A fill log read oldest-first means scrolling to the
 * bottom every time it refreshes, which is the wrong default for the thing that
 * changes most often.
 */

import { useMemo } from 'react';
import { Receipt } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { BookPanel } from '@/components/trading/BookPanel';
import { BrokerCell, ContractCell, SideCell } from '@/components/trading/cells';
import { StatGrid, StatTile } from '@/components/ui/StatTile';
import type { Column } from '@/components/ui/DataTable';
import { useTrades } from '@/hooks/queries';
import { clockTime, currency, decimal, integer } from '@/lib/format';
import type { Trade } from '@/schemas/trading';

export function TradesPage() {
  const query = useTrades();
  const trades = useMemo(() => query.data?.trades ?? [], [query.data]);

  const summary = useMemo(() => {
    let turnover = 0;
    let buys = 0;
    let sells = 0;
    for (const trade of trades) {
      turnover += trade.price * trade.quantity;
      if (trade.side === 'BUY') buys += 1;
      else sells += 1;
    }
    return { turnover, buys, sells };
  }, [trades]);

  const columns: Column<Trade>[] = [
    {
      id: 'time',
      header: 'Time',
      cell: (row) => <span className="qs-num text-[var(--text-tertiary)]">{clockTime(row.filledAt)}</span>,
      sortValue: (row) => row.filledAt ?? 0,
      width: '10%',
    },
    {
      id: 'contract',
      header: 'Instrument',
      cell: (row) => <ContractCell contract={row.contract} />,
      sortValue: (row) => row.contract.symbol,
      width: '28%',
    },
    {
      id: 'side',
      header: 'Side',
      cell: (row) => <SideCell side={row.side} />,
      sortValue: (row) => row.side,
    },
    {
      id: 'quantity',
      header: 'Qty',
      kind: 'num',
      cell: (row) => integer(row.quantity),
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
      id: 'value',
      header: 'Value',
      kind: 'num',
      cell: (row) => currency(row.price * row.quantity),
      sortValue: (row) => row.price * row.quantity,
    },
    {
      id: 'order',
      header: 'Order',
      cell: (row) => (
        <span className="qs-num text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {row.orderId || '—'}
        </span>
      ),
      sortValue: (row) => row.orderId,
      secondary: true,
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
      <PageHeader title="Trades" subtitle="Every fill reported today, newest first" />

      <div className="mb-[var(--container-gap)]">
        <StatGrid>
          <StatTile label="Fills" value={integer(trades.length)} detail="Executions today" />
          <StatTile label="Turnover" value={currency(summary.turnover)} detail="Gross traded value" />
          <StatTile label="Buys" value={integer(summary.buys)} />
          <StatTile label="Sells" value={integer(summary.sells)} />
        </StatGrid>
      </div>

      <BookPanel
        title="Fill tape"
        icon={<Receipt size={14} />}
        rows={trades}
        columns={columns}
        rowKey={(row, i) => `${row.feedId}:${row.id || i}`}
        errors={query.data?.errors}
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        emptyTitle="No fills today"
        emptyHint="Executions appear here as orders fill."
        initialSort={{ id: 'time', direction: 'desc' }}
      />
    </>
  );
}
