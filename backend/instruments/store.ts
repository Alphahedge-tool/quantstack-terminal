/**
 * The cross-broker instrument table.
 *
 * Holds one normalised master per broker, indexed twice:
 *
 *   byCanonical   `NIFTY28AUG2624500CE|NFO` → row      (what a consumer asks for)
 *   byBroker      `NIFTY28AUG26245000CE|nse_fo` → row  (what a broker reports back)
 *
 * The second index is not redundant. Order books, position reports and fill
 * streams come back speaking the BROKER's symbol, and mapping those to a
 * canonical contract is the only way a Kotak position can be priced by an Angel
 * feed — which is the whole point of `route()`.
 *
 * Masters are cached to disk because they are 8-30 MB each and downloading four
 * of them on every restart adds a minute to boot for data that changes once a
 * day, at 08:00 IST, whether or not this process is running.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { InstrumentRow } from './types.js';
import type { InstrumentKey } from '../feeds/identity.js';
import { symbolOf, segmentOf, canonicalExchange } from './symbol.js';

/** Bump when InstrumentRow changes shape — old cache files are then ignored. */
const CACHE_VERSION = 2;

/**
 * 20 hours, not 24.
 *
 * Exchanges publish the new master around 08:00 IST. A flat 24h TTL loaded at
 * 09:00 on Monday stays "fresh" until 09:00 Tuesday — i.e. through the first
 * 45 minutes of Tuesday's session, holding yesterday's contract list. Anything
 * under 23h avoids that; 20h leaves margin for a late publish.
 */
const TTL_MS = 20 * 60 * 60 * 1000;

const CACHE_DIR = process.env.QT_INSTRUMENT_CACHE_DIR
  || path.resolve(process.cwd(), 'cache', 'instruments');

function canonicalKey(symbol: string, exchange: string): string {
  return `${String(symbol ?? '').toUpperCase()}|${canonicalExchange(exchange)}`;
}

/**
 * Broker keys keep the broker's own segment spelling, lower-cased.
 *
 * Deliberately NOT run through canonicalExchange: this index exists to look up
 * what a broker literally sent us, and normalising both sides would collapse
 * `nse_fo` and `NFO` into one bucket — which is fine until two segments of the
 * same broker use the same trading symbol.
 */
function brokerKey(symbol: string, exchange: string): string {
  return `${String(symbol ?? '').toUpperCase()}|${String(exchange ?? '').toLowerCase()}`;
}

interface Entry {
  rows:        InstrumentRow[];
  byCanonical: Map<string, InstrumentRow>;
  byBroker:    Map<string, InstrumentRow>;
  byToken:     Map<string, InstrumentRow>;
  /** Lazily built by `segmentRows`. */
  bySegment:   Map<string, InstrumentRow[]>;
  loadedAt:    number;
}

function index(rows: InstrumentRow[]): Omit<Entry, 'rows' | 'loadedAt' | 'bySegment'> {
  const byCanonical = new Map<string, InstrumentRow>();
  const byBroker    = new Map<string, InstrumentRow>();
  const byToken     = new Map<string, InstrumentRow>();

  for (const row of rows) {
    if (row.symbol) byCanonical.set(canonicalKey(row.symbol, row.exchange), row);
    if (row.brsymbol) {
      // Both spellings: the broker's own segment, and the canonical exchange.
      // A position report may carry either, depending on which endpoint it came
      // from — Kotak's order book says `nse_fo`, its position book says `NFO`.
      byBroker.set(brokerKey(row.brsymbol, row.brexchange), row);
      byBroker.set(brokerKey(row.brsymbol, row.exchange), row);
    }
    if (row.token) byToken.set(`${row.token}|${String(row.brexchange).toLowerCase()}`, row);
  }
  return { byCanonical, byBroker, byToken };
}

export class InstrumentStore {
  private readonly brokers = new Map<string, Entry>();

  constructor(private readonly cacheDir: string = CACHE_DIR) {}

  // ── loading ────────────────────────────────────────────────────────────────

