/**
 * The trading contract — orders, positions, holdings, funds.
 *
 * Deliberately SEPARATE from `MarketDataFeed`. The two answer different
 * questions and fail independently: a broker whose tick socket is down can still
 * report your positions, and pinning the two together would take a working
 * position book offline over a broken WebSocket. They share the session, the
 * credential store and the error taxonomy — nothing else.
 *
 * ── Read-only, by design ──
 *
 * There is no `placeOrder` here. Nothing in this layer can send an instruction
 * to an exchange. That is a deliberate boundary, not an unfinished one: adding
 * placement means adding a method to this interface, which is a visible,
 * reviewable change rather than something that creeps in through an adapter.
 *
 * ── Canonical identity ──
 *
 * Every row carries a `contract` resolved through the canonical instrument
 * table. This is what makes a Kotak position priceable by an Angel feed: the
 * broker's own token is meaningless to any other broker, but the canonical
 * symbol resolves everywhere. Rows that cannot be resolved keep `key: null`
 * rather than being dropped — an unrecognised position is still your position,
 * and hiding it because the master is stale would be the worse failure.
 */

import type { InstrumentKey } from '../feeds/identity.js';

// ── Enumerations ─────────────────────────────────────────────────────────────

export type Side = 'BUY' | 'SELL';

/**
 * Order state, normalised.
 *
 * Every broker spells these differently — Angel says `complete`, Kite says
 * `COMPLETE`, Kotak says `filled`. `UNKNOWN` exists so an unrecognised status is
 * carried through visibly instead of being guessed into `OPEN`, which would show
 * a filled order as still working.
 */
export type OrderStatus =
  | 'PENDING'          // accepted by the broker, not yet at the exchange
  | 'OPEN'             // working at the exchange
  | 'PARTIAL'          // partially filled, still working
  | 'COMPLETE'
  | 'CANCELLED'
  | 'REJECTED'
  | 'TRIGGER_PENDING'  // stop order waiting for its trigger
  | 'UNKNOWN';

export type OrderKind = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M' | 'UNKNOWN';

/** Margin product. `CARRYFORWARD` is Angel's NRML / Kite's NRML / Kotak's NRML. */
export type Product = 'INTRADAY' | 'CARRYFORWARD' | 'DELIVERY' | 'MARGIN' | 'UNKNOWN';

// ── Contract identity ────────────────────────────────────────────────────────

/**
 * What a row is about, resolved through the canonical table.
 *
 * `label` is always populated — worst case it is the broker's own symbol — so
 * the UI can render something meaningful even for a contract the master does
 * not know.
 */
export interface Contract {
  /** Canonical symbol, or '' when unresolvable. */
  symbol:   string;
  /** Structural key, or null when not enough is known to build a usable one. */
  key:      InstrumentKey | null;
  /**
   * Whether this came from an instrument master, or was reconstructed from the
   * broker's own report fields.
   *
   * The distinction matters and is not visible from `key` alone. A reconstructed
   * contract has a well-formed key that no master has confirmed exists — correct
   * for a strike listed after the master was cached, and equally what a garbled
   * row produces. Consumers that price off `key` should treat `false` as "may
   * not resolve", and the UI should say so rather than showing a blank price
   * that looks like a dead feed.
   */
  resolved: boolean;
  /** Canonical exchange/segment — NFO, MCX, NSE… */
  exchange: string;
  /** Underlying root: NIFTY, CRUDEOIL. */
  underlying: string;
  expiry:   string;
  strike:   number | null;
  optionType: '' | 'CE' | 'PE';
  lot:      number;
  /** Human-readable, for display only. Never a lookup key. */
  label:    string;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface Order {
  /** The broker's order id. Only meaningful to that broker. */
  id:        string;
  /** Exchange-assigned id, when the broker publishes one. */
  exchangeId: string;
  contract:  Contract;
  side:      Side;
  status:    OrderStatus;
  kind:      OrderKind;
  product:   Product;
  /** Ordered quantity, in UNITS (not lots). */
  quantity:  number;
  filled:    number;
  pending:   number;
  price:     number;
  triggerPrice: number;
  averagePrice: number;
  /** Epoch ms, or null when the broker sent nothing parseable. */
  placedAt:  number | null;
  updatedAt: number | null;
  /** Rejection reason or status message, when there is one. */
  message:   string;
}

export interface Trade {
  id:       string;
  orderId:  string;
  contract: Contract;
  side:     Side;
  quantity: number;
  price:    number;
  filledAt: number | null;
}

export interface Position {
  contract: Contract;
  product:  Product;
  /** Signed net quantity in UNITS. Negative is short. */
  quantity: number;
  /** Quantity carried in from previous sessions. */
  overnight: number;
  buyQuantity:  number;
  sellQuantity: number;
  buyAverage:   number;
  sellAverage:  number;
  /** Last traded price as the BROKER reported it. May be stale — see `pnl`. */
  lastPrice: number;
  /** Previous close, for day-change calculations. */
  closePrice: number;
  /**
   * P&L as the broker computed it.
   *
   * Kept as the broker's own number rather than recomputed, because brokers
   * differ on whether realised legs are included and a recomputed figure that
   * disagrees with the broker's app is worse than useless.
   */
  pnl:        number;
  realised:   number;
  unrealised: number;
}

export interface Holding {
  contract:      Contract;
  quantity:      number;
  averagePrice:  number;
  lastPrice:     number;
  closePrice:    number;
  pnl:           number;
  /** Quantity pledged or otherwise unavailable to sell. */
  collateral:    number;
}

export interface Funds {
  /** Cash available to trade right now. */
  available:  number;
  /** Margin currently blocked by open positions and orders. */
  used:       number;
  /** Total account value as the broker states it. */
  total:      number;
  /** Which field the broker's payload this came from, for diagnosis. */
  source:     string;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * What a broker's trading API actually exposes.
 *
 * Checked before calling, so an unsupported book returns a clean "this broker
 * does not publish holdings" rather than an adapter-specific error. Kotak, for
 * instance, has no holdings endpoint in the Neo Trade API surface.
 */
export interface TradingCapabilities {
  orders:    boolean;
  trades:    boolean;
  positions: boolean;
  holdings:  boolean;
  funds:     boolean;
}

// ── The interface ────────────────────────────────────────────────────────────

export interface TradingBroker {
  /** Matches the feed id for the same account — `angel`, `zerodha#2`. */
  readonly id: string;
  readonly broker: string;
  readonly capabilities: TradingCapabilities;

