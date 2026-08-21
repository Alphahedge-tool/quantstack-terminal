/**
 * Sign in — the screen that stands between a cold start and the terminal.
 *
 * It answers two questions, in this order:
 *
 *   1. Which of my broker accounts do I want to work in?
 *   2. Is that account's session actually alive right now?
 *
 * The second is the one this page exists for. Connection state belongs to the
 * BACKEND — it auto-logs-in every feed in `QT_FEEDS` at boot — so an account is
 * usually already live before this screen is ever touched. Every badge here
 * reads from `/api/feeds` rather than from anything this tab remembers, because
 * a local "not connected" painted over a working session sends people to debug
 * a login that already succeeded.
 *
 * Rendered OUTSIDE AppShell: the shell mounts the live quote socket and polls
 * every book, and doing that behind a sign-in screen is work for a session that
 * may not exist yet.
 */

import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Gauge,
  KeyRound,
  Plus,
  Shield,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { Badge, StatusDot } from '@/components/ui/Badge';
import { BrokerLogo } from '@/components/auth/BrokerLogo';
import { Button } from '@/components/ui/Button';
import { CredentialField } from '@/components/auth/CredentialField';
import { Input, Label } from '@/components/ui/Field';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { EmptyState, Spinner } from '@/components/ui/States';
import {
  extractRequestToken,
  fetchZerodhaLoginUrl,
  useConnectFeed,
  useFeedStates,
  useSavedAccounts,
  useZerodhaToken,
  type FeedState,
} from '@/hooks/auth';
import {
  BROKERS,
  feedIdFor,
  getBroker,
  missingFields,
  type BrokerConfig,
  type BrokerId,
} from '@/lib/brokers';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { useAuthStore, type SessionStatus } from '@/stores/authStore';
import type { Tone } from '@/components/ui/Badge';

const STATUS_LABEL: Record<SessionStatus, string> = {
  active: 'Connected',
  connecting: 'Connecting',
  error: 'Failed',
  expired: 'Session expired',
  idle: 'Not connected',
};

const STATUS_TONE: Record<SessionStatus, Tone> = {
  active: 'success',
  connecting: 'warning',
  error: 'danger',
  expired: 'neutral',
  idle: 'neutral',
};

/**
 * The credential the BROKER logs in with, out of a filled form.
 *
 * This is what identifies an account across saves — see `identityOf` in the
 * store. Each broker names it differently and only one of these keys is ever
 * present for a given form.
 */
