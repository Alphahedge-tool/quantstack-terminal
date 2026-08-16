/**
 * Canonical symbols — the pivot every broker maps through.
 *
 * The terminal already addresses instruments STRUCTURALLY via `InstrumentKey`
 * (see feeds/identity.ts). That is the right shape for consumers, but it is a
 * poor lookup key against a broker's instrument master, which is a flat table of
 * strings. This module supplies the flat form:
 *
 *      InstrumentKey                      canonical symbol
 *      { NSE, NIFTY, OPT, 2026-08-28,  →  NIFTY28AUG2624500CE
 *        24500, CE }
 *
 * One canonical string, N broker rows. Angel calls it `NIFTY28AUG2624500CE`
 * with token `43215`, Zerodha calls it `NIFTY26AUG24500CE` with token
 * `12345678`, Kotak calls it something else again — and every one of those rows
 * is stored under the SAME canonical symbol. That is what makes "switch the
 * feed to another broker mid-session" a table lookup rather than a rewrite.
 *
 * The format is the NSE/Angel convention (`<ROOT><DD><MON><YY><STRIKE><CE|PE>`)
 * because it is the one that already round-trips through most masters. Nothing
 * outside `instruments/` and `feeds/adapters/` should care what it looks like —
 * consumers hold InstrumentKeys and let the store do the resolving.
 */

import type { InstrumentKey, InstrumentKind, OptionSide } from '../feeds/identity.js';
import { normalizeExpiry } from '../feeds/identity.js';

const MONTHS = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

/** Contract type as instrument masters spell it. */
export type ContractType = 'EQ' | 'FUT' | 'CE' | 'PE';

// ── Expiry ───────────────────────────────────────────────────────────────────

/**
 * Any expiry a broker might publish → `DDMMMYY`.
 *
 * Masters are wildly inconsistent here: Angel ships `28AUG2026`, Zerodha ships
 * `2026-08-28`, Kotak ships an epoch-seconds integer with a segment-dependent
 * offset. All three have to collapse to one string or the same contract lands
 * under three different canonical symbols and the switch silently loses legs.
 *
 * Unparseable input is returned upper-cased rather than throwing: a master with
 * one weird row should cost that row, not the whole load.
 */
export function expiryKey(input: string | number | null | undefined): string {
  if (input == null || input === '') return '';
  const value = String(input).trim().toUpperCase();

  // Already DDMMMYY / DDMMMYYYY
  const dmy = value.match(/^(\d{1,2})([A-Z]{3})(\d{2}|\d{4})$/);
  if (dmy) return `${dmy[1].padStart(2, '0')}${dmy[2]}${dmy[3].slice(-2)}`;

  // ISO, dashed or compact
  const iso = value.match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (iso) {
    const month = MONTHS[Number(iso[2]) - 1];
    if (month) return `${iso[3]}${month}${iso[1].slice(-2)}`;
  }

  // Epoch seconds or milliseconds, else anything Date.parse understands.
  const numeric = Number(value);
  const millis = Number.isFinite(numeric) && numeric > 0
    ? numeric * (value.length <= 10 ? 1000 : 1)
    : Date.parse(value);
  if (!Number.isNaN(millis)) {
    const d = new Date(millis);
    return `${String(d.getUTCDate()).padStart(2, '0')}`
      + `${MONTHS[d.getUTCMonth()]}`
      + `${String(d.getUTCFullYear()).slice(-2)}`;
  }

  return value;
}

/** `DDMMMYY` → ISO `YYYY-MM-DD`. Inverse of expiryKey for the compact form. */
export function expiryKeyToISO(key: string): string | undefined {
  const m = String(key).trim().toUpperCase().match(/^(\d{2})([A-Z]{3})(\d{2})$/);
  if (!m) return normalizeExpiry(key);
  const month = MONTHS.indexOf(m[2] as typeof MONTHS[number]);
  if (month < 0) return undefined;
  // Two-digit years in listed derivatives are always 20xx — the alternative is a
  // 1926 expiry, which no exchange lists.
  return `20${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1]}`;
}

// ── Strike ───────────────────────────────────────────────────────────────────

