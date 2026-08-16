/**
 * Background health prober.
 *
 * The router already recovers a feed opportunistically: the first request after
 * a cooldown claims the HALF_OPEN probe. That covers a busy system, but not a
 * quiet one — if nothing is requested between 09:20 and 09:50, a feed that
 * recovered at 09:21 stays marked dead for half an hour, and the failover you
 * see in the UI is stale.
 *
 * This closes that gap: every interval, probe the feeds that are NOT closed.
 * Healthy feeds are never probed, so the steady-state cost is zero.
 */

import { canAttempt, recordFailure, recordSuccess, stateOf } from './breaker.js';
import { ensureConnected } from './authManager.js';
import { classify } from './errors.js';
import { feeds } from './registry.js';

const INTERVAL_MS = Number(process.env.QT_FEED_HEALTH_INTERVAL_MS || 30_000);

let timer: NodeJS.Timeout | null = null;

async function probeOnce(): Promise<void> {
  for (const { feed } of feeds()) {
    if (stateOf(feed.id) === 'CLOSED') continue;
    // canAttempt claims the single HALF_OPEN slot; if a real request already
    // holds it, skip rather than probe in parallel.
    if (!canAttempt(feed.id)) continue;

    try {
      await ensureConnected(feed);
      await feed.ping();
      recordSuccess(feed.id);
      console.log(`[health] ${feed.id} recovered`);
    } catch (err) {
      const fe = classify(err, feed.id);
      // An AUTH failure means the SESSION is dead, not that the broker is down.
      // Leaving it in place is self-defeating: `isConnected()` stays true, so
      // the `ensureConnected` above no-ops on every future probe, the ping fails
      // the same way forever, and the breaker this loop exists to reopen never
      // closes. Dropping it lets the next probe log in for real.
      if (fe.code === 'AUTH') await feed.disconnect().catch(() => { /* already gone */ });
      recordFailure(feed.id, fe.message);
    }
  }
}

export function startHealthProbe(): void {
  if (timer) return;
  timer = setInterval(() => { void probeOnce(); }, INTERVAL_MS);
  // Never hold the process open for a probe loop.
  timer.unref?.();
  console.log(`[health] probing degraded feeds every ${INTERVAL_MS / 1000}s`);
}

export function stopHealthProbe(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Probe now, regardless of schedule. Used by /api/feeds and by tests. */
export const probeNow = probeOnce;