function identityFrom(broker: BrokerId, values: Record<string, string>): string {
  const key =
    broker === 'angelone' ? 'client_id'
    : broker === 'zerodha' ? 'user_id'
    : broker === 'nubra' ? 'phone'
    : 'mobile';
  return String(values[key] ?? '').trim();
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  /** Where the guard bounced us from, so a sign-in lands back on that page. */
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const accounts = useAuthStore((s) => s.accounts);
  const linkAccount = useAuthStore((s) => s.linkAccount);
  const removeAccount = useAuthStore((s) => s.removeAccount);
  const setActiveAccount = useAuthStore((s) => s.setActiveAccount);
  const setStatus = useAuthStore((s) => s.setStatus);
  const dedupeAccounts = useAuthStore((s) => s.dedupeAccounts);

  // Collapse duplicates left by earlier saves, once per mount.
  useEffect(() => {
    dedupeAccounts();
  }, [dedupeAccounts]);

  const [view, setView] = useState<'accounts' | 'add'>(
    accounts.length === 0 ? 'add' : 'accounts',
  );

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--surface-canvas)]">
      <TopStrip />

      <div className="flex min-h-0 flex-1">
        <Aside />

        <main className="min-w-0 flex-1 overflow-auto bg-[var(--surface-blue)] p-[var(--container-gap)]">
          <div className="mx-auto w-full max-w-[640px] py-6">
            {view === 'accounts' ? (
              <AccountsView
                onAdd={() => setView('add')}
                onSignedIn={() => navigate(from, { replace: true })}
                accounts={accounts}
                removeAccount={removeAccount}
                setActiveAccount={setActiveAccount}
                setStatus={setStatus}
              />
            ) : (
              <AddAccountView
                canCancel={accounts.length > 0}
                onCancel={() => setView('accounts')}
                onLinked={(account) => {
                  linkAccount(account);
                  setView('accounts');
                }}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/* ── Chrome ───────────────────────────────────────────────────────────────── */

function TopStrip() {
  const [time, setTime] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setTime(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <header
      className="flex shrink-0 items-center gap-3 border-b border-[var(--chrome-border-subtle)] bg-[var(--chrome-panel)] px-4"
      style={{ height: 'var(--topbar-height)' }}
    >
      <span className="flex size-6 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-info)] text-[var(--text-inverse)]">
        <Gauge size={14} strokeWidth={2.25} />
      </span>
      <span className="text-[length:var(--type-control)] font-bold tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
        Quant<span className="text-[var(--accent-info)]">Stack</span>
      </span>
      <Badge tone="neutral">Terminal</Badge>

      <div className="flex-1" />

      <span className="hidden text-[length:var(--type-micro)] text-[var(--text-tertiary)] sm:inline">
        NSE · BSE · MCX
      </span>
      <span className="qs-num text-[length:var(--type-caption)] tracking-wider text-[var(--text-secondary)]">
        {time.toLocaleTimeString('en-IN', {
          timeZone: 'Asia/Kolkata',
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        })}{' '}
        IST
      </span>
    </header>
  );
}

/** The pitch column. Hidden below `lg` — on a narrow window the form is the job. */
function Aside() {
  return (
    <aside className="hidden w-[340px] shrink-0 flex-col justify-between border-r border-[var(--chrome-border-subtle)] bg-[var(--chrome-panel)] p-8 lg:flex">
      <div>
        <p className="qs-label text-[var(--accent-info)]">Options intelligence workspace</p>
        <h1 className="mt-3 text-[length:var(--type-title)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          One terminal.
          <br />
          Every trading account.
        </h1>
        <p className="mt-3 text-[length:var(--type-caption)] leading-relaxed text-[var(--text-secondary)]">
          Connect your brokers and analyse NSE, BSE and MCX from a single workspace.
        </p>

        <ul className="mt-8 space-y-4">
          <Feature icon={<Zap size={14} />} title="Unattended sessions">
            TOTP is generated server-side; feeds reconnect on their own.
          </Feature>
          <Feature icon={<Users size={14} />} title="Multi-account">
            Four brokers, each with its own session and capabilities.
          </Feature>
          <Feature icon={<Shield size={14} />} title="Credentials stay server-side">
            This browser never holds or transmits a secret.
          </Feature>
          <Feature icon={<Clock size={14} />} title="Honest connection state">
            Every badge is read from the backend, not remembered locally.
          </Feature>
        </ul>
      </div>

      <div>
        <p className="qs-label mb-2 text-[var(--text-disabled)]">Supported connections</p>
        <div className="flex gap-2">
          {BROKERS.map((broker) => (
            <span key={broker.id} title={broker.name}>
              <BrokerLogo broker={broker} size="sm" />
            </span>
          ))}
        </div>
        <p className="mt-6 text-[length:var(--type-micro)] leading-relaxed text-[var(--text-disabled)]">
          QuantStack Terminal v1.0
          <br />
          For informational purposes only. Not SEBI registered.
        </p>
      </div>
    </aside>
  );
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--accent-info-soft)] text-[var(--accent-info)]">
        {icon}
      </span>
      <span className="min-w-0">
        <strong className="block text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
          {title}
        </strong>
        <span className="block text-[length:var(--type-caption)] leading-snug text-[var(--text-secondary)]">
          {children}
        </span>
      </span>
    </li>
  );
}

/* ── Accounts ─────────────────────────────────────────────────────────────── */

