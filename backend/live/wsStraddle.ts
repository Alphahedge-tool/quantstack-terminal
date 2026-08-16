/**
 * `/ws/live/straddle` — the live tick channel for the straddle chart.
 *
 * Protocol (JSON both ways, one message per frame):
 *
 *   → { type: 'subscribe', symbol, exchange, expiry, atmHint?, since? }
 *   → { type: 'resume', since }
 *   → { type: 'ping' }
 *   → { type: 'stop' }
 *
 *   ← { event: 'status',   status, message? }
 *   ← { event: 'point',    point, roll? }      one computed StraddlePoint
 *   ← { event: 'backfill', points, rolls, complete }
 *   ← { event: 'pong', t }
 *   ← { event: 'error',    message, code? }
 *
 * Structured as an upgrade handler rather than a route because server.ts's route
 * table is request/response — the same split Alphahedge's server.js uses.
 *
 * ── Why a session outlives the socket that asked for it ────────────────────
 *
 * The feed only ever sends the present, so anything a client is not connected
 * for is lost to it permanently. That used to be fine because a client was
 * assumed to be watching, but the case that matters most is the opposite one: a
 * tab left in the background for an hour, whose socket the OS, the browser or an
 * intermediary quietly dropped somewhere in the middle. Tearing the live session
 * down the moment that socket closed meant the reconnect respawned the python
 * bridge, waited seconds for depth to arm, and started emitting from *now* —
 * with the intervening minutes missing from the live feed and from the chart.
 *
 * So a session is keyed by contract, not by connection:
 *
 *   • Subscribers fan out from one session, so N tabs on the same contract cost
 *     one bridge instead of N.
 *   • Losing the last subscriber starts a GRACE_MS timer rather than a stop, so
 *     the session keeps computing across a reconnect and the client's `since`
 *     replays the hole out of the engine's retained window.
 *   • `complete: false` on that replay is the honest answer when the gap is
 *     older than the window: the client refills from history instead.
 *
 * A `stop` from a client is still a stop — it means "I am done", not "I dropped"
 * — but only of that client's own subscription; the session goes when nobody is
 * left and the grace period expires.
 */

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { requireSession } from '../lib/sessionStore.js';
import {
  startLiveStraddle, isMarketOpen, msUntilClose, type LiveStraddleHandle,
} from '../engine/liveStraddle.js';

export const LIVE_STRADDLE_PATH = '/ws/live/straddle';

/**
 * How long a session with no subscribers keeps running.
 *
 * Long enough to cover a reconnect that has to wait out a laptop waking up or a
 * network coming back, short enough that a closed tab does not hold a broker
 * subscription for the rest of the session.
 */
const GRACE_MS = Number(process.env.QT_LIVE_GRACE_MS || 120_000);

/**
 * Protocol-level ping interval, and the number of missed rounds tolerated.
 *
 * These are WebSocket control frames, not application messages: the browser
 * answers them in its network stack, so they keep working — and keep NAT and
 * proxy idle timers alive — while the tab's JavaScript is throttled to a crawl
 * in the background. They are also the only way this side learns that a socket
 * is dead rather than quiet.
 */
const PING_MS       = 20_000;
const PING_TOLERANCE = 2;

interface ClientMsg {
  type:      string;
  symbol?:   string;
  exchange?: string;
  expiry?:   string;
  atmHint?:  number;
  since?:    number;
}

/** One live engine, shared by every socket watching the same contract. */
interface Session {
  key:         string;
  live:        LiveStraddleHandle | null;
  /** Sockets currently attached. Emissions fan out to all of them. */
  subscribers: Set<(payload: unknown) => void>;
  /** Fires when the last subscriber has been gone for GRACE_MS. */
  idleTimer:   NodeJS.Timeout | null;
  /** Market close, which ends the session regardless of who is watching. */
  closeTimer:  NodeJS.Timeout | null;
  /** Set while startLiveStraddle is in flight, so a second subscribe waits. */
  starting:    Promise<void> | null;
}

const sessions = new Map<string, Session>();

function sessionKey(symbol: string, exchange: string, expiry: string): string {
  return `${exchange}|${symbol}|${expiry}`;
}

function endSession(s: Session): void {
  if (s.idleTimer)  { clearTimeout(s.idleTimer);  s.idleTimer  = null; }
  if (s.closeTimer) { clearTimeout(s.closeTimer); s.closeTimer = null; }
  s.live?.stop();
  s.live = null;
  sessions.delete(s.key);
}

