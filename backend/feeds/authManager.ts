/**
 * Per-feed session lifecycle.
 *
 * The one rule this file exists to enforce: **one login at a time, per feed.**
 *
 * ROLLING_CONCURRENCY is 4 and a straddle session needs 7-9 batches, so an
 * expired session does not produce one 401 — it produces a burst of them,
 * simultaneously, each of which wants to re-login. Eight concurrent TOTP logins
 * against one account is how you get rate-limited or locked out. Everyone
 * therefore awaits the SAME promise.
 *
 * Failed logins back off. A wrong TOTP secret is permanent until a human fixes
 * it, and retrying it every request would turn one misconfiguration into a
 * login storm against the broker.
 */

import { FeedError, classify } from './errors.js';
import type { FeedId, MarketDataFeed } from './types.js';

import { logger } from '../lib/logger.js';
import { feedLogins } from '../lib/metrics.js';

const log = logger('auth');

/** Backoff ladder after a failed connect. Capped, not unbounded. */
const BACKOFF_MS = [30_000, 60_000, 300_000, 900_000];

interface AuthState {
  inFlight?:    Promise<void>;
  lastError?:   FeedError;
  failures:     number;
  retryAfter:   number;   // epoch ms; 0 = may try now
  connectedAt:  number;
}

const state = new Map<FeedId, AuthState>();

function stateOf(id: FeedId): AuthState {
  let s = state.get(id);
  if (!s) {
    s = { failures: 0, retryAfter: 0, connectedAt: 0 };
    state.set(id, s);
  }
  return s;
}

/**
 * Ensure `feed` is connected, logging in if it is not.
 *
 * Concurrent callers share one login. Returns normally when the feed is usable
 * and throws a FeedError with code AUTH when it is not — the router treats that
 * as "this feed is unavailable" and moves on to the next one.
 */
export function ensureConnected(feed: MarketDataFeed): Promise<void> {
  const s = stateOf(feed.id);

  if (feed.isConnected()) {
    // Clear lastError too. Leaving it set made /api/feeds report a healthy feed
    // alongside a stale "credentials missing" — which sends you debugging a
    // login that already succeeded, while the real fault is somewhere else.
    s.failures   = 0;
    s.retryAfter = 0;
    s.lastError  = undefined;
    if (!s.connectedAt) s.connectedAt = Date.now();
    return Promise.resolve();
  }

  // Still serving a backoff window — fail fast rather than hammering the broker.
  if (s.retryAfter > Date.now()) {
    const wait = Math.ceil((s.retryAfter - Date.now()) / 1000);
    return Promise.reject(new FeedError(
      'AUTH',
      `${feed.id} login failed ${s.failures}× — retrying in ${wait}s`
      + (s.lastError ? ` (last: ${s.lastError.message})` : ''),
      { feedId: feed.id },
    ));
  }

  // ── the single-flight ──
  if (s.inFlight) return s.inFlight;

  s.inFlight = feed.connect()
    .then(() => {
      s.failures    = 0;
      s.retryAfter  = 0;
      s.lastError   = undefined;
      s.connectedAt = Date.now();
      feedLogins.inc({ feed: feed.id, outcome: 'success' });
      log.info({ feed: feed.id }, 'feed connected');
    })
    .catch((err) => {
      const fe = classify(err, feed.id);
      s.failures  += 1;
      s.lastError  = fe;
      s.retryAfter = Date.now()
        + BACKOFF_MS[Math.min(s.failures - 1, BACKOFF_MS.length - 1)];
      feedLogins.inc({ feed: feed.id, outcome: 'failure' });
      log.error({ feed: feed.id, failures: s.failures, code: fe.code, retryAfter: s.retryAfter }, fe.message);
      throw fe;
    })
    .finally(() => { s.inFlight = undefined; });

  return s.inFlight;
}

/**
 * Run `fn` against a connected feed, re-authenticating once if the session
 * turns out to be dead mid-request.
 *
 * The retry is deliberately single: if a fresh login still yields AUTH, the
 * credentials are wrong and looping would only burn TOTP attempts.
 */
export async function withAuth<T>(
  feed: MarketDataFeed,
  fn: () => Promise<T>,
): Promise<T> {
  await ensureConnected(feed);
  try {
    return await fn();
  } catch (err) {
    const fe = classify(err, feed.id);
    if (fe.code !== 'AUTH') throw fe;

    feedLogins.inc({ feed: feed.id, outcome: 'reauth' });
    log.warn({ feed: feed.id }, 'session rejected mid-request — re-authenticating');
    await feed.disconnect().catch(() => { /* already gone */ });
    await ensureConnected(feed);
    return fn();
  }
}

/** Drop a feed's session and its backoff history. */
export async function signOut(feed: MarketDataFeed): Promise<void> {
  state.delete(feed.id);
  await feed.disconnect();
}

/** Status for /api/feeds and diagnostics. */
export function authStatus(id: FeedId) {
  const s = state.get(id);
  return {
    connectedAt: s?.connectedAt || null,
    failures:    s?.failures ?? 0,
    retryAfter:  s?.retryAfter || null,
    lastError:   s?.lastError?.message ?? null,
    loggingIn:   Boolean(s?.inFlight),
  };
}

/** Test seam — forget all auth state. */
export function resetAuth(): void {
  state.clear();
}
