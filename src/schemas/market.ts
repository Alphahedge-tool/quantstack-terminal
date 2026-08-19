/**
 * Schemas for instruments, feeds, straddle analytics and live quote frames.
 *
 * These routes are older than the trading ones and their payloads are looser —
 * several fields are present only when a particular broker supplied them. The
 * schemas reflect that honestly with `.optional()` rather than pretending to a
 * completeness the backend does not promise.
 */

import { z } from 'zod';

/* ── Instruments ──────────────────────────────────────────────────────────── */

export const instrumentSchema = z
  .object({
    symbol: z.string().default(''),
    name: z.string().default(''),
    exchange: z.string().default(''),
    underlying: z.string().default(''),
    expiry: z.string().default(''),
    strike: z.number().nullable().default(null),
    optionType: z.string().default(''),
    lot: z.number().default(0),
    token: z.union([z.string(), z.number()]).optional(),
  })
  // The instrument master is a broker file with dozens of columns; passing the
  // extras through costs nothing and saves a schema edit every time a search
  // result needs one more of them.
  .passthrough();

export const instrumentSearchResponse = z.object({
  status: z.literal(true),
  count: z.number().default(0),
  instruments: z.array(instrumentSchema).default([]),
});

/**
 * One straddle-eligible underlying, as `/api/instruments/search` returns it.
 *
 * NOT the same shape as `instrumentSchema` above: that route answers with the
 * ASSET summary the instrument cache builds (`asset`, `kind`, `lot`, the whole
 * expiry list), not with one contract row. Parsing it as an `Instrument` is why
 * the symbol column can come back blank — `symbol` simply is not a field here.
 *
 * `kind` decides nothing on its own but is what lets the picker group indices
 * above stocks above commodities, which is the only way a list of 200 F&O names
 * stays scannable.
 */
export const eligibleAssetSchema = z
  .object({
    asset: z.string().default(''),
    exchange: z.string().default(''),
    kind: z.string().default(''),
    lot: z.number().default(0),
    expiries: z.array(z.string()).default([]),
  })
  .passthrough();

export type EligibleAsset = z.infer<typeof eligibleAssetSchema>;

export const eligibleSearchResponse = z.object({
  status: z.literal(true),
  count: z.number().default(0),
  instruments: z.array(eligibleAssetSchema).default([]),
});

export const expiriesResponse = z.object({
  status: z.literal(true),
  symbol: z.string().default(''),
  exchange: z.string().default(''),
  date: z.string().default(''),
  expiries: z.array(z.string()).default([]),
});

export const instrumentStatusResponse = z
  .object({ status: z.literal(true) })
  .passthrough();

/* ── Feeds ────────────────────────────────────────────────────────────────── */

