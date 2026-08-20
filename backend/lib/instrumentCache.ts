/**
 * Instrument Cache — downloads and persists Nubra's full instrument master.
 *
 * On login we warm the cache for today across all configured exchanges.
 * Subsequent requests (straddle engine, symbol search) read from memory.
 * Data is written to disk so a backend restart doesn't re-download.
 *
 * Cache keys:  `NSE|2026-08-07`,  `MCX|2026-08-07`
 * Disk path:   backend/cache/refdata/{EXCHANGE}_{DATE}.json
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NubraSession }    from '../brokers/nubra.js';
import { nubraFetch, withRetry, toRupees } from './nubraData.js';
import { writeMasterParquet, pruneExpiredParquet } from './parquetStore.js';

import { logger, asError } from './logger.js';
import { refdataFetches, refdataDuration, cacheAccess } from './metrics.js';

const log = logger('instrument-cache');
const logParquet = logger('parquet');

// ── Types ──────────────────────────────────────────────────────────────────

export interface InstrumentRow {
  asset:       string;   // underlying (NIFTY, RELIANCE, GOLD, CRUDEOIL …)
  name:        string;   // first trading symbol
  aliases:     string[];
  exchange:    string;   // NSE | MCX | BSE
  type:        'OPT' | 'FUT' | 'STOCK' | string;   // derivative_type
  assetType:   string;   // INDEX_FO | STOCK_FO | STOCKS | COM_FO | COM_INDEX_FO
  optionType?: 'CE' | 'PE';
  strike?:     number;   // rupees
  expiry?:     string;   // YYYYMMDD
  lot?:        number;
  refId:       string;
}

export interface StraddleEligible {
  asset:    string;   // NIFTY, RELIANCE, GOLD …
  exchange: string;
  kind:     'INDEX' | 'STOCK' | 'COMMODITY' | string;
  lot:      number;
  expiries: string[];  // sorted YYYYMMDD
}

// ── Cache state ────────────────────────────────────────────────────────────

interface CacheSlot {
  rows:        InstrumentRow[];
  eligibleMap: Map<string, StraddleEligible>; // asset → StraddleEligible
  fetchedAt:   number;
}

/**
 * Resident instrument masters, LRU-bounded.
 *
 * ── Why this has a cap at all ──
 *
 * It did not, and that was enough to kill the process. One slot is an entire
 * exchange's instrument master: ~81,000 parsed rows, measured at **23 MB of
 * resident heap** (`scripts/probeMemory.ts`), on top of a transient spike while
 * the 43 MB JSON file is read and parsed.
 *
 * Two or three slots is what normal use touches — today's NSE, BSE and MCX — so
 * an unbounded Map looked fine indefinitely. Then the DTE-median compare walked
 * back through the calendar one day at a time, asking for the expiry list as of
 * each candidate date, and every one of those loaded another master that was
 * then never released. Twenty-five candidates is ~800 MB resident plus the
 * parse spikes, against a 4.05 GB heap already holding session walks. The
 * backend died mid-compare.
 *
 * ── Why eight ──
 *
 * Three for today's warmed exchanges, leaving five for whatever history is
 * being looked at, which covers a cohort scan's working set without the whole
 * cap being churned by it. An evicted slot is not lost — it is on disk and
 * reloads without a network call.
 */
const MAX_RESIDENT_SLOTS = Math.max(
  3, Number(process.env.QT_INSTRUMENT_CACHE_SLOTS) || 8,
);

const memCache = new Map<string, CacheSlot>();

/**
 * Mark a slot as most-recently-used, then evict down to the cap.
 *
 * A `Map` iterates in insertion order, so delete-then-set is what makes it an
 * LRU rather than a FIFO — without the delete, a slot loaded once and read a
 * thousand times would still be evicted before one loaded later and never
 * touched again.
 */
function touch(key: string, slot: CacheSlot): void {
  memCache.delete(key);
  memCache.set(key, slot);

  while (memCache.size > MAX_RESIDENT_SLOTS) {
    const oldest = memCache.keys().next().value;
    if (oldest === undefined) break;
    memCache.delete(oldest);
    log.debug(
      { evicted: oldest, resident: memCache.size, max: MAX_RESIDENT_SLOTS },
      'evicted a refdata slot',
    );
  }
}