function AccountsView({
  accounts,
  onAdd,
  onSignedIn,
  removeAccount,
  setActiveAccount,
  setStatus,
}: {
  accounts: ReturnType<typeof useAuthStore.getState>['accounts'];
  onAdd: () => void;
  onSignedIn: () => void;
  removeAccount: (id: string) => void;
  setActiveAccount: (id: string | null) => void;
  setStatus: (id: string, status: SessionStatus, errorMsg?: string) => void;
}) {
  const feeds = useFeedStates();
  const connect = useConnectFeed();
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function handleConnect(id: string, broker: BrokerId) {
    const feed = feeds.stateOf(broker);

    // Not in QT_FEEDS. This one genuinely cannot connect, and naming the setting
    // is the difference between a config line to add and a missing feature.
    if (feeds.loaded && !feed.configured) {
      setStatus(
        id,
        'error',
        `${getBroker(broker)?.name ?? broker} is not in QT_FEEDS, so the backend holds no session for it. ` +
          `Add "${feedIdFor(broker)}" to QT_FEEDS in the backend's .env and restart.`,
      );
      return;
    }

    setPendingId(id);
    setStatus(id, 'connecting');
    const { ok, message } = await connect.mutateAsync(broker);
    setPendingId(null);

    if (!ok) {
      setStatus(id, 'error', message);
      return;
    }
    setStatus(id, 'active');
    setActiveAccount(id);
    onSignedIn();
  }

  return (
    <div className="space-y-[var(--container-gap)]">
      <Panel flush>
        <PanelHeader
          title="Select an account"
          subtitle={`${accounts.length} broker account${accounts.length === 1 ? '' : 's'} linked to this browser`}
          icon={<KeyRound size={14} />}
          actions={
            <Button variant="primary" icon={<Plus size={14} />} onClick={onAdd}>
              Add account
            </Button>
          }
        />
        {accounts.length === 0 ? (
          <EmptyState
            icon={<KeyRound size={22} strokeWidth={1.5} />}
            title="No accounts linked yet"
            hint="Link a broker account to sign in. The backend holds the credentials; this only records which account you are working in."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={onAdd}>
                Add account
              </Button>
            }
          />
        ) : null}

        <ul className="divide-y divide-[var(--container-rule)]">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              feed={feeds.stateOf(account.broker)}
              feedsLoaded={feeds.loaded}
              busy={pendingId === account.id}
              onConnect={() => handleConnect(account.id, account.broker)}
              onForget={() => removeAccount(account.id)}
              onStatus={(status, message) => setStatus(account.id, status, message)}
            />
          ))}
        </ul>
      </Panel>

      {feeds.error ? (
        <Notice tone="danger">
          The backend is not answering on <code>/api/feeds</code>, so no session state can be
          shown. Start qt-backend (port 3101) and this will fill in on its own.
        </Notice>
      ) : null}
    </div>
  );
}

