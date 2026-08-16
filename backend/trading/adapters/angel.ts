/**
 * Angel One trading reads.
 *
 * Shares the feed adapter's session — see `AngelFeed.requireSession`. Nothing
 * here logs in.
 *
 * Two things to know about Angel's books:
 *
 *   rate limits   getOrderBook, getTradeBook and getPosition are capped at ONE
 *                 request per second each (see adapters/angel/http.ts). Polling
 *                 them on a timer is how an API key gets throttled; the limiter
 *                 queues rather than rejects, so a tight loop silently becomes a
 *                 slow one.
 *   quantities    Angel reports UNITS, not lots, everywhere. The lot size comes
 *                 from the instrument master, not from the report.
 */

import type {
  TradingBroker, TradingCapabilities, Order, Trade, Position, Holding, Funds,
} from '../types.js';
import {
  toNumber, toSide, toStatus, toKind, toProduct, toTimestamp,
} from '../types.js';
import { resolveContract } from '../contract.js';
import { classify } from '../../feeds/errors.js';
import { smartCall, smartHeaders, authHeaders } from '../../feeds/adapters/angel/http.js';
import type { AngelFeed } from '../../feeds/adapters/angel/index.js';

const CAPABILITIES: TradingCapabilities = {
  orders: true, trades: true, positions: true, holdings: true, funds: true,
};

const PATHS = {
  orders:    '/rest/secure/angelbroking/order/v1/getOrderBook',
  trades:    '/rest/secure/angelbroking/order/v1/getTradeBook',
  positions: '/rest/secure/angelbroking/order/v1/getPosition',
  holdings:  '/rest/secure/angelbroking/portfolio/v1/getAllHolding',
  rms:       '/rest/secure/angelbroking/user/v1/getRMS',
} as const;

/** Angel's report rows, in the shape this adapter reads. */
type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * Angel returns a single object instead of an array when there is exactly one
 * row, and `null` when there are none. Both are normal.
 *
 * The empty-object guard is what stops a PHANTOM ROW. `smartCall` returns
 * `parsed.data ?? {}` so its callers never have to null-check — which means an
 * empty book (`data: null`) arrives here as `{}`, not as null. Wrapping that
 * into `[{}]` produced one order with no id, no quantity, no status and the
 * label "unknown", sitting in the book looking like a real order that had gone
 * wrong. An object with no keys is not a row.
 */
function rows(data: unknown): Row[] {
  if (Array.isArray(data)) return data.filter((r): r is Row => r != null && typeof r === 'object');
  if (data && typeof data === 'object') {
    const row = data as Row;
    return Object.keys(row).length > 0 ? [row] : [];
  }
  return [];
}

/** The fields every Angel book uses to name its instrument. */
function contractOf(r: Row) {
  return resolveContract('angel', {
    brsymbol:   str(r.tradingsymbol) || str(r.symbolname),
    brexchange: str(r.exchange) || str(r.exch_seg),
    token:      str(r.symboltoken) || str(r.token),
    underlying: str(r.symbolname),
    expiry:     str(r.expirydate),
    strike:     str(r.strikeprice),
    optionType: str(r.optiontype),
    lot:        toNumber(r.lotsize) || undefined,
  });
}

/**
 * Angel's margin payload names the same thing four ways depending on segment
 * and account type. Ordered by how authoritative each is.
 */
const MARGIN_KEYS = ['availablecash', 'net', 'availablelimitmargin', 'collateral'] as const;

/**
 * One Angel position row → a normalised Position.
 *
 * The realised/unrealised split is DERIVED rather than taken from the broker,
 * for the same reason it is in the Zerodha adapter: a squared-off leg came back
 * from Kite as `realised: 0` with everything in `unrealised`, which showed
 * "REALISED 0.00" beside two closed losing legs and made the payoff panel drop
 * them. Angel's fields are the same shape and no more trustworthy — its
 * `realised` is frequently absent on intraday rows — and the failure is silent
 * either way, because a wrong split still sums to the right total.
 *
 * A position at quantity 0 has no exposure left to be unrealised ABOUT; its P&L
 * is booked. Beyond that, the closed quantity is the smaller of the two sides.
 *
 * Exported for the verify script.
 */
