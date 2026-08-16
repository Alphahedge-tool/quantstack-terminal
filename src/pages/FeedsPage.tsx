/**
 * Feeds — the plumbing view.
 *
 * This is the page someone opens when prices have stopped moving, so it answers
 * that question directly: which feeds exist, which are connected, which
 * exchanges each can carry, and which trading capabilities each account
 * publishes. A capability gap is shown as absence, not as an error — a broker
 * that simply does not publish a holdings endpoint is not broken.
 */

import { Radio, Server } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { Badge, StatusDot } from '@/components/ui/Badge';
import { EmptyState, ErrorState, TableSkeleton } from '@/components/ui/States';
import { useBrokers, useFeeds, useHealth } from '@/hooks/queries';
import { dateTime } from '@/lib/format';

const CAPABILITY_LABELS = [
  ['orders', 'Orders'],
  ['trades', 'Trades'],
  ['positions', 'Positions'],
  ['holdings', 'Holdings'],
  ['funds', 'Funds'],
] as const;

export function FeedsPage() {
  const health = useHealth();
  const feeds = useFeeds();
  const brokers = useBrokers();

  return (
    <>
      <PageHeader title="Feeds" subtitle="Connection state for every configured feed and trading account" />

      <div className="grid gap-[var(--container-gap)] lg:grid-cols-2">
        <Panel flush>
          <PanelHeader
            title="Backend service"
            icon={<Server size={14} />}
            actions={
              <Badge tone={health.isSuccess ? 'success' : 'danger'}>
                {health.isSuccess ? 'Healthy' : 'Down'}
              </Badge>
            }
          />
          <div className="space-y-2 p-4 text-[length:var(--type-caption)]">
            <Row label="Service" value={health.data?.service ?? '—'} />
            <Row label="Port" value={health.data?.port ? String(health.data.port) : '—'} />
            <Row label="Last response" value={dateTime(health.data?.ts)} />
            {health.error ? (
              <p className="pt-2 text-[length:var(--type-micro)] text-[var(--status-danger)]">
                {(health.error as Error).message}
              </p>
            ) : null}
          </div>
        </Panel>

        <Panel flush>
          <PanelHeader
            title="Market data feeds"
            icon={<Radio size={14} />}
            subtitle={`${(feeds.data?.feeds ?? []).filter((f) => f.connected).length} of ${(feeds.data?.feeds ?? []).length} connected`}
          />
          <PanelBody>
            {feeds.isLoading ? (
              <TableSkeleton rows={3} columns={2} />
            ) : feeds.error ? (
              <ErrorState error={feeds.error} onRetry={() => feeds.refetch()} />
            ) : (feeds.data?.feeds ?? []).length === 0 ? (
              <EmptyState title="No feeds configured" hint="Add broker credentials to the backend's .env." />
            ) : (
              <ul className="divide-y divide-[var(--container-rule)]">
                {(feeds.data?.feeds ?? []).map((feed) => (
                  <li key={feed.id} className="flex items-center gap-3 px-4 py-3">
                    <StatusDot tone={feed.connected ? 'success' : 'danger'} pulse={feed.connected} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[length:var(--type-control)] font-medium text-[var(--text-primary)]">
                        {feed.broker || feed.id}
                      </div>
                      <div className="mt-0.5 truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                        {feed.capabilities?.exchanges?.length
                          ? feed.capabilities.exchanges.join(' · ')
                          : 'No exchanges reported'}
                      </div>
                    </div>
                    {feed.priority !== undefined ? (
                      <Badge tone="neutral" mono>
                        P{feed.priority}
                      </Badge>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
      </div>

      <div className="mt-[var(--container-gap)]">
        <Panel flush>
          <PanelHeader
            title="Trading accounts"
            subtitle="Capabilities each account publishes — an unlit capability means the broker does not offer that book, not that it failed"
            icon={<Server size={14} />}
          />
          <PanelBody>
            {brokers.isLoading ? (
              <TableSkeleton rows={3} columns={6} />
            ) : brokers.error ? (
              <ErrorState error={brokers.error} onRetry={() => brokers.refetch()} />
            ) : (brokers.data?.brokers ?? []).length === 0 ? (
              <EmptyState title="No trading accounts" hint="Configure a broker in the backend to see its books." />
            ) : (
              <ul className="divide-y divide-[var(--container-rule)]">
                {(brokers.data?.brokers ?? []).map((broker) => (
                  <li key={broker.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <StatusDot tone={broker.connected ? 'success' : 'danger'} pulse={broker.connected} />
                    <span className="min-w-[8rem] text-[length:var(--type-control)] font-medium text-[var(--text-primary)]">
                      {broker.broker || broker.id}
                    </span>
                    <Badge tone={broker.connected ? 'success' : 'neutral'}>
                      {broker.connected ? 'Connected' : 'Signed out'}
                    </Badge>
                    <div className="flex flex-wrap gap-1.5">
                      {CAPABILITY_LABELS.map(([key, label]) => (
                        <Badge
                          key={key}
                          tone={broker.capabilities[key] ? 'accent' : 'neutral'}
                          className={broker.capabilities[key] ? undefined : 'opacity-45'}
                        >
                          {label}
                        </Badge>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="qs-label">{label}</span>
      <span className="qs-num text-[var(--text-primary)]">{value}</span>
    </div>
  );
}
