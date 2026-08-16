/**
 * Kotak Neo trading reads.
 *
 * Shares the feed adapter's session.
 *
 * Kotak's field names are abbreviated to the point of being a cipher — `trdSym`,
 * `exSeg`, `flBuyQty`, `cfSellAmt`, `stkPrc` — and the position report gives
 * quantities and AMOUNTS rather than averages, split across day and carry-forward
 * buckets. So this adapter does more arithmetic than the other three:
 *
 *   buy quantity   = flBuyQty  + cfBuyQty     (day + carried forward)
 *   buy average    = (buyAmt + cfBuyAmt) / buy quantity
 *
 * Deriving the average rather than reading it is not a preference. Kotak
 * publishes no average-price field at all, and using only the day bucket would
 * report the wrong cost basis on any position held overnight.
 *
 * No holdings endpoint exists in the Neo Trade API surface, which `capabilities`
 * states rather than the adapter throwing at call time.
 */

import type {
  TradingBroker, TradingCapabilities, Order, Trade, Position, Holding, Funds,
} from '../types.js';
import {
  toNumber, toSide, toStatus, toKind, toProduct, toTimestamp,
} from '../types.js';
import { resolveContract } from '../contract.js';
import { FeedError, classify } from '../../feeds/errors.js';
import { kotakCall } from '../../feeds/adapters/kotak/session.js';
import type { KotakFeed } from '../../feeds/adapters/kotak/index.js';

const CAPABILITIES: TradingCapabilities = {
  orders: true, trades: true, positions: true,
  holdings: false,   // not exposed by the Neo Trade API
  funds: true,
};

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return String(v ?? '').trim();
}

function contractOf(r: Row) {
  return resolveContract('kotak', {
    brsymbol:   str(r.trdSym) || str(r.sym),
    brexchange: str(r.exSeg),
    token:      str(r.tok),
    underlying: str(r.sym),
    expiry:     str(r.expDt),
    strike:     str(r.stkPrc),
    optionType: str(r.optTp),
    lot:        toNumber(r.lotSz) || toNumber(r.brdLtQty) || undefined,
  });
}

/** Kotak wraps its report lists under `data`, and sometimes returns nothing. */
function rows(out: unknown): Row[] {
  if (Array.isArray(out)) return out.filter((r): r is Row => r != null && typeof r === 'object');
  const data = (out as { data?: unknown })?.data;
  if (Array.isArray(data)) return data.filter((r): r is Row => r != null && typeof r === 'object');
  return [];
}

/**
 * One Kotak position row → the normalised shape.
 *
 * Exported and pure so the arithmetic above can be verified without a session —
 * it is the part of this adapter most likely to be quietly wrong, because every
 * input is an amount rather than the average it has to become.
 */
export function normalizeKotakPosition(r: Row): Position {
  const dayBuy  = toNumber(r.flBuyQty);
  const daySell = toNumber(r.flSellQty);
  const cfBuy   = toNumber(r.cfBuyQty);
  const cfSell  = toNumber(r.cfSellQty);

  const buyQty  = dayBuy + cfBuy;
  const sellQty = daySell + cfSell;
  const buyAmt  = toNumber(r.buyAmt)  + toNumber(r.cfBuyAmt);
  const sellAmt = toNumber(r.sellAmt) + toNumber(r.cfSellAmt);

  const buyAvg  = buyQty  ? buyAmt  / buyQty  : 0;
  const sellAvg = sellQty ? sellAmt / sellQty : 0;

  // Realised P&L on the quantity actually closed out. Kotak reports no realised
  // figure, and the closed quantity is the smaller of the two sides — anything
  // beyond that is still open and belongs in unrealised, which needs a price
  // this report does not carry.
  const closed = Math.min(buyQty, sellQty);

  return {
    contract:  contractOf(r),
    product:   toProduct(r.prod),
    quantity:  r.qty != null ? toNumber(r.qty) : buyQty - sellQty,
    overnight: cfBuy - cfSell,
    buyQuantity:  buyQty,
    sellQuantity: sellQty,
    buyAverage:   buyAvg,
    sellAverage:  sellAvg,
    // Kotak's position report carries no price at all. The live feed supplies
    // it through the canonical-symbol join — which is why these are 0 rather
    // than invented from the averages.
    lastPrice:  0,
    closePrice: 0,
    pnl:        (sellAvg - buyAvg) * closed,
    realised:   (sellAvg - buyAvg) * closed,
    unrealised: 0,
  };
}

export class KotakTrading implements TradingBroker {
  readonly capabilities = CAPABILITIES;
  readonly broker = 'kotak';

  constructor(private readonly feed: KotakFeed) {}

  get id(): string {
    return this.feed.id;
  }

  isConnected(): boolean {
    return this.feed.isConnected();
  }

  private async get(path: string): Promise<Row[]> {
    try {
      return rows(await kotakCall(this.feed.requireSession(), path));
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  async orders(): Promise<Order[]> {
    return (await this.get('/Orders/2.0/quick/user/orders')).map((r): Order => {
      const quantity = toNumber(r.qty);
      const filled   = toNumber(r.fldQty);
      return {
        id:         str(r.nOrdNo),
        exchangeId: str(r.exOrdId),
        contract:   contractOf(r),
        side:       toSide(r.trnsTp),
        status:     toStatus(r.ordSt),
        kind:       toKind(r.prcTp),
        product:    toProduct(r.prod),
        quantity,
        filled,
        // Kotak's `unFldSz` is reliable here, unlike Angel's equivalent, but the
        // subtraction is kept for consistency across adapters and reconciles
        // with the two columns beside it.
        pending:      Math.max(0, quantity - filled),
        price:        toNumber(r.prc),
        triggerPrice: toNumber(r.trgPrc),
        averagePrice: toNumber(r.avgPrc),
        placedAt:     toTimestamp(r.ordDtTm),
        updatedAt:    toTimestamp(r.exCfmTm ?? r.hsUpTm ?? r.ordDtTm),
        message:      str(r.rejRsn),
      };
    });
  }

  async trades(): Promise<Trade[]> {
    return (await this.get('/Orders/2.0/quick/user/trades')).map((r): Trade => ({
      id:       str(r.exTrdNo) || str(r.trdNo),
      orderId:  str(r.nOrdNo),
      contract: contractOf(r),
      side:     toSide(r.trnsTp),
      quantity: toNumber(r.fldQty) || toNumber(r.qty),
      price:    toNumber(r.avgPrc) || toNumber(r.fldPrc) || toNumber(r.prc),
      filledAt: toTimestamp(r.exTm ?? r.hsUpTm),
    }));
  }

  async positions(): Promise<Position[]> {
    return (await this.get('/Positions/2.0/positions/todays')).map(normalizeKotakPosition);
  }

  async holdings(): Promise<Holding[]> {
    throw new FeedError(
      'UNSUPPORTED',
      'Kotak Neo does not expose a holdings endpoint through this API',
      { feedId: this.id },
    );
  }

  async funds(): Promise<Funds> {
    let out: Record<string, unknown>;
    try {
      out = await kotakCall<Record<string, unknown>>(
        this.feed.requireSession(), '/Orders/2.0/quick/user/limits',
        { method: 'POST', jData: { seg: 'ALL', exch: 'ALL', prod: 'ALL' } },
      );
    } catch (err) {
      throw classify(err, this.id);
    }

    return {
      available: toNumber(out.Net ?? out.net ?? out.MrgnOnPos),
      used:      toNumber(out.MrgnOnPos ?? out.marginUsed),
      total:     toNumber(out.CollateralValue ?? out.Net ?? out.net),
      source:    'kotak:limits',
    };
  }
}
