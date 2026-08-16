/**
 * Display formatting.
 *
 * Centralised because a trading screen is read by scanning columns, and a
 * column only scans if every cell in it was formatted by the same function.
 * Two call sites each doing `toFixed(2)` drift the moment one of them needs a
 * thousands separator.
 */

const INR = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INR_COMPACT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  notation: 'compact',
  maximumFractionDigits: 2,
});

const DECIMAL = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** The em-dash placeholder for absent data. Never render a bare `0` for null —
 *  "no position" and "a position worth zero" are different facts. */
export const EMPTY = '—';

function nullish(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || Number.isNaN(value);
}

export function currency(value: number | null | undefined): string {
  return nullish(value) ? EMPTY : INR.format(value);
}

/** For headline tiles where ₹1,24,50,000 would blow the layout. */
export function currencyCompact(value: number | null | undefined): string {
  return nullish(value) ? EMPTY : INR_COMPACT.format(value);
}

export function decimal(value: number | null | undefined, digits = 2): string {
  if (nullish(value)) return EMPTY;
  if (digits === 2) return DECIMAL.format(value);
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function integer(value: number | null | undefined): string {
  return nullish(value) ? EMPTY : INTEGER.format(value);
}

/** P&L always carries its sign. A gain reading `1,240` next to a loss reading
 *  `-980` makes the reader supply the `+`; making it explicit is faster. */
export function signed(value: number | null | undefined, digits = 2): string {
  if (nullish(value)) return EMPTY;
  const body = decimal(Math.abs(value), digits);
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

export function signedCurrency(value: number | null | undefined): string {
  if (nullish(value)) return EMPTY;
  const body = INR.format(Math.abs(value));
  if (value > 0) return `+${body}`;
  if (value < 0) return `-${body}`;
  return body;
}

export function percent(value: number | null | undefined, digits = 2): string {
  return nullish(value) ? EMPTY : `${signed(value, digits)}%`;
}

/** Direction for colour selection. Zero is neutral, not a gain. */
export type Direction = 'up' | 'down' | 'flat';

export function direction(value: number | null | undefined): Direction {
  if (nullish(value) || value === 0) return 'flat';
  return value > 0 ? 'up' : 'down';
}

/** Epoch millis → HH:MM:SS, the only clock format a tape needs. */
export function clockTime(ts: number | null | undefined): string {
  if (nullish(ts) || ts <= 0) return EMPTY;
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function dateTime(ts: number | null | undefined): string {
  if (nullish(ts) || ts <= 0) return EMPTY;
  const d = new Date(ts);
  return `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${clockTime(ts)}`;
}

/** "3s ago" / "4m ago" — for freshness indicators where the exact instant is
 *  less useful than the distance from now. */
export function relativeTime(ts: number | null | undefined): string {
  if (nullish(ts) || ts <= 0) return EMPTY;
  const delta = Math.max(0, Date.now() - ts);
  const seconds = Math.floor(delta / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** ISO `2026-08-28` → `28 Aug`, the form used on expiry chips. */
export function expiryLabel(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const parsed = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

/** Compact instrument label, falling back through the fields the backend's
 *  Contract type may or may not have resolved. */
export function contractLabel(contract: {
  label?: string;
  symbol?: string;
  underlying?: string;
  strike?: number | null;
  optionType?: string;
}): string {
  if (contract.label) return contract.label;
  if (contract.symbol) return contract.symbol;
  const parts = [contract.underlying, contract.strike ?? undefined, contract.optionType]
    .filter((p) => p !== undefined && p !== null && p !== '');
  return parts.length ? parts.join(' ') : EMPTY;
}
