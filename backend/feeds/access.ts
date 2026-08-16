/**
 * How a route gets a feed.
 *
 * This is the replacement for `requireSession()`. The difference is the whole
 * point of the layer: `requireSession()` threw when there was no session and
 * left the caller stuck until someone POSTed /api/nubra/login. `activeFeed()`
 * logs in instead — once, no matter how many requests arrive at the same
 * moment — and returns something usable.
 *
 * Phase 4 replaces the body of this with the FeedRouter, which will also pick
 * BETWEEN feeds. Routes will not need to change when it does: they already ask
 * for "a feed that works" rather than for Nubra.
 */

import { ensureConnected } from './authManager.js';
import { primaryFeed, feeds } from './registry.js';
import { router } from './router.js';
import { FeedError } from './errors.js';
import type { MarketDataFeed } from './types.js';

/**
 * The feed a route should use: the router, which stands in for all of them.
 *
 * Note it does NOT connect anything here. Connection is per-call and per-feed
 * inside the router, because deciding up front which feed to log into would
 * defeat failover — the right feed to authenticate is the one that ends up
 * serving the request, and that is not known until the request is routed.
 *
 * `activeFeed()` stays async because it was, and because a future router may
 * need to await configuration.
 */
export async function activeFeed(): Promise<MarketDataFeed> {
  if (!feeds().length) {
    throw new FeedError('INTERNAL', 'No data feeds configured — set QT_FEEDS', {});
  }
  return router;
}

/**
 * Eagerly connect every feed — used at boot, and by POST /api/feeds/:id/login.
 *
 * Failures are returned rather than thrown: one dead broker must not stop the
 * others from coming up.
 */
export async function connectAll(): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
  return Promise.all(feeds().map(async ({ feed }) => {
    try {
      await ensureConnected(feed);
      return { id: feed.id, ok: true };
    } catch (err) {
      return { id: feed.id, ok: false, error: (err as Error).message };
    }
  }));
}

/**
 * The highest-priority feed WITHOUT connecting it.
 *
 * For status endpoints, which must report "logged out" rather than trigger a
 * login as a side effect of being asked.
 */
export function currentFeed(): MarketDataFeed {
  return primaryFeed();
}
