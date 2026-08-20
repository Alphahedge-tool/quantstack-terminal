/**
 * `/ws/live/quotes` — live prices for an arbitrary set of contracts.
 *
 * Protocol (JSON both ways, one message per frame):
 *
 *   → { type: 'subscribe', keys: InstrumentKey[] }
 *   → { type: 'ping' }
 *
 *   ← { event: 'quotes', quotes: [{ symbol, ltp, bid?, ask?, iv?, ts }] }
 *   ← { event: 'status', carrying, broker? }
 *   ← { event: 'pong', t }
 *
 * ── Why this exists ──
 *
 * The position book's P&L was marked from the REST book, which meant it only
 * moved when the book was re-fetched. The order socket says when a position's
 * STRUCTURE changes — a leg opened, closed or flipped — but says nothing about
 * price, so on its own it leaves the P&L column frozen between fills. This is
 * the other half: the same contracts, priced continuously.
 *
 * Everything broker-specific is already handled by `liveRouter`, which picks a
 * feed that can actually carry the contracts and switches brokers mid-session
 * without the consumer noticing. So this file is only a fan-out and a throttle.
 *
 * ── Indexed by canonical symbol, not by key ──
 *
 * Frames carry `symbol` (NIFTY18AUG2624300CE) rather than a structural key.
 * That is exactly the field `/api/trading/positions` already puts on every row,
 * so the browser can join ticks to positions with a plain map lookup and needs
 * no key-encoding logic of its own — one less place for the two sides to
 * disagree about what identifies a contract.
 */

import type http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import type { InstrumentKey } from '../feeds/identity.js';
import type { Tick } from '../feeds/types.js';
import { liveRouter } from '../feeds/liveRouter.js';
import { instruments } from '../instruments/store.js';
import { symbolOf } from '../instruments/symbol.js';

import { logger } from '../lib/logger.js';
import { wsConnections, wsMessages } from '../lib/metrics.js';

const log = logger('ws/quotes');

export const LIVE_QUOTES_PATH = '/ws/live/quotes';

/** Metrics label for this socket. One of a fixed set — see lib/metrics.ts. */
const CHANNEL = 'quotes';

/**
 * Coalescing window.
 *
 * An option chain in a fast market prints far more often than a table can
 * usefully repaint, and every frame costs a React render across the whole book.
 * Ticks are collapsed to the latest price per contract and flushed on this
 * interval — the same knob the straddle feed uses.
 */
const THROTTLE_MS = Number(process.env.QT_LIVE_THROTTLE_MS || 250);

const PING_MS = 20_000;
const PING_TOLERANCE = 2;

interface Quote {
  symbol: string;
  ltp?:   number;
  bid?:   number;
  ask?:   number;
  /**
   * Implied vol as the FEED published it, decimal per the units convention in
   * feeds/types.ts (0.1048 = 10.48%).
   *
   * Forwarded rather than left for the browser to invert out of the premium. A
   * broker's own IV is quoted off the book, where a solved one can only be
   * struck from the last trade — so in a thin wing the two disagree by more
   * than the spreads this terminal is built to measure. Absent whenever the
   * carrying adapter does not publish one, which is the normal case; consumers
   * fall back to solving.
   */
  iv?:    number;
  ts:     number;
}

/** A key that arrived over the wire, validated enough to hand to the router. */
function toKey(raw: unknown): InstrumentKey | null {
  if (!raw || typeof raw !== 'object') return null;
  const k = raw as Record<string, unknown>;
  const exchange = String(k.exchange ?? '').trim();
  const asset    = String(k.asset ?? '').trim();
  const kind     = String(k.kind ?? '').trim();
  if (!exchange || !asset || !kind) return null;

  return {
    exchange,
    asset,
    kind: kind as InstrumentKey['kind'],
    expiry: k.expiry ? String(k.expiry) : undefined,
    strike: k.strike == null ? undefined : Number(k.strike),
    side:   k.side ? (String(k.side) as InstrumentKey['side']) : undefined,
  };
}

