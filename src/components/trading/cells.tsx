/**
 * Cell renderers shared across the books.
 *
 * A contract renders identically in Positions, Orders and Trades, and a status
 * pill means the same thing wherever it appears. Defining them once is what
 * makes the books feel like one product rather than three screens that happen
 * to share a stylesheet.
 */

import { Badge, type Tone } from '@/components/ui/Badge';
import { contractLabel } from '@/lib/format';
import type { Contract, OrderStatus, Side } from '@/schemas/trading';

/**
 * Instrument identity: the tradable label on top, the exchange and expiry
 * beneath. Two lines rather than one long string — a symbol column that wraps
 * or truncates mid-strike is unreadable at a glance, and the strike is exactly
 * the part that gets cut.
 */
export function ContractCell({ contract }: { contract: Contract }) {
  const meta = [contract.exchange, contract.expiry].filter(Boolean).join(' · ');
  return (
    <div className="min-w-0 leading-tight">
      <div className="truncate font-medium text-[var(--text-primary)]">
        {contractLabel(contract)}
      </div>
      {meta ? (
        <div className="mt-0.5 truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {meta}
          {contract.resolved ? null : (
            // An unresolved contract is one the instrument master could not
            // match. Its strike and lot may be blank, and saying so beats
            // rendering an em-dash the reader assumes is a real zero.
            <span className="ml-1 text-[var(--status-warning)]">unmatched</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** BUY/SELL. Buy takes the accent, sell the down colour — the same pairing the
 *  rest of the app uses for direction. */
export function SideCell({ side }: { side: Side }) {
  return (
    <span
      className="text-[length:var(--type-micro)] font-bold uppercase tracking-[var(--tracking-label)]"
      style={{ color: side === 'BUY' ? 'var(--color-buy)' : 'var(--color-sell)' }}
    >
      {side}
    </span>
  );
}

const STATUS_TONES: Record<OrderStatus, Tone> = {
  COMPLETE: 'success',
  OPEN: 'warning',
  PENDING: 'warning',
  // Both are live orders and take the working tone. A partial fill in the
  // success green would read as done while its remainder is still at the
  // exchange, which is the mistake this pill exists to prevent.
  PARTIAL: 'warning',
  TRIGGER_PENDING: 'warning',
  CANCELLED: 'neutral',
  REJECTED: 'danger',
  UNKNOWN: 'neutral',
};

/** `TRIGGER_PENDING` is too wide for a table pill and the underscore reads as a
 *  code identifier rather than a state. Everything else is already short. */
const STATUS_LABELS: Partial<Record<OrderStatus, string>> = {
  TRIGGER_PENDING: 'TRIGGER',
};

export function StatusCell({ status, message }: { status: OrderStatus; message?: string }) {
  return (
    // The rejection reason is the single most useful field on a rejected order
    // and the backend already carries it — surfacing it on hover costs nothing.
    // The full status is in the tooltip too, since the label may be shortened.
    <span title={message || (STATUS_LABELS[status] ? status : undefined)}>
      <Badge tone={STATUS_TONES[status]}>{STATUS_LABELS[status] ?? status}</Badge>
    </span>
  );
}

/** Which account a row came from. Muted: it is a qualifier on the row, not the
 *  row's subject, and at full contrast it competes with the instrument. */
export function BrokerCell({ broker, feedId }: { broker: string; feedId: string }) {
  const label = broker || feedId;
  if (!label) return <span className="text-[var(--text-disabled)]">—</span>;
  return (
    <span className="text-[length:var(--type-micro)] uppercase tracking-[var(--tracking-label)] text-[var(--text-tertiary)]">
      {label}
    </span>
  );
}
