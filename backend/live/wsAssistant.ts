/**
 * `/ws/assistant` — the IRIS channel.
 *
 * Protocol (JSON both ways, one message per frame):
 *
 *   → { type: 'ask',    id?, text }
 *   → { type: 'cancel', id }              barge-in: stop speaking, drop the turn
 *   → { type: 'ping' }
 *
 *   ← { event: 'hello',    sessionId, name }
 *   ← { event: 'thinking', id }
 *   ← { event: 'reply',    ...Reply }
 *   ← { event: 'alert',    alert: AlertEvent }
 *   ← { event: 'watches',  watches: WatchSummary[] }
 *   ← { event: 'pong',     t }
 *
 * ── Why a socket and not POST /ask ──
 *
 * Alerts. A watch fires minutes or hours after the request that created it, and
 * there is no request left to answer on. The same connection that carries the
 * conversation carries the alerts, so the client needs one channel and one
 * reconnect story rather than a request path plus an SSE path that can
 * disagree about whether the user is still there.
 *
 * ── Session identity ──
 *
 * Each connection mints its own conversation id. That is intentional: two
 * browser tabs are two conversations, and context bleeding between them ("what
 * about 25100" resolving against the OTHER tab's symbol) would be baffling.
 * Watches outlive the connection that made them and are keyed by this id only
 * for routing alerts — `listWatches` deliberately falls back to showing all of
 * them, so a reload never looks like data loss.
 *
 * ── Turn serialisation ──
 *
 * One in-flight turn per connection. A second `ask` while one is running is
 * queued behind it rather than run concurrently, because both would read and
 * write the same conversation memory and the interleaving would scramble it.
 * Voice makes this common: users talk over the reply.
 */

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { ask, endConversation, onAlert, startAssistant } from '../assistant/index.js';
import { IRIS_NAME } from '../assistant/types.js';
import { watchesFor, allWatches } from '../assistant/monitor/watchStore.js';
import { summarize } from '../assistant/monitor/engine.js';

export const ASSISTANT_PATH = '/ws/assistant';

const PING_MS = 20_000;
const PING_TOLERANCE = 2;

/** Longest utterance accepted. Anything past this is a paste, not a question. */
const MAX_TEXT = 500;

let nextSession = 1;

export function attachAssistantSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== ASSISTANT_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    const sessionId = `s${nextSession++}_${Date.now().toString(36)}`;
    let missedPings = 0;
    let closed = false;

    /** Turn currently running, so the next one can chain onto it. */
    let queue: Promise<void> = Promise.resolve();
    /** Turns the client cancelled — their replies are dropped, not sent. */
    const cancelled = new Set<string>();

    const send = (payload: unknown) => {
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    // The monitor is started on first connection rather than at boot: a
    // terminal nobody has opened does not need to hold chain subscriptions, and
    // starting here means the very first client also restores persisted
    // watches.
    startAssistant();

    const stopAlerts = onAlert((alert) => {
      // Every connection sees every alert. Watches survive reloads and a user
      // who refreshed still expects to hear about the watch they set, but that
      // session id no longer exists — filtering by it would silently mute them.
      send({ event: 'alert', alert });
    });

    send({ event: 'hello', sessionId, name: IRIS_NAME });
    sendWatches();

    function sendWatches(): void {
      const mine = watchesFor(sessionId);
      send({ event: 'watches', watches: summarize(mine.length ? mine : allWatches()) });
    }

    ws.on('message', (data: Buffer) => {
      let msg: { type?: string; id?: string; text?: string };
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }

      if (msg.type === 'ping') { send({ event: 'pong', t: Date.now() }); return; }

      if (msg.type === 'cancel') {
        if (msg.id) cancelled.add(msg.id);
        return;
      }

      if (msg.type === 'watches') { sendWatches(); return; }

      if (msg.type !== 'ask') return;

      const text = String(msg.text ?? '').slice(0, MAX_TEXT).trim();
      if (!text) return;
      const id = String(msg.id ?? `r_${Date.now().toString(36)}`);

      send({ event: 'thinking', id });

      queue = queue.then(async () => {
        if (closed || cancelled.has(id)) { cancelled.delete(id); return; }
        try {
          const reply = await ask(text, { sessionId, id });
          // A turn cancelled mid-flight — the user barged in — must not speak
          // its answer over whatever they said next.
          if (cancelled.has(id)) { cancelled.delete(id); return; }
          send({ event: 'reply', ...reply });

          // Any turn that could have changed the watch set republishes it, so
          // the UI's watch panel never drifts from the engine's truth.
          if (reply.intent.startsWith('watch.')) sendWatches();
        } catch (err) {
          send({
            event: 'reply',
            id,
            intent: 'unknown',
            confidence: 0,
            error: true,
            text: `Something went wrong: ${(err as Error).message}`,
            speak: 'Sorry, something went wrong.',
          });
        }
      });
    });

    const heartbeat = setInterval(() => {
      if (missedPings > PING_TOLERANCE) { ws.terminate(); return; }
      missedPings += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    heartbeat.unref?.();

    ws.on('pong', () => { missedPings = 0; });

    ws.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      stopAlerts();
      // Releases chains this conversation was holding for its own questions.
      // Watch-backed chains are unaffected — they belong to the watch, not the
      // socket, which is what lets alerts keep firing after the tab closes.
      endConversation(sessionId);
    });
  });

  console.log(`[ws/assistant] ${IRIS_NAME} listening on ${ASSISTANT_PATH}`);
}
