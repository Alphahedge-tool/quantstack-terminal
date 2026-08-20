/**
 * Angel One order updates — the dedicated SmartAPI order-status WebSocket.
 *
 *   Endpoint  wss://tns.angelone.in/smart-order-update
 *   Auth      Authorization: Bearer <jwtToken>   (handshake header)
 *   Liveness  Angel drops the socket without a ping roughly every 10s
 *   Cap       3 sockets per CLIENT CODE — per account, not per app
 *
 * This is what lets the books stop polling. Angel rate-limits getOrderBook and
 * getPosition to ONE request per second each, so the old 5s/10s poll was both
 * the fastest safe cadence AND slow enough that a multi-leg exit could paint a
 * position book that never existed — three legs filled, one of them shown.
 *
 * ── The cap is per client code, not per process ──
 *
 * Three sockets, counted by Angel across everything using that client code. The
 * Angel mobile app and any other tool on the same account consume the same
 * three. So a 429 here is NOT a bug to retry — retrying a limit that is already
 * saying no is a self-inflicted outage. It falls back to polling instead, and
 * says so.
 */

import WebSocket from 'ws';

import type { Order } from '../types.js';
import { toSide, toStatus, toKind, toProduct, toTimestamp, toNumber } from '../types.js';
import type { OrderStatus } from '../types.js';
import { resolveContract } from '../contract.js';
import { ensureConnected } from '../../feeds/authManager.js';
import type { AngelFeed } from '../../feeds/adapters/angel/index.js';

import { logger, asError } from '../../lib/logger.js';

const log = logger('orderStream/angel');

const ORDER_WS_URL = process.env.ANGEL_ORDER_WS_URL
  || 'wss://tns.angelone.in/smart-order-update';

/** Angel docs say ~10s; 9s leaves margin for a slow round trip. */
const PING_MS = 9_000;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS  = 30_000;

/** Consecutive failed reconnects before the token itself is suspected. */
const REAUTH_AFTER_RETRIES = 2;

/** Floor between re-logins, so a socket failing for some other reason cannot
 *  turn the retry ceiling into a login every 30 seconds. */
const MIN_REAUTH_GAP_MS = 60_000;

/**
 * Angel's `order-status` codes → this codebase's OrderStatus.
 *
 * Every modify / AMO / pending variant is still a WORKING order, so they all
 * collapse to OPEN rather than inventing states the rest of the app would have
 * to learn.
 */
const STATUS_CODES: Record<string, OrderStatus> = {
  AB01: 'OPEN',
  AB02: 'CANCELLED',
  AB03: 'REJECTED',
  AB04: 'OPEN',              // modified
  AB05: 'COMPLETE',
  AB06: 'OPEN',              // after-market order received
  AB07: 'CANCELLED',         // after-market order cancelled
  AB08: 'OPEN',              // modify AMO received
  AB09: 'OPEN',              // open pending
  AB10: 'TRIGGER_PENDING',
  AB11: 'OPEN',              // modify pending
};

/** The connection acknowledgement. Proof the socket is authenticated. */
const ACK_CODE = 'AB00';

