/**
 * Kotak HSM — binary tick socket, normalised to `Tick`.
 *
 * The most involved of the three protocols, and worth understanding before
 * touching: unlike Angel and Kite, HSM is STATEFUL and self-describing.
 *
 * ── Snapshot / update ──
 *
 * A subscription first yields a SNAP packet carrying the instrument's name, a
 * numeric topic id, and the full field array. Every packet after that is an
 * UPDATE carrying only the topic id and the fields that CHANGED. So the decoder
 * has to keep per-topic state: an update on its own is meaningless, and a topic
 * map lost on reconnect makes every subsequent packet undecodable. That is why
 * `topics` is cleared on connect and repopulated from fresh snapshots.
 *
 * ── Self-describing scale ──
 *
 * Prices are integers scaled by a multiplier and a decimal precision that the
 * instrument itself declares, in fields 23 and 24. There is no fixed divisor to
 * hard-code — a hard-coded ÷100 works for equities and is wrong for currency.
 *
 * ── Trash values ──
 *
 * `-2147483648` (INT32_MIN) means "no value in this update", NOT zero. Writing
 * it through would print a bid of −21 million.
 */

import WebSocket from 'ws';

import type { InstrumentKey } from '../../identity.js';
import type { Tick } from '../../types.js';
import { instruments } from '../../../instruments/store.js';
import { symbolOf, segmentOf } from '../../../instruments/symbol.js';
import type { KotakSession } from './session.js';

import { logger } from '../../../lib/logger.js';

const log = logger('kotak/stream');

const HSM_URL = process.env.KOTAK_HSM_URL || 'wss://mlhsm.kotaksecurities.com';

const MAX_INSTRUMENTS = 200;
const MAX_PER_FRAME   = 100;
const MAX_CHANNELS    = 16;

/** INT32_MIN — Kotak's "field absent from this update" sentinel. */
const TRASH = -2_147_483_648;

const TYPE = { CONNECTION: 1, THROTTLE: 2, ACK: 3, SUBSCRIBE: 4, UNSUBSCRIBE: 5, DATA: 6 } as const;
const SNAP   = 83;
const UPDATE = 85;

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS  = 15_000;

// ── Frame construction ───────────────────────────────────────────────────────

interface Writer {
  byte(v: number): void;
  short(v: number): void;
  int(v: number): void;
  string(v: string): void;
  raw(v: Buffer): void;
}

/** Every HSM frame is length-prefixed with a big-endian uint16. */
function framed(build: (w: Writer) => void): Buffer {
  const parts: Buffer[] = [];
  const w: Writer = {
    byte:   (v) => parts.push(Buffer.from([v & 255])),
    short:  (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); parts.push(b); },
    int:    (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); parts.push(b); },
    string: (v) => parts.push(Buffer.from(String(v), 'utf8')),
    raw:    (v) => parts.push(v),
  };
  build(w);

  const body  = Buffer.concat(parts);
  const frame = Buffer.alloc(body.length + 2);
  frame.writeUInt16BE(body.length);
  body.copy(frame, 2);
  return frame;
}

function connectionFrame(token: string, sid: string): Buffer {
  return framed((w) => {
    w.byte(TYPE.CONNECTION);
    w.byte(3);
    for (const [field, value] of [[1, token], [2, sid], [3, 'JS_API']] as const) {
      const text = String(value ?? '');
      w.byte(field);
      w.short(Buffer.byteLength(text));
      w.string(text);
    }
  });
}

interface Item { token: string; segment: string; prefix: string }

function scripArray(items: Item[]): Buffer {
  const names = items.map((i) => `${i.prefix}|${i.segment}|${i.token}`);
  const head  = Buffer.alloc(2);
  head.writeUInt16BE(names.length);

  const parts: Buffer[] = [head];
  for (const name of names) {
    const bytes = Buffer.from(name, 'utf8');
    parts.push(Buffer.from([bytes.length & 255]), bytes);
  }
  return Buffer.concat(parts);
}

function subscriptionFrame(items: Item[], channel: number, unsubscribe = false): Buffer {
  const array = scripArray(items);
  return framed((w) => {
    w.byte(unsubscribe ? TYPE.UNSUBSCRIBE : TYPE.SUBSCRIBE);
    w.byte(2);
    w.byte(1);
    w.short(array.length);
    w.raw(array);
    w.byte(2);
    w.short(1);
    w.byte(channel);
  });
}

