/**
 * Singleton compute cache for rolling straddle results.
 *
 * Cache key: `${symbol}|${exchange}|${expiry}|${date}`
 *
 * TTL strategy:
 *   - Historical dates (before today):  48 hours  — data never changes
 *   - Today's date:                     12 hours  — long enough to span MCX's
 *     09:00–23:55 session
 *
 * Today's entry used to expire after 30 minutes, because a session cached at
 * 11:00 is wrong by 11:31. It no longer expires for that reason: every load
 * runs engine/straddleCatchUp.ts, which appends the bars since the entry was
 * written and stores the merged session back here. Freshness comes from that
 * path, not from throwing the day away and re-walking it from 09:15.
 *
 * The tail refresh is append-only, so a bar the feed later revises stays as
 * first cached. POST /api/straddle/cache-invalidate forces the full re-walk.
 *
 * ── Capacity ──
 *
 * Bounded by estimated BYTES, not by entry count. It used to be "50 entries",
 * on the estimate that a full day was 15–20 MB and fifty of them ~750 MB. That
 * estimate was low by about 3.5×: measured against a live NIFTY session, one
 * 22,484-point entry retains ~67 MB once GC settles (a 17-field object per
 * point, plus the arrays holding them), so fifty of them is ~3.3 GB. Node's
 * default old-space ceiling is ~2 GB, so a user flipping through enough
 * expiries and dates to fill the cache killed the backend with
 * "JavaScript heap out of memory" — reliably, and with no single request
 * looking unreasonable.
 *
 * The budget below leaves room for the rest of the process (instrument masters,
 * live chains, the straddle engine's own buffers) inside the default heap. Give
 * the backend a bigger --max-old-space-size and QT_STRADDLE_CACHE_MB can go up
 * with it.
 */

import { LRUCache } from './lruCache.js';

import { logger } from './logger.js';

const log = logger('compute-cache');

// ── TTL constants ──────────────────────────────────────────────────────────
const TTL_HISTORICAL_MS = 48 * 60 * 60 * 1000;  // 48 h — past days
const TTL_TODAY_MS      = 12 * 60 * 60 * 1000;  // 12 h — current day, kept fresh by catch-up

// ── Determine if a date string is today (IST) ─────────────────────────────
export function isToday(dateISO: string): boolean {
  const todayIST = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return dateISO === todayIST;
}

// ── Sizing ─────────────────────────────────────────────────────────────────

/**
 * Estimated retained bytes per StraddlePoint.
 *
 * Measured, not derived: a 22,484-point session moved settled heap by ~67 MB,
 * which is ~3 KB per point. That is far above the ~150 bytes the 17 numeric
 * fields would suggest, because each point is a separate V8 object and the
 * arrays holding them carry pointer and allocation overhead of their own. The
 * measurement is what the budget has to respect, so the measurement is what
 * this uses.
 */
const BYTES_PER_POINT = 3_000;

/** Floor for an entry with no points, so empty results still cost something. */
const BYTES_BASE = 64 * 1024;

/** Total budget for cached sessions. ~7 full days at the measured size. */
const BUDGET_BYTES = Number(process.env.QT_STRADDLE_CACHE_MB || 480) * 1024 * 1024;

function weighSession(data: unknown): number {
  const points = (data as { points?: unknown[] } | null)?.points;
  return BYTES_BASE + (Array.isArray(points) ? points.length * BYTES_PER_POINT : 0);
}

// ── Singleton ──────────────────────────────────────────────────────────────
// The entry cap stays as a second bound so a pathological run of tiny results
// cannot grow the map without limit; the byte budget is what normally binds.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cache = new LRUCache<any>(50, { maxBytes: BUDGET_BYTES, weigh: weighSession });

/**
 * Build the canonical cache key.
 * e.g. "NIFTY|NSE|20260811|2026-08-07"
 */
export function cacheKey(
  symbol: string,
  exchange: string,
  expiry: string,
  date: string,
): string {
  return `${symbol.toUpperCase()}|${exchange.toUpperCase()}|${expiry}|${date}`;
}

/** Retrieve a cached result. Returns null on miss or expiry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getComputed(key: string): any | null {
  const hit = cache.get(key);
  if (hit) {
    log.info(`HIT  ${key}`);
  }
  return hit;
}

/** Store a computed result with the appropriate TTL. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setComputed(key: string, data: any, date: string): void {
  const ttl = isToday(date) ? TTL_TODAY_MS : TTL_HISTORICAL_MS;
  cache.set(key, data, ttl);
  log.info(
    `SET  ${key}  TTL=${ttl / 60000}min`,
  );
}

/** Invalidate one specific entry (e.g. force-refresh today's data). */
export function invalidate(key: string): void {
  cache.delete(key);
  log.info(`DEL  ${key}`);
}

/** Current cache stats — exposed via /api/straddle/cache-status. */
export function cacheStatus() {
  return {
    capacity:   50,
    budgetMB:   Math.round(BUDGET_BYTES / 1024 / 1024),
    usedMB:     Math.round(cache.bytes / 1024 / 1024),
    size:       cache.size,
    entries:    cache.entries(),
  };
}