function str(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * One socket frame → an Order, or null when the frame is not an order.
 *
 * Exported for the verify script: this mapping is pure, and it is exactly the
 * part that fails silently — a status that lands on OPEN when the order really
 * filled looks completely normal on screen.
 */
export function normalizeOrderFrame(raw: string): Order | null {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;                      // 'pong' and other text frames
  }

  const code = str(message['order-status']).toUpperCase();
  const data = (message.orderData ?? {}) as Record<string, unknown>;

  // Trust the PAYLOAD over the status code. AB00 is documented as the
  // connection ack and normally arrives with orderData blank — but Angel's own
  // sample response shows AB00 carrying a fully populated rejected order. A
  // frame with an orderid is an order; one without is not, whatever the code.
  if (!str(data.orderid)) return null;

  const statusText = data.orderstatus ?? data.status;
  const status: OrderStatus = code === ACK_CODE
    ? toStatus(statusText)
    : STATUS_CODES[code] ?? toStatus(statusText);

  const filled   = toNumber(data.filledshares);
  const unfilled = toNumber(data.unfilledshares);
  // Angel omits `quantity` on some frames; filled + unfilled reconstructs it.
  const quantity = toNumber(data.quantity) || filled + unfilled;

  return {
    id:         str(data.orderid),
    exchangeId: str(data.exchorderid) || str(data.uniqueorderid),
    // Same resolver the REST book uses, so a socket row and a book row
    // describing one order cannot disagree and defeat the merge.
    contract: resolveContract('angel', {
      brsymbol:   str(data.tradingsymbol) || str(data.symbolname),
      brexchange: str(data.exchange),
      token:      str(data.symboltoken),
      underlying: str(data.symbolname),
      expiry:     str(data.expirydate),
      strike:     str(data.strikeprice),
      optionType: str(data.optiontype),
      lot:        toNumber(data.lotsize) || undefined,
    }),
    side:    toSide(data.transactiontype),
    status,
    kind:    toKind(data.ordertype),
    product: toProduct(data.producttype),
    quantity,
    filled,
    // Matches the REST adapter: `unfilledshares` disagrees with
    // quantity − filled on partially cancelled orders, and the subtraction is
    // the one that reconciles with the other two columns on screen.
    pending:      Math.max(0, quantity - filled),
    price:        toNumber(data.price),
    triggerPrice: toNumber(data.triggerprice),
    averagePrice: toNumber(data.averageprice),
    placedAt:     toTimestamp(data.updatetime ?? data.exchtime ?? data.ordertime),
    updatedAt:    toTimestamp(data.updatetime ?? data.exchorderupdatetime),
    message:      str(data.text),
  };
}

/** Why the stream stopped trying, when it did. */
export interface StreamFault {
  reason:  'cap' | 'auth' | 'transport';
  message: string;
  /** False means reconnecting cannot fix it — fall back to polling. */
  retry:   boolean;
}

/**
 * Angel's documented handshake rejections.
 *
 * Each needs a DIFFERENT thing from the operator, so they are reported
 * separately rather than as one "socket failed".
 */
function classifyStatus(httpStatus: number): StreamFault {
  if (httpStatus === 429) {
    return {
      reason: 'cap', retry: false,
      message: 'Angel allows 3 order sockets per client code and all 3 are in use — '
        + 'possibly by the Angel app or another tool on this account. Falling back to polling.',
    };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      reason: 'auth', retry: true,
      message: `Angel rejected the order socket token (${httpStatus}) — re-authenticating.`,
    };
  }
  return { reason: 'transport', retry: true, message: `Angel order socket HTTP ${httpStatus}` };
}

export interface OrderStreamHandlers {
  onOrder:  (order: Order) => void;
  /** Connected / disconnected / gave up, for the UI's status pill. */
  onStatus: (state: 'connected' | 'disconnected' | 'stopped', detail?: StreamFault) => void;
}

/**
 * A live order socket for one Angel account.
 *
 * Owns nothing but the socket: the session belongs to the feed adapter, which is
 * also the thing that knows how to renew it.
 */
export class AngelOrderStream {
  private ws: WebSocket | null = null;
  private pingTimer:  NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private lastReauthAt = 0;
  private closed = false;
  private handlers: OrderStreamHandlers | null = null;

  constructor(private readonly feed: AngelFeed) {}

  get id(): string {
    return this.feed.id;
  }

  /** Start streaming. Returns a teardown function. */
  open(handlers: OrderStreamHandlers): () => void {
    this.handlers = handlers;
    this.closed = false;
    this.connect();
    return () => this.close();
  }