function ackFrame(n: number): Buffer {
  return framed((w) => {
    w.byte(TYPE.ACK);
    w.byte(1);
    w.byte(1);
    w.short(4);
    w.int(n);
  });
}

// ── Topic state ──────────────────────────────────────────────────────────────

interface Topic {
  prefix:     string;
  segment:    string;
  token:      string;
  fields:     Array<number | null>;
  multiplier: number;
  precision:  number;
}

function topicFromName(name: string): Topic | null {
  const [prefix, segment, ...rest] = String(name ?? '').split('|');
  if (!['sf', 'if', 'dp'].includes(prefix)) return null;
  return {
    prefix, segment, token: rest.join('|'),
    fields: new Array(100).fill(null),
    multiplier: 1, precision: 2,
  };
}

/**
 * Field indices differ by feed type: `sf` is a full scrip feed, `if` an index
 * feed with a much smaller field set and no book at all.
 */
const SCALE_INDEX = {
  sf: { multiplier: 23, precision: 24 },
  if: { multiplier: 8,  precision: 9 },
  dp: { multiplier: 32, precision: 33 },
} as const;

interface DecodedTick { ltp: number; bid?: number; ask?: number }

function decode(topic: Topic): DecodedTick | null {
  const idx = SCALE_INDEX[topic.prefix as keyof typeof SCALE_INDEX];
  if (!idx) return null;

  topic.multiplier = topic.fields[idx.multiplier] || topic.multiplier || 1;
  topic.precision  = topic.fields[idx.precision] ?? topic.precision ?? 2;

  const divisor = topic.multiplier * 10 ** topic.precision;
  const price = (i: number): number | undefined =>
    topic.fields[i] == null ? undefined : topic.fields[i]! / divisor;

  if (topic.prefix === 'if') {
    const ltp = price(2);
    return ltp == null ? null : { ltp };
  }
  if (topic.prefix === 'sf') {
    const ltp = price(5);
    return ltp == null ? null : { ltp, bid: price(9), ask: price(10) };
  }
  return null;
}

// ── The socket ───────────────────────────────────────────────────────────────

export class KotakStream {
  private ws: WebSocket | null = null;
  private handler: ((t: Tick) => void) | null = null;

  private items: Item[] = [];
  /** `prefix|segment|token` → the key the consumer asked for. */
  private byName = new Map<string, InstrumentKey>();
  /** Numeric topic id → its decoding state. Rebuilt from snapshots on connect. */
  private topics = new Map<number, Topic>();

  private ackEvery  = 0;
  private dataCount = 0;

  private retryTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  private closed  = false;

  constructor(private readonly session: KotakSession) {}

  open(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    this.handler = cb;
    this.items   = [];
    this.byName.clear();

    const missing: string[] = [];
    for (const key of keys) {
      const row = instruments.resolve('kotak', symbolOf(key), segmentOf(key.exchange, key.kind));
      if (!row?.token) { missing.push(symbolOf(key)); continue; }
      // Numeric tokens are scrip feeds, everything else an index feed.
      const prefix  = /^\d+$/.test(row.token) ? 'sf' : 'if';
      const segment = row.brexchange.toLowerCase();
      this.items.push({ token: row.token, segment, prefix });
      this.byName.set(`${prefix}|${segment}|${row.token}`, key);
    }

    if (missing.length) {
      log.warn(
        `${missing.length} contract(s) not in Kotak's master, skipped: `
        + `${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' …' : ''}`,
      );
    }
    if (!this.items.length) throw new Error('Kotak carries none of the requested contracts');

    if (this.items.length > MAX_INSTRUMENTS) {
      log.warn(`${this.items.length} contracts requested; HSM caps at ${MAX_INSTRUMENTS}`);
      this.items = this.items.slice(0, MAX_INSTRUMENTS);
    }

    this.connect();
    return () => this.close();
  }

