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
 * Capacity: 50 entries max (~50 full-day straddle datasets in RAM).
 * Each entry is ~23,400 StraddlePoint objects ≈ 15–20 MB peak in V8.
 * 50 entries ≈ 750 MB RAM worst-case (acceptable for a terminal workstation).
 * In practice, users load 3–5 different sessions before reloading old ones.
 */

import { LRUCache } from './lruCache.js';

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

// ── Singleton ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cache = new LRUCache<any>(50);

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
    console.log(`[compute-cache] HIT  ${key}`);
  }
  return hit;
}

/** Store a computed result with the appropriate TTL. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setComputed(key: string, data: any, date: string): void {
  const ttl = isToday(date) ? TTL_TODAY_MS : TTL_HISTORICAL_MS;
  cache.set(key, data, ttl);
  console.log(
    `[compute-cache] SET  ${key}  TTL=${ttl / 60000}min`,
  );
}

/** Invalidate one specific entry (e.g. force-refresh today's data). */
export function invalidate(key: string): void {
  cache.delete(key);
  console.log(`[compute-cache] DEL  ${key}`);
}

/** Current cache stats — exposed via /api/straddle/cache-status. */
export function cacheStatus() {
  return {
    capacity: 50,
    size:     cache.size,
    entries:  cache.entries(),
  };
}
