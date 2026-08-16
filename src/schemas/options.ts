/**
 * `POST /api/options/marks` — live price and implied vol per contract.
 *
 * ── Why this route exists at all ──
 *
 * A position book says what you hold; it does not say what it is worth forward.
 * Pricing a payoff or a greek needs an implied vol per leg, and NO BROKER
 * REPORTS ONE — Angel, Zerodha and Kotak all return a last traded price and
 * nothing else. Nubra does publish IV, so this route is the join: legs
 * identified by canonical key from one broker's book, valued with another
 * broker's vol.
 *
 * ── The nulls are the point ──
 *
 * `iv: null` is a real, common answer and must never be defaulted to zero. A leg
 * with no vol cannot be valued before expiry at all, and a zero vol prices every
 * option at intrinsic — which looks like a plausible number and is not one.
 * `ivSource` says where a vol came from so a fed vol and a locally solved one
 * are never presented as equally good.
 */

import { z } from 'zod';

export const optionMarkSchema = z
  .object({
    /** `keyOf(InstrumentKey)` — `NSE:NIFTY:OPT:2026-08-28:24500:CE`. */
    key: z.string(),
    ltp: z.number().nullable().default(null),
    /** Decimal (0.13 = 13%), matching black76.ts. */
    iv: z.number().nullable().default(null),
    ivSource: z.literal('feed').nullable().default(null),
    ts: z.number().nullable().default(null),
  })
  .passthrough();

/**
 * Note `status: true` even when nothing could be priced.
 *
 * A feed that cannot serve these contracts is not a failed request: the expiry
 * payoff needs no vol at all and is still exactly correct. The route says so in
 * `warning` rather than 500-ing, and the panel surfaces that text instead of
 * showing an error where a usable chart belongs.
 */
export const optionMarksResponse = z
  .object({
    status: z.literal(true),
    date: z.string().default(''),
    marks: z.array(optionMarkSchema).default([]),
    warning: z.string().optional(),
    code: z.string().optional(),
  })
  .passthrough();

export type OptionMark = z.infer<typeof optionMarkSchema>;
