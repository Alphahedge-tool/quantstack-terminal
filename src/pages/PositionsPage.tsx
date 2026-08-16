/**
 * Positions — the working screen. Net position on the left, order flow on the
 * right, both live.
 *
 * ── Why the two books share a page ──
 *
 * They are read together and only together. "What am I holding" and "what is
 * still in the market" is one question asked twice, and answering them on
 * separate routes means alt-tabbing between two screens to work out what the
 * position will be in thirty seconds. This is the layout that used to be split
 * across the dashboard's two summary panels; those showed a truncated top-six
 * and sent you elsewhere for the rest, which is the worst of both.
 *
 * ── Why the P&L is recomputed here ──
 *
 * The REST book only moves when it is re-fetched, which leaves P&L frozen
 * between polls. The quote socket is the other half: the same contracts, priced
 * continuously. Rows join ticks by `contract.symbol`, the field both sides
 * already agree on.
 */

import { useMemo } from 'react';
import { Layers } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { ActivityPanel } from '@/components/trading/ActivityPanel';
import { BookPanel } from '@/components/trading/BookPanel';
import { BrokerCell, ContractCell } from '@/components/trading/cells';
import { spotKeys } from '@/lib/options/fromPositions';
import { DeltaText } from '@/components/ui/Badge';
import type { Column } from '@/components/ui/DataTable';
import { usePositions } from '@/hooks/queries';
import { useQuoteSubscription } from '@/hooks/useLiveQuotes';
import { useQuoteStore } from '@/stores/quoteStore';
import { decimal, integer, signedCurrency } from '@/lib/format';

