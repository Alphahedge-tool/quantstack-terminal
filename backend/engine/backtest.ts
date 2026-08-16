/**
 * Multi-day straddle backtester.
 *
 * Replays the rolling-ATM straddle engine over a date range and reduces each
 * session to a DayMetrics row, then aggregates the panel. This is the same
 * engine the live chart uses — not a reimplementation — so a backtested day and
 * a charted day are the same numbers by construction.
 *
 * How historical (expired) options are reached:
 *
 *   Nubra's `refdata/refdata/<date>` returns the instrument master AS IT WAS on
 *   that date, including contracts that have since expired. instrumentCache
 *   already fetches and persists exactly that per exchange+date, so asking for
 *   2026-03-12 returns the strikes and trading symbols that were live on
 *   2026-03-12, and charts/timeseries serves their bars. Nothing about expiry
 *   needs special handling — the historical name simply resolves.
 *
 * Cost model, because this matters before you point it at a year:
 *
 *   Per day  = 1 refdata download (once per exchange+date, then disk-cached)
 *            + 1 spot series
 *            + ceil(optionNames / 8) option-series batches
 *   A NIFTY day is ~20-30 option names → 3-4 batches. Days run through a small
 *   pool on top of the engine's own batch pool, so in-flight requests are
 *   dayConcurrency × ROLLING_CONCURRENCY. Both are deliberately modest: Nubra's
 *   gateway 403s on bursts.
 *
 * Every completed day is written to disk as a ~4 KB metrics row, so re-running
 * a range you have already pulled costs nothing and extending a range only
 * fetches the new days.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { MarketDataFeed } from '../feeds/types.js';
import { normalizeExpiry, compactExpiry } from '../feeds/identity.js';
import { runPool } from '../lib/nubraData.js';
import { computeRollingStraddle } from './rollingStraddle.js';
import { computeDayMetrics, daysToExpiry, type DayMetrics } from '../analytics/straddleMetrics.js';
import { computeBacktestStats, type BacktestStats } from '../analytics/backtestStats.js';

// ─── Disk cache ───────────────────────────────────────────────────────────────

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dir, '..', 'cache', 'backtest');
fs.mkdirSync(CACHE_DIR, { recursive: true });

/** Cache version — bump when DayMetrics gains or changes a field. */
const METRICS_VERSION = 4;   // v4: vega/theta greeks on the rolling straddle

function dayCachePath(
  exchange: string, symbol: string, date: string, expiry: string, interval: string,
): string {
  // Expiry is pinned to the compact YYYYMMDD form regardless of how it arrives.
  //
  // Feeds now hand out canonical ISO expiries ("2026-06-16"), but this cache is
  // on disk and predates that: thousands of files are named with the compact
  // form. Interpolating the ISO string straight in renamed every key, orphaning
  // the entire cache and silently turning instant backtests into full
  // recomputes. Normalising here keeps both spellings pointing at one file.
  const compact = compactExpiry(normalizeExpiry(expiry)) ?? expiry;
  const safe = `${exchange}_${symbol}_${date}_${compact}_${interval}_v${METRICS_VERSION}`
    .replace(/[^A-Za-z0-9_.-]/g, '');
  return path.join(CACHE_DIR, `${safe}.json`);
}

function readDayCache(file: string): DayMetrics | null {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DayMetrics;
  } catch {
    return null;   // a corrupt row is a cache miss, not a run-ending error
  }
}

function writeDayCache(file: string, metrics: DayMetrics): void {
  try {
    fs.writeFileSync(file, JSON.stringify(metrics), 'utf8');
  } catch (e) {
    console.warn(`[backtest] cache write failed: ${(e as Error).message}`);
  }
}

// ─── Date enumeration ─────────────────────────────────────────────────────────

/**
 * Every weekday in [from, to] inclusive.
 *
 * Weekends are the only dates excluded up front. Exchange holidays are NOT
 * hardcoded — there is no reliable static list across NSE/BSE/MCX and years,
 * and a stale one silently drops real sessions. A holiday instead surfaces as
 * a day with no spot bars and is recorded as a skip with that reason, which is
 * both self-maintaining and auditable.
 */
