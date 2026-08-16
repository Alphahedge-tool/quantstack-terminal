/**
 * The implied-volatility surface, as `/api/options/surface` serves it.
 *
 * Parsed at the edge like every other response, but with one difference worth
 * stating: almost every numeric field here is `.nullable()` rather than
 * defaulted to zero.
 *
 * That is not defensive noise. A missing IV and an IV of zero are opposite
 * claims — one says the chain had no usable quote at that strike, the other
 * says the market prices it at no volatility at all. `compareSurfaces` counts
 * on the difference: it reports a pair with a null side as unmatched, which is
 * how "the chain does not reach OTM5 on this leg" reaches the screen instead of
 * a confident 0.00% and a spread invented from it. Defaulting these to 0 would
 * turn every gap in the data into a fabricated extreme reading.
 */

import { z } from 'zod';

/** One listed contract on one side of one strike. */
export const surfaceRowSchema = z.object({
  strike: z.number(),
  side: z.enum(['CE', 'PE']),
  /** DECIMAL, not percent — 0.086 is 8.6% vol. `ivPercent` does the ×100. */
  iv: z.number().nullable().default(null),
  delta: z.number().nullable().default(null),
  ltp: z.number().nullable().default(null),
  /** Signed strike-steps from ATM. Negative is below the money. */
  steps: z.number().default(0),
  /** Canonical symbol, the join key to a live tick. */
  symbol: z.string().default(''),
});

export const underlyingRefSchema = z.object({
  key: z.object({
    exchange: z.string().default(''),
    asset: z.string().default(''),
    kind: z.enum(['SPOT', 'FUT', 'OPT']).catch('SPOT'),
    expiry: z.string().nullish(),
    strike: z.number().nullish(),
    side: z.enum(['CE', 'PE']).nullish(),
  }),
  symbol: z.string().default(''),
});

export const surfaceResponse = z.object({
  symbol: z.string().default(''),
  exchange: z.string().default(''),
  expiry: z.string().default(''),
  date: z.string().default(''),
  spot: z.number().default(0),
  /**
   * The market's implied forward from put-call parity.
   *
   * Optional because an older cached response may predate the field. Callers
   * fall back to spot and are wrong in a specific way — see the note on
   * `Surface.forward` in `lib/options/ivArbitrage.ts`.
   */
  forward: z.number().nullish(),
  forwardFromParity: z.boolean().nullish(),
  basis: z.number().nullish(),
  atmStrike: z.number().default(0),
  /** The strike ladder's increment. 50 for NIFTY, 100 for BANKNIFTY. */
  step: z.number().default(50),
  /** Time to expiry in YEARS, as the pricer wants it. */
  years: z.number().default(0),
  underlying: underlyingRefSchema.nullish(),
  rows: z.array(surfaceRowSchema).default([]),
});

export const expiriesResponse = z.object({
  symbol: z.string().default(''),
  exchange: z.string().default(''),
  expiries: z.array(z.string()).default([]),
});

export const assetSearchResponse = z.object({
  instruments: z
    .array(
      z.object({
        asset: z.string().default(''),
        exchange: z.string().default(''),
        kind: z.string().default(''),
        lot: z.number().nullish(),
        expiries: z.array(z.string()).nullish(),
      }),
    )
    .default([]),
});

export type SurfaceResponse = z.infer<typeof surfaceResponse>;
export type AssetSearchResponse = z.infer<typeof assetSearchResponse>;
