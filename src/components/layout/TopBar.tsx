/**
 * Top bar — identity, global controls, and the two health signals that matter
 * everywhere: is the backend answering, and is a feed carrying prices.
 *
 * The clock is here rather than in the status bar because on a trading screen
 * the time is checked constantly and the eye already goes to the top-right.
 */

import { useEffect, useState } from 'react';
import { Gauge, LogOut, RefreshCw, Rows3, Rows4 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Badge, StatusDot } from '@/components/ui/Badge';
import { BrokerLogo } from '@/components/auth/BrokerLogo';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { useBrokers, useHealth } from '@/hooks/queries';
import { getBroker } from '@/lib/brokers';
import { useAuthStore } from '@/stores/authStore';
import { useQuoteStore } from '@/stores/quoteStore';
import { useUiStore } from '@/stores/uiStore';

const REFRESH_OPTIONS = [
  { value: '2000', label: '2s' },
  { value: '5000', label: '5s' },
  { value: '15000', label: '15s' },
  { value: '30000', label: '30s' },
  { value: '0', label: 'Off' },
];

/** Ticking clock. Its own state so the second-by-second re-render is scoped to
 *  this component and does not touch the rest of the bar. */
function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <span className="qs-num text-[length:var(--type-caption)] tracking-wider text-[var(--text-secondary)]">
      {now.toLocaleTimeString('en-IN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}
    </span>
  );
}

/**
 * Who you are signed in as, and the way out.
 *
 * Signing out clears the local selection only — it deliberately does not call
 * `/api/feeds/logout`. That session is shared with every other tab and with the
 * backend's own scheduled work, so tearing it down because one browser stepped
 * away would take the feed offline for all of them.
 */
function AccountChip() {
  const navigate = useNavigate();
  const accounts = useAuthStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const signOut = useAuthStore((s) => s.signOut);

  const account = accounts.find((a) => a.id === activeAccountId);
  if (!account) return null;

  const broker = getBroker(account.broker);

  return (
    <div className="flex shrink-0 items-center gap-2">
      {broker ? <BrokerLogo broker={broker} size="sm" /> : null}
      <span className="hidden max-w-[10rem] flex-col leading-tight md:flex">
        <span className="truncate text-[length:var(--type-micro)] font-semibold text-[var(--text-primary)]">
          {account.name}
        </span>
        <span className="truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {broker?.name ?? account.broker}
        </span>
      </span>
      <Button
        size="sm"
        iconOnly
        title="Sign out"
        aria-label="Sign out"
        onClick={() => {
          signOut();
          navigate('/login', { replace: true });
        }}
        icon={<LogOut size={14} />}
      />
    </div>
  );
}

export function TopBar() {
  const queryClient = useQueryClient();
  const health = useHealth();
  const brokers = useBrokers();

  const socketState = useQuoteStore((s) => s.socket);
  const carrying = useQuoteStore((s) => s.carrying);

  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const refreshMs = useUiStore((s) => s.refreshMs);
  const setRefreshMs = useUiStore((s) => s.setRefreshMs);
  const brokerFilter = useUiStore((s) => s.brokerFilter);
  const setBrokerFilter = useUiStore((s) => s.setBrokerFilter);

  const brokerOptions = [
    { value: '', label: 'All accounts' },
    ...(brokers.data?.brokers ?? []).map((b) => ({
      value: b.id,
      // Connection state belongs on the option: picking a signed-out account
      // and getting an empty book is otherwise indistinguishable from a flat one.
      label: b.connected ? b.broker || b.id : `${b.broker || b.id} (offline)`,
    })),
  ];

  return (
    <header
      className="flex shrink-0 items-center gap-4 border-b border-[var(--chrome-border-subtle)] bg-[var(--chrome-panel)] px-4"
      style={{ height: 'var(--topbar-height)' }}
    >
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-info)] text-[var(--text-inverse)]">
          <Gauge size={14} strokeWidth={2.25} />
        </span>
        <span className="text-[length:var(--type-control)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          Quant<span className="text-[var(--accent-info)]">Stack</span>
        </span>
      </div>

      <div className="h-5 w-px shrink-0 bg-[var(--chrome-border-subtle)]" />

      {/* ── Health ── two separate facts, deliberately not merged. The backend
          can be up while no feed is carrying, and that difference is the first
          thing to check when prices stop moving. */}
      <div className="flex shrink-0 items-center gap-3">
        <span className="flex items-center gap-1.5" title="Backend service">
          <StatusDot tone={health.isSuccess ? 'success' : 'danger'} pulse={health.isSuccess} />
          <span className="text-[length:var(--type-micro)] text-[var(--text-secondary)]">
            {health.isSuccess ? 'Backend' : 'Backend down'}
          </span>
        </span>

        <span className="flex items-center gap-1.5" title="Live quote channel">
          <StatusDot
            tone={socketState === 'open' ? (carrying ? 'success' : 'warning') : 'danger'}
            pulse={socketState === 'open' && carrying}
          />
          <span className="text-[length:var(--type-micro)] text-[var(--text-secondary)]">
            {socketState === 'open' ? (carrying ? 'Live' : 'Idle') : 'Offline'}
          </span>
        </span>
      </div>

      <div className="flex-1" />

      <div className="flex shrink-0 items-center gap-2">
        {brokerOptions.length > 1 ? (
          <Select
            aria-label="Account filter"
            value={brokerFilter}
            options={brokerOptions}
            onChange={(e) => setBrokerFilter(e.target.value)}
            className="min-w-[9rem]"
          />
        ) : null}

        <Select
          aria-label="Refresh interval"
          value={String(refreshMs)}
          options={REFRESH_OPTIONS}
          onChange={(e) => setRefreshMs(Number(e.target.value))}
          className="w-[5.5rem]"
        />

        <Button
          size="sm"
          iconOnly
          title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
          aria-label="Toggle row density"
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
          icon={density === 'compact' ? <Rows3 size={14} /> : <Rows4 size={14} />}
        />

        <Button
          size="sm"
          iconOnly
          title="Refresh all"
          aria-label="Refresh all data"
          onClick={() => queryClient.invalidateQueries()}
          icon={<RefreshCw size={14} />}
        />

        <div className="h-5 w-px bg-[var(--chrome-border-subtle)]" />

        {health.data?.port ? (
          <Badge tone="neutral" mono>
            :{health.data.port}
          </Badge>
        ) : null}
        <Clock />

        <div className="h-5 w-px bg-[var(--chrome-border-subtle)]" />
        <AccountChip />
      </div>
    </header>
  );
}
