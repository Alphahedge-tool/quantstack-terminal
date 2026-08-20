/**
 * Instrument routes:
 *   GET /api/instruments/search   ?q=&exchange=
 *   GET /api/instruments/expiries ?symbol=&exchange=&date=
 *   GET /api/instruments/status   → cache statistics
 */

import { route, ApiError } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { searchEligible, cacheStats, warmExchange } from '../lib/instrumentCache.js';
import { hasParquet, searchAssetsParquet } from '../lib/parquetStore.js';
import { getSession } from '../lib/sessionStore.js';
import { latestTradingDate } from '../engine/rollingStraddle.js';

import { logger } from '../lib/logger.js';

const log = logger('instruments');

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
  /*
   * Parquet first, and it usually answers.
   *
   * The store is written on every login warm and holds every asset with a live
   * expiry, so this path serves the symbol picker without loading a single
   * instrument master into memory — the JSON route below reads 33 MB per
   * exchange and keeps 23 MB of it resident per date.
   *
   * It is a fast path, not a replacement: a fresh install has no parquet until
   * the first warm converts one, and `null` means exactly that. Anything else
   * falls through.
   */
  const fromParquet = hasParquet(exchange || 'NSE')
    ? await searchAssetsParquet(q, exchange, limit).catch((e) => {
      log.warn(`parquet search failed, using the JSON path: ${(e as Error).message}`);
      return null;
    })
    : null;

  if (fromParquet?.length) {
    return { status: true, count: fromParquet.length, instruments: fromParquet, source: 'parquet' };
  }

  const wanted = exchange ? [exchange] : feed.capabilities.exchanges;
  const date   = latestTradingDate();
  const session = getSession();
  await Promise.allSettled(
    wanted.map((ex) => (
      // `feed.assets` only guarantees the exchanges in WARM_EXCHANGES are
      // loaded, so an exchange outside that list answers "no results" for
      // symbols that do exist — which is what the symbol picker's search would
      // report for BSE if the warm list were ever narrowed. `warmExchange`
      // loads the slot actually being searched; both are no-ops once cached.
      session
        ? warmExchange(ex, date, session).catch(() => feed.assets(ex, date))
        : feed.assets(ex, date)
    )),
  );

  const results = searchEligible(q, exchange, limit);
  return { status: true, count: results.length, instruments: results, source: 'json' };
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