  private connect(): void {
    if (this.closed) return;

    let jwt: string;
    try {
      jwt = this.feed.requireSession().jwtToken;
    } catch {
      // Not logged in yet. Not an error — the feed logs in on its own schedule,
      // so wait a beat and look again rather than failing the stream.
      this.scheduleReconnect();
      return;
    }

    const ws = new WebSocket(ORDER_WS_URL, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    this.ws = ws;

    ws.on('open', () => {
      this.retries = 0;
      log.info({ feed: this.id }, 'order stream connected');
      this.startPing();
      this.handlers?.onStatus('connected');
    });

    ws.on('message', (data: Buffer) => {
      const order = normalizeOrderFrame(data.toString('utf8'));
      if (!order) return;
      log.info(
        { feed: this.id, order: order.id, status: order.status, contract: order.contract.label },
        'order update',
      );
      this.handlers?.onOrder(order);
    });

    // The handshake was refused. `ws` reports the HTTP status only here — by the
    // time 'close' fires the status is gone, so the classification must happen
    // in this handler.
    ws.on('unexpected-response', (_req, res) => {
      const fault = classifyStatus(res.statusCode ?? 0);
      log.warn({ feed: this.id, status: res.statusCode, retry: fault.retry }, fault.message);
      if (!fault.retry) {
        this.closed = true;                   // a cap will not clear by retrying
        this.handlers?.onStatus('stopped', fault);
        this.teardownSocket();
        return;
      }
      if (fault.reason === 'auth') this.lastReauthAt = 0;   // re-auth immediately
      this.down('handshake refused');
    });

    const down = (why: string) => {
      if (this.ws !== ws) return;             // superseded by a newer socket
      this.down(why);
    };

    ws.on('close', () => down('closed'));
    ws.on('error', (err: Error) => down(err.message));
  }

  private down(why: string): void {
    this.ws = null;
    this.stopPing();
    if (this.closed) return;
    log.warn({ feed: this.id, why }, 'order stream disconnected — reconnecting');
    this.handlers?.onStatus('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.retryTimer || this.closed) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** this.retries, RETRY_MAX_MS);
    this.retries += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.reconnect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /**
   * Reconnect, making sure the feed is logged in first.
   *
   * ── What this deliberately does NOT do ──
   *
   * It does not log the session out to force a fresh one. That is tempting,
   * because this socket's credentials are baked into its handshake headers and
   * a stale JWT is refused identically every time. But the session is SHARED:
   * `disconnect()` calls Angel's logout, which invalidates the token the
   * position book, the order book and the tick socket are all using. One
   * unhappy order socket would then bounce the whole account — the books would
   * flash "Angel One not signed in", empty themselves, and refill a moment
   * later once something re-logged-in. A socket-level problem must not cost the
   * account its session.
   *
   * It does not need to. `connect()` re-reads `requireSession()` on every
   * attempt, so the moment anything else renews the session — a book request
   * hitting AUTH, or the health prober — the next retry picks the new token up
   * on its own. `ensureConnected` here only covers the ordinary case of the
   * stream starting before the feed has finished logging in; it is a no-op when
   * the feed is already connected.
   */
  private async reconnect(): Promise<void> {
    if (this.closed) return;

    const due = Date.now() - this.lastReauthAt >= MIN_REAUTH_GAP_MS;
    if (this.retries >= REAUTH_AFTER_RETRIES && due) {
      this.lastReauthAt = Date.now();
      try {
        // Single-flighted by AuthManager, so this cannot race the tick socket
        // into two logins for one account.
        await ensureConnected(this.feed);
      } catch (err) {
        log.warn({ feed: this.id, err: asError(err) }, 'feed not connected');
      }
    }
    if (this.closed) return;
    this.connect();
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { this.stopPing(); return; }
      try { ws.send('ping'); } catch { this.stopPing(); }
    }, PING_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.stopPing();
    try { ws?.close(); } catch { /* already gone */ }
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.handlers = null;
    this.teardownSocket();
  }
}
