/**
 * Angel SmartStream V2 — binary tick socket, normalised to `Tick`.
 *
 * Everything broker-specific about live data is confined here: the exchange-type
 * codes, the packed little-endian layout, the paise scaling, and the fact that
 * Angel pushes a snapshot only at subscribe time. The `LiveRouter` above sees
 * `subscribe(keys, cb)` and nothing else, which is what lets it swap Angel for
 * Zerodha mid-session.
 *
 * ── Token resolution ──
 *
 * Subscriptions arrive as InstrumentKeys and are resolved to Angel tokens
 * through the canonical instrument table. A key with no Angel row is dropped
 * with a warning rather than failing the whole subscription: one delisted strike
 * must not take a 40-leg chain down with it.
 */

import WebSocket from 'ws';

import type { InstrumentKey } from '../../identity.js';
import type { Tick } from '../../types.js';
import { instruments } from '../../../instruments/store.js';
import { symbolOf, segmentOf } from '../../../instruments/symbol.js';
import { SMART_STREAM_URL } from './http.js';
import type { AngelSession } from './session.js';

/** Angel's hard cap is 1000 tokens per session; leave headroom. */
const MAX_TOKENS = 990;

/** Angel pings out at ~15s of silence. */
const PING_INTERVAL_MS = 10_000;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS  = 15_000;

/** Consecutive failed reconnects before the token itself is suspected. */
const REAUTH_AFTER_RETRIES = 2;

/** Floor between re-logins, so a socket that fails for some OTHER reason
 *  cannot turn a 15s retry ceiling into a login every 15 seconds. */
const MIN_REAUTH_GAP_MS = 60_000;

/** Exchange segment → SmartStream `exchangeType`. */
const EXCHANGE_TYPE: Record<string, number> = {
  NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, NCDEX: 7, CDS: 13,
};

function exchangeType(segment: string): number {
  return EXCHANGE_TYPE[String(segment).toUpperCase()] ?? EXCHANGE_TYPE.NFO;
}

/**
 * Price divisor by exchange type.
 *
 * Everything is paise (÷100) except currency derivatives, which Angel publishes
 * scaled by 10^7. A USDINR quote priced at 88.25 arrives as 882500000, so the
 * wrong divisor here does not look like a rounding bug — it looks like the rupee
 * collapsed.
 */
function divisorFor(exType: number): number {
  return exType === EXCHANGE_TYPE.CDS ? 10_000_000 : 100;
}

/** Subscription mode 3 = SNAP_QUOTE: LTP, OHLC, OI and the best-five book. */
const MODE_SNAP_QUOTE = 3;

// ── Packet layout (little-endian) ────────────────────────────────────────────
//
//   0       mode                     35..42   exchange timestamp (ms)
//   1       exchange type            43..50   last traded price
//   2..26   token, NUL-padded ASCII  91..122  open / high / low / close
//   27..34  sequence number          131..138 open interest
//   147..346  best five: 10 × 20-byte packets
//             0..1 buy flag (1 = buy)  2..9 quantity  10..17 price
const LTP_END        = 51;
const BEST_FIVE_AT   = 147;
const BEST_FIVE_END  = 347;
const DEPTH_ENTRY    = 20;

interface ParsedTick {
  token: string;
  exType: number;
  ts:  number;
  ltp: number;
  bid?: number;
  ask?: number;
}

/**
 * Decode one SmartStream packet, or null when it is not a tick.
 *
 * Short packets are normal, not errors: Angel sends the LTP-only layout for some
 * instruments even in SNAP_QUOTE mode, so every field past 51 bytes is read only
 * after a length check.
 */
export function parsePacket(buf: Buffer): ParsedTick | null {
  if (buf.length < LTP_END) return null;

  const exType = buf.readUInt8(1);
  const token  = buf.toString('ascii', 2, 27).split('\0')[0].trim();
  if (!token) return null;

  const divisor = divisorFor(exType);
  const ltp     = Number(buf.readBigInt64LE(43)) / divisor;

  // Angel's exchange timestamp is authoritative; fall back to arrival time only
  // if it is absent, because a chart plotted on receipt time drifts under load.
  const exchangeTs = Number(buf.readBigInt64LE(35));
  const ts = exchangeTs > 0 ? exchangeTs : Date.now();

  const tick: ParsedTick = { token, exType, ts, ltp };

  // Best bid and best ask from the depth block. The 10 packets are not ordered
  // buy-then-sell reliably, so both sides are scanned for their best level.
  if (buf.length >= BEST_FIVE_END) {
    let bestBid = 0;
    let bestAsk = 0;
    for (let off = BEST_FIVE_AT; off < BEST_FIVE_END; off += DEPTH_ENTRY) {
      const isBuy = buf.readInt16LE(off) === 1;
      const price = Number(buf.readBigInt64LE(off + 10)) / divisor;
      if (price <= 0) continue;
      if (isBuy) { if (price > bestBid) bestBid = price; }
      else       { if (bestAsk === 0 || price < bestAsk) bestAsk = price; }
    }
    if (bestBid > 0) tick.bid = bestBid;
    if (bestAsk > 0) tick.ask = bestAsk;
  }

  return tick;
}

// ── The socket ───────────────────────────────────────────────────────────────

interface Resolved {
  key:    InstrumentKey;
  token:  string;
  exType: number;
}

/**
 * InstrumentKeys → Angel tokens, dropping what Angel does not list.
 *
 * The reverse map is what the message handler needs: packets carry a token and
 * an exchange type, and the consumer expects an InstrumentKey back.
 */
