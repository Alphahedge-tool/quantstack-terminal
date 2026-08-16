/**
 * Schemas for `/api/trading/*`.
 *
 * Mirrors backend/trading/types.ts. The books are broker-neutral: every row is
 * tagged with the account it came from, and one broker being down contributes
 * an entry to `errors` rather than failing the request. A caller that ignores
 * `errors` just sees fewer rows; a caller that reads it can say which account
 * is unavailable — which beats an empty table that looks like a flat book.
 *
 * Enums are `catch`-guarded rather than strict. The backend already normalises
 * broker vocabulary into these unions, but a broker adding a status the mapper
 * has not learned yet should degrade one cell to UNKNOWN, not blank the book.
 */

import { z } from 'zod';

export const sideSchema = z.enum(['BUY', 'SELL']).catch('BUY');

/**
 * Order state, as `backend/trading/types.ts` normalises it.
 *
 * ── PARTIAL and TRIGGER_PENDING are not optional members ──
 *
 * This enum was missing both, and `.catch('UNKNOWN')` meant they did not fail
 * loudly — they were silently rewritten. Both are orders that are STILL WORKING:
 * a partial fill has a live remainder at the exchange, and a stop order is armed
 * and waiting for its trigger. Coerced to UNKNOWN they matched no filter, so a
 * resting stop-loss vanished from every "working orders" view in the app while
 * being very much alive in the market.
 *
 * That is the worst direction for this particular error to fail in, which is why
 * the two derived predicates below exist rather than each page spelling out its
 * own status list — four call sites drifted apart exactly once already.
 */
export const orderStatusSchema = z
  .enum([
    'PENDING',
    'OPEN',
    'PARTIAL',
    'TRIGGER_PENDING',
    'COMPLETE',
    'CANCELLED',
    'REJECTED',
    'UNKNOWN',
  ])
  .catch('UNKNOWN');

export const orderKindSchema = z
  .enum(['MARKET', 'LIMIT', 'SL', 'SL-M', 'UNKNOWN'])
  .catch('UNKNOWN');

export const productSchema = z
  .enum(['INTRADAY', 'CARRYFORWARD', 'DELIVERY', 'MARGIN', 'UNKNOWN'])
  .catch('UNKNOWN');

/**
 * The structural address the backend resolved this contract to.
 *
 * ── Why this must be carried, not rebuilt ──
 *
 * `/ws/live/quotes` subscribes by InstrumentKey, never by symbol: the live
 * router hands the key to whichever broker's master can resolve it, which is
 * the whole mechanism behind pricing a Kotak position off an Angel feed.
 *
 * This schema previously omitted `key`, and a zod object strips what it does
 * not declare — so the field arrived on the wire and was deleted before any
 * component saw it. The subscription fell back to sending canonical symbol
 * STRINGS, which `backend/live/wsQuotes.ts:toKey` rejects outright (it requires
 * an object), leaving the socket connected and permanently carrying nothing.
 *
 * Rebuilding the key from the sibling fields is not an equivalent fix. The
 * backend fills `contract.exchange` with the SEGMENT (`NFO`) while a key needs
 * the underlying exchange (`NSE`) — see `exchangeForKey` in
 * backend/trading/contract.ts. Reconstructing would look right and resolve
 * against nothing.
 *
 * Nullable, and that is meaningful: a row nothing could identify still shows in
 * the book with `key: null`, and it simply cannot be priced live.
 */
export const instrumentKeySchema = z.object({
  /** Where the UNDERLYING lives — NSE, BSE, MCX. Not the segment. */
  exchange: z.string().default(''),
  /** Underlying root — NIFTY, RELIANCE, CRUDEOIL. */
  asset: z.string().default(''),
  kind: z.enum(['SPOT', 'FUT', 'OPT']).catch('SPOT'),
  // Absent for SPOT, and omitted from the JSON rather than sent as null — but
  // both are accepted, because the two sides deploy separately and the backend
  // treats them identically.
  expiry: z.string().nullable().optional(),
  strike: z.number().nullable().optional(),
  side: z.enum(['CE', 'PE']).nullable().optional(),
});

export const contractSchema = z.object({
  symbol: z.string().default(''),
  key: instrumentKeySchema.nullable().default(null),
  resolved: z.boolean().default(false),
  /** Canonical segment — NFO, BFO, MCX. See `key.exchange` for the underlying. */
  exchange: z.string().default(''),
  underlying: z.string().default(''),
  expiry: z.string().default(''),
  strike: z.number().nullable().default(null),
  optionType: z.enum(['', 'CE', 'PE']).catch(''),
  lot: z.number().default(0),
  label: z.string().default(''),
});

/** Every book row carries the account that produced it. */
const taggedFields = {
  broker: z.string().default(''),
  feedId: z.string().default(''),
};

