/**
 * Funds — margin and cash, per account.
 *
 * Deliberately NOT summed into one headline number. Cash in a Zerodha account
 * cannot margin an Angel position, so a combined total would be a figure that
 * is true of no account and misleading about all of them. The backend makes the
 * same call (see routes/trading.ts) and this page honours it: one card per
 * account, and the only cross-account figure is a count.
 */

import { Wallet } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { BrokerErrorStrip, EmptyState, ErrorState, TableSkeleton } from '@/components/ui/States';
import { Badge } from '@/components/ui/Badge';
import { useFunds } from '@/hooks/queries';
import { currency } from '@/lib/format';
import type { Funds } from '@/schemas/trading';

/** Utilisation as a proportion of the account's own total. Clamped because a
 *  broker reporting `used > total` mid-settlement would otherwise overflow the
 *  bar past its track. */
function utilisation(row: Funds): number {
  if (!row.total) return 0;
  return Math.min(100, Math.max(0, (row.used / row.total) * 100));
}

function FundsCard({ row }: { row: Funds }) {
  const pct = utilisation(row);
  // Colour by headroom, not by a fixed threshold per broker: past 85% an
  // intraday move can reject the next order, and that is worth flagging.
  const tone = pct >= 85 ? 'var(--status-danger)' : pct >= 60 ? 'var(--status-warning)' : 'var(--accent-info)';

  return (
    <Panel flush>
      <PanelHeader
        title={row.broker || row.feedId}
        subtitle={row.source ? `Source: ${row.source}` : undefined}
        icon={<Wallet size={14} />}
        actions={<Badge tone="neutral" mono>{pct.toFixed(0)}% used</Badge>}
      />

      <div className="space-y-4 p-4">
        <div>
          <span className="qs-label">Available to trade</span>
          <div className="mt-1 font-mono text-[length:var(--type-title)] font-semibold tabular-nums leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
            {currency(row.available)}
          </div>
        </div>

        {/* The utilisation bar. A single track, because the two numbers under it
            already give the exact figures — the bar only has to carry "how
            close to the edge is this account". */}
        <div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: 'var(--surface-raised)' }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{ width: `${pct}%`, background: tone }}
            />
          </div>
          <div className="mt-2 flex justify-between text-[length:var(--type-micro)]">
            <span className="text-[var(--text-tertiary)]">
              Used <span className="qs-num text-[var(--text-secondary)]">{currency(row.used)}</span>
            </span>
            <span className="text-[var(--text-tertiary)]">
              Total <span className="qs-num text-[var(--text-secondary)]">{currency(row.total)}</span>
            </span>
          </div>
        </div>
      </div>
    </Panel>
  );
}

export function FundsPage() {
  const query = useFunds();
  const funds = query.data?.funds ?? [];

  return (
    <>
      <PageHeader
        title="Funds"
        subtitle="Margin and cash, per account — not aggregated, because cash in one account cannot margin a position in another"
      />

      <BrokerErrorStrip errors={query.data?.errors ?? []} />

      {query.isLoading ? (
        <Panel flush>
          <TableSkeleton rows={3} columns={3} />
        </Panel>
      ) : query.error ? (
        <Panel>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </Panel>
      ) : funds.length === 0 ? (
        <Panel>
          <EmptyState
            icon={<Wallet size={22} strokeWidth={1.5} />}
            title="No funds reported"
            hint="Sign in to a broker account that publishes a funds endpoint."
          />
        </Panel>
      ) : (
        <div className="grid gap-[var(--container-gap)] md:grid-cols-2 xl:grid-cols-3">
          {funds.map((row) => (
            <FundsCard key={`${row.feedId}:${row.broker}`} row={row} />
          ))}
        </div>
      )}
    </>
  );
}
