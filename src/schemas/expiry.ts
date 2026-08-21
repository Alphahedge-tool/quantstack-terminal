/**
 * The expiry cockpit's payload.
 *
 * Everything on this page comes from ONE endpoint — `/api/expiry/state` — which
 * is deliberate. The regime, the pressure score, the ladder and the series are
 * all derived from the same chain snapshot at the same instant, and splitting
 * them across routes would let the panels disagree about what minute they are
 * describing. A dashboard whose gauge and whose ladder are one poll apart is
 * worse than one that updates a second later.
 */

import { z } from 'zod';

const num = z.number().nullable().default(null);

/** One contract, as the ladder carries it. */
export const expiryLegSchema = z
  .object({
    strike: z.number(),
    side: z.string(),
    ltp: z.number().optional(),
    iv: z.number().optional(),
    oi: z.number().optional(),
    prevOi: z.number().optional(),
    volume: z.number().optional(),
    gamma: z.number().optional(),
    delta: z.number().optional(),
  })
  .passthrough();

/**
 * How OI moved against price on this leg.
 *
 * An INFERENCE, not an observation — the exchange publishes neither who traded
 * nor which side opened. Typed as a union anyway so the UI cannot invent a
 * fifth label that the backend never emits.
 */
export const oiFlowSchema = z.enum([
  'writing', 'short-covering', 'long-build', 'long-unwind', 'flat',
]);
export type OiFlow = z.infer<typeof oiFlowSchema>;

export const expiryRungSchema = z.object({
  strike: z.number(),
  call: expiryLegSchema.nullable().default(null),
  put: expiryLegSchema.nullable().default(null),
  callOi: z.number().default(0),
  putOi: z.number().default(0),
  totalOi: z.number().default(0),
  callOiChange: z.number().default(0),
  putOiChange: z.number().default(0),
  callGex: z.number().default(0),
  putGex: z.number().default(0),
  netGex: z.number().default(0),
  callFlow: oiFlowSchema.default('flat'),
  putFlow: oiFlowSchema.default('flat'),
});
export type ExpiryRung = z.infer<typeof expiryRungSchema>;

export const expiryBarSchema = z.object({
  time: z.number(),
  spot: num,
  atmStrike: num,
  straddle: num,
  iv: num,
  skew: num,
  syntheticFuture: num,
  netGex: num,
  gammaFlip: num,
  callWall: num,
  putWall: num,
  callOi: num,
  putOi: num,
  volume: num,
  expectedMovePct: num,
  realizedVolPct: num,
});
export type ExpiryBar = z.infer<typeof expiryBarSchema>;

export const regimeSchema = z.enum([
  'pin', 'compression', 'expansion', 'trend', 'whipsaw', 'unknown',
]);
export type Regime = z.infer<typeof regimeSchema>;

export const pressureSchema = z.object({
  score: z.number().default(0),
  components: z
    .array(z.object({
      key: z.string(),
      label: z.string(),
      score: z.number().default(0),
      detail: z.string().default(''),
    }))
    .default([]),
});

export const migrationSchema = z.object({
  side: z.string(),
  from: num,
  to: num,
  steps: z.number().default(0),
});

export const expiryStateResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    exchange: z.string().default(''),
    expiry: z.string().default(''),
    lot: z.number().default(0),
    updatedAt: z.number().default(0),
    minutesToExpiry: num,
    live: z.boolean().default(false),
    spot: num,
    atmStrike: num,
    straddle: num,
    iv: num,
    skew: num,
    syntheticFuture: num,
    expectedMovePct: num,
    realizedVolPct: num,
    netGex: num,
    gammaFlip: num,
    callWall: num,
    putWall: num,
    maxPain: num,
    regime: regimeSchema.default('unknown'),
    regimeNote: z.string().default(''),
    pressure: pressureSchema.default({ score: 0, components: [] }),
    migration: z.array(migrationSchema).default([]),
    ladder: z.array(expiryRungSchema).default([]),
    bars: z.array(expiryBarSchema).default([]),
    recorded: z.number().default(0),
  })
  .passthrough();

export type ExpiryState = z.infer<typeof expiryStateResponse>;

/**
 * A session that has already happened, rebuilt from history.
 *
 * Deliberately NOT the same schema as the live state, even though the page
 * renders both through one shape. A replay has no socket, no `live` flag and no
 * chain-published spot — its forward comes from put-call parity — and giving
 * the two one type would let a replay be mistaken for a live view by any code
 * that only checked the fields they share. `source` and `gammaSource` are the
 * fields that keep them distinguishable.
 */
export const expiryReplayResponse = z
  .object({
    status: z.literal(true),
    symbol: z.string().default(''),
    exchange: z.string().default(''),
    expiry: z.string().default(''),
    date: z.string().default(''),
    source: z.literal('replay'),
    /** Whether gamma came from the feed or was priced from Black-76 — the feed
     *  carries it for about a month, OI for at least six. */
    gammaSource: z.enum(['feed', 'black76', 'mixed', 'none']).default('none'),
    contracts: z.number().default(0),
    minutesToExpiry: num,
    callWall: num,
    putWall: num,
    maxPain: num,
    regime: regimeSchema.default('unknown'),
    regimeNote: z.string().default(''),
    pressure: pressureSchema.default({ score: 0, components: [] }),
    migration: z.array(migrationSchema).default([]),
    ladder: z.array(expiryRungSchema).default([]),
    bars: z.array(expiryBarSchema).default([]),
    tookMs: z.number().default(0),
  })
  .passthrough();

export type ExpiryReplay = z.infer<typeof expiryReplayResponse>;

/* ── Live cockpit frames (`/ws/expiry`) ───────────────────────────────────── */

/**
 * Server → client frames for the live cockpit.
 *
 * The `state` frame is the REST body minus its `status: true` envelope — the
 * socket carries the event name instead, and reusing the same shape here is
 * what lets the page render a pushed frame and a polled response through one
 * code path.
 *
 * Every state frame is the whole state except `bars`, which arrives as a tail
 * to be spliced — the series reaches ~147 KB by 15:30 and gains one minute at a
 * time, so resending it every second would be most of the wire. There is still
 * no backfill and no gap handling: a fresh socket is sent a full series, so a
 * reconnect heals itself. Unmodelled events parse to null and are skipped
 * rather than thrown over, same rule as the quote channel — the server may add
 * frames this build does not read.
 */
export const expiryFrameSchema = z.union([
  expiryStateResponse.omit({ status: true }).extend({
    event: z.literal('state'),
    /**
     * How to apply `bars` — see wsExpiry.ts.
     *
     * `barsFull` true means `bars` is the whole series; false means it is the
     * tail starting at `barsFrom` and the client splices. Both DEFAULT to a
     * full replace, so a frame from a server that does not send them is handled
     * as a plain whole-state update rather than silently mis-splicing.
     */
    barsFrom: z.number().default(0),
    barsFull: z.boolean().default(true),
  }),
  z.object({
    event: z.literal('status'),
    status: z.string(),
    message: z.string().optional(),
  }),
  z.object({
    event: z.literal('error'),
    message: z.string().default('Expiry feed error'),
    code: z.string().optional(),
  }),
  z.object({
    event: z.literal('pong'),
    t: z.number().optional(),
  }),
]);

export type ExpiryFrame = z.infer<typeof expiryFrameSchema>;