function AccountRow({
  account,
  feed,
  feedsLoaded,
  busy,
  onConnect,
  onForget,
  onStatus,
}: {
  account: ReturnType<typeof useAuthStore.getState>['accounts'][number];
  feed: FeedState;
  feedsLoaded: boolean;
  busy: boolean;
  onConnect: () => void;
  onForget: () => void;
  onStatus: (status: SessionStatus, message?: string) => void;
}) {
  const broker = getBroker(account.broker);
  if (!broker) return null;

  // The backend is the authority. A local status is only consulted when the
  // backend does not claim the session is up.
  const status: SessionStatus =
    busy || feed.loggingIn ? 'connecting' : feed.connected ? 'active' : account.status;

  const error = feed.connected ? undefined : errorFor(account.errorMsg, feed, feedsLoaded, broker);

  const backoff =
    !feed.connected && feed.retryAfter && feed.retryAfter > Date.now()
      ? Math.ceil((feed.retryAfter - Date.now()) / 1000)
      : 0;

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3.5">
      <BrokerLogo broker={broker} size="lg" />

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="truncate text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
            {account.name}
          </h3>
          <Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>
          {account.env === 'UAT' ? <Badge tone="warning">Sandbox</Badge> : null}
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          <span>{broker.name}</span>
          {account.identity ? <span className="qs-num">{account.identity}</span> : null}
          {account.autoLogin ? (
            <span className="flex items-center gap-1">
              <Zap size={10} />
              Auto-login
            </span>
          ) : null}
          {feed.connected && feed.connectedAt ? (
            <span>Session since {relativeTime(feed.connectedAt)}</span>
          ) : account.lastLogin ? (
            <span>Last used {relativeTime(Date.parse(account.lastLogin))}</span>
          ) : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="mt-2 flex gap-1.5 text-[length:var(--type-micro)] leading-snug text-[var(--status-danger)]"
          >
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        ) : null}

        {backoff > 0 ? (
          <p className="mt-1 text-[length:var(--type-micro)] text-[var(--status-warning)]">
            The backend is backing off after a failed login and will refuse another attempt for
            about {backoff}s. Eight concurrent TOTP retries is how an account gets locked out, so
            the wait is deliberate.
          </p>
        ) : null}

        {feed.breakerOpen ? (
          <p className="mt-1 text-[length:var(--type-micro)] text-[var(--status-warning)]">
            Circuit breaker is OPEN — the router has taken this feed out of rotation. Reset it from
            the Feeds page once the broker is healthy.
          </p>
        ) : null}

        {/*
          Zerodha's browser login. Kite Connect has no login endpoint, so two
          cases need a real browser: the one-time "Authorize" screen on an
          account's first connection to an API app, and an account with no TOTP
          secret stored, where the headless login cannot run at all. Offered on
          every disconnected Zerodha row rather than only after a failure —
          waiting for the error makes the supported path look like a fallback.
        */}
        {account.broker === 'zerodha' && !feed.connected ? (
          <ZerodhaBrowserLogin onStatus={onStatus} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="ghost"
          iconOnly
          title={`Forget ${account.name}`}
          aria-label={`Forget ${account.name}`}
          onClick={onForget}
          icon={<Trash2 size={14} />}
        />
        <Button variant="primary" disabled={busy} onClick={onConnect}>
          {busy ? (
            <>
              <Spinner />
              Connecting
            </>
          ) : feed.connected ? (
            <>
              Enter
              <ChevronRight size={14} />
            </>
          ) : (
            <>
              Connect
              <ChevronRight size={14} />
            </>
          )}
        </Button>
      </div>
    </li>
  );
}

/**
 * Which failure to show, in the order the user can act on them.
 *
 * The Zerodha rewrite is the one that matters most. A Zerodha row with no TOTP
 * secret cannot log in headlessly, and the backend says so in the language of
 * the headless path — "credentials missing". Shown as-is next to a working
 * Browser login button that needs none of those fields, it reads as a dead end.
 */
function errorFor(
  local: string | undefined,
  feed: FeedState,
  feedsLoaded: boolean,
  broker: BrokerConfig,
): string | undefined {
  if (feedsLoaded && !feed.configured) {
    return `Not in QT_FEEDS — the backend holds no session for ${broker.name}.`;
  }

  const message = local ?? feed.lastError ?? undefined;

  if (broker.id === 'zerodha' && message && /credentials missing/i.test(message)) {
    return (
      'Headless login needs a TOTP secret and account password, which this account has not ' +
      'stored. Use Browser login — it needs neither.'
    );
  }
  return message;
}

