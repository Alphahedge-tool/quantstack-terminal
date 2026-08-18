/**
 * Result cards — the visual half of a reply.
 *
 * The spoken answer is a sentence; the card is the evidence behind it. They are
 * built from the same payload but never duplicate each other: the sentence says
 * "OI is up four percent", the card shows what it was, what it is, how unusual
 * that is, and the price beside it. A user who trusts the sentence never reads
 * the card, and a user who doesn't has everything needed to check it.
 *
 * All cards are deliberately narrow and dense. They render inside a 380px
 * conversation panel that floats over a working page, so a card that needs
 * horizontal room is a card that will be scrolled past.
 */

import { AlertTriangle, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import type {
  AlertEvent, BuildupKind, Card, MetricName, WatchSummary,
} from '@/lib/iris/protocol';

// ── Formatting ───────────────────────────────────────────────────────────────
//
// Mirrors backend/assistant/format.ts. Duplicated rather than shared for the
// same reason protocol.ts is: separate TS projects. The two must agree, so keep
// them in step — the backend is the reference.

const IN = 'en-IN';

function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString(IN);
}

export function formatMetric(v: number | undefined, metric: MetricName): string {
  if (v == null || !Number.isFinite(v)) return '—';
  switch (metric) {
    case 'oi':
    case 'volume': return compact(v);
    case 'ltp':    return `₹${v.toLocaleString(IN, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    case 'iv':     return `${v.toFixed(2)}%`;
    case 'pcr':    return v.toFixed(2);
    case 'spot':   return v.toLocaleString(IN, { maximumFractionDigits: 2 });
    case 'gamma':  return v.toFixed(5);
    default:       return v.toFixed(3);
  }
}

const signed = (pct: number) => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(ms / 3_600_000);
  return h < 24 ? `${h}h` : `${Math.round(ms / 86_400_000)}d`;
}

const toneClass = (tone?: 'up' | 'down' | 'neutral') =>
  tone === 'up'   ? 'text-[var(--status-success)]'
: tone === 'down' ? 'text-[var(--status-danger)]'
:                   'text-[var(--text-primary)]';

// ── Shell ────────────────────────────────────────────────────────────────────

function CardShell({ title, children, accent }: {
  title: string; children: React.ReactNode; accent?: string;
}) {
  return (
    <div
      className={cn(
        'mt-2 overflow-hidden rounded-[var(--radius-md)] border',
        'border-[var(--container-border)] bg-[var(--surface-raised)]',
      )}
    >
      <div
        className={cn(
          'border-b border-[var(--container-rule)] bg-[var(--container-head)] px-2.5 py-1.5',
          'text-[length:var(--type-micro)] font-semibold uppercase tracking-wide',
        )}
        style={{ color: accent ?? 'var(--text-secondary)' }}
      >
        {title}
      </div>
      <div className="p-2.5">{children}</div>
    </div>
  );
}

/** Two-column label/value list — the workhorse layout. */
function Rows({ rows }: { rows: Array<{ label: string; value: string; tone?: 'up' | 'down' | 'neutral' }> }) {
  return (
    <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-2">
          <dt className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">{r.label}</dt>
          <dd className={cn('font-mono text-[length:var(--type-caption)] tabular-nums', toneClass(r.tone))}>
            {r.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ── Sparkline ────────────────────────────────────────────────────────────────

/**
 * Inline SVG rather than the charting engine.
 *
 * StraddlePage lazy-loads ~180kB of canvas charting for a reason; pulling that
 * into a component mounted on every page would undo it. A polyline is enough to
 * answer "what shape was it", and anything more belongs on the analysis page.
 */
function Spark({ points, tone }: {
  points: Array<{ ts: number; v: number }>; tone: 'up' | 'down';
}) {
  if (points.length < 2) return null;

  const W = 320;
  const H = 54;
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;

  const d = points.map((p, i) => {
    const x = (i / (points.length - 1)) * W;
    // Inverted: SVG y grows downward, and a rising series must rise.
    const y = H - ((p.v - min) / span) * H;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  const colour = tone === 'up' ? 'var(--status-success)' : 'var(--status-danger)';

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-[54px] w-full" preserveAspectRatio="none" role="img">
      <path d={`${d} L${W},${H} L0,${H} Z`} fill={colour} opacity={0.1} />
      <path d={d} fill="none" stroke={colour} strokeWidth={1.5}
            vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

// ── Buildup ──────────────────────────────────────────────────────────────────

const BUILDUP_TONE: Record<BuildupKind, string> = {
  'long-buildup':   'var(--status-success)',
  'short-buildup':  'var(--status-danger)',
  'short-covering': 'var(--accent-info)',
  'long-unwinding': 'var(--status-warning)',
  flat:             'var(--text-tertiary)',
};

const BUILDUP_LABEL: Record<BuildupKind, string> = {
  'long-buildup':   'Long buildup',
  'short-buildup':  'Short buildup',
  'short-covering': 'Short covering',
  'long-unwinding': 'Long unwinding',
  flat:             'Flat',
};

// ── The card renderer ────────────────────────────────────────────────────────

export function IrisCard({ card }: { card: Card }) {
  switch (card.kind) {
    case 'quote':
      return <CardShell title={card.title}><Rows rows={card.rows} /></CardShell>;

    case 'change': {
      const up = card.deltaPct >= 0;
      const level = card.significance?.level;
      return (
        <CardShell
          title={card.title}
          accent={up ? 'var(--status-success)' : 'var(--status-danger)'}
        >
          <div className="mb-2 flex items-center gap-2">
            {up ? <TrendingUp size={16} className="text-[var(--status-success)]" />
                : <TrendingDown size={16} className="text-[var(--status-danger)]" />}
            <span className={cn(
              'font-mono text-[length:var(--type-body)] font-semibold tabular-nums',
              up ? 'text-[var(--status-success)]' : 'text-[var(--status-danger)]',
            )}>
              {signed(card.deltaPct)}
            </span>
            {level && level !== 'normal' ? (
              <span className={cn(
                'rounded-[var(--radius-xs)] px-1.5 py-0.5 text-[10px] font-semibold uppercase',
                'bg-[var(--status-warning-soft)] text-[var(--status-warning)]',
              )}>
                {level}
              </span>
            ) : null}
          </div>
          <Rows rows={card.rows} />
        </CardShell>
      );
    }

    case 'chain':
      return (
        <CardShell title={card.title}>
          <Rows rows={[
            { label: 'Spot',     value: formatMetric(card.spot, 'spot') },
            { label: 'ATM',      value: card.atm != null ? String(card.atm) : '—' },
            { label: 'PCR',      value: formatMetric(card.pcr, 'pcr'),
              tone: card.pcr != null ? (card.pcr > 1 ? 'up' : 'down') : undefined },
            { label: 'Max pain', value: card.maxPain != null ? String(card.maxPain) : '—' },
          ]} />

          {/* Horizontal scroll on the table only — the panel itself must never
              scroll sideways over the page behind it. */}
          <div className="-mx-2.5 mt-2 overflow-x-auto">
            <table className="w-full min-w-[300px] border-collapse text-[length:var(--type-micro)]">
              <thead>
                <tr className="text-[var(--text-tertiary)]">
                  <th className="px-2 py-1 text-right font-medium">Call OI</th>
                  <th className="px-2 py-1 text-right font-medium">LTP</th>
                  <th className="px-2 py-1 text-center font-medium">Strike</th>
                  <th className="px-2 py-1 text-right font-medium">LTP</th>
                  <th className="px-2 py-1 text-right font-medium">Put OI</th>
                </tr>
              </thead>
              <tbody className="font-mono tabular-nums">
                {card.strikes.map((r) => (
                  <tr
                    key={r.strike}
                    className={cn(
                      'border-t border-[var(--container-rule)]',
                      r.atm && 'bg-[var(--accent-info-soft)]',
                    )}
                  >
                    <td className="px-2 py-1 text-right text-[var(--text-secondary)]">{r.ceOi != null ? compact(r.ceOi) : '—'}</td>
                    <td className="px-2 py-1 text-right text-[var(--text-primary)]">{formatMetric(r.ceLtp, 'ltp')}</td>
                    <td className={cn(
                      'px-2 py-1 text-center font-semibold',
                      r.atm ? 'text-[var(--accent-info)]' : 'text-[var(--text-primary)]',
                    )}>
                      {r.strike}
                    </td>
                    <td className="px-2 py-1 text-right text-[var(--text-primary)]">{formatMetric(r.peLtp, 'ltp')}</td>
                    <td className="px-2 py-1 text-right text-[var(--text-secondary)]">{r.peOi != null ? compact(r.peOi) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardShell>
      );

    case 'series': {
      const first = card.points[0]?.v ?? 0;
      const last = card.points[card.points.length - 1]?.v ?? 0;
      const up = last >= first;
      return (
        <CardShell title={card.title}>
          <Spark points={card.points} tone={up ? 'up' : 'down'} />
          <div className="mt-1.5">
            <Rows rows={[
              { label: 'From',   value: formatMetric(first, card.metric) },
              { label: 'To',     value: formatMetric(last, card.metric), tone: up ? 'up' : 'down' },
              { label: 'Points', value: String(card.points.length) },
            ]} />
          </div>
        </CardShell>
      );
    }

    case 'buildup':
      return (
        <CardShell title={card.title}>
          <ul className="space-y-1">
            {card.rows.map((r) => (
              <li
                key={`${r.strike}-${r.side}`}
                className="flex items-center justify-between gap-2 border-b border-[var(--container-rule)] pb-1 last:border-0"
              >
                <span className="font-mono text-[length:var(--type-caption)] text-[var(--text-primary)]">
                  {r.strike} {r.side}
                </span>
                <span
                  className="text-[length:var(--type-micro)]"
                  style={{ color: BUILDUP_TONE[r.kind] }}
                >
                  {BUILDUP_LABEL[r.kind]}
                </span>
                <span className={cn(
                  'w-16 text-right font-mono text-[length:var(--type-caption)] tabular-nums',
                  r.oiChgPct >= 0 ? 'text-[var(--status-success)]' : 'text-[var(--status-danger)]',
                )}>
                  {signed(r.oiChgPct)}
                </span>
              </li>
            ))}
          </ul>
        </CardShell>
      );

    case 'watches':
      return (
        <CardShell title={card.title}>
          {card.watches.length === 0
            ? <p className="text-[length:var(--type-caption)] text-[var(--text-tertiary)]">Nothing active.</p>
            : <WatchList watches={card.watches} />}
        </CardShell>
      );

    case 'alerts':
      return (
        <CardShell title={card.title}>
          <ul className="space-y-1.5">
            {card.alerts.slice(0, 8).map((a) => <AlertLine key={a.id} alert={a} />)}
          </ul>
        </CardShell>
      );

    case 'note':
      return (
        <CardShell title={card.title}>
          <p className="text-[length:var(--type-caption)] text-[var(--text-secondary)]">{card.body}</p>
        </CardShell>
      );

    default:
      return null;
  }
}

// ── Shared list pieces, reused by the panel's own tabs ───────────────────────

export function WatchList({ watches, onCancel }: {
  watches: WatchSummary[];
  onCancel?: (id: string) => void;
}) {
  return (
    <ul className="space-y-1.5">
      {watches.map((w) => (
        <li
          key={w.id}
          className="rounded-[var(--radius-sm)] border border-[var(--container-rule)] bg-[var(--surface-panel)] px-2 py-1.5"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[length:var(--type-caption)] font-medium text-[var(--text-primary)]">
                {w.strike != null ? `${w.symbol} ${w.strike} ${w.side}` : w.symbol}
              </p>
              <p className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                {w.metric.toUpperCase()} ·{' '}
                {w.mode === 'auto' ? 'adaptive' : w.mode === 'pct' ? `${w.threshold}%` : compact(w.threshold)}
                {' '}/ {duration(w.windowMs)}
                {w.firedCount > 0 ? ` · fired ${w.firedCount}×` : ''}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {w.current != null ? (
                <span className="font-mono text-[length:var(--type-caption)] tabular-nums text-[var(--text-primary)]">
                  {formatMetric(w.current, w.metric)}
                </span>
              ) : null}
              {w.deltaPct != null ? (
                <span className={cn(
                  'font-mono text-[length:var(--type-micro)] tabular-nums',
                  w.deltaPct >= 0 ? 'text-[var(--status-success)]' : 'text-[var(--status-danger)]',
                )}>
                  {signed(w.deltaPct)}
                </span>
              ) : null}
              {onCancel ? (
                <button
                  type="button"
                  onClick={() => onCancel(w.id)}
                  className="text-[length:var(--type-micro)] text-[var(--text-tertiary)] hover:text-[var(--status-danger)]"
                  aria-label={`Cancel watch on ${w.symbol}`}
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function AlertLine({ alert }: { alert: AlertEvent }) {
  const up = alert.direction === 'up';
  return (
    <li className="flex items-start gap-2 border-b border-[var(--container-rule)] pb-1.5 last:border-0 last:pb-0">
      <AlertTriangle
        size={13}
        className="mt-0.5 shrink-0"
        style={{ color: up ? 'var(--status-success)' : 'var(--status-danger)' }}
      />
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--type-caption)] leading-snug text-[var(--text-primary)]">
          {alert.text}
        </p>
        <p className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {new Date(alert.firedAt).toLocaleTimeString(IN, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          {alert.significance && alert.significance.level !== 'normal'
            ? ` · ${alert.significance.level} (${alert.significance.z.toFixed(1)}σ)`
            : ''}
        </p>
      </div>
    </li>
  );
}
