/**
 * Per-feed circuit breaker.
 *
 * Three states, and the one that matters most is HALF_OPEN — it is the half of
 * failover that most designs omit. Without it a feed that blips for ten seconds
 * at 09:20 stays dead until someone notices and restarts the process.
 *
 *   CLOSED ──(N consecutive faults)──▶ OPEN
 *   OPEN ──(cooldown elapses)──▶ HALF_OPEN
 *   HALF_OPEN ──(probe succeeds)──▶ CLOSED
 *   HALF_OPEN ──(probe fails)──▶ OPEN, cooldown doubled
 *
 * Only faults count. A capability mismatch (UNSUPPORTED) or missing data
 * (NOT_FOUND) must never trip a breaker — see FeedError.countsAsFailure.
 */

import type { FeedId } from './types.js';

import { logger } from '../lib/logger.js';

const log = logger('breaker');

export type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

const THRESHOLD    = Number(process.env.QT_FEED_BREAKER_THRESHOLD   || 3);
const COOLDOWN_MS  = Number(process.env.QT_FEED_BREAKER_COOLDOWN_MS || 30_000);
const COOLDOWN_MAX = Number(process.env.QT_FEED_BREAKER_MAX_MS      || 300_000);

interface Entry {
  state:        BreakerState;
  failures:     number;
  cooldown:     number;   // current backoff length, ms
  openedAt:     number;
  lastError:    string | null;
  /** True while a HALF_OPEN probe is in flight, so only one is allowed. */
  probing:      boolean;
  trips:        number;   // lifetime count, for diagnostics
  lastStateAt:  number;
}

const entries = new Map<FeedId, Entry>();

function entryOf(id: FeedId): Entry {
  let e = entries.get(id);
  if (!e) {
    e = {
      state: 'CLOSED', failures: 0, cooldown: COOLDOWN_MS, openedAt: 0,
      lastError: null, probing: false, trips: 0, lastStateAt: Date.now(),
    };
    entries.set(id, e);
  }
  return e;
}

function transition(id: FeedId, e: Entry, to: BreakerState): void {
  if (e.state === to) return;
  log.info({ feed: id, from: e.state, to }, 'breaker state changed');
  e.state = to;
  e.lastStateAt = Date.now();
}

/**
 * Whether the router may send this call to the feed.
 *
 * Has a side effect by design: an OPEN feed whose cooldown has elapsed moves to
 * HALF_OPEN here, and the single probe slot is claimed by the caller that sees
 * it. That keeps the recovery attempt on the normal request path — no separate
 * scheduler needed for the common case.
 */
export function canAttempt(id: FeedId): boolean {
  const e = entryOf(id);

  if (e.state === 'CLOSED') return true;

  if (e.state === 'OPEN') {
    if (Date.now() - e.openedAt < e.cooldown) return false;
    transition(id, e, 'HALF_OPEN');
    e.probing = true;
    return true;
  }

  // HALF_OPEN: exactly one probe at a time.
  if (e.probing) return false;
  e.probing = true;
  return true;
}

export function recordSuccess(id: FeedId): void {
  const e = entryOf(id);
  e.probing   = false;
  e.failures  = 0;
  e.lastError = null;
  e.cooldown  = COOLDOWN_MS;      // reset the ladder, not just the state
  transition(id, e, 'CLOSED');
}

export function recordFailure(id: FeedId, reason: string): void {
  const e = entryOf(id);
  e.lastError = reason;

  // A failed probe re-opens immediately and waits longer next time — retrying a
  // sick feed every 30s forever is its own kind of outage.
  if (e.state === 'HALF_OPEN') {
    e.probing  = false;
    e.cooldown = Math.min(e.cooldown * 2, COOLDOWN_MAX);
    e.openedAt = Date.now();
    e.trips++;
    transition(id, e, 'OPEN');
    return;
  }

  e.failures++;
  if (e.failures >= THRESHOLD) {
    e.openedAt = Date.now();
    e.trips++;
    transition(id, e, 'OPEN');
    log.warn(
      { feed: id, failures: e.failures, cooldownSec: Math.round(e.cooldown / 1000), reason },
      'breaker opened — feed parked',
    );
  }
}

export function stateOf(id: FeedId): BreakerState {
  const e = entries.get(id);
  if (!e) return 'CLOSED';
  // Report the state a caller would actually get, without claiming the probe.
  if (e.state === 'OPEN' && Date.now() - e.openedAt >= e.cooldown) return 'HALF_OPEN';
  return e.state;
}

export function status(id: FeedId) {
  const e = entryOf(id);
  const cooldownLeft = e.state === 'OPEN'
    ? Math.max(0, e.cooldown - (Date.now() - e.openedAt))
    : 0;
  return {
    state:        stateOf(id),
    failures:     e.failures,
    trips:        e.trips,
    cooldownMs:   e.cooldown,
    cooldownLeft,
    lastError:    e.lastError,
    since:        e.lastStateAt,
  };
}

/** Force a feed back into rotation — the manual override behind /api/feeds. */
export function reset(id: FeedId): void {
  entries.delete(id);
}

export function resetAll(): void {
  entries.clear();
}
