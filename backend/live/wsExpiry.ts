/**
 * `/ws/expiry` — the expiry cockpit channel.
 *
 * Protocol (JSON both ways, one message per frame):
 *
 *   → { type: 'subscribe', symbol, exchange?, expiry? }
 *   → { type: 'ping' }
 *
 *   ← { event: 'state',  ...ExpiryState }
 *   ← { event: 'status', status: 'subscribing' | 'subscribed', message? }
 *   ← { event: 'error',  message, code? }
 *   ← { event: 'pong',   t }
 *
 * ── Why this exists, given routes/expiry.ts argues against it ──
 *
 * That header's objection is right about resolution and wrong about the cost.
 * The chain publishes about once a second and most of the cockpit is rates
 * measured over minutes, so pushing every publish really would send twenty
 * frames for every one that moves a number worth reading. The answer is not to
 * go back to polling, though — it is to push on the chain's clock and throttle
 * to the reader's, which is what `MIN_INTERVAL_MS` below does.
 *
 * What the socket buys that the poll could not:
 *
 *   - the top line (spot, straddle, ATM) is as live as the feed rather than up
 *     to four seconds stale, which on expiry afternoon is the difference
 *     between watching a move and reading about it;
 *   - the server knows when the tab is gone, so a closed cockpit releases its
 *     chain immediately instead of after a three-minute idle timeout;
 *   - a cold chain reports `subscribing` and then delivers, instead of the page
 *     polling a `live: false` state every four seconds until it fills in.
 *
 * ── The one incremental part, and why ──
 *
 * Every frame carries the whole state EXCEPT the bar series, which is sent as a
 * tail. Measured on a live NIFTY chain, a frame is ~30 KB of ladder plus ~400 B
 * per bar — so by 15:30 a full-state frame is ~176 KB, of which ~147 KB is a
 * series that gained one minute and changed one value. At 1/s that is 1.4 Mbps
 * per tab, growing all session, for data the client already has.
 *
 * The rule is deliberately the smallest one that is correct:
 *
 *   barsFull: true   → `bars` IS the series. Replace.
 *   barsFull: false  → `bars` is the tail from index `barsFrom`. Splice.
 *
 * The tail starts one bar EARLIER than the client's last, because `sample()`
 * overwrites the current minute's bar on every publish — so the bar a client
 * already holds is precisely the one most likely to have changed.
 *
 * A full frame is sent whenever the socket cannot prove the client's series
 * lines up: first frame, contract change, or a series that got shorter (the
 * `MAX_BARS` shift). So a reconnect is still self-healing — a fresh socket has
 * sent nothing, so its first frame is full by construction. There is still no
 * `since` and no backfill.
 */

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import { watchExpiry, type ExpiryState } from '../expiry/session.js';
import { activeFeed } from '../feeds/access.js';
import { latestTradingDate } from '../engine/rollingStraddle.js';

export const EXPIRY_PATH = '/ws/expiry';

const PING_MS = 20_000;
const PING_TOLERANCE = 2;

/**
 * Floor on the gap between pushed frames.
 *
 * The chain publishes ~1/s and the state object carries the whole bar series,
 * so an unthrottled push is both more frames than a human reads and more JSON
 * than the wire needs. One second is the feed's own resolution, which is the
 * fastest rate at which anything here can actually change.
 *
 * The trailing edge matters: when a frame is suppressed the newest state is
 * held and sent when the window opens, so the client's last frame is never a
 * stale one that happened to win the race.
 */
const MIN_INTERVAL_MS = Number(process.env.QT_EXPIRY_PUSH_MS || 1_000);

interface ClientMsg {
  type?:     string;
  symbol?:   string;
  exchange?: string;
  expiry?:   string;
}

