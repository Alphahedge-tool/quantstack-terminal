/**
 * Zerodha (Kite Connect) trading reads.
 *
 * Shares the feed adapter's session.
 *
 * Kite's books are the cleanest of the four — already typed, already in rupees,
 * ISO-8601 timestamps — with one gap that shapes this file: Kite states neither
 * strike, expiry nor option type on an order or a position. It sends only
 * `tradingsymbol`. Everything the UI needs to render a contract therefore comes
 * from resolving that symbol against the canonical master, which is exactly what
 * `resolveContract` does.
 *
 * Positions come back split into `net` and `day`. `net` is the real book — `day`
 * excludes carried-forward quantity, so using it would show a hedge that has
 * been held since yesterday as flat.
 */

import type {
  TradingBroker, TradingCapabilities, Order, Trade, Position, Holding, Funds,
} from '../types.js';
import {
  toNumber, toSide, toStatus, toKind, toProduct, toTimestamp,
} from '../types.js';
import { resolveContract } from '../contract.js';
import { classify } from '../../feeds/errors.js';
import { kiteCall } from '../../feeds/adapters/zerodha/session.js';
import type { ZerodhaFeed } from '../../feeds/adapters/zerodha/index.js';

const CAPABILITIES: TradingCapabilities = {
  orders: true, trades: true, positions: true, holdings: true, funds: true,
};

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function contractOf(r: Row) {
  return resolveContract('zerodha', {
    brsymbol:   str(r.tradingsymbol),
    brexchange: str(r.exchange),
    token:      str(r.instrument_token),
    lot:        undefined,
  });
}

/**
 * One Kite `net` position row → a normalised Position.
 *
 * Exported for the verify script, because the realised/unrealised split below
 * is the kind of thing that fails silently: a wrong split still adds up to the
 * right total, so the book looks correct while the payoff panel — which trusts
 * the split — quietly drops closed legs.
 *
 * ── Kite's split is not trustworthy, so it is DERIVED ──
 *
 * Verified against a live account: a fully squared-off leg (quantity 0, bought
 * and sold the same 120) came back as `realised: 0` with the whole figure in
 * `unrealised`. That is exactly backwards. A position with no quantity has no
 * exposure left to be unrealised ABOUT; every rupee of it is booked. Passing it
 * through showed "REALISED 0.00" beside two closed losing legs.
 *
 * The closed quantity is the smaller of the two sides; anything beyond it is
 * still open. Same derivation the Kotak adapter uses, for the same reason.
 */
export function normalizeZerodhaPosition(r: Row): Position {
  const quantity = toNumber(r.quantity);
  const buyQty   = toNumber(r.buy_quantity);
  const sellQty  = toNumber(r.sell_quantity);
  const pnl      = toNumber(r.pnl);

  const closed = Math.min(buyQty, sellQty);
  const realised = quantity === 0
    // Fully closed: the whole P&L is booked, whatever Kite says.
    ? pnl
    // Partially closed: realised on the matched quantity only.
    : closed > 0
      ? (toNumber(r.sell_price) - toNumber(r.buy_price)) * closed
      : 0;

  return {
    contract:  contractOf(r),
    product:   toProduct(r.product),
    quantity,
    overnight: toNumber(r.overnight_quantity),
    buyQuantity:  buyQty,
    sellQuantity: sellQty,
    buyAverage:   toNumber(r.buy_price),
    sellAverage:  toNumber(r.sell_price),
    lastPrice:    toNumber(r.last_price),
    closePrice:   toNumber(r.close_price),
    pnl,
    realised,
    // The remainder, so the two always reconcile to `pnl` — a book whose parts
    // do not add up to its own total is worse than one without parts.
    unrealised: pnl - realised,
  };
}

export class ZerodhaTrading implements TradingBroker {
  readonly capabilities = CAPABILITIES;
  readonly broker = 'zerodha';

  constructor(private readonly feed: ZerodhaFeed) {}

  get id(): string {
    return this.feed.id;
  }

  isConnected(): boolean {
    return this.feed.isConnected();
  }

  private async get<T>(path: string): Promise<T> {
    try {
      return await kiteCall<T>(this.feed.requireSession(), path);
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  async orders(): Promise<Order[]> {
    const list = await this.get<Row[]>('/orders') ?? [];
    return list.map((r): Order => ({
      id:         str(r.order_id),
      exchangeId: str(r.exchange_order_id),
      contract:   contractOf(r),
      side:       toSide(r.transaction_type),
      status:     toStatus(r.status),
      kind:       toKind(r.order_type),
      product:    toProduct(r.product),
      quantity:   toNumber(r.quantity),
      filled:     toNumber(r.filled_quantity),
      pending:    toNumber(r.pending_quantity),
      price:        toNumber(r.price),
      triggerPrice: toNumber(r.trigger_price),
      averagePrice: toNumber(r.average_price),
      placedAt:   toTimestamp(r.order_timestamp),
      updatedAt:  toTimestamp(r.exchange_update_timestamp ?? r.exchange_timestamp),
      message:    str(r.status_message),
    }));
  }

  async trades(): Promise<Trade[]> {
    const list = await this.get<Row[]>('/trades') ?? [];
    return list.map((r): Trade => ({
      id:       str(r.trade_id),
      orderId:  str(r.order_id),
      contract: contractOf(r),
      side:     toSide(r.transaction_type),
      quantity: toNumber(r.quantity),
      price:    toNumber(r.average_price) || toNumber(r.price),
      filledAt: toTimestamp(r.fill_timestamp ?? r.exchange_timestamp),
    }));
  }

  async positions(): Promise<Position[]> {
    const out = await this.get<{ net?: Row[]; day?: Row[] }>('/portfolio/positions');
    // `net`, not `day` — see the file header.
    return (out?.net ?? []).map(normalizeZerodhaPosition);
  }

  async holdings(): Promise<Holding[]> {
    const list = await this.get<Row[]>('/portfolio/holdings') ?? [];
    return list.map((r): Holding => ({
      contract:     contractOf(r),
      quantity:     toNumber(r.quantity),
      averagePrice: toNumber(r.average_price),
      lastPrice:    toNumber(r.last_price),
      closePrice:   toNumber(r.close_price),
      pnl:          toNumber(r.pnl),
      // Pledged stock sits in `collateral_quantity`; `t1_quantity` is settlement
      // pending and is already counted inside `quantity`.
      collateral:   toNumber(r.collateral_quantity),
    }));
  }

  async funds(): Promise<Funds> {
    const out = await this.get<Record<string, Row>>('/user/margins');

    // Kite reports equity and commodity separately. The terminal wants one
    // number, and `equity` is the segment options trade under — but an account
    // that is commodity-only would report zero, so fall through to it.
    const segment = (out?.equity && Object.keys(out.equity).length ? 'equity' : 'commodity');
    const block   = (out?.[segment] ?? {}) as Row;
    const avail   = (block.available ?? {}) as Row;
    const used    = (block.utilised  ?? {}) as Row;

    return {
      available: toNumber(avail.live_balance ?? avail.cash),
      used:      toNumber(used.debits),
      total:     toNumber(block.net),
      source:    `kite:${segment}`,
    };
  }
}