/**
 * Strike as it appears inside a trading symbol.
 *
 * Integers stay bare (`24500`) and fractional strikes keep only the digits that
 * matter (`1.075`, not `1.07500`) — MCX and CDS both list them, and a trailing
 * zero is enough to miss the row.
 */
export function strikeKey(input: number | string | null | undefined): string {
  const value = Number(input);
  if (!Number.isFinite(value)) return String(input ?? '');
  if (Number.isInteger(value)) return String(value);
  return String(value).replace(/0+$/, '').replace(/\.$/, '');
}

// ── The canonical symbol ─────────────────────────────────────────────────────

export interface CanonicalParts {
  /** Underlying root — NIFTY, RELIANCE, CRUDEOIL. */
  name:     string;
  type:     ContractType;
  expiry?:  string | number | null;
  strike?:  number | null;
}

/**
 * Build the canonical symbol for a contract.
 *
 *   { NIFTY,     CE,  2026-08-28, 24500 } → NIFTY28AUG2624500CE
 *   { CRUDEOIL,  FUT, 2026-08-19        } → CRUDEOIL19AUG26FUT
 *   { RELIANCE,  EQ                     } → RELIANCE
 */
export function canonicalSymbol({ name, type, expiry, strike }: CanonicalParts): string {
  const root = String(name ?? '').toUpperCase().trim();
  if (!root) return '';
  if (type === 'EQ') return root;
  if (type === 'FUT') return `${root}${expiryKey(expiry)}FUT`;
  return `${root}${expiryKey(expiry)}${strikeKey(strike)}${type}`;
}

// ── InstrumentKey ↔ canonical symbol ─────────────────────────────────────────

/** The `MarketDataFeed` kind + side pair, as a master's contract type. */
export function contractTypeOf(kind: InstrumentKind, side?: OptionSide): ContractType {
  if (kind === 'OPT') return side === 'PE' ? 'PE' : 'CE';
  if (kind === 'FUT') return 'FUT';
  return 'EQ';
}

/** Canonical symbol for a structural key. The bridge between the two worlds. */
export function symbolOf(key: InstrumentKey): string {
  return canonicalSymbol({
    name:   key.asset,
    type:   contractTypeOf(key.kind, key.side),
    expiry: key.expiry,
    strike: key.strike,
  });
}

/**
 * Which exchange segment a contract trades on.
 *
 * `InstrumentKey.exchange` names where the UNDERLYING lives (NSE, BSE, MCX)
 * because that is what a user picks. Masters index derivatives by their own
 * segment instead, and an NSE option is filed under NFO. Resolving without this
 * step finds nothing and looks like a missing instrument.
 */
export function segmentOf(exchange: string, kind: InstrumentKind): string {
  const ex = String(exchange ?? '').toUpperCase();
  if (kind === 'SPOT') return ex;
  switch (ex) {
    case 'NSE': return 'NFO';
    case 'BSE': return 'BFO';
    case 'CDS': return 'CDS';
    case 'BCD': return 'BCD';
    default:    return ex;   // MCX derivatives stay on MCX
  }
}

/** Inverse of `segmentOf` — a master's segment back to the underlying exchange. */
export function exchangeOfSegment(segment: string): string {
  switch (String(segment ?? '').toUpperCase()) {
    case 'NFO': return 'NSE';
    case 'BFO': return 'BSE';
    default:    return String(segment ?? '').toUpperCase();
  }
}

/**
 * Broker segment strings → the canonical exchange code.
 *
 * Kotak alone spells the same six segments in three ways (`nse_fo`, `bse_cm`,
 * `bcs-fo`), so this table is the only place that has to know.
 */
const SEGMENT_ALIASES: Record<string, string> = {
  nse_cm: 'NSE', nse_fo: 'NFO',
  bse_cm: 'BSE', bse_fo: 'BFO',
  cde_fo: 'CDS', bcs_fo: 'BCD', 'bcs-fo': 'BCD',
  mcx_fo: 'MCX', mcx_index: 'MCX',
  nfo: 'NFO', bfo: 'BFO', nse: 'NSE', bse: 'BSE', mcx: 'MCX',
  cds: 'CDS', bcd: 'BCD',
};

export function canonicalExchange(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  return SEGMENT_ALIASES[raw.toLowerCase()] ?? raw.toUpperCase();
}