// ── Disk cache dir ─────────────────────────────────────────────────────────

const __dir  = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dir, '..', 'cache', 'refdata');
fs.mkdirSync(CACHE_DIR, { recursive: true });

function diskPath(exchange: string, date: string) {
  return path.join(CACHE_DIR, `${exchange}_${date}.json`);
}

// ── Refdata URL ────────────────────────────────────────────────────────────

function refdataUrl(date: string, exchange: string): string {
  const ex = exchange.toUpperCase();
  return ex === 'NSE'
    ? `refdata/refdata/${date}`
    : `refdata/refdata/${date}?exchange=${encodeURIComponent(ex)}`;
}

// ── Parse raw rows → InstrumentRow[] ─────────────────────────────────────

function parseRows(raw: Record<string, unknown>[], exchange: string): InstrumentRow[] {
  const rows: InstrumentRow[] = [];
  for (const r of raw) {
    const asset = String(r.asset || r.underlying || '').trim().toUpperCase();
    if (!asset) continue;

    const aliases = [...new Set(
      [r.stock_name, r.symbol, r.trading_symbol, r.tradingsymbol,
       r.display_name, r.displayName, r.zanskar_name, r.nubra_name]
        .map((v) => String(v || '').trim().toUpperCase())
        .filter(Boolean),
    )];
    if (!aliases.length) continue;

    const dtype      = String(r.derivative_type || r.type || '').toUpperCase();
    const assetType  = String(r.asset_type || r.assetType || '').toUpperCase();
    const optionType = String(r.option_type || r.ot || r.side || '').toUpperCase();
    // Nubra sends every price in paise — including strikes. Unconditionally
    // /100, same as nubraData.toRupees. A magnitude heuristic would misread
    // sub-₹10 strikes (raw 500 → ₹5, not ₹500).
    const strike     = toRupees(r.strike_price ?? r.strike);
    const expiry     = String(r.expiry || '').replace(/-/g, '');       // → YYYYMMDD
    const lot        = Number(r.lot_size || r.lot || 0);
    const refId      = String(r.refId ?? r.ref_id ?? r.refid ?? r.instrument_id ?? '');

    rows.push({
      asset,
      name:        aliases[0],
      aliases,
      exchange:    exchange.toUpperCase(),
      // No default: a blank derivative_type is not an option row, and the
      // straddle path filters on type === 'OPT'.
      type:        dtype,
      assetType,
      optionType:  optionType === 'CE' ? 'CE' : optionType === 'PE' ? 'PE' : undefined,
      strike:      strike != null && strike > 0 ? strike : undefined,
      expiry:      expiry.length === 8 ? expiry : undefined,
      lot:         lot > 0 ? lot : undefined,
      refId,
    });
  }
  return rows;
}

// ── Build eligibleMap from rows ───────────────────────────────────────────

/**
 * Classify an asset from Nubra's own `asset_type`, not from a hardcoded symbol
 * list. A list has to be edited every time a new index is listed (it already
 * missed NIFTYNXT50), and the feed labels each row for us:
 *   INDEX_FO → index · STOCK_FO/STOCKS → stock · COM_FO/COM_INDEX_FO → commodity
 */
function classifyKind(row: InstrumentRow): StraddleEligible['kind'] {
  const at = row.assetType;
  if (at.startsWith('COM'))       return 'COMMODITY';
  if (at.startsWith('INDEX'))     return 'INDEX';
  if (at.startsWith('STOCK'))     return 'STOCK';
  // Fallback for feeds that omit asset_type: exchange is the only clue left.
  return row.exchange === 'MCX' ? 'COMMODITY' : 'STOCK';
}

function buildEligible(rows: InstrumentRow[], exchange: string): Map<string, StraddleEligible> {
  const map = new Map<string, StraddleEligible>();

  for (const row of rows) {
    if (row.type !== 'OPT') continue; // only option rows give straddle eligibility
    if (!row.expiry) continue;

    const existing = map.get(row.asset);
    if (existing) {
      if (!existing.expiries.includes(row.expiry)) {
        existing.expiries.push(row.expiry);
      }
      if (!existing.lot && row.lot) existing.lot = row.lot;
    } else {
      map.set(row.asset, {
        asset:    row.asset,
        exchange: exchange.toUpperCase(),
        kind:     classifyKind(row),
        lot:      row.lot ?? 0,
        expiries: [row.expiry],
      });
    }
  }

  // Sort expiries ascending
  for (const el of map.values()) {
    el.expiries.sort();
  }

  return map;
}

