/**
 * Zerodha Kite ticker — binary tick socket, normalised to `Tick`.
 *
 * Kite's wire format differs from Angel's in every detail, which is the point of
 * having this file: the `LiveRouter` sees the same `subscribe(keys, cb)` from
 * both, so switching between them is a routing decision rather than a rewrite.
 *
 * ── Frame layout ──
 *
 * One frame carries MANY packets, unlike Angel's one-packet-per-frame:
 *
 *   int16   number of packets
 *   ├─ int16  packet length          ┐ repeated
 *   └─ bytes  packet                 ┘
 *
 * Packet length identifies the mode — 8 = LTP, 44 = quote (index), 184 = full.
 * All big-endian, which is the opposite of Angel.
 *
 * ── The segment trick ──
 *
 * Kite encodes the exchange in the LOW BYTE of the instrument token, so the
 * price divisor can be derived from the token itself with no lookup. That
 * matters for currency derivatives, which are scaled by 10^7 rather than 100.
 */

import WebSocket from 'ws';

import type { InstrumentKey } from '../../identity.js';
import type { Tick } from '../../types.js';
import { instruments } from '../../../instruments/store.js';
import { symbolOf, segmentOf } from '../../../instruments/symbol.js';
import type { ZerodhaSession } from './session.js';

import { logger } from '../../../lib/logger.js';

const log = logger('zerodha/stream');

const TICKER_URL = 'wss://ws.kite.trade';

/** Kite's documented ceiling is 3000 tokens per connection. */
const MAX_TOKENS = 3_000;

const PING_INTERVAL_MS = 25_000;
const RETRY_BASE_MS    = 1_000;
const RETRY_MAX_MS     = 15_000;

/** Segment codes packed into the instrument token's low byte. */
const SEGMENT_CDS = 3;
const SEGMENT_BCD = 6;

/**
 * Currency derivatives are published scaled by 10^7; everything else by 100.
 *
 * Reading the segment out of the token avoids a master lookup per packet — at
 * a few thousand ticks a second that lookup is not free.
 */
function divisorFor(token: number): number {
  const segment = token & 0xff;
  return segment === SEGMENT_CDS || segment === SEGMENT_BCD ? 10_000_000 : 100;
}

// Packet sizes.
const LTP_SIZE   = 8;
const INDEX_FULL = 32;
const QUOTE_SIZE = 44;
const FULL_SIZE  = 184;

/** Market depth starts here in a full packet: 10 × 12 bytes, 5 bid then 5 ask. */
const DEPTH_AT    = 64;
const DEPTH_ENTRY = 12;

interface ParsedTick {
  token: number;
  ts:    number;
  ltp:   number;
  bid?:  number;
  ask?:  number;
}

/** Split one frame into its packets. */
function splitPackets(buf: Buffer): Buffer[] {
  if (buf.length < 2) return [];
  const count = buf.readInt16BE(0);
  const out: Buffer[] = [];
  let offset = 2;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > buf.length) break;
    const len = buf.readInt16BE(offset);
    offset += 2;
    if (len <= 0 || offset + len > buf.length) break;
    out.push(buf.subarray(offset, offset + len));
    offset += len;
  }
  return out;
}

/** Decode one packet, or null when it is too short to be a tick. */
export function parsePacket(p: Buffer): ParsedTick | null {
  if (p.length < LTP_SIZE) return null;

  const token   = p.readInt32BE(0);
  const divisor = divisorFor(token);
  const ltp     = p.readInt32BE(4) / divisor;

  // Index packets carry their own timestamp at 28 (32-byte form) and have no
  // depth at all — indices do not have a book.
  if (p.length === INDEX_FULL) {
    return { token, ts: p.readInt32BE(28) * 1000, ltp };
  }

  if (p.length < QUOTE_SIZE) return { token, ts: Date.now(), ltp };

  // Full packets carry the exchange timestamp at 60. Quote packets do not, and
  // fall back to arrival time — plotting on receipt time drifts under load, so
  // the exchange stamp is used wherever it exists.
  const ts = p.length >= FULL_SIZE ? p.readInt32BE(60) * 1000 : Date.now();
  const tick: ParsedTick = { token, ts: ts > 0 ? ts : Date.now(), ltp };

  if (p.length >= FULL_SIZE) {
    // First five entries are bids, next five asks — a fixed layout, unlike
    // Angel's flagged entries.
    const bid = p.readInt32BE(DEPTH_AT + 4) / divisor;
    const ask = p.readInt32BE(DEPTH_AT + 5 * DEPTH_ENTRY + 4) / divisor;
    if (bid > 0) tick.bid = bid;
    if (ask > 0) tick.ask = ask;
  }

  return tick;
}

// ── The socket ───────────────────────────────────────────────────────────────

/** Subscription mode: `full` is the only one carrying depth and a timestamp. */
const MODE_FULL = 'full';

export class ZerodhaStream {
  private ws: WebSocket | null = null;
  private tokens: number[] = [];
  private byToken = new Map<number, InstrumentKey>();
  private handler: ((t: Tick) => void) | null = null;

  private pingTimer:  NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private closed = false;

  constructor(private readonly session: ZerodhaSession) {}

  open(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    this.handler = cb;

    const missing: string[] = [];
    this.byToken.clear();
    this.tokens = [];

    for (const key of keys) {
      const row = instruments.resolve('zerodha', symbolOf(key), segmentOf(key.exchange, key.kind));
      const token = Number(row?.token);
      if (!row || !Number.isFinite(token)) { missing.push(symbolOf(key)); continue; }
      this.tokens.push(token);
      this.byToken.set(token, key);
    }

    if (missing.length) {
      log.warn(
        `${missing.length} contract(s) not in Kite's master, skipped: `
        + `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
      );
    }
    if (!this.tokens.length) throw new Error('Zerodha carries none of the requested contracts');

    if (this.tokens.length > MAX_TOKENS) {
      log.warn(`${this.tokens.length} contracts requested; Kite caps at ${MAX_TOKENS}`);
      this.tokens = this.tokens.slice(0, MAX_TOKENS);
    }

    this.connect();
    return () => this.close();
  }

  private connect(): void {
    if (this.closed) return;

    // Kite authenticates the socket by query string, not headers.
    const url = `${TICKER_URL}?api_key=${encodeURIComponent(this.session.apiKey)}`
      + `&access_token=${encodeURIComponent(this.session.accessToken)}`;

    const ws = new WebSocket(url);
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      this.retries = 0;
      log.info(`connected — ${this.tokens.length} contracts`);
      ws.send(JSON.stringify({ a: 'subscribe', v: this.tokens }));
      ws.send(JSON.stringify({ a: 'mode', v: [MODE_FULL, this.tokens] }));
      this.startPing();
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      // Text frames are order postbacks and errors, not ticks.
      if (!isBinary) return;
      // A single-packet frame of length 1 is Kite's heartbeat.
      if (data.length <= 2) return;

      for (const packet of splitPackets(data)) {
        const parsed = parsePacket(packet);
        if (!parsed) continue;
        const key = this.byToken.get(parsed.token);
        if (!key || !this.handler) continue;
        this.handler({ key, ts: parsed.ts, ltp: parsed.ltp, bid: parsed.bid, ask: parsed.ask });
      }
    });

    const down = (why: string) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      if (this.closed) return;
      log.warn(`disconnected (${why}) — reconnecting`);
      this.scheduleReconnect();
    };

    ws.on('close', () => down('closed'));
    ws.on('error', (err: Error) => down(err.message));
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { this.stopPing(); return; }
      try { ws.ping(); } catch { this.stopPing(); }
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
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
    this.retryTimer.unref?.();
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