export function normalizeAngelPosition(r: Row): Position {
  const buyQty   = toNumber(r.totalbuyqty)  || toNumber(r.buyqty);
  const sellQty  = toNumber(r.totalsellqty) || toNumber(r.sellqty);
  const quantity = toNumber(r.netqty);
  const pnl      = toNumber(r.pnl);

  const buyAvg  = toNumber(r.totalbuyavgprice)  || toNumber(r.buyavgprice);
  const sellAvg = toNumber(r.totalsellavgprice) || toNumber(r.sellavgprice);

  const closed = Math.min(buyQty, sellQty);
  const realised = quantity === 0
    ? pnl                                     // fully closed: all of it is booked
    : closed > 0 ? (sellAvg - buyAvg) * closed
    : 0;

  return {
    contract:  contractOf(r),
    product:   toProduct(r.producttype),
    quantity,
    overnight: toNumber(r.cfbuyqty) - toNumber(r.cfsellqty),
    buyQuantity:  buyQty,
    sellQuantity: sellQty,
    buyAverage:   buyAvg,
    sellAverage:  sellAvg,
    lastPrice:    toNumber(r.ltp),
    closePrice:   toNumber(r.close),
    pnl,
    realised,
    // The remainder, so the parts always reconcile to the total.
    unrealised: pnl - realised,
  };
}

export class AngelTrading implements TradingBroker {
  readonly capabilities = CAPABILITIES;
  readonly broker = 'angel';

  /**
   * `feed` is public because the order stream needs the same session this
   * adapter uses — and it must be the SAME one. Angel counts sessions per
   * client code, so a stream that logged in for itself could invalidate the
   * session the books are reading through.
   */
  constructor(readonly feed: AngelFeed) {}

  get id(): string {
    return this.feed.id;
  }

  isConnected(): boolean {
    return this.feed.isConnected();
  }

  private headers(): Record<string, string> {
    const s = this.feed.requireSession();
    return authHeaders(smartHeaders(s.apiKey), s.jwtToken);
  }

  private async get(path: string): Promise<Row[]> {
    try {
      return rows(await smartCall(path === PATHS.holdings ? 'GET' : 'GET', path, this.headers()));
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  // ── books ──────────────────────────────────────────────────────────────────

  async orders(): Promise<Order[]> {
    return (await this.get(PATHS.orders)).map((r): Order => {
      const quantity = toNumber(r.quantity);
      const filled   = toNumber(r.filledshares);
      return {
        id:         str(r.orderid),
        exchangeId: str(r.exchangeorderid) || str(r.uniqueorderid),
        contract:   contractOf(r),
        side:       toSide(r.transactiontype),
        status:     toStatus(r.orderstatus ?? r.status),
        kind:       toKind(r.ordertype),
        product:    toProduct(r.producttype),
        quantity,
        filled,
        // Angel publishes `unfilledshares`, but it disagrees with
        // quantity − filled on partially cancelled orders. The subtraction is
        // the one that always reconciles with the other two columns on screen.
        pending:      Math.max(0, quantity - filled),
        price:        toNumber(r.price),
        triggerPrice: toNumber(r.triggerprice),
        averagePrice: toNumber(r.averageprice),
        placedAt:     toTimestamp(r.updatetime ?? r.exchtime ?? r.ordertime),
        updatedAt:    toTimestamp(r.updatetime),
        message:      str(r.text),
      };
    });
  }

  async trades(): Promise<Trade[]> {
    return (await this.get(PATHS.trades)).map((r): Trade => ({
      id:       str(r.fillid) || str(r.tradeid),
      orderId:  str(r.orderid),
      contract: contractOf(r),
      side:     toSide(r.transactiontype),
      quantity: toNumber(r.fillsize) || toNumber(r.quantity),
      price:    toNumber(r.fillprice) || toNumber(r.price),
      filledAt: toTimestamp(r.filltime ?? r.exchtime),
    }));
  }

  async positions(): Promise<Position[]> {
    return (await this.get(PATHS.positions)).map(normalizeAngelPosition);
  }

  async holdings(): Promise<Holding[]> {
    // getAllHolding nests the list under `holdings` alongside a totals block.
    let data: unknown;
    try {
      data = await smartCall<{ holdings?: unknown }>('GET', PATHS.holdings, this.headers());
    } catch (err) {
      throw classify(err, this.id);
    }

    const list = data && typeof data === 'object' && 'holdings' in data
      ? (data as { holdings?: unknown }).holdings
      : data;

    return rows(list).map((r): Holding => ({
      contract:     contractOf(r),
      quantity:     toNumber(r.quantity),
      averagePrice: toNumber(r.averageprice),
      lastPrice:    toNumber(r.ltp),
      closePrice:   toNumber(r.close),
      pnl:          toNumber(r.profitandloss),
      collateral:   toNumber(r.collateralquantity),
    }));
  }

  async funds(): Promise<Funds> {
    let data: Record<string, unknown>;
    try {
      data = await smartCall<Record<string, unknown>>('GET', PATHS.rms, this.headers());
    } catch (err) {
      throw classify(err, this.id);
    }

    const source = MARGIN_KEYS.find((k) => data[k] != null) ?? 'unknown';
    return {
      available: toNumber(data[source]),
      used:      toNumber(data.utiliseddebits),
      total:     toNumber(data.net),
      source,
    };
  }
}