function resolveKeys(keys: InstrumentKey[]): Resolved[] {
  const out: Resolved[] = [];
  const missing: string[] = [];

  for (const key of keys) {
    const row = instruments.resolve('angel', symbolOf(key), segmentOf(key.exchange, key.kind));
    if (!row?.token) { missing.push(symbolOf(key)); continue; }
    out.push({ key, token: row.token, exType: exchangeType(row.brexchange || row.exchange) });
  }

  if (missing.length) {
    console.warn(
      `[angel/stream] ${missing.length} contract(s) not in Angel's master, skipped: `
      + `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
    );
  }
  return out;
}

export class AngelStream {
  private ws: WebSocket | null = null;
  private resolved: Resolved[] = [];
  private byToken = new Map<string, InstrumentKey>();
  private handler: ((t: Tick) => void) | null = null;

  private pingTimer:  NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private closed = false;

  private lastReauthAt = 0;

  constructor(
    private session: AngelSession,
    /** Re-login, for when the socket is being refused a dead token. */
    private readonly refresh?: () => Promise<AngelSession>,
  ) {}

  /**
   * Open the socket for `keys` and deliver ticks to `cb`.
   *
   * Returns a teardown function. Callers get a synchronous handle even though
   * the connection is asynchronous — an unsubscribe that arrives before the
   * socket opens still cancels it, which matters when a chart is closed quickly.
   */
  open(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    if (!this.session.feedToken) {
      throw new Error('Angel live feed needs a feedToken — the session has none');
    }

    this.handler  = cb;
    this.resolved = resolveKeys(keys).slice(0, MAX_TOKENS);
    if (keys.length > MAX_TOKENS) {
      console.warn(`[angel/stream] ${keys.length} contracts requested; Angel caps at ${MAX_TOKENS}`);
    }
    this.byToken = new Map(this.resolved.map((r) => [`${r.exType}|${r.token}`, r.key]));

    if (!this.resolved.length) {
      throw new Error('Angel carries none of the requested contracts');
    }

    this.connect();
    return () => this.close();
  }

  private connect(): void {
    if (this.closed) return;

    // SmartStream authenticates entirely through headers — the raw JWT with no
    // "Bearer " prefix, which is the opposite of every REST call.
    const ws = new WebSocket(SMART_STREAM_URL, {
      headers: {
        Authorization:    this.session.jwtToken,
        'x-api-key':      this.session.apiKey,
        'x-client-code':  this.session.clientCode,
        'x-feed-token':   this.session.feedToken,
      },
    });
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      this.retries = 0;
      console.log(`[angel/stream] connected — ${this.resolved.length} contracts`);
      this.sendSubscribe();
      this.startPing();
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;               // text frames are pongs and errors
      const parsed = parsePacket(data);
      if (!parsed) return;
      const key = this.byToken.get(`${parsed.exType}|${parsed.token}`);
      if (!key || !this.handler) return;
      this.handler({ key, ts: parsed.ts, ltp: parsed.ltp, bid: parsed.bid, ask: parsed.ask });
    });

    const down = (why: string) => {
      if (this.ws !== ws) return;          // superseded by a newer socket
      this.ws = null;
      this.stopPing();
      if (this.closed) return;
      console.warn(`[angel/stream] disconnected (${why}) — reconnecting`);
      this.scheduleReconnect();
    };

    ws.on('close', () => down('closed'));
    ws.on('error', (err: Error) => down(err.message));
  }

  /**
   * Send the subscribe frame.
   *
   * Re-subscribing an already-subscribed token is not a no-op in the way it
   * looks: Angel pushes a snapshot at subscribe time and then only on change, so
   * re-sending is how a reconnect gets current prices without waiting for the
   * next trade. On an illiquid strike that wait can be the whole session.
   */
  private sendSubscribe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const byType = new Map<number, string[]>();
    for (const r of this.resolved) {
      const list = byType.get(r.exType) ?? [];
      list.push(r.token);
      byType.set(r.exType, list);
    }

    ws.send(JSON.stringify({
      correlationID: 'qt',
      action: 1,
      params: {
        mode: MODE_SNAP_QUOTE,
        tokenList: [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens })),
      },
    }));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { this.stopPing(); return; }
      try { ws.send('ping'); } catch { this.stopPing(); }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
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
   * Reconnect, re-authenticating first when the token looks like the problem.
   *
   * A dropped socket is usually a network blip, and re-running TOTP for one of
   * those would burn login attempts against an account that is fine — so the
   * first couple of retries reuse the session unchanged. Past that it is no
   * longer blip-shaped: SmartStream authenticates in the handshake headers, so
   * an expired feedToken is refused instantly and identically every time. That
   * is the loop behind "connected … disconnected … connected" in the log while
   * the account still reports itself signed in, and no amount of retrying with
   * the same headers will ever break out of it.
   *
   * `retries` resets to 0 whenever a socket actually opens, so a healthy feed
   * never reaches the re-auth branch at all.
   */
  private async reconnect(): Promise<void> {
    if (this.closed) return;

    const due = Date.now() - this.lastReauthAt >= MIN_REAUTH_GAP_MS;
    if (this.refresh && this.retries >= REAUTH_AFTER_RETRIES && due) {
      this.lastReauthAt = Date.now();
      try {
        this.session = await this.refresh();
        console.log('[angel/stream] re-authenticated before reconnect');
      } catch (err) {
        // Keep reconnecting on the old session — the next attempt tries again,
        // and a login that is failing for its own reasons is AuthManager's
        // problem to report, not a reason to stop the socket recovering.
        console.warn(`[angel/stream] re-auth failed: ${(err as Error).message}`);
      }
    }
    if (this.closed) return;   // unsubscribed while the login was in flight
    this.connect();
  }

  close(): void {
    this.closed = true;
    this.stopPing();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.handler = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already gone */ }
  }
}