export const feedSchema = z
  .object({
    id: z.string(),
    connected: z.boolean().default(false),
    priority: z.number().optional(),
    broker: z.string().optional(),
    /**
     * Session state from `feeds/authManager.ts`.
     *
     * Typed rather than left to `passthrough` because the login screen branches
     * on all four fields: `loggingIn` is a login in flight, `retryAfter` is a
     * backoff window that will refuse a Connect press until it elapses, and
     * `lastError` is the only place the broker's own refusal is written down.
     * Rendering "not connected" for all three is what makes a login look broken
     * when it is merely waiting.
     */
    auth: z
      .object({
        connectedAt: z.number().nullable().default(null),
        failures: z.number().default(0),
        retryAfter: z.number().nullable().default(null),
        lastError: z.string().nullable().default(null),
        loggingIn: z.boolean().default(false),
      })
      .passthrough()
      .optional(),
    /** OPEN means the router has taken this feed out of rotation entirely. */
    breaker: z
      .object({ state: z.string().default('CLOSED') })
      .passthrough()
      .optional(),
    capabilities: z
      .object({ exchanges: z.array(z.string()).default([]) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const feedsResponse = z
  .object({
    status: z.literal(true),
    feeds: z.array(feedSchema).default([]),
  })
  .passthrough();

export const liveFeedResponse = z
  .object({ status: z.literal(true) })
  .passthrough();

export const healthResponse = z.object({
  status: z.literal(true),
  service: z.string().default(''),
  ts: z.number().default(0),
  port: z.number().default(0),
});

/* ── Straddle ─────────────────────────────────────────────────────────────── */

export const straddleExpiriesResponse = z
  .object({
    status: z.literal(true),
    expiries: z.array(z.string()).default([]),
  })
  .passthrough();

/**
 * One bar of the rolling straddle walk, as produced by
 * `engine/rollingStraddle.ts`.
 *
 * Nearly everything is nullable and that is not defensiveness: the engine emits
 * a point per bar even when a leg had no quote, and a null here means "the feed
 * did not publish this", which the chart must draw as a GAP rather than as a
 * zero. Coercing these to 0 would put a line through the floor on every quiet
 * minute.
 */
export const straddlePointSchema = z
  .object({
    /** Epoch millis. Named `time`, not `ts` — matching the engine. */
    time: z.number(),
    spot: z.number().nullable().optional(),
    atmStrike: z.number().nullable().optional(),
    syntheticFuture: z.number().nullable().optional(),
    callLtp: z.number().nullable().optional(),
    putLtp: z.number().nullable().optional(),
    straddlePrice: z.number().nullable().optional(),
    straddleBid: z.number().nullable().optional(),
    straddleAsk: z.number().nullable().optional(),
    iv: z.number().nullable().optional(),
    /**
     * Where the vol came from: `feed` when the broker published it, otherwise
     * the model that produced it (`black76`).
     *
     * Worth typing rather than leaving to `passthrough`, because the two are
     * not interchangeable facts. A fed vol is a number someone quoted; an
     * inverted one is a number we calculated from a price, and it inherits
     * every assumption in the model — most sharply near expiry, where the
     * inversion goes unstable exactly when the reader is watching hardest.
     */
    ivSource: z.string().nullable().optional(),
    vega: z.number().nullable().optional(),
    theta: z.number().nullable().optional(),
    isRollEvent: z.boolean().optional(),
  })
  .passthrough();

/**
 * `POST /api/straddle/history` — the full session walk.
 *
 * The envelope carries its own baselines (`entryStraddle`, the 9:15 print) and
 * a `greekCoverage` fraction. Both matter for honesty on the page: a flat vega
 * line because the feed went silent looks identical to a flat one because vol
 * did not move, and only `greekCoverage` tells them apart.
 */
export const straddleHistoryResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    exchange: z.string().default(''),
    expiry: z.string().default(''),
    date: z.string().default(''),
    interval: z.string().default(''),
    entryPrice: z.number().nullable().default(null),
    entryStraddle: z.number().nullable().default(null),
    greekCoverage: z.number().nullable().default(null),
    currentStrike: z.number().nullable().default(null),
    lastSpot: z.number().nullable().default(null),
    points: z.array(straddlePointSchema).default([]),
    /** Strike changes through the session — worth marking on the chart, since a
     *  jump in premium at a roll is a change of instrument, not a move. */
    rollEvents: z
      .array(
        z
          .object({
            time: z.number(),
            fromStrike: z.number().nullable().optional(),
            toStrike: z.number().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

/**
 * `GET /api/straddle/snapshot?expiries=a,b,c` — the LAST value per expiry, not
 * a time series. It backs a term-structure comparison, not the session chart.
 */
export const straddleSnapshotResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    snapshots: z
      .array(
        z
          .object({
            expiry: z.string(),
            straddleMid: z.number().nullable().default(null),
            straddleBid: z.number().nullable().default(null),
            straddleAsk: z.number().nullable().default(null),
            iv: z.number().nullable().default(null),
            atmStrike: z.number().nullable().default(null),
            syntheticFuture: z.number().nullable().default(null),
            spot: z.number().nullable().optional(),
            /** Present when THIS expiry failed while others succeeded — one bad
             *  contract must not blank the whole comparison. */
            error: z.string().optional(),
          })
          .passthrough(),
      )
      .default([]),
  })
  .passthrough();

export const straddleStatusResponse = z
  .object({ status: z.literal(true) })
  .passthrough();

/* ── Band greeks ──────────────────────────────────────────────────────────── */

/**
 * One bar of the delta-band greeks walk, from `engine/bandGreeks.ts`.
 *
 * `callVega`/`callTheta` are the band's NET exposure per leg; the `*Total`
 * fields are the gross sum across the legs in the basket. Both are published
 * because they answer different questions — net is what a spread is worth, and
 * gross is how much of the chain is behind that number.
 *
 * Every greek is nullable. The band can be empty on a bar (no strike sat in the
 * delta window), and that must draw as a GAP rather than as a zero: a vega of
 * zero is a flat position, and "no legs qualified" is not.
 */
export const bandGreeksPointSchema = z
  .object({
    time: z.number(),
    spot: z.number().nullable().optional(),
    synFuture: z.number().nullable().optional(),
    atmStrike: z.number().nullable().optional(),
    callVega: z.number().nullable().optional(),
    putVega: z.number().nullable().optional(),
    callTheta: z.number().nullable().optional(),
    putTheta: z.number().nullable().optional(),
    callVegaTotal: z.number().nullable().optional(),
    putVegaTotal: z.number().nullable().optional(),
    callThetaTotal: z.number().nullable().optional(),
    putThetaTotal: z.number().nullable().optional(),
    callCount: z.number().nullable().optional(),
    putCount: z.number().nullable().optional(),
    isRollEvent: z.boolean().optional(),
  })
  .passthrough();

export const bandGreeksResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    expiry: z.string().default(''),
    date: z.string().default(''),
    interval: z.string().default(''),
    deltaMin: z.number().nullable().default(null),
    deltaMax: z.number().nullable().default(null),
    /** Fetched vs actually inside the delta window. When `legsUsed` is 0 the
     *  whole basket is null and the chart must say why — see the page. */
    legsFetched: z.number().nullable().default(null),
    legsUsed: z.number().nullable().default(null),
    coverage: z.number().nullable().default(null),
    points: z.array(bandGreeksPointSchema).default([]),
  })
  .passthrough();

/* ── Risk reversal ────────────────────────────────────────────────────────── */

/**
 * One bar of the risk-reversal walk, from `engine/riskReversal.ts`.
 *
 * Note the two skew measures and DO NOT confuse them: `rr` is the wing spread
 * in IV points (put IV − call IV), and `skew` is that same spread as a
 * percentage of ATM IV. The normalised one is comparable across days and across
 * underlyings; the raw one is what the wings actually cost. Verified against a
 * live bar: putIv 9.426 − callIv 9.144 = rr 0.282, and 0.282 / atmIv 9.132 =
 * skew 3.09%.
 */
export const riskReversalPointSchema = z
  .object({
    time: z.number(),
    spot: z.number().nullable().optional(),
    synFuture: z.number().nullable().optional(),
    atmStrike: z.number().nullable().optional(),
    atmIv: z.number().nullable().optional(),
    callIv: z.number().nullable().optional(),
    putIv: z.number().nullable().optional(),
    callDelta: z.number().nullable().optional(),
    putDelta: z.number().nullable().optional(),
    callStrike: z.number().nullable().optional(),
    putStrike: z.number().nullable().optional(),
    /** Put IV − call IV, in IV points. */
    rr: z.number().nullable().optional(),
    /** `rr` as a percentage of ATM IV. */
    skew: z.number().nullable().optional(),
    isRollEvent: z.boolean().optional(),
  })
  .passthrough();

export const riskReversalResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    expiry: z.string().default(''),
    date: z.string().default(''),
    interval: z.string().default(''),
    targetDelta: z.number().nullable().default(null),
    tolerance: z.number().nullable().default(null),
    coverage: z.number().nullable().default(null),
    /** Fraction of bars whose IV came from the feed rather than being inverted
     *  locally. A locally inverted vol is a model output, not a quote. */
    feedIvShare: z.number().nullable().default(null),
    points: z.array(riskReversalPointSchema).default([]),
  })
  .passthrough();

/* ── Live quote frames (`/ws/live/quotes`) ────────────────────────────────── */

export const quoteSchema = z.object({
  symbol: z.string(),
  ltp: z.number().optional(),
  bid: z.number().optional(),
  ask: z.number().optional(),
  iv: z.number().optional(),
  ts: z.number().optional(),
});

/**
 * Server → client frames, discriminated on `event`.
 *
 * `catchall` on the union's fallback matters: an unknown event type must be
 * ignorable, not fatal. The socket carries a live tape and a parse throw would
 * take the connection down mid-market over a frame we simply do not use.
 */
export const liveFrameSchema = z.union([
  z.object({
    event: z.literal('quotes'),
    quotes: z.array(quoteSchema).default([]),
  }),
  z.object({
    event: z.literal('status'),
    carrying: z.boolean().default(false),
    broker: z.string().optional(),
    dropped: z.unknown().optional(),
    message: z.string().optional(),
  }),
  z.object({
    event: z.literal('pong'),
    t: z.number().optional(),
  }),
]);

export type Instrument = z.infer<typeof instrumentSchema>;
export type Feed = z.infer<typeof feedSchema>;
export type Quote = z.infer<typeof quoteSchema>;
export type LiveFrame = z.infer<typeof liveFrameSchema>;
export type StraddlePoint = z.infer<typeof straddlePointSchema>;
export type StraddleHistory = z.infer<typeof straddleHistoryResponse>;
export type BandGreeksPoint = z.infer<typeof bandGreeksPointSchema>;
export type BandGreeks = z.infer<typeof bandGreeksResponse>;
export type RiskReversalPoint = z.infer<typeof riskReversalPointSchema>;
export type RiskReversal = z.infer<typeof riskReversalResponse>;