// ── Internal: fetch + parse + cache ─────────────────────────────────────

async function fetchAndCache(
  exchange: string, date: string, session: NubraSession,
): Promise<CacheSlot> {
  log.info({ exchange, date }, 'downloading refdata');
  const t0 = Date.now();

  const raw = await withRetry(() =>
    nubraFetch<{ refdata?: unknown[] }>(refdataUrl(date, exchange), session, { timeoutMs: 90_000 }),
  );
  const rawRows  = Array.isArray(raw.refdata) ? raw.refdata as Record<string, unknown>[] : [];
  const rows     = parseRows(rawRows, exchange);
  const eligible = buildEligible(rows, exchange);

  // An EMPTY response is never cached — not to memory, not to disk.
  //
  // Nubra returns `{refdata: []}` both for dates genuinely outside its history
  // (MCX carries no instrument master before 2026-03-05; NSE reaches back much
  // further) and for transient upstream faults that never surface as an HTTP
  // error. The two are indistinguishable in the response, so neither is safe
  // to persist: caching a transient blank permanently blanks that date, and
  // every later run reports "no option contracts" without retrying.
  //
  // Returning an uncached empty slot costs one cheap request (~200ms, the
  // payload is empty) and keeps a recoverable failure recoverable.
  if (!rawRows.length) {
    refdataFetches.inc({ exchange, outcome: 'empty' });
    refdataDuration.observe({ exchange }, (Date.now() - t0) / 1000);
    log.warn(
      { exchange, date, tookMs: Date.now() - t0 },
      'empty refdata — not cached, will retry on next request',
    );
    return { rows: [], eligibleMap: new Map(), fetchedAt: 0 };
  }

  refdataFetches.inc({ exchange, outcome: 'success' });
  refdataDuration.observe({ exchange }, (Date.now() - t0) / 1000);
  log.info(
    { exchange, date, rows: rows.length, eligible: eligible.size, tookMs: Date.now() - t0 },
    `${rows.length} instruments loaded`,
  );

  // Persist to disk
  const jsonPath = diskPath(exchange, date);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(rawRows), 'utf8');
  } catch (e) {
    log.warn({ exchange, date, err: asError(e) }, 'refdata disk write failed');
  }

  /*
   * Then the same master as Parquet, partitioned by expiry.
   *
   * Fire-and-forget, and deliberately so: this runs inside a login warm that
   * the server does not wait for, and a conversion that failed — a locked file,
   * a full disk — must not take down the login it is riding on. The JSON on
   * disk stays authoritative either way, so the worst case is a stale partition
   * and a warning, not a broken session.
   */
  void writeMasterParquet(exchange, jsonPath)
    .then((result) => {
      if (!result) return;
      logParquet.info(
        `${result.exchange}: ${result.expiries} expiries, `
        + `${result.rows.toLocaleString('en-IN')} rows, `
        + `${(result.bytes / 1048576).toFixed(1)} MB — ${result.tookMs}ms`,
      );
    })
    .catch((e) => logParquet.warn(`${exchange} write failed: ${(e as Error).message}`));

  const slot: CacheSlot = { rows, eligibleMap: eligible, fetchedAt: Date.now() };
  touch(`${exchange}|${date}`, slot);
  return slot;
}

// ── In-flight dedup ───────────────────────────────────────────────────────

const inflight = new Map<string, Promise<CacheSlot>>();

