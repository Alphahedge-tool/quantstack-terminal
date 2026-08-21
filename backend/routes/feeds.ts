/**
 * Feed control plane:
 *   GET  /api/feeds                → every feed, its health and its session
 *   POST /api/feeds/login          { id? }  connect one feed, or all
 *   POST /api/feeds/logout         { id? }  drop a session
 *   POST /api/feeds/reset          { id }   force a tripped breaker closed
 *   GET  /api/feeds/probe          run the health probe now
 *
 * These exist so a failover is observable. A router that silently switches
 * brokers is worse than one that does not switch at all: when two feeds price
 * the same straddle slightly differently, "which one am I looking at?" has to
 * have an answer.
 */

import { route, readJSON, ApiError, getPort } from '../server.js';
import { goComputeStatus } from '../lib/computeClient.js';
import { goEngineStatus } from '../lib/engineClient.js';
import { feeds, feedById } from '../feeds/registry.js';
import { authStatus, ensureConnected, signOut } from '../feeds/authManager.js';
import { status as breakerStatus, reset as breakerReset } from '../feeds/breaker.js';
import { connectAll } from '../feeds/access.js';
import { probeNow } from '../feeds/health.js';
import { liveRouter } from '../feeds/liveRouter.js';
import { instruments } from '../instruments/store.js';

function describe() {
  return feeds().map(({ feed, priority, broker, instance }) => ({
    id:        feed.id,
    broker,
    instance:  instance ?? null,
    priority,
    connected: feed.isConnected(),
    breaker:   breakerStatus(feed.id),
    auth:      authStatus(feed.id),
    capabilities: feed.capabilities,
  }));
}

// GET /api/feeds
route('GET', '/api/feeds', () => {
  const all = describe();
  return {
    status:  true,
    count:   all.length,
    // The feed that would serve the next request, so the UI can name it
    // without replaying the router's selection rules.
    serving: all.find((f) => f.breaker.state !== 'OPEN' && f.connected)?.id ?? null,
    feeds:   all,
  };
});

// POST /api/feeds/login  { id? }
route('POST', '/api/feeds/login', async (req) => {
  const { id } = await readJSON<{ id?: string }>(req);

  if (!id) {
    const results = await connectAll();
    return { status: results.some((r) => r.ok), results };
  }

  const feed = feedById(id);
  if (!feed) throw new ApiError(`Unknown feed: ${id}`, 404);
  await ensureConnected(feed);
  return { status: true, id, connected: feed.isConnected() };
});

// POST /api/feeds/logout  { id? }
route('POST', '/api/feeds/logout', async (req) => {
  const { id } = await readJSON<{ id?: string }>(req);

  if (!id) {
    await Promise.all(feeds().map(({ feed }) => signOut(feed)));
    return { status: true, message: 'All feeds signed out' };
  }

  const feed = feedById(id);
  if (!feed) throw new ApiError(`Unknown feed: ${id}`, 404);
  await signOut(feed);
  return { status: true, id };
});

// POST /api/feeds/reset  { id }
// Manual override for a breaker that is open — e.g. the broker confirmed the
// outage is over and you would rather not wait out the cooldown.
route('POST', '/api/feeds/reset', async (req) => {
  const { id } = await readJSON<{ id?: string }>(req);
  if (!id) throw new ApiError('id is required', 400);
  if (!feedById(id)) throw new ApiError(`Unknown feed: ${id}`, 404);
  breakerReset(id);
  return { status: true, id, breaker: breakerStatus(id) };
});

// GET /api/feeds/probe
route('GET', '/api/feeds/probe', async () => {
  await probeNow();
  return { status: true, feeds: describe() };
});

// ── live tick channel ────────────────────────────────────────────────────────
//
// The live socket is routed independently of REST: a broker can be perfectly
// able to answer a candle request while its tick stream is dead, and pinning the
// two together would take working history down with a broken WebSocket.

// GET /api/feeds/live — who is serving ticks, and the recent switch history.
route('GET', '/api/feeds/live', () => ({ status: true, live: liveRouter.status() }));

// POST /api/feeds/live/pin  { id? }
// Hold the tick stream on one broker, or pass no id to release it back to
// automatic selection. Exists so two feeds pricing the same straddle
// differently can be compared one at a time.
route('POST', '/api/feeds/live/pin', async (req) => {
  const { id } = await readJSON<{ id?: string }>(req);
  try {
    await liveRouter.pin(id ?? null);
  } catch (err) {
    throw new ApiError((err as Error).message, 404);
  }
  return { status: true, live: liveRouter.status() };
});

// POST /api/feeds/live/rotate — drop the current tick feed and pick another.
route('POST', '/api/feeds/live/rotate', async () => {
  await liveRouter.rotate('manual');
  return { status: true, live: liveRouter.status() };
});

// GET /api/instruments/status — canonical master coverage, per broker.
route('GET', '/api/instruments/status', () => ({
  status: true,
  brokers: instruments.status(),
}));

/**
 * GET /api/services — is the whole stack actually wired together?
 *
 * `npm run dev:all` starts four processes, and three of them can be running
 * perfectly while the backend talks to none of them: the sidecars are opt-in
 * through `QT_GO_COMPUTE` / `QT_GO_ENGINE`, so a stack where the flags did not
 * reach the API child looks completely healthy and is simply doing all the work
 * in Node. That failure is invisible from every other endpoint.
 *
 * `goComputeStatus()` and `goEngineStatus()` were both written for a health
 * route that did not exist yet. This is it.
 *
 *   enabled  the backend was told to use it
 *   healthy  the last probe succeeded — null means it has not been asked yet,
 *            which is the normal state until the first batch needs it
 */
route('GET', '/api/services', () => ({
  status: true,
  api: { port: getPort(), pid: process.pid },
  compute: goComputeStatus(),
  engine: goEngineStatus(),
}));
