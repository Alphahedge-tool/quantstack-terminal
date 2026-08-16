/**
 * Instrument routes:
 *   GET /api/instruments/search   ?q=&exchange=
 *   GET /api/instruments/expiries ?symbol=&exchange=&date=
 *   GET /api/instruments/status   → cache statistics
 */

import { route, ApiError } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { searchEligible, cacheStats } from '../lib/instrumentCache.js';
import { latestTradingDate } from '../engine/rollingStraddle.js';

// GET /api/instruments/search?q=&exchange=
route('GET', '/api/instruments/search', async (_req, _res, { query }) => {
  const feed     = await activeFeed();
  const q        = query.get('q') || '';
  const exchange = query.get('exchange') || '';
  const limit    = Math.min(100, Math.max(1, Number(query.get('limit')) || 50));

  // The cache fills in the background after login, so a search in the first few
  // seconds would otherwise answer "no results" for symbols that do exist.
  //
  // An empty `exchange` means "search everything", which the router cannot take
  // literally — it matches a feed on the exchange asked for, and no feed
  // carries "". So it is expanded to every exchange the feed does carry.
  // allSettled, not all: one exchange being unavailable must not blank the
  // whole search.
  const wanted = exchange ? [exchange] : feed.capabilities.exchanges;
  await Promise.allSettled(
    wanted.map((ex) => feed.assets(ex, latestTradingDate())),
  );

  const results = searchEligible(q, exchange, limit);
  return { status: true, count: results.length, instruments: results };
});

// GET /api/instruments/expiries?symbol=&exchange=&date=
route('GET', '/api/instruments/expiries', async (_req, _res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = query.get('symbol');
  const exchange = query.get('exchange') || 'NSE';
  const date     = query.get('date')     || latestTradingDate();

  if (!symbol) throw new ApiError('symbol is required', 400);

  const expiries = await feed.expiries(symbol, exchange, date);
  return { status: true, symbol, exchange, date, expiries };
});

// GET /api/instruments/status
route('GET', '/api/instruments/status', () => {
  return { status: true, ...cacheStats() };
});
