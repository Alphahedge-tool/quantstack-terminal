/**
 * The right-hand container beside the position book.
 *
 * Three views of the same book, switched from the header:
 *
 *   Working   — orders still live in the market (OPEN, PENDING, PARTIAL,
 *               TRIGGER_PENDING)
 *   Executed  — orders that filled (COMPLETE)
 *   Payoff    — the whole position as one curve, with greeks and risk
 *
 * ── Why these three share a container ──
 *
 * They are the same question at three horizons: what is about to happen, what
 * just happened, and what the result is worth across every price. Given three
 * panels they would each get a third of the width and none would be readable;
 * given three routes you would be alt-tabbing to compare a fill against the
 * curve it just moved.
 *
 * ── What the order tabs deliberately do NOT cover ──
 *
 * Cancelled and rejected orders are in neither bucket. Letting them vanish would
 * be the worst omission on this screen — a rejection is the single row a trader
 * most needs to see, and an order that silently is not there reads as an order
 * that was never placed. They are counted in the footer with a way through to
 * the full book instead.
 */

import { useMemo, useState } from 'react';
import { Activity, ArrowRight, ScrollText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { BookPanel } from './BookPanel';
import { PayoffPanel } from './PayoffPanel';
import { BrokerCell, ContractCell, SideCell, StatusCell } from './cells';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/Field';
import type { Column } from '@/components/ui/DataTable';
import { useOrders } from '@/hooks/queries';
import { clockTime, decimal, integer } from '@/lib/format';
import { isExecuted, isWorking, type Order, type Position } from '@/schemas/trading';

type Tab = 'working' | 'executed' | 'payoff';

export function ActivityPanel({ positions }: { positions: Position[] }) {
  const query = useOrders();
  const [tab, setTab] = useState<Tab>('working');

  const all = useMemo(() => query.data?.orders ?? [], [query.data]);

  const { working, executed, other } = useMemo(() => {
    const w: Order[] = [];
    const e: Order[] = [];
    const o: Order[] = [];
    for (const order of all) {
      // Working covers partial fills and armed stop orders too — see
      // `isWorking`. A resting stop-loss belongs on that tab, not in the footer.
      if (isWorking(order.status)) w.push(order);
      else if (isExecuted(order.status)) e.push(order);
      else o.push(order);
    }
    return { working: w, executed: e, other: o };
  }, [all]);

  const tabs = (
    <SegmentedControl<Tab>
      value={tab}
      onChange={setTab}
      options={[
        { value: 'working', label: <TabLabel text="Working" count={working.length} /> },
        { value: 'executed', label: <TabLabel text="Executed" count={executed.length} /> },
        { value: 'payoff', label: 'Payoff' },
      ]}
    />
  );

  if (tab === 'payoff') {
    return (
      <Panel flush className="min-h-[20rem]">
        <PanelHeader
          title="Payoff"
          icon={<Activity size={14} />}
          subtitle="Every open leg as one curve"
          actions={tabs}
        />
        <PanelBody>
          <PayoffPanel positions={positions} />
        </PanelBody>
      </Panel>
    );
  }

  const rows = tab === 'working' ? working : executed;

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
    },
    {
      id: 'contract',
      header: 'Instrument',
      cell: (row) => <ContractCell contract={row.contract} />,
      sortValue: (row) => row.contract.symbol,
      width: '34%',
    },
    {
      id: 'side',
      header: 'Side',
      cell: (row) => <SideCell side={row.side} />,
      sortValue: (row) => row.side,
    },
    {
      id: 'qty',
      header: 'Qty',
      kind: 'num',
      // Filled against total on the working tab, because a part-filled order is
      // a different situation from an untouched one. On the executed tab they
      // are equal by definition, so only the size is worth the width.
      cell: (row) =>
        tab === 'working'
          ? `${integer(row.filled)} / ${integer(row.quantity)}`
          : integer(row.filled || row.quantity),
      sortValue: (row) => row.quantity,
    },
    {
      id: 'price',
      header: tab === 'working' ? 'Price' : 'Avg',
      kind: 'num',
      // A working order's price is what it is RESTING at; an executed one's is
      // what it actually got. Showing the limit price on a fill would be quietly
      // wrong on every order that slipped.
      cell: (row) =>
        tab === 'working'
          ? decimal(row.triggerPrice || row.price)
          : decimal(row.averagePrice || row.price),
      sortValue: (row) => (tab === 'working' ? row.price : row.averagePrice),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => <StatusCell status={row.status} message={row.message} />,
      sortValue: (row) => row.status,
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
    <BookPanel
      title="Order flow"
      icon={<ScrollText size={14} />}
      rows={rows}
      columns={columns}
      // The tab is part of the key. Without it the two views share a row
      // identity, and React reuses the executed row's DOM for whatever working
      // order lands in the same position.
      rowKey={(row, i) => `${tab}:${row.feedId}:${row.id || i}`}
      errors={query.data?.errors}
      isLoading={query.isLoading}
      isFetching={query.isFetching}
      error={query.error}
      onRetry={() => query.refetch()}
      emptyTitle={tab === 'working' ? 'Nothing working' : 'No fills yet'}
      emptyHint={
        tab === 'working'
          ? 'Orders still live in the market appear here.'
          : 'Orders that filled today appear here. It is still early if the session just opened.'
      }
      initialSort={{ id: 'time', direction: 'desc' }}
      actions={tabs}
      footer={
        other.length ? (
          /*
           * What neither tab shows. Worded as "neither working nor filled"
           * rather than naming the statuses, because the bucket also catches
           * UNKNOWN — a status the backend could not map — and calling that
           * "cancelled" would be a guess presented as a fact.
           */
          <Link
            to="/orders"
            className="flex items-center gap-1 text-[var(--text-tertiary)] hover:text-[var(--accent-info)]"
          >
            {integer(other.length)} order{other.length === 1 ? '' : 's'} neither working nor filled
            — see the full book
            <ArrowRight size={11} />
          </Link>
        ) : undefined
      }
    />
  );
}

function TabLabel({ text, count }: { text: string; count: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {text}
      <span className="qs-num opacity-60">{count}</span>
    </span>
  );
}