export function PositionsPage() {
  const query = usePositions();
  const positions = useMemo(() => query.data?.positions ?? [], [query.data]);
  const quotes = useQuoteStore((s) => s.quotes);

  /**
   * ONE subscription for the whole page.
   *
   * The contracts on screen, plus a SPOT key per underlying for the payoff tab.
   * Both live here rather than each panel subscribing for itself, because the
   * server holds a single subscription set per connection and `subscribe`
   * REPLACES it — two components calling the hook would overwrite each other,
   * and whichever rendered last would win while the other's prices went dead.
   *
   * The hook takes contracts, not symbols: the socket addresses instruments by
   * their structural key, and the key is the one field a symbol string cannot be
   * turned back into.
   */
  const subscriptions = useMemo(
    () => [...positions.map((p) => p.contract), ...spotKeys(positions)],
    [positions],
  );
  useQuoteSubscription(subscriptions);

  /**
   * Mark each row to the live price when one has arrived, falling back to the
   * broker's own last price.
   *
   * P&L is recomputed from the live mark rather than trusting the broker's
   * `pnl` field, which is as stale as the poll. Direction comes from the signed
   * quantity: a short position gains as the price falls.
   */
  const marked = useMemo(
    () =>
      positions.map((position) => {
        const quote = quotes[position.contract.symbol];
        const mark = quote?.ltp ?? position.lastPrice;
        const average =
          position.quantity >= 0 ? position.buyAverage : position.sellAverage;
        const livePnl =
          mark && average && position.quantity !== 0
            ? (mark - average) * position.quantity
            : position.pnl;

        return { ...position, mark, livePnl, tick: quote?.tick ?? 'flat' };
      }),
    [positions, quotes],
  );

  const totals = useMemo(() => {
    let net = 0;
    let realised = 0;
    let open = 0;
    for (const row of marked) {
      net += row.livePnl;
      realised += row.realised;
      if (row.quantity !== 0) open += 1;
    }
    return { net, realised, open };
  }, [marked]);

  type Row = (typeof marked)[number];

  const columns: Column<Row>[] = [
    {
      id: 'contract',
      header: 'Instrument',
      cell: (row) => <ContractCell contract={row.contract} />,
      sortValue: (row) => row.contract.symbol,
      width: '24%',
    },
    {
      id: 'broker',
      header: 'Account',
      cell: (row) => <BrokerCell broker={row.broker} feedId={row.feedId} />,
      sortValue: (row) => row.broker,
      secondary: true,
    },
    {
      id: 'product',
      header: 'Product',
      cell: (row) => (
        <span className="text-[length:var(--type-micro)] uppercase tracking-[var(--tracking-label)] text-[var(--text-tertiary)]">
          {row.product}
        </span>
      ),
      sortValue: (row) => row.product,
      secondary: true,
    },
    {
      id: 'quantity',
      header: 'Qty',
      kind: 'num',
      // Quantity carries direction: a signed number is how long and short are
      // told apart, so it is coloured rather than shown as a bare magnitude.
      cell: (row) => <DeltaText value={row.quantity}>{integer(row.quantity)}</DeltaText>,
      sortValue: (row) => row.quantity,
    },
    {
      id: 'average',
      header: 'Avg',
      kind: 'num',
      cell: (row) =>
        decimal(row.quantity >= 0 ? row.buyAverage : row.sellAverage),
      sortValue: (row) => (row.quantity >= 0 ? row.buyAverage : row.sellAverage),
    },
    {
      id: 'mark',
      header: 'LTP',
      kind: 'num',
      cell: (row) => (
        <span className="text-[var(--text-primary)]">{decimal(row.mark)}</span>
      ),
      sortValue: (row) => row.mark,
    },
    {
      id: 'pnl',
      header: 'P&L',
      kind: 'num',
      cell: (row) => <DeltaText value={row.livePnl}>{signedCurrency(row.livePnl)}</DeltaText>,
      sortValue: (row) => row.livePnl,
    },
    {
      id: 'realised',
      header: 'Realised',
      kind: 'num',
      cell: (row) => <DeltaText value={row.realised}>{signedCurrency(row.realised)}</DeltaText>,
      sortValue: (row) => row.realised,
      secondary: true,
    },
  ];

  return (
    /*
     * A column that fills the shell's scroll region, so the two books below get
     * a bounded height and scroll INSIDE their own panels. Letting the page
     * scroll instead would push the order flow off the bottom of the screen the
     * moment the position book grew past a dozen rows — which is exactly when
     * both of them need to be visible at once.
     */
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Positions"
        subtitle="Net position and order flow across every connected account, marked to the live tape"
      />

      {/*
        No KPI strip.
        The three tiles here restated numbers the table already contains, and
        cost ~62px of the one thing this page is short of — rows on screen. Net
        P&L and Realised now sit at the foot of their own columns, which is both
        less space and a shorter trip for the eye: a total under the column it
        totals needs no matching to a heading.
      */}
      <div className="grid min-h-0 flex-1 gap-[var(--container-gap)] xl:grid-cols-2">
        <BookPanel
          title="Position book"
          icon={<Layers size={14} />}
          rows={marked}
          columns={columns}
          rowKey={(row, i) => `${row.feedId}:${row.contract.symbol}:${row.product}:${i}`}
          // The flash is keyed off the tick direction the store derived; a row
          // that did not move gets no class and so no animation restart.
          rowClassName={(row) =>
            row.tick === 'up' ? 'tick-up' : row.tick === 'down' ? 'tick-down' : undefined
          }
          errors={query.data?.errors}
          isLoading={query.isLoading}
          isFetching={query.isFetching}
          error={query.error}
          onRetry={() => query.refetch()}
          emptyTitle="No open positions"
          emptyHint="Positions appear here once a connected account reports them."
          initialSort={{ id: 'pnl', direction: 'desc' }}
          // Only the two columns that can honestly be added up. Quantity across
          // different strikes sums to a number with no meaning, and an average
          // of averages is worse than no figure at all.
          totals={{
            contract: (
              <span className="text-[length:var(--type-micro)] uppercase tracking-[var(--tracking-label)] text-[var(--text-secondary)]">
                Net · {totals.open} open of {marked.length}
              </span>
            ),
            pnl: <DeltaText value={totals.net}>{signedCurrency(totals.net)}</DeltaText>,
            realised: (
              <DeltaText value={totals.realised}>{signedCurrency(totals.realised)}</DeltaText>
            ),
          }}
        />

        <ActivityPanel positions={positions} />
      </div>
    </div>
  );
}
