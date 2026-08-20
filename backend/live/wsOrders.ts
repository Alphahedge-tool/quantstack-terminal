/**
 * `/ws/live/orders` — live order updates, pushed instead of polled.
 *
 * Protocol (JSON both ways, one message per frame):
 *
 *   → { type: 'ping' }
 *
 *   ← { event: 'status', broker, state, message? }   state: connected | disconnected | stopped
 *   ← { event: 'order',  broker, order }             one normalised Order
 *   ← { event: 'pong', t }
 *
 * ── What this is FOR ──
 *
 * The books used to poll: positions every 5s, orders every 10s. That was not a
 * tuning choice — Angel caps getOrderBook and getPosition at one request per
 * second each, and the backend queues rather than rejects, so polling harder
 * just makes every book arrive late. The cost is that a fill is invisible for up
 * to a full interval, and a multi-leg exit spends that interval rendering a
 * position book that never existed.
 *
 * So the browser fetches each book ONCE and this channel tells it when something
 * actually changed. The REST call becomes the thing that reconciles, not the
 * thing that discovers.
 *
 * ── One upstream socket, many tabs ──
 *
 * Angel counts order sockets per CLIENT CODE and allows three. A socket per tab
 * would exhaust that with three tabs open, and the fourth would be refused a
 * connection that the account is genuinely entitled to. So the upstream socket
 * is per broker and shared: it opens when the first tab asks and closes after
 * the last one leaves, with a grace period so a reload does not churn it.
 */

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { Order } from '../trading/types.js';
import { brokers } from '../trading/registry.js';
import { AngelTrading } from '../trading/adapters/angel.js';
import { AngelOrderStream, type StreamFault } from '../trading/orderStream/angel.js';

import { logger } from '../lib/logger.js';
import { wsConnections, wsMessages } from '../lib/metrics.js';

const log = logger('ws/orders');

export const LIVE_ORDERS_PATH = '/ws/live/orders';

/** Metrics label for this socket. One of a fixed set — see lib/metrics.ts. */
const CHANNEL = 'orders';

/**
 * How long the upstream sockets stay up with no browser attached.
 *
 * A page reload drops and re-adds a client within a second or two. Tearing the
 * broker sockets down for that would spend one of Angel's three connection
 * slots on every refresh, and the reconnect is not instant.
 */
const GRACE_MS = Number(process.env.QT_ORDERS_GRACE_MS || 30_000);

const PING_MS = 20_000;
const PING_TOLERANCE = 2;

type Sink = (payload: unknown) => void;

interface BrokerStream {
  stream: AngelOrderStream;
  state:  'connected' | 'disconnected' | 'stopped';
  fault?: StreamFault;
}

const subscribers = new Set<Sink>();
const streams = new Map<string, BrokerStream>();
let idleTimer: NodeJS.Timeout | null = null;

function broadcast(payload: unknown): void {
  for (const send of subscribers) {
    try { send(payload); } catch { /* one slow client must not stall the rest */ }
  }
}

/**
 * Open an upstream socket per broker that can carry one.
 *
 * Only Angel today. Zerodha's postback needs a public URL and Kotak's order
 * socket is unverified against a live account, so both stay on the REST book
 * rather than shipping a stream that silently delivers nothing.
 */
function startStreams(): void {
  if (streams.size) return;

  for (const broker of brokers()) {
    if (!(broker instanceof AngelTrading)) continue;

    const stream = new AngelOrderStream(broker.feed);
    const entry: BrokerStream = { stream, state: 'disconnected' };
    streams.set(broker.id, entry);

    stream.open({
      onOrder: (order: Order) => {
        broadcast({ event: 'order', broker: broker.id, order });
      },
      onStatus: (state, fault) => {
        entry.state = state;
        entry.fault = fault;
        broadcast({
          event: 'status', broker: broker.id, state, message: fault?.message,
        });
      },
    });
  }

  if (!streams.size) log.info('no broker can carry an order stream');
}

function stopStreams(): void {
  for (const { stream } of streams.values()) stream.close();
  streams.clear();
}

export function attachLiveOrdersSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    // Not ours — leave the socket alone for the other upgrade handlers.
    if (url.pathname !== LIVE_ORDERS_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    wsConnections.inc({ channel: CHANNEL });
    ws.on('close', () => wsConnections.dec({ channel: CHANNEL }));

    let missedPings = 0;

    const send: Sink = (payload) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(payload));
      wsMessages.inc({ channel: CHANNEL, direction: 'out' });
    };

    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    subscribers.add(send);
    startStreams();

    // Tell the joining tab what it is joining, so its status pill is correct
    // immediately rather than reading "offline" until the next order happens.
    for (const [id, entry] of streams) {
      send({ event: 'status', broker: id, state: entry.state, message: entry.fault?.message });
    }

    ws.on('message', (data: Buffer) => {
      wsMessages.inc({ channel: CHANNEL, direction: 'in' });
      let msg: { type?: string };
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
      if (msg.type === 'ping') send({ event: 'pong', t: Date.now() });
    });

    // Protocol-level ping: the browser answers these in its network stack, so
    // they keep working while a background tab's JavaScript is throttled, and
    // they are the only way this side learns a socket is dead rather than idle.
    const heartbeat = setInterval(() => {
      if (missedPings > PING_TOLERANCE) { ws.terminate(); return; }
      missedPings += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    heartbeat.unref?.();

    ws.on('pong', () => { missedPings = 0; });

    ws.on('close', () => {
      clearInterval(heartbeat);
      subscribers.delete(send);
      if (subscribers.size) return;

      // Nobody watching. Hold the broker sockets briefly — the usual reason a
      // client vanishes is a reload, and reconnecting costs one of Angel's
      // three per-account slots plus the handshake.
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (subscribers.size === 0) stopStreams();
      }, GRACE_MS);
      idleTimer.unref?.();
    });
  });

  log.info({ path: LIVE_ORDERS_PATH }, 'orders socket listening');
}