export function enumerateWeekdays(from: string, to: string): string[] {
  const out: string[] = [];
  const start = Date.parse(`${from}T00:00:00Z`);
  const end   = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return out;

  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExpiryRule = 'front' | 'min-dte';

export interface BacktestOptions {
  symbol:    string;
  exchange?: string;
  from:      string;          // YYYY-MM-DD inclusive
  to:        string;          // YYYY-MM-DD inclusive
  feed:      MarketDataFeed;

  /**
   * 'front'    — nearest expiry, whatever it is (includes expiry day itself).
   * 'min-dte'  — nearest expiry with at least `minDte` calendar days left.
   *              minDte: 1 is the usual way to exclude expiry-day sessions,
   *              which are a different regime and dominate any pooled average.
   */
  expiryRule?: ExpiryRule;
  minDte?:     number;
  /** Skip the day entirely if the selected expiry is further out than this. */
  maxDte?:     number;

  interval?:    string;   // default '1m'
  concurrency?: number;   // day-level, default 2
  refresh?:     boolean;  // bypass the per-day metrics cache
}

export interface SkippedDay {
  date:   string;
  reason: string;
  /**
   * True when the day was excluded BY THE FILTER (wrong DTE), false when it
   * could not be computed (holiday, missing data, upstream failure).
   *
   * The two look identical in a flat list and are not remotely the same thing:
   * an expiry-day-only run legitimately drops ~80% of weekdays, and presenting
   * that as 80% failures buries the handful of days that actually broke.
   */
  filtered: boolean;
}

export interface BacktestResult {
  status:   true;
  symbol:   string;
  exchange: string;
  from:     string;
  to:       string;
  interval: string;
  expiryRule: ExpiryRule;
  minDte:   number;

  days:     DayMetrics[];
  skipped:  SkippedDay[];
  stats:    BacktestStats;

  requested:   number;   // weekdays scanned
  filteredOut: number;   // excluded by the DTE filter, working as intended
  failed:      number;   // holidays and genuine failures
  computed:    number;
  fromCache:   number;
  elapsedMs:   number;
}

type ProgressCb = (p: {
  stage: string; pct: number; message: string;
  done: number; total: number;
}) => void;

// ─── Expiry selection ─────────────────────────────────────────────────────────

/**
 * Pick which expiry this day trades.
 *
 * Consistency across days is the whole point: mixing a 0-DTE session with a
 * 6-DTE session inside one average produces a number that describes neither.
 */
function selectExpiry(
  expiries: string[], date: string, rule: ExpiryRule, minDte: number,
): { expiry: string; dte: number } | null {
  const withDte = expiries
    .map((e) => ({ expiry: e, dte: daysToExpiry(date, e) }))
    .filter((e) => e.dte >= 0)
    .sort((a, b) => a.dte - b.dte);

  if (!withDte.length) return null;
  if (rule === 'front') return withDte[0];
  return withDte.find((e) => e.dte >= minDte) ?? null;
}

// ─── Single day ───────────────────────────────────────────────────────────────

type DayOutcome =
  | { ok: true;  metrics: DayMetrics; cached: boolean }
  | { ok: false; reason: string; filtered?: boolean };

async function runOneDay(
  date: string, opts: Required<Pick<BacktestOptions,
    'symbol' | 'exchange' | 'expiryRule' | 'minDte' | 'interval' | 'refresh'>>
    & { maxDte?: number; feed: MarketDataFeed },
): Promise<DayOutcome> {
  const { symbol, exchange, feed, interval } = opts;

  // 1. Which contracts existed on this date, and which expiry do we trade?
  let expiries: string[];
  try {
    expiries = await feed.expiries(symbol, exchange, date);
  } catch (e) {
    return { ok: false, reason: `refdata failed: ${(e as Error).message}` };
  }
  if (!expiries.length) {
    // Nubra returned no instrument master for this date. Three causes, and the
    // response cannot tell them apart, so the message names all three rather
    // than asserting "holiday" — MCX in particular carries no refdata at all
    // before 2026-03-05, which looks identical to a market closure.
    return {
      ok: false,
      reason: 'no instrument master for this date '
        + '(non-trading day, outside Nubra history, or symbol not listed yet)',
    };
  }

  const chosen = selectExpiry(expiries, date, opts.expiryRule, opts.minDte);
  if (!chosen) {
    return { ok: false, filtered: true, reason: `no expiry with dte >= ${opts.minDte}` };
  }
  if (opts.maxDte != null && chosen.dte > opts.maxDte) {
    return {
      ok: false, filtered: true,
      reason: `front expiry is ${chosen.dte} DTE, filter allows <= ${opts.maxDte}`,
    };
  }

  // 2. Cached metrics row?
  const cacheFile = dayCachePath(exchange, symbol, date, chosen.expiry, interval);
  if (!opts.refresh) {
    const hit = readDayCache(cacheFile);
    if (hit) return { ok: true, metrics: hit, cached: true };
  }

  // 3. Replay the session through the live engine.
  const result = await computeRollingStraddle({
    symbol, exchange, date, expiry: chosen.expiry, feed,
    intervals: [interval],
  });

  if (!result.status) return { ok: false, reason: result.message };

  const metrics = computeDayMetrics(result, expiries);
  if (!metrics) return { ok: false, reason: 'session too thin to characterise' };

  writeDayCache(cacheFile, metrics);
  return { ok: true, metrics, cached: false };
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runBacktest(
  options: BacktestOptions,
  onProgress?: ProgressCb,
): Promise<BacktestResult> {
  const prog = onProgress ?? (() => {});
  const t0 = Date.now();

  const symbol     = options.symbol.trim().toUpperCase();
  const exchange   = (options.exchange || 'NSE').trim().toUpperCase();
  const expiryRule = options.expiryRule ?? 'front';
  const minDte     = options.minDte ?? 0;
  const interval   = options.interval ?? '1m';
  const refresh    = options.refresh ?? false;
  // Day-level parallelism multiplies the engine's own batch pool. Keeping the
  // default at 2 holds total in-flight requests at ~8, the same ceiling the
  // single-day path already runs at safely.
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 2, 6));

  const dates = enumerateWeekdays(options.from, options.to);
  if (!dates.length) {
    throw new Error(`Empty or invalid date range: ${options.from} → ${options.to}`);
  }

  const days:    DayMetrics[] = [];
  const skipped: SkippedDay[] = [];
  let computed = 0, fromCache = 0, done = 0;

  const dayOpts = {
    symbol, exchange, expiryRule, minDte, interval, refresh,
    maxDte: options.maxDte, feed: options.feed,
  };

  prog({
    stage: 'init', pct: 2, done: 0, total: dates.length,
    message: `Replaying ${dates.length} sessions of ${symbol} (${options.from} → ${options.to})…`,
  });

  await runPool(
    dates.map((date) => async () => {
      try {
        const outcome = await runOneDay(date, dayOpts);
        if (outcome.ok) {
          days.push(outcome.metrics);
          if (outcome.cached) fromCache++; else computed++;
        } else {
          skipped.push({ date, reason: outcome.reason, filtered: outcome.filtered === true });
        }
      } catch (e) {
        // One bad day must not abandon the run — a single 403 or a delisted
        // contract is expected over a long range.
        skipped.push({
          date, filtered: false,
          reason: (e as Error).message || 'unknown error',
        });
      } finally {
        done++;
        const failed = skipped.filter((s) => !s.filtered).length;
        prog({
          stage: 'days',
          pct: 2 + Math.floor((done / dates.length) * 92),
          done, total: dates.length,
          message: `${done}/${dates.length} scanned · ${days.length} matched`
            + (failed ? ` · ${failed} failed` : ''),
        });
      }
    }),
    concurrency,
  );

  prog({
    stage: 'stats', pct: 96, done, total: dates.length,
    message: `Aggregating ${days.length} sessions…`,
  });

  // computeBacktestStats re-sorts internally; the pool completes out of order.
  const stats = computeBacktestStats(days);
  const elapsedMs = Date.now() - t0;
  const filteredOut = skipped.filter((s) => s.filtered).length;
  const failed      = skipped.length - filteredOut;

  console.log(
    `[backtest] ${exchange} ${symbol} ${options.from}→${options.to} @${interval} — `
    + `${days.length}/${dates.length} matched (${computed} computed, ${fromCache} cached), `
    + `${filteredOut} filtered out, ${failed} failed, ${elapsedMs}ms`,
  );

  prog({ stage: 'done', pct: 100, done, total: dates.length, message: 'Complete' });

  return {
    status: true,
    symbol, exchange,
    from: options.from, to: options.to,
    interval, expiryRule, minDte,
    days: [...days].sort((a, b) => a.date.localeCompare(b.date)),
    skipped: skipped.sort((a, b) => a.date.localeCompare(b.date)),
    stats,
    requested: dates.length,
    filteredOut, failed,
    computed, fromCache,
    elapsedMs,
  };
}

// ─── Cache maintenance ────────────────────────────────────────────────────────

export function backtestCacheStats(): { files: number; bytes: number; dir: string } {
  let files = 0, bytes = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const st = fs.statSync(path.join(CACHE_DIR, name));
      if (st.isFile()) { files++; bytes += st.size; }
    }
  } catch { /* dir may not exist yet */ }
  return { files, bytes, dir: CACHE_DIR };
}

/** Delete cached day rows. `prefix` narrows to e.g. "NSE_NIFTY". */
export function clearBacktestCache(prefix?: string): number {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (prefix && !name.startsWith(prefix)) continue;
      fs.unlinkSync(path.join(CACHE_DIR, name));
      removed++;
    }
  } catch { /* nothing to clear */ }
  return removed;
}