export function attachLiveQuotesSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== LIVE_QUOTES_PATH) return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws: WebSocket) => {
    wsConnections.inc({ channel: CHANNEL });
    ws.on('close', () => wsConnections.dec({ channel: CHANNEL }));

    let missedPings = 0;
    let unsubscribe: (() => void) | null = null;
    /** Latest price per symbol since the last flush. */
    let pending = new Map<string, Quote>();
    let flushTimer: NodeJS.Timeout | null = null;

    const send = (payload: unknown) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(payload));
      wsMessages.inc({ channel: CHANNEL, direction: 'out' });
    };

    const flush = () => {
      flushTimer = null;
      if (!pending.size) return;
      send({ event: 'quotes', quotes: [...pending.values()] });
      pending = new Map();
    };

    const onTick = (tick: Tick) => {
      const symbol = symbolOf(tick.key);
      if (!symbol) return;
      // Merge rather than replace: a quote frame and a depth frame for the same
      // contract carry different fields, and dropping either would make bid/ask
      // flicker to undefined between ticks.
      const prev = pending.get(symbol);
      pending.set(symbol, {
        symbol,
        ltp: tick.ltp ?? prev?.ltp,
        bid: tick.bid ?? prev?.bid,
        ask: tick.ask ?? prev?.ask,
        iv:  tick.iv  ?? prev?.iv,
        ts:  tick.ts,
      });
      if (!flushTimer) {
        flushTimer = setTimeout(flush, THROTTLE_MS);
        flushTimer.unref?.();
      }
    };

    const resubscribe = (requested: InstrumentKey[]) => {
      unsubscribe?.();
      unsubscribe = null;
      pending = new Map();

      // Drop what no instrument master carries, BEFORE the router sees it.
      //
      // The router subscribes all-or-nothing: `covers()` requires every key to
      // resolve, so one unknown contract makes it conclude that no feed can
      // serve the set and pause ticks for ALL of them. That is right for the
      // straddle engine, which needs an exact chain — but wrong here, where a
      // caller asks for whatever it happens to hold. One delisted strike, or an
      // index whose master has not loaded, must not blank the P&L on every
      // other position.
      const keys = requested.filter((k) => instruments.brokersFor(k).length > 0);
      const dropped = requested.length - keys.length;
      if (dropped) {
        log.warn({ dropped, requested: requested.length }, 'contracts not carried by any master — skipped');
      }

      if (!keys.length) {
        send({
          event: 'status',
          carrying: false,
          message: dropped ? `${dropped} contract(s) are not priceable` : undefined,
        });
        return;
      }
      try {
        unsubscribe = liveRouter.subscribe(keys, onTick);
        send({ event: 'status', carrying: true, dropped });
      } catch (err) {
        // No feed can carry these contracts. Say so rather than sitting silent:
        // the client falls back to the REST book's prices.
        send({ event: 'status', carrying: false, message: (err as Error).message });
      }
    };

    ws.on('message', (data: Buffer) => {
      wsMessages.inc({ channel: CHANNEL, direction: 'in' });
      let msg: { type?: string; keys?: unknown[] };
      try { msg = JSON.parse(data.toString('utf8')); } catch { return; }

      if (msg.type === 'ping') { send({ event: 'pong', t: Date.now() }); return; }

      if (msg.type === 'subscribe') {
        const keys = (msg.keys ?? [])
          .map(toKey)
          .filter((k): k is InstrumentKey => k !== null);
        resubscribe(keys);
      }
    });

    const heartbeat = setInterval(() => {
      if (missedPings > PING_TOLERANCE) { ws.terminate(); return; }
      missedPings += 1;
      try { ws.ping(); } catch { /* closing */ }
    }, PING_MS);
    heartbeat.unref?.();

    ws.on('pong', () => { missedPings = 0; });

    ws.on('close', () => {
      clearInterval(heartbeat);
      if (flushTimer) clearTimeout(flushTimer);
      unsubscribe?.();
      unsubscribe = null;
    });
  });

  log.info({ path: LIVE_QUOTES_PATH }, 'quotes socket listening');
}