export function attachExpirySocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    // Not ours — leave the socket alone so the other channels can claim it.
    if (url.pathname !== EXPIRY_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    let missedPings = 0;
    let closed = false;
    /** Detaches the current subscription, if any. */
    let release: (() => void) | null = null;
    /**
     * Which subscribe call is current.
     *
     * Acquiring a cold chain takes seconds, and a user changing symbol twice in
     * that window would otherwise land two subscriptions whose frames interleave
     * on one socket. Every subscribe takes a token; a resolved acquire that no
     * longer holds the current token releases itself and stays silent.
     */
    let token = 0;

    let throttleTimer: NodeJS.Timeout | null = null;
    let lastSentAt = 0;
    let held: ExpiryState | null = null;

    /** Bars this socket has delivered, and the contract they belong to. */
    let sentBars = 0;
    let sentFor  = '';

    const send = (payload: unknown) => {
      if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
    };

    /**
     * Send one state frame, with the bar series reduced to what this socket is
     * missing.
     *
     * The bookkeeping happens HERE rather than where a frame is queued, because
     * the throttle drops intermediate states: counting a frame the socket never
     * sent would leave the client permanently one splice behind.
     */
    const emit = (state: ExpiryState) => {
      const key  = `${state.exchange}|${state.symbol}|${state.expiry}`;
      const bars = state.bars ?? [];

      // Anything that breaks the client's alignment forces a full series.
      const full = key !== sentFor || sentBars === 0 || bars.length < sentBars;
      sentFor  = key;
      const from = full ? 0 : Math.max(0, sentBars - 1);
      sentBars = bars.length;

      send({
        event: 'state',
        ...state,
        bars: full ? bars : bars.slice(from),
        barsFrom: from,
        barsFull: full,
      });
    };

    /** Send now if the window is open, otherwise hold the newest for the edge. */
    const push = (state: ExpiryState) => {
      const now = Date.now();
      const wait = MIN_INTERVAL_MS - (now - lastSentAt);
      if (wait <= 0) {
        lastSentAt = now;
        held = null;
        emit(state);
        return;
      }
      held = state;
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = null;
        if (held == null) return;
        lastSentAt = Date.now();
        const pending = held;
        held = null;
        emit(pending);
      }, wait);
      throttleTimer.unref?.();
    };

    const detach = () => {
      release?.();
      release = null;
      if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
      held = null;
      lastSentAt = 0;
      // Forget what the client holds: the next subscription's first frame must
      // carry the whole series, whatever contract it turns out to be for.
      sentBars = 0;
      sentFor  = '';
    };

    const subscribe = async (msg: ClientMsg) => {
      const symbol   = String(msg.symbol   || '').trim().toUpperCase();
      const exchange = String(msg.exchange || 'NSE').trim().toUpperCase();
      let   expiry   = String(msg.expiry   || '').trim();

      if (!symbol) {
        send({ event: 'error', message: 'symbol is required' });
        return;
      }

      const mine = ++token;
      detach();
      send({ event: 'status', status: 'subscribing', message: `${symbol} ${expiry || 'front expiry'}` });

      try {
        /*
         * An absent expiry means the FRONT one, resolved here for the same
         * reason routes/expiry.ts resolves it: the cockpit is about the contract
         * that is expiring, and which one that is comes from the exchange
         * calendar rather than from the page.
         */
        if (!expiry) {
          const feed = await activeFeed();
          const expiries = await feed.expiries(symbol, exchange, latestTradingDate());
          if (!expiries.length) throw new Error(`No expiries listed for ${exchange} ${symbol}`);
          expiry = expiries[0];
        }

        const sub = await watchExpiry(exchange, symbol, expiry, (state) => {
          if (token !== mine) return;
          push(state);
        });

        // Superseded or disconnected while the chain was coming up.
        if (token !== mine || closed) { sub.release(); return; }

        release = sub.release;
        send({ event: 'status', status: 'subscribed', message: `${symbol} ${expiry}` });
        // First frame goes out immediately rather than through the throttle:
        // the reader is looking at an empty cockpit until it lands. `sentBars`
        // is still 0 here, so `emit` correctly sends the whole series.
        lastSentAt = Date.now();
        emit(sub.state);
      } catch (err) {
        if (token !== mine) return;
        send({
          event: 'error',
          message: (err as Error)?.message || 'Could not watch that expiry',
        });
      }
    };

    ws.on('message', (raw: Buffer) => {
      let msg: ClientMsg;
      try { msg = JSON.parse(raw.toString('utf8')) as ClientMsg; } catch { return; }

      if (msg.type === 'ping') { send({ event: 'pong', t: Date.now() }); return; }
      if (msg.type === 'subscribe') { void subscribe(msg); return; }
    });

    const heartbeat = setInterval(() => {
      if (missedPings > PING_TOLERANCE) { ws.terminate(); return; }
      missedPings += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    heartbeat.unref?.();

    ws.on('pong', () => { missedPings = 0; });

    const teardown = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      // Releasing here is the point of the socket: the chain goes as soon as the
      // tab does, rather than after the poll path's three-minute idle timeout.
      detach();
    };

    ws.on('close', teardown);
    ws.on('error', teardown);
  });

  console.log(`[ws/expiry] cockpit listening on ${EXPIRY_PATH}`);
}