  /** True when the underlying session is live. Login is the feed adapter's job. */
  isConnected(): boolean;

  orders():    Promise<Order[]>;
  trades():    Promise<Trade[]>;
  positions(): Promise<Position[]>;
  holdings():  Promise<Holding[]>;
  funds():     Promise<Funds>;
}

// ── Shared normalisation ─────────────────────────────────────────────────────

export function toNumber(v: unknown): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}

export function toSide(v: unknown): Side {
  return String(v ?? '').trim().toUpperCase().startsWith('S') ? 'SELL' : 'BUY';
}

/**
 * Status strings → the normalised enum.
 *
 * The table covers all four brokers' vocabularies. Anything unmatched becomes
 * UNKNOWN deliberately — see the note on OrderStatus.
 */
const STATUS_MAP: Record<string, OrderStatus> = {
  // shared
  complete: 'COMPLETE', completed: 'COMPLETE', filled: 'COMPLETE', executed: 'COMPLETE',
  open: 'OPEN', pending: 'PENDING', 'open pending': 'PENDING',
  cancelled: 'CANCELLED', canceled: 'CANCELLED',
  rejected: 'REJECTED',
  // partials
  'partially filled': 'PARTIAL', partial: 'PARTIAL', 'put order req received': 'PENDING',
  // stop orders
  'trigger pending': 'TRIGGER_PENDING', 'trigger_pending': 'TRIGGER_PENDING',
  // Angel
  'validation pending': 'PENDING', 'modify pending': 'PENDING',
  'cancel pending': 'PENDING', 'modified': 'OPEN',
  // Kotak
  'new': 'OPEN', 'ordered': 'OPEN', 'replaced': 'OPEN',
};

export function toStatus(v: unknown): OrderStatus {
  const raw = String(v ?? '').trim().toLowerCase();
  return STATUS_MAP[raw] ?? 'UNKNOWN';
}

const KIND_MAP: Record<string, OrderKind> = {
  market: 'MARKET', mkt: 'MARKET', mis: 'MARKET',
  limit: 'LIMIT', l: 'LIMIT', lmt: 'LIMIT',
  sl: 'SL', 'stoploss_limit': 'SL', 'sl-l': 'SL', spread: 'SL',
  'sl-m': 'SL-M', slm: 'SL-M', 'stoploss_market': 'SL-M',
};

export function toKind(v: unknown): OrderKind {
  return KIND_MAP[String(v ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

const PRODUCT_MAP: Record<string, Product> = {
  intraday: 'INTRADAY', mis: 'INTRADAY', i: 'INTRADAY',
  carryforward: 'CARRYFORWARD', nrml: 'CARRYFORWARD', normal: 'CARRYFORWARD', cf: 'CARRYFORWARD',
  delivery: 'DELIVERY', cnc: 'DELIVERY', c: 'DELIVERY',
  margin: 'MARGIN', co: 'MARGIN', bo: 'MARGIN',
};

export function toProduct(v: unknown): Product {
  return PRODUCT_MAP[String(v ?? '').trim().toLowerCase()] ?? 'UNKNOWN';
}

/**
 * Broker timestamp → epoch ms, or null.
 *
 * Returns null rather than `Date.now()` on a parse failure. A fabricated
 * timestamp sorts an order book plausibly and wrongly; a null is visibly absent.
 */
export function toTimestamp(v: unknown): number | null {
  const raw = String(v ?? '').trim();
  if (!raw) return null;

  // Angel and Kotak both send `YYYY-MM-DD HH:mm:ss` in IST with no zone marker.
  // Parsing that as local time is right only if the server runs in IST, which it
  // may not — so the offset is applied explicitly.
  const ist = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (ist) {
    const [, y, mo, d, h, mi, s] = ist;
    return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) - 5.5 * 3_600_000;
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
