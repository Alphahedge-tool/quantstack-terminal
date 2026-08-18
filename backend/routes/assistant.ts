/**
 * IRIS REST surface.
 *
 *   GET    /api/assistant/status     engine + monitor health
 *   GET    /api/assistant/watches    every watch, with live readings
 *   DELETE /api/assistant/watches    cancel by id (?id=) or all (?all=1)
 *   POST   /api/assistant/watches    pause/resume  { id, paused }
 *   GET    /api/assistant/alerts     recent fires
 *   POST   /api/assistant/ask        one turn, for clients without a socket
 *
 * ── Why these exist alongside the socket ──
 *
 * The socket is the conversation. These are for everything that is not a
 * conversation: a settings panel listing watches, a health check, a curl during
 * debugging. Splitting them means the socket protocol stays about turns and
 * alerts rather than growing a CRUD dialect.
 *
 * `POST /ask` is the exception and is deliberately limited — it answers one
 * turn and cannot deliver alerts, so it is a fallback and a test hook, not the
 * supported path.
 */

import { route, readJSON, ApiError } from '../server.js';
import { ask, monitorStats, chainStats, recentAlerts } from '../assistant/index.js';
import {
  allWatches, removeWhere, setPaused, getWatch,
} from '../assistant/monitor/watchStore.js';
import { summarize, reconcileChains } from '../assistant/monitor/engine.js';
import { getSession } from '../lib/sessionStore.js';
import { IRIS_NAME } from '../assistant/types.js';

route('GET', '/api/assistant/status', () => ({
  status: true,
  name:   IRIS_NAME,
  ...monitorStats(),
  liveChains: chainStats(),
}));

route('GET', '/api/assistant/watches', () => ({
  status:  true,
  watches: summarize(allWatches()),
}));

route('DELETE', '/api/assistant/watches', async (_req, _res, { query }) => {
  const id  = query.get('id');
  const all = query.get('all') === '1';

  if (!id && !all) throw new ApiError('Pass ?id=<watchId> or ?all=1', 400);

  const gone = removeWhere((w) => (all ? true : w.id === id));
  // Dropping a watch may free the last consumer of a chain; reconciling here
  // releases it rather than leaving a python process streaming for nobody.
  const session = getSession();
  if (session) await reconcileChains(session);

  return { status: true, cancelled: gone.length, ids: gone.map((w) => w.id) };
});

route('POST', '/api/assistant/watches', async (req) => {
  const body = await readJSON<{ id?: string; paused?: boolean }>(req);
  if (!body.id) throw new ApiError('id is required', 400);
  if (typeof body.paused !== 'boolean') throw new ApiError('paused must be a boolean', 400);

  if (!getWatch(body.id)) throw new ApiError(`No watch ${body.id}`, 404);
  setPaused(body.id, body.paused);

  const session = getSession();
  if (session) await reconcileChains(session);

  return { status: true, id: body.id, paused: body.paused };
});

route('GET', '/api/assistant/alerts', (_req, _res, { query }) => {
  const limit = Math.min(200, Math.max(1, Number(query.get('limit') || 50)));
  return { status: true, alerts: recentAlerts(undefined, limit) };
});

route('POST', '/api/assistant/ask', async (req) => {
  const body = await readJSON<{ text?: string; sessionId?: string }>(req);
  const text = String(body.text ?? '').trim();
  if (!text) throw new ApiError('text is required', 400);

  // A caller with no session id gets a throwaway conversation, so REST callers
  // never share context by accident. Pass a stable one to keep follow-ups.
  const sessionId = body.sessionId || `rest_${Date.now().toString(36)}`;
  const reply = await ask(text, { sessionId });
  return { status: true, sessionId, reply };
});