  private connect(): void {
    if (this.closed) return;

    const ws = new WebSocket(HSM_URL);
    this.ws = ws;
    ws.binaryType = 'nodebuffer';

    ws.on('open', () => {
      // Auth is its own frame, not a header or a query string — the third
      // distinct approach across the three brokers.
      ws.send(connectionFrame(this.session.tradeToken, this.session.sid));
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      this.onFrame(data);
    });

    const down = (why: string) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed) return;
      log.warn(`disconnected (${why}) — reconnecting`);
      this.scheduleReconnect();
    };

    ws.on('close', () => down('closed'));
    ws.on('error', (err: Error) => down(err.message));
  }

  private onFrame(buf: Buffer): void {
    if (buf.length < 4) return;
    let pos = 2;                       // skip the length prefix
    const type = buf.readUInt8(pos++);
    try {
      if (type === TYPE.CONNECTION) this.onConnectionAck(buf, pos);
      else if (type === TYPE.DATA)  this.onData(buf, pos);
    } catch {
      // Drop a malformed packet. The next snapshot repairs topic state, so one
      // bad frame must not tear down a working socket.
    }
  }

  private onConnectionAck(buf: Buffer, pos: number): void {
    const count = buf.readUInt8(pos++);
    if (!count) return;

    pos += 1;
    const len = buf.readUInt16BE(pos); pos += 2;
    const status = buf.toString('utf8', pos, pos + len); pos += len;

    if (count >= 2) {
      pos += 1;
      const ackLen = buf.readUInt16BE(pos); pos += 2;
      // Kotak asks to be acknowledged every N data frames; ignoring it makes
      // the server throttle and eventually drop the connection.
      this.ackEvery = Number(buf.readUIntBE(pos, Math.min(ackLen, 6)) || 0);
    }

    if (status !== 'K') {
      log.error('authentication rejected');
      this.close();
      return;
    }

    this.retries = 0;
    // Topic ids are assigned per CONNECTION. Carrying them across a reconnect
    // would decode new packets against stale instruments.
    this.topics.clear();
    log.info(`connected — ${this.items.length} contracts`);
    this.sendSubscribe();
  }

  private sendSubscribe(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    for (let i = 0; i < this.items.length; i += MAX_PER_FRAME) {
      const batch   = this.items.slice(i, i + MAX_PER_FRAME);
      const channel = ((i / MAX_PER_FRAME) % MAX_CHANNELS) + 1;
      ws.send(subscriptionFrame(batch, channel));
    }
  }

  private onData(buf: Buffer, pos: number): void {
    if (this.ackEvery > 0) {
      this.dataCount += 1;
      const n = buf.readInt32BE(pos); pos += 4;
      if (this.dataCount >= this.ackEvery) {
        this.dataCount = 0;
        try { this.ws?.send(ackFrame(n)); } catch { /* socket going down */ }
      }
    }

    const count = buf.readUInt16BE(pos); pos += 2;

    for (let i = 0; i < count; i += 1) {
      const size  = buf.readUInt16BE(pos); pos += 2;
      const start = pos;
      const kind  = buf.readUInt8(pos++);

      let topic: Topic | undefined;
      let key: InstrumentKey | undefined;

      if (kind === SNAP) {
        const id = buf.readInt32BE(pos); pos += 4;
        const nameLen = buf.readUInt8(pos++);
        const name = buf.toString('utf8', pos, pos + nameLen); pos += nameLen;
        const built = topicFromName(name);
        if (built) { this.topics.set(id, built); topic = built; }
        key = this.byName.get(name);
      } else if (kind === UPDATE) {
        const id = buf.readInt32BE(pos); pos += 4;
        topic = this.topics.get(id);
        if (topic) key = this.byName.get(`${topic.prefix}|${topic.segment}|${topic.token}`);
      }

      if (!topic) { pos = start + size; continue; }

      const fieldCount = buf.readUInt8(pos++);
      for (let f = 0; f < fieldCount; f += 1) {
        const value = buf.readInt32BE(pos); pos += 4;
        // Only overwrite when the update actually carries the field — see the
        // header note on TRASH.
        if (value !== TRASH) topic.fields[f] = value;
      }

      // Snapshots carry trailing strings; skipping them keeps `pos` aligned even
      // though nothing here needs their values.
      if (kind === SNAP) {
        const stringCount = buf.readUInt8(pos++);
        for (let s = 0; s < stringCount; s += 1) {
          pos += 1;                              // field id
          const len = buf.readUInt8(pos++);
          pos += len;
        }
      }

      const decoded = key ? decode(topic) : null;
      if (decoded && key && this.handler) {
        // HSM carries no exchange timestamp, so arrival time is the only clock
        // available — unlike Angel and Kite, which both publish one.
        this.handler({ key, ts: Date.now(), ltp: decoded.ltp, bid: decoded.bid, ask: decoded.ask });
      }

      pos = start + size;
    }
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
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.handler = null;
    this.topics.clear();
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already gone */ }
  }
}