function ZerodhaBrowserLogin({
  onStatus,
}: {
  onStatus: (status: SessionStatus, message?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pasted, setPasted] = useState('');
  const submit = useZerodhaToken();

  /**
   * Open Kite's login page, then wait for the token.
   *
   * The paste box is shown REGARDLESS of whether the popup opens. Kite redirects
   * to the URL registered in the developer console, which frequently is not this
   * server — a production domain, or `https://127.0.0.1` with nothing listening.
   * When that happens the token is still in the address bar of the tab that just
   * opened, and pasting it is the whole recovery.
   */
  async function begin() {
    setOpen(true);
    setPasted('');
    const { url, error } = await fetchZerodhaLoginUrl();
    if (!url) {
      onStatus('error', error ?? 'Could not build the Zerodha login URL.');
      setOpen(false);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  async function finish() {
    const token = extractRequestToken(pasted);
    if (!token) return;
    const { ok, message } = await submit.mutateAsync(token);
    if (!ok) {
      // Keep the box open: the usual failures are a stale or already-used token,
      // and the fix is to run the login again and paste a fresh one.
      onStatus('error', message);
      return;
    }
    setPasted('');
    setOpen(false);
    onStatus('active');
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={begin}
        className="mt-2 text-[length:var(--type-micro)] font-semibold text-[var(--accent-info)] underline-offset-2 hover:underline"
      >
        Browser login →
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Input
        value={pasted}
        onChange={(event) => setPasted(event.target.value)}
        placeholder="Paste request_token, or the whole redirected URL"
        aria-label="Zerodha request token"
        className="min-w-[15rem] flex-1"
      />
      <Button
        variant="primary"
        disabled={!pasted.trim() || submit.isPending}
        onClick={finish}
      >
        {submit.isPending ? 'Exchanging…' : 'Finish sign-in'}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setOpen(false);
          setPasted('');
        }}
      >
        Cancel
      </Button>
    </div>
  );
}

/* ── Add an account ───────────────────────────────────────────────────────── */

function AddAccountView({
  canCancel,
  onCancel,
  onLinked,
}: {
  canCancel: boolean;
  onCancel: () => void;
  onLinked: (account: {
    name: string;
    broker: BrokerId;
    identity: string;
    savedAccountId?: string;
    env?: string;
    autoLogin: boolean;
  }) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [brokerId, setBrokerId] = useState<BrokerId | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [autoLogin, setAutoLogin] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);

  const broker = brokerId ? getBroker(brokerId) : undefined;
  const saved = useSavedAccounts(brokerId);
  const rows = saved.data?.accounts ?? [];
  const chosen = rows.find((row) => row.id === savedId) ?? rows[0] ?? null;

  /**
   * Apply the chosen stored account to the form.
   *
   * Adjusted during render rather than in an effect — React's documented way to
   * reset state when its input changes. An effect would paint the empty form
   * first and then overwrite it, and would re-run on every new array identity,
   * wiping anything typed in between. Tracking the id that has been applied
   * makes it fire exactly once per account.
   */
  const [appliedId, setAppliedId] = useState<string | null>(null);
  if (chosen && chosen.id !== appliedId) {
    setAppliedId(chosen.id);
    setValues({ ...chosen.fields });
    setDisplayName(chosen.label);
    setAutoLogin(chosen.autoLogin);
  }

  const gaps = broker && chosen
    ? missingFields(values, broker.fields, chosen.stored)
    : null;

  function reset() {
    setStep(1);
    setBrokerId(null);
    setDisplayName('');
    setValues({});
    setAutoLogin(true);
    setSavedId(null);
    setAppliedId(null);
  }

  function save() {
    if (!broker) return;
    const identity = identityFrom(broker.id, values);
    onLinked({
      name: displayName.trim() || `${broker.name} account`,
      broker: broker.id,
      identity,
      savedAccountId: chosen?.id,
      env: chosen?.env,
      autoLogin,
    });
    reset();
  }

  return (
    <div className="space-y-[var(--container-gap)]">
      <Panel flush>
        <PanelHeader
          title={step === 1 ? 'Add a broker account' : `Configure ${broker?.name}`}
          subtitle={
            step === 1
              ? 'Choose the account provider you want to connect.'
              : 'Review what the backend already holds for this account.'
          }
          icon={<Plus size={14} />}
          actions={
            canCancel ? (
              <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={onCancel}>
                Back
              </Button>
            ) : null
          }
        />

        <div className="p-4">
          <Stepper step={step} />

          {step === 1 ? (
            <div className="mt-4 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {BROKERS.map((item) => (
                  <BrokerCard
                    key={item.id}
                    broker={item}
                    selected={brokerId === item.id}
                    onSelect={() => setBrokerId(item.id)}
                  />
                ))}
              </div>

              <div
                aria-live="polite"
                className="min-h-[2.5rem] rounded-[var(--radius-sm)] border border-[var(--container-rule)] bg-[var(--surface-raised)] px-3 py-2 text-[length:var(--type-caption)]"
              >
                {broker ? (
                  <>
                    <strong className="text-[var(--text-primary)]">{broker.name}</strong>{' '}
                    <span className="text-[var(--text-secondary)]">{broker.sessionNote}</span>
                  </>
                ) : (
                  <span className="text-[var(--text-tertiary)]">
                    Select a broker to see how its session is established.
                  </span>
                )}
              </div>

              <Button
                variant="primary"
                size="md"
                disabled={!brokerId}
                onClick={() => setStep(2)}
                className="w-full"
              >
                Continue to credentials
                <ChevronRight size={15} />
              </Button>
            </div>
          ) : null}

          {step === 2 && broker ? (
            <div className="mt-4 space-y-4">
              {saved.isLoading ? (
                <Notice tone="neutral">
                  <Spinner /> Looking for saved credentials…
                </Notice>
              ) : null}

              {saved.error ? (
                <Notice tone="warning">
                  Could not read stored credentials — {(saved.error as Error).message}. The
                  account can still be linked; the backend signs in from its own store.
                </Notice>
              ) : null}

              {!saved.isLoading && !chosen ? (
                <Notice tone="warning">
                  No stored {broker.name} account. The backend signs in from the
                  <code> broker_accounts </code> table, so add a row there before connecting —
                  what is typed below is not sent to the broker.
                </Notice>
              ) : null}

              {chosen ? (
                <Notice tone="neutral">
                  <strong className="text-[var(--text-primary)]">
                    Filled from your saved {broker.name} account
                  </strong>
                  <span className="block text-[var(--text-secondary)]">
                    {chosen.label}
                    {chosen.clientCode ? ` · ${chosen.clientCode}` : ''}
                    {chosen.env === 'UAT' ? ' · SANDBOX' : ''}
                    {gaps?.missing.length
                      ? ` — still missing ${gaps.missing.join(', ')}`
                      : ' — all stored fields present'}
                    {gaps?.manual.length
                      ? `. ${gaps.manual.join(' and ')} ${gaps.manual.length > 1 ? 'are' : 'is'} never stored server-side.`
                      : ''}
                  </span>
                </Notice>
              ) : null}

              {/*
                More than one row for this broker. The live table can hold a
                production account and a UAT one whose client codes differ by a
                single character — picking the wrong one shows sandbox data that
                looks entirely real, so the choice is explicit, not positional.
              */}
              {rows.length > 1 ? (
                <div role="radiogroup" aria-label="Saved accounts" className="flex flex-wrap gap-2">
                  {rows.map((row) => (
                    <button
                      key={row.id}
                      type="button"
                      role="radio"
                      aria-checked={chosen?.id === row.id}
                      onClick={() => setSavedId(row.id)}
                      className={cn(
                        'rounded-[var(--control-radius)] border px-3 py-1.5',
                        'text-[length:var(--type-caption)] transition-colors',
                        chosen?.id === row.id
                          ? 'border-[var(--accent-info)] bg-[var(--accent-info-soft)] text-[var(--accent-info)]'
                          : 'border-[var(--control-border)] text-[var(--text-secondary)] hover:border-[var(--border-strong)]',
                      )}
                    >
                      {row.label}
                      {row.env === 'UAT' ? ' (sandbox)' : ''}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="space-y-3 rounded-[var(--radius-md)] border border-[var(--container-rule)] bg-[var(--surface-raised)] p-4">
                <div>
                  <Label htmlFor="display-name">Account display name</Label>
                  <Input
                    id="display-name"
                    value={displayName}
                    placeholder={`e.g. Raj / ${broker.name}`}
                    onChange={(event) => setDisplayName(event.target.value)}
                  />
                </div>

                <div className="h-px bg-[var(--container-rule)]" />

                {broker.fields.map((field) => (
                  <CredentialField
                    key={field.key}
                    field={field}
                    value={values[field.key] ?? ''}
                    filled={
                      Boolean(chosen?.fields[field.key])
                      || Boolean(chosen?.stored.includes(field.key))
                    }
                    onChange={(value) =>
                      setValues((current) => ({ ...current, [field.key]: value }))
                    }
                  />
                ))}
              </div>

              <label className="flex cursor-pointer items-center justify-between gap-4 rounded-[var(--radius-md)] border border-[var(--container-rule)] bg-[var(--surface-raised)] p-4">
                <span className="min-w-0">
                  <strong className="block text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
                    Auto-login on startup
                  </strong>
                  <span className="block text-[length:var(--type-caption)] text-[var(--text-secondary)]">
                    Mirrors the <code>auto_login</code> flag on the stored row.
                  </span>
                </span>
                <input
                  type="checkbox"
                  checked={autoLogin}
                  onChange={(event) => setAutoLogin(event.target.checked)}
                  className="size-4 shrink-0 accent-[var(--accent-info)]"
                />
              </label>

              {/*
                Said plainly, because the form looks like it does more than it
                does. Connecting posts a feed id; the backend authenticates from
                `broker_accounts`. Nothing typed here reaches a broker, and
                nothing typed here is written to this machine.
              */}
              <div className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--container-rule)] bg-[var(--surface-panel)] p-3">
                <Shield size={15} className="mt-0.5 shrink-0 text-[var(--accent-info)]" />
                <p className="text-[length:var(--type-micro)] leading-relaxed text-[var(--text-secondary)]">
                  Credentials live in the backend's <code>broker_accounts</code> store and are sent
                  only to your broker's official API. This browser keeps the account link — broker,
                  client code and display name — and never persists a secret.
                </p>
              </div>

              <div className="flex items-center justify-between gap-2">
                <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={() => setStep(1)}>
                  Back
                </Button>
                <Button variant="primary" size="md" icon={<Check size={15} />} onClick={save}>
                  Link account
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Panel>
    </div>
  );
}

function Stepper({ step }: { step: 1 | 2 }) {
  const steps = [
    { n: 1, title: 'Broker', hint: 'Select provider' },
    { n: 2, title: 'Credentials', hint: 'Confirm access' },
  ] as const;

  return (
    <ol className="flex items-center gap-2" aria-label="Account setup progress">
      {steps.map(({ n, title, hint }, index) => {
        const done = step > n;
        const current = step === n;
        return (
          <li key={n} className="flex flex-1 items-center gap-2">
            <span
              aria-current={current ? 'step' : undefined}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full',
                'text-[length:var(--type-micro)] font-bold',
                done || current
                  ? 'bg-[var(--accent-info)] text-[var(--text-inverse)]'
                  : 'bg-[var(--surface-raised)] text-[var(--text-tertiary)]',
              )}
            >
              {done ? <Check size={12} strokeWidth={3} /> : n}
            </span>
            <span className="min-w-0">
              <strong
                className={cn(
                  'block text-[length:var(--type-caption)] font-semibold',
                  current || done ? 'text-[var(--text-primary)]' : 'text-[var(--text-tertiary)]',
                )}
              >
                {title}
              </strong>
              <span className="block text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                {hint}
              </span>
            </span>
            {index === 0 ? <span className="h-px flex-1 bg-[var(--container-rule)]" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function BrokerCard({
  broker,
  selected,
  onSelect,
}: {
  broker: BrokerConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex items-center gap-3 rounded-[var(--radius-md)] border p-3 text-left',
        'transition-colors duration-100',
        selected
          ? 'border-[var(--accent-info)] bg-[var(--accent-info-soft)]'
          : 'border-[var(--container-rule)] bg-[var(--surface-raised)] hover:border-[var(--border-strong)]',
      )}
    >
      <BrokerLogo broker={broker} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
          {broker.name}
        </span>
        <span className="block truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {broker.shortName} · {broker.authMethod}
        </span>
      </span>
      <span className="shrink-0 text-[var(--text-tertiary)]">
        {selected ? (
          <Check size={14} strokeWidth={3} className="text-[var(--accent-info)]" />
        ) : (
          <ChevronRight size={14} />
        )}
      </span>
    </button>
  );
}

/* ── Shared bits ──────────────────────────────────────────────────────────── */

function Notice({
  tone,
  children,
}: {
  tone: 'neutral' | 'warning' | 'danger';
  children: React.ReactNode;
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border px-3 py-2',
        'text-[length:var(--type-caption)] leading-snug',
        tone === 'neutral' &&
          'border-[var(--container-rule)] bg-[var(--surface-raised)] text-[var(--text-secondary)]',
        tone === 'warning' &&
          'border-transparent bg-[var(--status-warning-soft)] text-[var(--text-secondary)]',
        tone === 'danger' &&
          'border-transparent bg-[var(--status-danger-soft)] text-[var(--text-secondary)]',
      )}
    >
      {tone !== 'neutral' ? (
        <StatusDot tone={tone === 'warning' ? 'warning' : 'danger'} />
      ) : null}
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