  /** Install a freshly loaded master and write it through to disk. */
  set(broker: string, rows: InstrumentRow[]): number {
    const entry: Entry = { rows, ...index(rows), bySegment: new Map(), loadedAt: Date.now() };
    this.brokers.set(broker, entry);

    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      // Write to a temp file and rename: a crash mid-write would otherwise leave
      // truncated JSON that the next boot reads as "no cache" at best, and as a
      // half-populated master at worst.
      const target = path.join(this.cacheDir, `${broker}.json`);
      const tmp    = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, loadedAt: entry.loadedAt, rows }));
      fs.renameSync(tmp, target);
    } catch {
      // A read-only cache directory must not stop the in-memory store working.
    }
    return rows.length;
  }

  /** Rehydrate from disk. Returns false when absent, stale, or the wrong version. */
  loadCache(broker: string): boolean {
    try {
      const raw = fs.readFileSync(path.join(this.cacheDir, `${broker}.json`), 'utf8');
      const parsed = JSON.parse(raw) as { version?: number; loadedAt?: number; rows?: InstrumentRow[] };
      if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.rows)) return false;
      const loadedAt = Number(parsed.loadedAt || 0);
      if (Date.now() - loadedAt >= TTL_MS) return false;
      this.brokers.set(broker, { rows: parsed.rows, ...index(parsed.rows), bySegment: new Map(), loadedAt });
      return true;
    } catch {
      return false;
    }
  }

  isFresh(broker: string): boolean {
    const entry = this.brokers.get(broker);
    return Boolean(entry && Date.now() - entry.loadedAt < TTL_MS);
  }

  has(broker: string): boolean {
    return this.brokers.has(broker);
  }

  // ── resolution ─────────────────────────────────────────────────────────────

  /** Canonical symbol + exchange → this broker's row. */
  resolve(broker: string, symbol: string, exchange: string): InstrumentRow | null {
    return this.brokers.get(broker)?.byCanonical.get(canonicalKey(symbol, exchange)) ?? null;
  }

  /**
   * A structural key → this broker's row.
   *
   * The signature every adapter actually wants: hand it the InstrumentKey the
   * router gave you and get back the token to subscribe with.
   */
  resolveKey(broker: string, key: InstrumentKey): InstrumentRow | null {
    return this.resolve(broker, symbolOf(key), segmentOf(key.exchange, key.kind));
  }

  /** This broker's own symbol (from a report it sent us) → its row. */
  resolveBroker(broker: string, brsymbol: string, brexchange: string): InstrumentRow | null {
    return this.brokers.get(broker)?.byBroker.get(brokerKey(brsymbol, brexchange)) ?? null;
  }

  /** This broker's own token → its row. For decoding tick streams. */
  resolveToken(broker: string, token: string, brexchange: string): InstrumentRow | null {
    const entry = this.brokers.get(broker);
    if (!entry) return null;
    return entry.byToken.get(`${String(token)}|${String(brexchange).toLowerCase()}`) ?? null;
  }

  /**
   * The same contract across every loaded broker.
   *
   * This is the feed-switch primitive: given what the user is watching, it says
   * which brokers can carry it and what each one calls it. A broker missing from
   * the result cannot serve that contract and must not be switched to for it.
   */
  route(symbol: string, exchange: string): Record<string, InstrumentRow | null> {
    const out: Record<string, InstrumentRow | null> = {};
    for (const broker of this.brokers.keys()) out[broker] = this.resolve(broker, symbol, exchange);
    return out;
  }

  /** `route` for a structural key. */
  routeKey(key: InstrumentKey): Record<string, InstrumentRow | null> {
    return this.route(symbolOf(key), segmentOf(key.exchange, key.kind));
  }

  /** Which loaded brokers can serve this contract, in no particular order. */
  brokersFor(key: InstrumentKey): string[] {
    return Object.entries(this.routeKey(key))
      .filter(([, row]) => row != null)
      .map(([broker]) => broker);
  }

  // ── introspection ──────────────────────────────────────────────────────────

  /** Every row this broker loaded. The array is shared — treat it as read-only. */
  rowsOf(broker: string): readonly InstrumentRow[] {
    return this.brokers.get(broker)?.rows ?? [];
  }

  /**
   * Rows on one canonical segment, e.g. every NFO contract.
   *
   * Indexed on first use per broker+segment. Chain and expiry lookups scan a
   * segment repeatedly, and a linear pass over 120k rows for each of ~40 strikes
   * is the difference between an option chain rendering instantly and taking a
   * visible second.
   */
  segmentRows(broker: string, segment: string): readonly InstrumentRow[] {
    const entry = this.brokers.get(broker);
    if (!entry) return [];
    const want = canonicalExchange(segment);

    let cached = entry.bySegment.get(want);
    if (!cached) {
      cached = entry.rows.filter((r) => r.exchange === want);
      entry.bySegment.set(want, cached);
    }
    return cached;
  }

  search(broker: string, query: string, limit = 50): InstrumentRow[] {
    const text = String(query ?? '').toUpperCase().trim();
    if (!text) return [];
    const out: InstrumentRow[] = [];
    for (const row of this.brokers.get(broker)?.rows ?? []) {
      if (row.symbol.includes(text)
        || row.name.toUpperCase().includes(text)
        || row.brsymbol.toUpperCase().includes(text)) {
        out.push(row);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  status(): Record<string, { rows: number; loadedAt: string; fresh: boolean }> {
    const out: Record<string, { rows: number; loadedAt: string; fresh: boolean }> = {};
    for (const [broker, entry] of this.brokers) {
      out[broker] = {
        rows:     entry.rows.length,
        loadedAt: new Date(entry.loadedAt).toISOString(),
        fresh:    this.isFresh(broker),
      };
    }
    return out;
  }

  /** Test seam. */
  clear(): void {
    this.brokers.clear();
  }
}

/** Process-wide store. One master set, shared by the feeds and the trading side. */
export const instruments = new InstrumentStore();