async function getSlot(exchange: string, date: string, session: NubraSession): Promise<CacheSlot> {
  const key = `${exchange.toUpperCase()}|${date}`;

  // 1. Memory cache. Touched on read as well as on write — see `touch`.
  const mem = memCache.get(key);
  if (mem) {
    touch(key, mem);
    cacheAccess.inc({ cache: 'refdata', outcome: 'memory' });
    return mem;
  }

  // 2. Disk cache
  const dPath = diskPath(exchange.toUpperCase(), date);
  if (fs.existsSync(dPath)) {
    try {
      const rawRows = JSON.parse(fs.readFileSync(dPath, 'utf8')) as Record<string, unknown>[];
      // An empty file is a MISS, not a hit — it is the poisoned artefact of an
      // earlier empty response (written before fetchAndCache refused to cache
      // those). Deleting it here means the range self-heals on the next run
      // instead of needing a manual cache wipe.
      if (!Array.isArray(rawRows) || !rawRows.length) {
        log.warn({ exchange, date }, 'empty cache file — removing, will refetch');
        try { fs.unlinkSync(dPath); } catch { /* best effort */ }
      } else {
        const rows     = parseRows(rawRows, exchange);
        const eligible = buildEligible(rows, exchange);
        const slot: CacheSlot = { rows, eligibleMap: eligible, fetchedAt: Date.now() };
        touch(key, slot);
        cacheAccess.inc({ cache: 'refdata', outcome: 'disk' });
        log.info({ exchange, date, rows: rows.length, source: 'disk' }, `${rows.length} instruments loaded`);
        return slot;
      }
    } catch (e) {
      log.warn({ exchange, date, err: asError(e) }, 'refdata disk load failed');
    }
  }

  // 3. Deduplicated network fetch
  const pending = inflight.get(key);
  if (pending) return pending;

  const req = fetchAndCache(exchange.toUpperCase(), date, session)
    .finally(() => inflight.delete(key));
  inflight.set(key, req);
  return req;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Return raw instrument rows for a given exchange+date.
 * Used by nubraData.ts → rollingOptionRows to replace the per-call Nubra fetch.
 */
export async function getCachedRefdata(
  exchange: string,
  date: string,
  session: NubraSession,
): Promise<InstrumentRow[]> {
  const slot = await getSlot(exchange, date, session);
  return slot.rows;
}

/**
 * Search for straddle-eligible assets across all cached exchanges.
 * Returns a ranked list (indices first, then stocks, then commodities).
 */
export function searchEligible(
  query: string, exchange?: string, limit = 50,
): StraddleEligible[] {
  const q  = query.trim().toUpperCase();
  const ex = exchange?.trim().toUpperCase();
  const hits: Array<{ el: StraddleEligible; rank: number }> = [];
  const seen = new Set<string>();   // asset|exchange — dedupe across cached dates

  for (const slot of memCache.values()) {
    for (const el of slot.eligibleMap.values()) {
      if (ex && el.exchange !== ex) continue;

      // Match rank: exact beats prefix beats substring. Without this an "NIFTY"
      // query buries NIFTY itself under BANKNIFTY/FINNIFTY/MIDCPNIFTY.
      let rank = 0;
      if (q) {
        if (el.asset === q)                 rank = 0;
        else if (el.asset.startsWith(q))    rank = 1;
        else if (el.asset.includes(q))      rank = 2;
        else continue;
      }

      const dedupeKey = `${el.asset}|${el.exchange}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      hits.push({ el, rank });
    }
  }

  // Sort: match quality, then INDEX → STOCK → COMMODITY, then alphabetical
  const kindOrder = { INDEX: 0, STOCK: 1, COMMODITY: 2 };
  hits.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const ko = (kindOrder[a.el.kind as keyof typeof kindOrder] ?? 9)
             - (kindOrder[b.el.kind as keyof typeof kindOrder] ?? 9);
    if (ko !== 0) return ko;
    return a.el.asset.localeCompare(b.el.asset);
  });

  return hits.slice(0, limit).map((h) => h.el);
}

export interface SpotRef {
  /** `type` for charts/timeseries: INDEX | STOCK | FUT */
  type:   string;
  /** `values[0]` for charts/timeseries */
  symbol: string;
  kind:   StraddleEligible['kind'];
}

/**
 * Resolve which instrument carries the underlying price for an option straddle.
 *
 * The three kinds need three different things, and getting this wrong is a
 * silent empty series rather than an error:
 *   INDEX     → the index itself, type INDEX
 *   STOCK     → the cash equity, type STOCK  (type INDEX 400s here)
 *   COMMODITY → MCX has no cash leg. The underlying is a specific future, and
 *               the bare asset name returns zero points — it must be the
 *               contract's own symbol, e.g. FUT_GOLD_20261005.
 *
 * For commodities the right contract is the first future expiring AFTER the
 * option expiry (verified against every GOLD/SILVER/CRUDEOIL option series:
 * each option's `underlying_prev_close` matches exactly that future's close).
 */
export async function resolveSpotRef(
  asset: string,
  exchange: string,
  date: string,
  optionExpiry: string | undefined,
  session: NubraSession,
): Promise<SpotRef> {
  const sym  = asset.trim().toUpperCase();
  const slot = await getSlot(exchange, date, session);
  const kind = slot.eligibleMap.get(sym)?.kind
    ?? (exchange.toUpperCase() === 'MCX' ? 'COMMODITY' : 'INDEX');

  if (kind === 'STOCK') return { type: 'STOCK', symbol: sym, kind };
  if (kind !== 'COMMODITY') return { type: 'INDEX', symbol: sym, kind };

  const futures = slot.rows
    .filter((r) => r.asset === sym && r.type === 'FUT' && r.expiry && r.name)
    .sort((a, b) => a.expiry!.localeCompare(b.expiry!));

  if (!futures.length) return { type: 'FUT', symbol: sym, kind };   // nothing better to offer

  const front = optionExpiry
    ? futures.find((f) => f.expiry! > optionExpiry)
    : undefined;
  return { type: 'FUT', symbol: (front ?? futures[0]).name, kind };
}

/**
 * Ordered spot candidates, best first.
 *
 * resolveSpotRef names the single correct underlying, and it is right — a
 * CRUDEOILM option's `underlying_prev_close` matches FUT_CRUDEOILM exactly,
 * not FUT_CRUDEOIL. But being the right contract does not guarantee Nubra has
 * a chart series for it: thin mini futures go unquoted on some days, and a
 * single missing series silently drops the whole session from a backtest.
 *
 * So the caller gets a fallback chain instead of one name:
 *   1. the correct future (first expiring after the option expiry)
 *   2. that asset's other futures, nearest expiry first
 *   3. the sibling contract's futures — CRUDEOILM ↔ CRUDEOIL, which track the
 *      same commodity within a few paise (860500 vs 860800 on 2026-04-16)
 *   4. the bare asset name, as a last resort
 *
 * Anything past step 1 is a substitute and the caller should say so rather
 * than pass it off as the real underlying.
 */
export async function resolveSpotCandidates(
  asset: string,
  exchange: string,
  date: string,
  optionExpiry: string | undefined,
  session: NubraSession,
): Promise<SpotRef[]> {
  const sym  = asset.trim().toUpperCase();
  const slot = await getSlot(exchange, date, session);
  const kind = slot.eligibleMap.get(sym)?.kind
    ?? (exchange.toUpperCase() === 'MCX' ? 'COMMODITY' : 'INDEX');

  if (kind === 'STOCK') return [{ type: 'STOCK', symbol: sym, kind }];
  if (kind !== 'COMMODITY') return [{ type: 'INDEX', symbol: sym, kind }];

  const futuresOf = (a: string) => slot.rows
    .filter((r) => r.asset === a && r.type === 'FUT' && r.expiry && r.name)
    .sort((x, y) => x.expiry!.localeCompare(y.expiry!));

  const own = futuresOf(sym);

  // Mini and full-size contracts on the same commodity: one name is a prefix
  // of the other (CRUDEOIL / CRUDEOILM, GOLD / GOLDM). Derived from the day's
  // own instrument list rather than a hardcoded pair table, which would need
  // editing every time MCX lists a new size.
  const siblings = [...new Set(slot.rows
    .filter((r) => r.type === 'FUT' && r.asset !== sym
      && (r.asset.startsWith(sym) || sym.startsWith(r.asset)))
    .map((r) => r.asset))];

  const ordered: InstrumentRow[] = [];
  const front = optionExpiry ? own.find((f) => f.expiry! > optionExpiry) : undefined;
  if (front) ordered.push(front);
  for (const f of own) if (f !== front) ordered.push(f);
  for (const sib of siblings) {
    const sibFutures = futuresOf(sib);
    const sibFront = optionExpiry
      ? sibFutures.find((f) => f.expiry! > optionExpiry)
      : undefined;
    if (sibFront) ordered.push(sibFront);
    for (const f of sibFutures) if (f !== sibFront) ordered.push(f);
  }

  const seen = new Set<string>();
  const out: SpotRef[] = [];
  for (const f of ordered) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({ type: 'FUT', symbol: f.name, kind });
  }
  out.push({ type: 'FUT', symbol: sym, kind });
  return out;
}

/**
 * Look up one asset's straddle metadata (kind, lot, expiries).
 * Returns null if the asset has no options on that exchange/date.
 */
export async function getEligible(
  asset: string, exchange: string, date: string, session: NubraSession,
): Promise<StraddleEligible | null> {
  const slot = await getSlot(exchange, date, session);
  return slot.eligibleMap.get(asset.trim().toUpperCase()) ?? null;
}

/**
 * All expiries for one asset, sorted ascending (drives the expiry dropdown).
 * Served from cache; only downloads if that exchange/date isn't cached yet.
 */
export async function getCachedExpiries(
  asset: string, exchange: string, date: string, session: NubraSession,
): Promise<string[]> {
  const slot = await getSlot(exchange, date, session);
  return slot.eligibleMap.get(asset.trim().toUpperCase())?.expiries ?? [];
}

/**
 * Exchanges warmed on login. Override with QT_INSTRUMENT_EXCHANGES=NSE,BSE,MCX
 *
 * BSE is in the default list because SENSEX and BANKEX live there and nowhere
 * else — verified against the live backend, where `SENSEX` on NSE returns zero
 * expiries and on BSE returns nineteen. Leaving BSE cold made every BSE symbol
 * invisible to `searchEligible`, so the symbol picker could not offer a
 * contract the straddle engine is perfectly able to walk.
 */
export const WARM_EXCHANGES = (process.env.QT_INSTRUMENT_EXCHANGES || 'NSE,BSE,MCX')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

/**
 * Warm one exchange/date slot on demand.
 *
 * `warmInstrumentCache` only covers WARM_EXCHANGES; a search scoped to an
 * exchange outside that list (CDS, NFO, or BSE with the env var overridden)
 * would otherwise answer "no results" for symbols that do exist. This is a
 * no-op once the slot is cached.
 */
export async function warmExchange(
  exchange: string, date: string, session: NubraSession,
): Promise<void> {
  await getSlot(exchange.toUpperCase(), date, session);
}

export function todayIST(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

let warmPromise: Promise<void> | null = null;
let warmedDate  = '';

/**
 * Warm the cache for today across all configured exchanges.
 * Called once after Nubra login — runs in the background, does not block startup.
 */
export function warmInstrumentCache(session: NubraSession): Promise<void> {
  const today = todayIST();

  // Re-warm only when the day rolls over, not on every login.
  if (warmPromise && warmedDate === today) return warmPromise;
  warmedDate  = today;

  warmPromise = Promise.allSettled(
    WARM_EXCHANGES.map((ex) => getSlot(ex, today, session).catch((e) => {
      log.warn({ exchange: ex, err: asError(e) }, 'warm failed');
    })),
  ).then(() => {
    log.info({ slots: cacheStats().cached }, 'instrument warm complete');
    /*
     * Prune once a warm, which is once a login and therefore once a day.
     *
     * Here rather than on a timer: an expiry passing is a daily event, and a
     * process that stays up over a weekend has nothing to prune until it warms
     * again anyway. Synchronous — it is a handful of directory removals — and
     * wrapped, because losing a login to a file-permissions error on a cleanup
     * would be a poor trade.
     */
    try {
      pruneExpiredParquet();
    } catch (e) {
      logParquet.warn(`prune failed: ${(e as Error).message}`);
    }
  });

  return warmPromise;
}

/**
 * Await the warm-up if one is running, so a search that arrives seconds after
 * login returns results instead of an empty list. Starts the warm if the
 * cache is cold (e.g. login happened before this module was reachable).
 */
export async function ensureWarm(session: NubraSession): Promise<void> {
  if (memCache.size === 0 || warmedDate !== todayIST()) {
    await warmInstrumentCache(session);
    return;
  }
  if (warmPromise) await warmPromise;
}

/** Cache diagnostics for /api/instruments/status */
export function cacheStats() {
  const entries: Array<{
    key: string; assets: number; rows: number; fetchedAt: number;
  }> = [];
  for (const [key, slot] of memCache.entries()) {
    entries.push({
      key,
      assets:    slot.eligibleMap.size,
      rows:      slot.rows.length,
      fetchedAt: slot.fetchedAt,
    });
  }
  return {
    cached: entries.length,
    limit: MAX_RESIDENT_SLOTS,
    entries,
  };
}