export const orderSchema = z.object({
  ...taggedFields,
  id: z.string().default(''),
  exchangeId: z.string().default(''),
  contract: contractSchema,
  side: sideSchema,
  status: orderStatusSchema,
  kind: orderKindSchema,
  product: productSchema,
  quantity: z.number().default(0),
  filled: z.number().default(0),
  pending: z.number().default(0),
  price: z.number().default(0),
  triggerPrice: z.number().default(0),
  averagePrice: z.number().default(0),
  placedAt: z.number().nullable().default(null),
  updatedAt: z.number().nullable().default(null),
  message: z.string().default(''),
});

export const tradeSchema = z.object({
  ...taggedFields,
  id: z.string().default(''),
  orderId: z.string().default(''),
  contract: contractSchema,
  side: sideSchema,
  quantity: z.number().default(0),
  price: z.number().default(0),
  filledAt: z.number().nullable().default(null),
});

export const positionSchema = z.object({
  ...taggedFields,
  contract: contractSchema,
  product: productSchema,
  quantity: z.number().default(0),
  overnight: z.number().default(0),
  buyQuantity: z.number().default(0),
  sellQuantity: z.number().default(0),
  buyAverage: z.number().default(0),
  sellAverage: z.number().default(0),
  lastPrice: z.number().default(0),
  closePrice: z.number().default(0),
  pnl: z.number().default(0),
  realised: z.number().default(0),
  unrealised: z.number().default(0),
  /**
   * Which brokers' feeds can price this contract. Some brokers' position
   * reports carry no price at all, so this is how the UI knows a position is
   * priceable from another account's feed rather than showing a blank LTP.
   */
  pricedBy: z.array(z.string()).default([]),
});

export const holdingSchema = z.object({
  ...taggedFields,
  contract: contractSchema,
  quantity: z.number().default(0),
  averagePrice: z.number().default(0),
  lastPrice: z.number().default(0),
  closePrice: z.number().default(0),
  pnl: z.number().default(0),
  collateral: z.number().default(0),
});

export const fundsSchema = z.object({
  ...taggedFields,
  available: z.number().default(0),
  used: z.number().default(0),
  total: z.number().default(0),
  source: z.string().default(''),
});

export const brokerErrorSchema = z.object({
  broker: z.string(),
  message: z.string(),
  code: z.string(),
});

/**
 * The aggregate envelope every book route returns.
 *
 * Written out per book rather than generated from a helper: a computed key
 * (`{ [name]: … }`) collapses to an index signature in TypeScript, so the
 * inferred type would lose `orders` / `positions` as named fields and every
 * consumer would fall back to `any`. The repetition buys real types.
 */
const errors = z.array(brokerErrorSchema).default([]);

export const ordersResponse = z.object({
  status: z.literal(true),
  orders: z.array(orderSchema).default([]),
  errors,
});

export const tradesResponse = z.object({
  status: z.literal(true),
  trades: z.array(tradeSchema).default([]),
  errors,
});

export const positionsResponse = z.object({
  status: z.literal(true),
  positions: z.array(positionSchema).default([]),
  errors,
});

export const holdingsResponse = z.object({
  status: z.literal(true),
  holdings: z.array(holdingSchema).default([]),
  errors,
});

export const fundsResponse = z.object({
  status: z.literal(true),
  funds: z.array(fundsSchema).default([]),
  errors,
});

export const tradingCapabilitiesSchema = z.object({
  orders: z.boolean().default(false),
  trades: z.boolean().default(false),
  positions: z.boolean().default(false),
  holdings: z.boolean().default(false),
  funds: z.boolean().default(false),
});

export const brokerStateSchema = z.object({
  id: z.string(),
  broker: z.string().default(''),
  connected: z.boolean().default(false),
  capabilities: tradingCapabilitiesSchema,
});

export const tradingControlResponse = z.object({
  status: z.literal(true),
  brokers: z.array(brokerStateSchema).default([]),
});

/**
 * Still live in the market, in any form.
 *
 * The one definition of "working" in the app. `UNKNOWN` is excluded on purpose:
 * an unrecognised status is a status we cannot make a claim about, and putting
 * it here would assert the order is live when nobody knows that.
 */
export function isWorking(status: OrderStatus): boolean {
  return (
    status === 'OPEN' ||
    status === 'PENDING' ||
    status === 'PARTIAL' ||
    status === 'TRIGGER_PENDING'
  );
}

/** Filled. A partial fill is NOT executed — its remainder is still working. */
export function isExecuted(status: OrderStatus): boolean {
  return status === 'COMPLETE';
}

export type ContractKey = z.infer<typeof instrumentKeySchema>;
export type Contract = z.infer<typeof contractSchema>;
export type Order = z.infer<typeof orderSchema>;
export type Trade = z.infer<typeof tradeSchema>;
export type Position = z.infer<typeof positionSchema>;
export type Holding = z.infer<typeof holdingSchema>;
export type Funds = z.infer<typeof fundsSchema>;
export type BrokerError = z.infer<typeof brokerErrorSchema>;
export type BrokerState = z.infer<typeof brokerStateSchema>;
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export type Side = z.infer<typeof sideSchema>;
