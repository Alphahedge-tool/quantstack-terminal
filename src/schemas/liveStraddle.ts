/**
 * Frames on `/ws/live/straddle`.
 *
 * Protocol, from `backend/live/wsStraddle.ts`:
 *
 *   → { type: 'subscribe', symbol, exchange, expiry, atmHint?, since? }
 *   → { type: 'resume', since }
 *   → { type: 'ping' } | { type: 'stop' }
 *   ← { event: 'point',    point, roll? }
 *   ← { event: 'backfill', points, rolls, complete }
 *   ← { event: 'status',   status, message? }
 *   ← { event: 'error',    message, code? }
 *   ← { event: 'pong',     t }
 *
 * ── Why the point schema is the historical one ──
 *
 * A live point and a walked one are the SAME shape, because the backend applies
 * the same cheapest-of-band rule to both. That is the whole reason the live line
 * can be appended to the loaded session rather than drawn as a second series —
 * so this reuses `straddlePointSchema` instead of declaring a parallel type that
 * could drift from it.
 */

import { z } from 'zod';
import { straddlePointSchema } from '@/schemas/market';

export const liveRollSchema = z.object({
  time: z.number(),
  fromStrike: z.number().nullable().default(null),
  toStrike: z.number().nullable().default(null),
});

const pointFrame = z.object({
  event: z.literal('point'),
  point: straddlePointSchema,
  roll: liveRollSchema.nullish(),
});

const backfillFrame = z.object({
  event: z.literal('backfill'),
  points: z.array(straddlePointSchema).default([]),
  rolls: z.array(liveRollSchema).default([]),
  /**
   * False when the backend could not account for everything since `since`.
   *
   * Not a detail to default away: it is the ONLY signal that a hole exists which
   * the socket cannot close, and the caller's correct response is to reload the
   * session from history. Defaulting it to `true` would leave a silent gap in
   * the middle of the chart.
   */
  complete: z.boolean().default(true),
});

const statusFrame = z.object({
  event: z.literal('status'),
  status: z.string().default(''),
  message: z.string().nullish(),
});

const errorFrame = z.object({
  event: z.literal('error'),
  message: z.string().default('Live error'),
  code: z.string().nullish(),
});

const pongFrame = z.object({ event: z.literal('pong'), t: z.number().nullish() });

export const liveStraddleFrame = z.discriminatedUnion('event', [
  pointFrame, backfillFrame, statusFrame, errorFrame, pongFrame,
]);

export type LiveStraddleFrame = z.infer<typeof liveStraddleFrame>;
export type LiveRoll = z.infer<typeof liveRollSchema>;

/**
 * Parse one frame, or null for anything this channel does not model.
 *
 * Null rather than throwing, because `LiveSocket` treats null as "ignore" — and
 * it has to. The backend is free to add event types, and a throw here would
 * drop a healthy connection over a frame we simply do not read yet.
 */
export function parseLiveStraddleFrame(raw: unknown): LiveStraddleFrame | null {
  const result = liveStraddleFrame.safeParse(raw);
  return result.success ? result.data : null;
}
