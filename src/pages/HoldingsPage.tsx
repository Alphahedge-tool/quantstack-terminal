/**
 * Holdings — the demat book.
 *
 * Unlike positions, these settle overnight, so the page polls slowly and does
 * not subscribe to the live tape. Marking a long-term holding at 4Hz would burn
 * a subscription slot for a number that matters once a day.
 */

import { useMemo } from 'react';
import { Briefcase } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { BookPanel } from '@/components/trading/BookPanel';
import { BrokerCell, ContractCell } from '@/components/trading/cells';
import { DeltaText } from '@/components/ui/Badge';
import { StatGrid, StatTile } from '@/components/ui/StatTile';
import type { Column } from '@/components/ui/DataTable';
import { useHoldings } from '@/hooks/queries';
import { currency, decimal, integer, percent, signedCurrency } from '@/lib/format';
import type { Holding } from '@/schemas/trading';

export function HoldingsPage() {
  const query = useHoldings();
  const holdings = useMemo(() => query.data?.holdings ?? [], [query.data]);

  const summary = useMemo(() => {
    let invested = 0;
    let market = 0;
    let pnl = 0;
    let collateral = 0;
    for (const row of holdings) {
      invested += row.averagePrice * row.quantity;
      market += row.lastPrice * row.quantity;
      pnl += row.pnl;
      collateral += row.collateral;
    }
    return { invested, market, pnl, collateral };
  }, [holdings]);

  /** Return on cost. Guarded: a zero-cost holding (a bonus issue, a corporate
   *  action the master has not priced) would otherwise render as Infinity. */
  function returnPct(row: Holding): number | null {
    const cost = row.averagePrice * row.quantity;
    if (!cost) return null;
    return (row.pnl / cost) * 100;
  }

  const columns: Column<Holding>[] = [
    {
      id: 'contract',
      header: 'Instrument',
      cell: (row) => <ContractCell contract={row.contract} />,
      sortValue: (row) => row.contract.symbol,
      width: '26%',
    },
    {
      id: 'quantity',
      header: 'Qty',
      kind: 'num',
      cell: (row) => integer(row.quantity),
      sortValue: (row) => row.quantity,
    },
    {
      id: 'average',
      header: 'Avg cost',
      kind: 'num',
      cell: (row) => decimal(row.averagePrice),
      sortValue: (row) => row.averagePrice,
    },
    {
      id: 'last',
      header: 'LTP',
      kind: 'num',
      cell: (row) => decimal(row.lastPrice),
      sortValue: (row) => row.lastPrice,
    },
    {
      id: 'value',
      header: 'Value',
      kind: 'num',
      cell: (row) => currency(row.lastPrice * row.quantity),
      sortValue: (row) => row.lastPrice * row.quantity,
    },
    {
      id: 'pnl',
      header: 'P&L',
      kind: 'num',
      cell: (row) => <DeltaText value={row.pnl}>{signedCurrency(row.pnl)}</DeltaText>,
      sortValue: (row) => row.pnl,
    },
    {
      id: 'return',
      header: 'Return',
      kind: 'num',
      cell: (row) => {
        const pct = returnPct(row);
        return <DeltaText value={pct}>{percent(pct)}</DeltaText>;
      },
      sortValue: (row) => returnPct(row) ?? 0,
    },
    {
      id: 'collateral',
      header: 'Collateral',
      kind: 'num',
      cell: (row) => currency(row.collateral),
      sortValue: (row) => row.collateral,
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

  const totalReturn = summary.invested ? (summary.pnl / summary.invested) * 100 : null;

  return (
    <>
      <PageHeader title="Holdings" subtitle="Settled demat positions across every connected account" />

      <div className="mb-[var(--container-gap)]">
        <StatGrid>
          <StatTile label="Invested" value={currency(summary.invested)} detail="At average cost" />
          <StatTile label="Market value" value={currency(summary.market)} detail="At last price" />
          <StatTile
            label="Unrealised P&L"
            value={signedCurrency(summary.pnl)}
            signedBy={summary.pnl}
            detail={totalReturn === null ? undefined : `${percent(totalReturn)} on cost`}
          />
          <StatTile label="Collateral" value={currency(summary.collateral)} detail="Pledged value" />
        </StatGrid>
      </div>

      <BookPanel
        title="Holdings"
        icon={<Briefcase size={14} />}
        rows={holdings}
        columns={columns}
        rowKey={(row, i) => `${row.feedId}:${row.contract.symbol}:${i}`}
        errors={query.data?.errors}
        isLoading={query.isLoading}
        isFetching={query.isFetching}
        error={query.error}
        onRetry={() => query.refetch()}
        emptyTitle="No holdings"
        emptyHint="Settled equity positions appear here once a connected account reports them."
        initialSort={{ id: 'value', direction: 'desc' }}
      />
    </>
  );
}
