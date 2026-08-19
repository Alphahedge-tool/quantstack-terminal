/**
 * Expiry cockpit routes:
 *   GET /api/expiry/state   ?symbol=&exchange=&expiry=
 *   GET /api/expiry/status  → what is being watched and recorded
 *
 * ── Why polling and not a socket ──
 *
 * The state this serves is derived from a chain that publishes about once a
 * second, and every figure on it is a rate measured over minutes. Pushing that
 * at socket speed would deliver twenty updates for every one that changes a
 * number the reader can act on, and it would need its own reconnect, backfill
 * and gap handling — the machinery `wsStraddle` already has, for a series where
 * a missed tick is a hole in a chart rather than a slightly stale gauge.
 *
 * So the cockpit polls, and this route is cheap on purpose: the store is
 * already subscribed and already has the answer, so a request is a read of
 * memory plus a JSON encode. The one expensive call is the FIRST, which
 * acquires a cold chain.
 */

import { route, ApiError } from '../server.js';
import { expiryState, expiryStats } from '../expiry/session.js';
import { replayExpiry } from '../expiry/replay.js';
import { activeFeed } from '../feeds/access.js';
import { latestTradingDate } from '../engine/rollingStraddle.js';

// GET /api/expiry/state
route('GET', '/api/expiry/state', async (_req, _res, { query }) => {
  const symbol   = String(query.get('symbol') || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  let   expiry   = String(query.get('expiry') || '').trim();

  if (!symbol) throw new ApiError('symbol is required', 400);

  /*
   * An absent expiry means the FRONT one, resolved here rather than by the
   * caller.
   *
   * The cockpit is about the contract that is expiring, and on any given day
   * that is a fact about the exchange calendar, not a preference. Making the
   * page pick it would mean the page owning a rule it cannot check — and on a
   * Thursday afternoon, picking the wrong one shows a chain with three days of
   * life in it under a heading that says expiry.
   */
  if (!expiry) {
    const feed = await activeFeed();
    const expiries = await feed.expiries(symbol, exchange, latestTradingDate());
    if (!expiries.length) throw new ApiError(`No expiries listed for ${exchange} ${symbol}`, 404);
    expiry = expiries[0];
  }

  const state = await expiryState(exchange, symbol, expiry);
  return { status: true, ...state };
});

// GET /api/expiry/replay?symbol=&exchange=&expiry=&date=
//
// The same cockpit over a session that has already happened. Slower than
// `/state` by two orders of magnitude — it walks ~42 contracts across a whole
// session — so it is a separate route rather than a parameter on the live one,
// and the frontend can show the difference in its loading state.
route('GET', '/api/expiry/replay', async (_req, _res, { query }) => {
  const symbol   = String(query.get('symbol') || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const date     = String(query.get('date') || '').trim();
  let   expiry   = String(query.get('expiry') || '').trim();

  if (!symbol) throw new ApiError('symbol is required', 400);
  if (!date)   throw new ApiError('date is required (YYYY-MM-DD)', 400);

  /*
   * An absent expiry means the one that was FRONT on that date.
   *
   * Resolved against the date being replayed, not against today: asking today's
   * front expiry of a session three weeks ago names a contract that had a month
   * of life left, which is a chain worth looking at and not the expiry day the
   * caller asked for.
   */
  if (!expiry) {
    const feed = await activeFeed();
    const expiries = await feed.expiries(symbol, exchange, date);
    if (!expiries.length) throw new ApiError(`No expiries for ${exchange} ${symbol} on ${date}`, 404);
    expiry = expiries[0];
  }

  const result = await replayExpiry({ symbol, exchange, expiry, date });
  return { status: true, ...result };
});

// GET /api/expiry/status
route('GET', '/api/expiry/status', () => {
  const watching = expiryStats();
  return {
    status: true,
    watching,
    // The recorder is the only part of this feature that accumulates something
    // irreplaceable — OI history the broker does not serve. Surfaced here so a
    // day of silent write failures is visible before the research needs it.
    recorded: watching.reduce((sum, w) => sum + Math.max(0, w.recorded), 0),
  };
});
