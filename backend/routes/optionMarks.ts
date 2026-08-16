/**
 * Live marks and implied vol for a set of contracts.
 *
 *   POST /api/options/marks   { keys: InstrumentKey[], date? }
 *        → { marks: [{ key, ltp, iv, ts }] }
 *
 * ── Why this exists ──
 *
 * A position book says what you hold; it does not say what it is worth forward.
 * Pricing a payoff or a greek needs an implied vol per leg, and NO BROKER
 * REPORTS ONE. Angel, Zerodha and Kotak all return a position's last traded
 * price and nothing else.
 *
 * Nubra does publish IV — `ivBid` / `ivAsk` / `ivMid` come back on its option
 * series, which is why its `capabilities.greeks` is true and the other three
 * adapters' are false. So this route is the join: legs identified by canonical
 * symbol from one broker's book, valued with another broker's vol.
 *
 * That join only works because both sides address instruments structurally
 * (feeds/identity.ts). A broker token could not cross the gap.
 *
 * ── Solving instead of reading ──
 *
 * When the feed carries no IV for a contract, the caller falls back to solving
 * it from the mark (`src/lib/options/payoff.ts` → `backfillIv`). That is a
 * genuinely worse number — an illiquid strike with a stale print yields a stale
 * vol — so this route reports WHERE each vol came from rather than blending the
 * two silently.
 */

import { route, readJSON, ApiError } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { keyOf, type InstrumentKey } from '../feeds/identity.js';
import { latestTradingDate, sessionRange } from '../engine/rollingStraddle.js';
import { FeedError } from '../feeds/errors.js';

interface MarkRequest {
  keys?: InstrumentKey[];
  /** Trading date, ISO. Defaults to the most recent session. */
  date?: string;
}

export interface OptionMark {
  key: string;
  ltp: number | null;
  /** Decimal (0.13 = 13%), matching analytics/black76.ts. */
  iv: number | null;
  /** Where `iv` came from — never blended without saying so. */
  ivSource: 'feed' | null;
  ts: number | null;
}

/** Last finite value in a series, or null. Series arrive ascending by time. */
function lastOf(points: Array<{ ts: number; v: number }> | undefined): { v: number; ts: number } | null {
  if (!points?.length) return null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const p = points[i];
    if (Number.isFinite(p.v) && p.v > 0) return { v: p.v, ts: p.ts };
  }
  return null;
}

/**
 * Mid implied vol, derived from the two sides — NOT read from `ivMid`.
 *
 * `OptionSeries` has an `ivMid` field and it is always empty, which cost a live
 * debugging session to find. `QUOTE_FIELDS` in lib/nubraData.ts asks the feed
 * for `l1bid, l1ask, iv_bid, iv_ask, close` — `iv_mid` is not in that list, so
 * `sd?.iv_mid` is undefined on every row and `ivMid` parses to `[]`.
 *
 * The two sides ARE fetched, and their average is what a mid vol means anyway.
 * One-sided quotes fall back to whichever side exists rather than returning
 * nothing: a deep OTM strike often has an ask vol and no bid, and half an
 * answer beats refusing to price the leg.
 */
function midIv(series: { ivBid?: Array<{ ts: number; v: number }>; ivAsk?: Array<{ ts: number; v: number }> }):
  { v: number; ts: number } | null {
  const bid = lastOf(series.ivBid);
  const ask = lastOf(series.ivAsk);

  if (bid && ask) return { v: (bid.v + ask.v) / 2, ts: Math.max(bid.ts, ask.ts) };
  return bid ?? ask ?? null;
}

route('POST', '/api/options/marks', async (req) => {
  const body = await readJSON<MarkRequest>(req);
  const keys = Array.isArray(body.keys) ? body.keys : [];

  if (!keys.length) throw new ApiError('keys is required', 400);
  if (keys.length > 200) throw new ApiError('too many keys (max 200)', 400);

  const date = String(body.date || latestTradingDate()).trim();
  const feed = await activeFeed();

  // Options only. A future has no vol and a spot leg has no contract; asking
  // the feed for their option series would just produce empty rows.
  const optionKeys = keys.filter((k) => k.kind === 'OPT');
  const marks = new Map<string, OptionMark>(
    keys.map((k) => [keyOf(k), { key: keyOf(k), ltp: null, iv: null, ivSource: null, ts: null }]),
  );

  if (!optionKeys.length) return { status: true, date, marks: [...marks.values()] };

  // The whole session rather than a trailing window: outside market hours a
  // "last 30 minutes" range returns nothing at all, and a position book is read
  // after the close at least as often as during it.
  const { start, end } = sessionRange(date, String(optionKeys[0].exchange || 'NSE'));

  try {
    const result = await feed.optionSeries({
      keys: optionKeys,
      interval: '1m',
      from: start,
      to: end,
    });

    for (const key of optionKeys) {
      const id = keyOf(key);
      const series = result.series.get(id);
      if (!series) continue;

      const ltp = lastOf(series.ltp) ?? lastOf(series.bid);
      const iv = midIv(series);

      marks.set(id, {
        key: id,
        ltp: ltp?.v ?? null,
        iv:  iv?.v ?? null,
        ivSource: iv ? 'feed' : null,
        ts: iv?.ts ?? ltp?.ts ?? null,
      });
    }
  } catch (err) {
    // A feed that cannot serve these contracts is not a failed request — the
    // caller can still draw the expiry payoff, which needs no vol at all. Say
    // so in the body instead of 500-ing the panel.
    const fe = err instanceof FeedError ? err : null;
    return {
      status: true,
      date,
      marks: [...marks.values()],
      warning: `No implied vol available: ${(err as Error).message}`,
      code: fe?.code ?? 'INTERNAL',
    };
  }

  return { status: true, date, marks: [...marks.values()] };
});