export function attachLiveStraddleSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    // Not ours — leave the socket alone. Destroying it here would break any
    // other upgrade handler added later (Next HMR proxies one through in dev).
    if (url.pathname !== LIVE_STRADDLE_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    /** The session this socket is attached to, and its own sink into it. */
    let joined: Session | null = null;
    let missedPings = 0;

    const send = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    /** Detach from the shared session without ending it for anyone else. */
    const leave = () => {
      const s = joined;
      joined = null;
      if (!s) return;
      s.subscribers.delete(send);
      if (s.subscribers.size > 0) return;
      // Nobody left. Keep computing for a while: the usual reason a client
      // vanishes is a dropped connection, and the point of the grace period is
      // that the reconnect finds the session still running and its window
      // still holding what was missed.
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.idleTimer = setTimeout(() => {
        if (s.subscribers.size === 0) endSession(s);
      }, GRACE_MS);
    };

    /** An explicit client stop ends the session for that client outright. */
    const stopForClient = () => {
      const s = joined;
      leave();
      if (s && s.subscribers.size === 0) endSession(s);
    };

    const attach = (s: Session) => {
      if (joined === s) return;
      leave();
      joined = s;
      s.subscribers.add(send);
      if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    };

    /**
     * Answer a client's `since` with what it missed.
     *
     * Sent before any further live point can reach this socket, so the client
     * sees the hole filled in order and never has to sort a merge.
     */
    const backfill = (s: Session, since: number | undefined) => {
      if (since == null || !Number.isFinite(since)) return;
      const replay = s.live?.replaySince(since);
      send({
        event:    'backfill',
        points:   replay?.points ?? [],
        rolls:    replay?.rolls  ?? [],
        // No session at all means nothing can be spoken for: incomplete, so the
        // client refills from history rather than splicing onto a stale tail.
        complete: replay?.complete ?? false,
      });
    };

    const subscribe = (msg: ClientMsg) => {
      const symbol   = String(msg.symbol   || '').trim().toUpperCase();
      const exchange = String(msg.exchange || 'NSE').trim().toUpperCase();
      const expiry   = String(msg.expiry   || '').trim();
      if (!symbol || !expiry) {
        send({ event: 'error', message: 'symbol and expiry are required' });
        return;
      }

      if (!isMarketOpen(exchange)) {
        send({ event: 'status', status: 'market-closed', message: `${exchange} is closed` });
        return;
      }

      const key = sessionKey(symbol, exchange, expiry);
      const existing = sessions.get(key);

      // The common reconnect: the session survived the drop, so this costs
      // nothing but a replay.
      if (existing) {
        attach(existing);
        const wait = existing.starting ?? Promise.resolve();
        void wait.then(() => {
          if (joined !== existing) return;   // moved on while starting
          send({ event: 'status', status: 'resumed', message: `${symbol} ${expiry}` });
          backfill(existing, msg.since);
        });
        return;
      }

      let session;
      try {
        session = requireSession();
      } catch (err) {
        send({ event: 'error', code: 'FEED_AUTH_REQUIRED', message: (err as Error).message });
        return;
      }

      const fresh: Session = {
        key, live: null, subscribers: new Set(), idleTimer: null, closeTimer: null,
        starting: null,
      };
      sessions.set(key, fresh);
      attach(fresh);

      // Emissions fan out to whoever is attached at the time, which is what
      // makes the session outlive any one of them.
      const fanout = (payload: unknown) => {
        for (const sink of fresh.subscribers) sink(payload);
      };

      fresh.starting = startLiveStraddle(
        { symbol, exchange, expiry, session, atmHint: msg.atmHint }, fanout,
      )
        .then((handle) => {
          // The session was already ended while the bridge was coming up —
          // nothing would ever call its stop().
          if (sessions.get(key) !== fresh) { handle.stop(); return; }
          fresh.live = handle;
          const untilClose = msUntilClose(exchange);
          if (untilClose > 0) {
            fresh.closeTimer = setTimeout(() => {
              fanout({ event: 'status', status: 'market-closed', message: 'Session ended' });
              endSession(fresh);
            }, untilClose);
          }
        })
        .catch((err: unknown) => {
          fanout({ event: 'error', message: (err as Error)?.message || 'Could not start live feed' });
          endSession(fresh);
        })
        .finally(() => { fresh.starting = null; });

      // A first subscribe carries the last historical bar as `since`. The window
      // is empty at that point, so this reports whether the join is clean rather
      // than replaying anything — see LiveStraddleHandle.replaySince.
      void fresh.starting.then(() => {
        if (joined === fresh) backfill(fresh, msg.since);
      });
    };

    ws.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString('utf8')) as ClientMsg;
      } catch {
        send({ event: 'error', message: 'Invalid JSON' });
        return;
      }

      switch (msg.type) {
        case 'subscribe':
          subscribe(msg);
          return;

        case 'resume':
          // The socket survived but the client thinks it may have missed
          // something — a tab coming back from the background asks this before
          // it trusts what is on screen.
          if (!joined) { send({ event: 'error', message: 'Not subscribed' }); return; }
          backfill(joined, msg.since);
          return;

        case 'ping':
          // Application-level, so a client can prove the round trip works and
          // not merely that its own socket object still says OPEN.
          send({ event: 'pong', t: Date.now() });
          return;

        case 'stop':
          stopForClient();
          send({ event: 'status', status: 'stopped' });
          return;

        default:
          send({ event: 'error', message: `Unknown command: ${msg.type}` });
      }
    });

    // A dropped client must not take the session with it — see the header.
    ws.on('close', leave);
    ws.on('error', leave);

    ws.on('pong', () => { missedPings = 0; });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (++missedPings > PING_TOLERANCE) {
        // Half-open: the TCP connection is gone but no FIN ever arrived. Only
        // terminate() reclaims it; close() would wait for a reply that is not
        // coming.
        ws.terminate();
        return;
      }
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    ws.on('close', () => clearInterval(heartbeat));
  });

  console.log(`[qt-backend] live straddle socket at ws://localhost:*${LIVE_STRADDLE_PATH}`);
}
