/**
 * Dashboard — "where do I stand right now?", in four numbers.
 *
 * ── Why the tables are gone ──
 *
 * This page used to carry two summary panels: the top six positions by absolute
 * P&L, and the first six working orders. Both have moved to the Positions page,
 * whole, side by side.
 *
 * They were never good here. A truncated book is the worst of both readings —
 * not enough to act on, and enough to look complete, so a seventh position that
 * matters is invisible rather than obviously elsewhere. Everything a dashboard
 * can honestly say about a 200-row book is the aggregate, which is what these
 * tiles are.
 *
 * The tiles are still marked from the live tape rather than the REST book, so
 * the headline P&L here and the one on the Positions page cannot disagree.
 */

import { useMemo } from 'react';
import { ArrowRight, Layers, Receipt, ScrollText, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '@/components/layout/AppShell';
import { StatGrid, StatTile } from '@/components/ui/StatTile';
import { Badge } from '@/components/ui/Badge';
import { useFunds, useOrders, usePositions, useTrades } from '@/hooks/queries';
import { useQuoteSubscription } from '@/hooks/useLiveQuotes';
import { useQuoteStore } from '@/stores/quoteStore';
import { currency, integer, signedCurrency } from '@/lib/format';
import { isWorking } from '@/schemas/trading';

export function DashboardPage() {
  const positions = usePositions();
  const orders = useOrders();
  const trades = useTrades();
  const funds = useFunds();

  const quotes = useQuoteStore((s) => s.quotes);
  const rows = useMemo(() => positions.data?.positions ?? [], [positions.data]);

  const contracts = useMemo(() => rows.map((p) => p.contract), [rows]);
  useQuoteSubscription(contracts);

  // Same live-marking rule as the positions page — the dashboard's headline P&L
  // must not disagree with the book it summarises.
  const { netPnl, openLegs } = useMemo(() => {
    let net = 0;
    let open = 0;
    for (const position of rows) {
      const mark = quotes[position.contract.symbol]?.ltp ?? position.lastPrice;
      const average = position.quantity >= 0 ? position.buyAverage : position.sellAverage;
      net +=
        mark && average && position.quantity !== 0
          ? (mark - average) * position.quantity
          : position.pnl;
      if (position.quantity !== 0) open += 1;
    }
    return { netPnl: net, openLegs: open };
  }, [rows, quotes]);

  const allOrders = orders.data?.orders ?? [];
  const working = allOrders.filter((o) => isWorking(o.status));
  const fills = trades.data?.trades ?? [];
  const availableTotal = (funds.data?.funds ?? []).reduce((sum, f) => sum + f.available, 0);
  const accountCount = (funds.data?.funds ?? []).length;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live standing across every connected account"
        actions={
          <Link to="/positions">
            <Badge tone="accent" className="cursor-pointer">
              Position book <ArrowRight size={10} />
            </Badge>
          </Link>
        }
      />

      <StatGrid>
        <StatTile
          label="Net P&L"
          value={signedCurrency(netPnl)}
          signedBy={netPnl}
          detail={`${openLegs} open leg${openLegs === 1 ? '' : 's'}`}
          icon={<Layers size={14} />}
        />
        <StatTile
          label="Working orders"
          value={integer(working.length)}
          detail={`${allOrders.length} today`}
          icon={<ScrollText size={14} />}
        />
        <StatTile
          label="Fills"
          value={integer(fills.length)}
          detail="Executions today"
          icon={<Receipt size={14} />}
        />
        <StatTile
          label="Available margin"
          value={currency(availableTotal)}
          // Says out loud that this is a sum across accounts that cannot fund
          // each other — the funds page keeps them separate for that reason.
          detail={
            accountCount > 1 ? `Across ${accountCount} accounts — not fungible` : 'Free to trade'
          }
          icon={<Wallet size={14} />}
        />
      </StatGrid>
    </>
  );
}
