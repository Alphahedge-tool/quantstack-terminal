/**
 * Nubra market-data client — TypeScript port of Alphahedge node-backend/lib/nubraData.js.
 *
 * Endpoints used:
 *   POST charts/timeseries        → spot / option bid,ask,iv,close series
 *   GET  refdata/refdata/<date>   → day's instrument list (strikes, aliases)
 *
 * Unit conventions (same as Alphahedge):
 *   Timestamps arrive in NANOSECONDS  → pointMs() divides by 1e6
 *   Prices arrive in PAISE            → toRupees() divides by 100
 */

import type { NubraSession } from '../brokers/nubra.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NubraPoint {
  ts: number;   // epoch milliseconds
  v:  number;   // value (rupees for prices, plain for IV)
}

export interface NubraOptionSeries {
  bid:   NubraPoint[];
  ask:   NubraPoint[];
  ltp:   NubraPoint[];
  ivBid: NubraPoint[];
  ivAsk: NubraPoint[];
  ivMid: NubraPoint[];
  /** From `cumulative_oi` and `cumulative_volume` — plain counts, not paise. */
  oi:     NubraPoint[];
  volume: NubraPoint[];
  /**
   * Per-leg greeks, straight from the feed.
   *
   * Plain numbers, NOT paise — unlike every price field above. Greeks are
   * sensitivities rather than premiums, and the reference implementation
   * (Alphahedge `fetchVegaSeries`) parses them with its rupee flag off, which is
   * the only direct evidence available for how this endpoint denominates them.
   * Applying toRupees() here would silently divide every greek by 100.
   *
   * Sparse or absent for older contracts — the same ~3-month greek horizon that
   * already limits iv_bid/iv_ask. Consumers must treat an empty array as "not
   * published", not as zero.
   */
  delta: NubraPoint[];
  gamma: NubraPoint[];
  vega:  NubraPoint[];
  theta: NubraPoint[];
}

export interface OptionRow {
  name:    string;               // canonical trading symbol (first alias)
  aliases: string[];
  expiry:  string;               // YYYY-MM-DD
  side:    'CE' | 'PE';
  strike:  number;               // rupees
  refId:   string;
}

// ─── Constants (match Alphahedge exactly) ─────────────────────────────────────

export const ROLLING_INTERVALS  = ['1s', '1m'] as const;

// Nubra's charts/timeseries accepts at most 8 symbols in one `values` array —
// a hard upstream limit, not a tuning knob. Don't raise it.
export const ROLLING_BATCH_SIZE = 8;

// How many of those 8-symbol requests may be in flight at once. The batch size
// is capped upstream; the number of batches is not, and that is where the time
// went: a session needs ~7-9 batches, and running them one-at-a-time with a
// pause between each made the wall time the SUM of every round-trip.
// Nubra's gateway 403s on bursts, so this stays modest and every batch retries
// with backoff (see RETRYABLE) rather than being dropped.
export const ROLLING_CONCURRENCY = Math.max(
  1, Number(process.env.QT_ROLLING_CONCURRENCY || 4),
);

// Statuses worth retrying: gateway burst rejections and transient upstream
// faults. 400 is excluded on purpose — it means "interval unsupported", which
// the 1s->1m fallback handles instead.
const RETRYABLE = new Set([403, 408, 425, 429, 500, 502, 503, 504]);
const RETRY_ATTEMPTS = 3;

export type RollingInterval = (typeof ROLLING_INTERVALS)[number];

// ─── Concurrency helpers ──────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run tasks with bounded concurrency. An unbounded Promise.all over every batch
 * would open a burst of sockets and earn a 403; strictly serial execution is
 * the thing we're removing. A fixed pool of workers gives the parallelism
 * without the burst.
 */
export async function runPool(
  tasks: Array<() => Promise<void>>,
  concurrency: number,
): Promise<void> {
  let next = 0;
  const workers = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(
    Array.from({ length: workers }, async () => {
      for (let i = next++; i < tasks.length; i = next++) await tasks[i]();
    }),
  );
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  if (status != null && RETRYABLE.has(status)) return true;
  const name = (err as Error)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Retry with exponential backoff + jitter. This is what makes the pool safe. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = RETRY_ATTEMPTS): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isRetryable(err) || attempt === attempts - 1) break;
      await sleep(200 * 2 ** attempt + Math.floor(Math.random() * 120));
    }
  }
  throw lastError;
}

// ─── Error ────────────────────────────────────────────────────────────────────

export class NubraDataError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'NubraDataError';
    this.status = status;
  }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function baseUrl(): string {
  const env = String(process.env.NUBRA_ENV ?? '').toUpperCase();
  if (env === 'UAT') return 'https://uatapi.nubra.io';
  return process.env.NUBRA_BASE_URL || 'https://api.nubra.io';
}

function authHeaders(session: NubraSession): Record<string, string> {
  const token = session.sessionToken.startsWith('Bearer ')
    ? session.sessionToken
    : `Bearer ${session.sessionToken}`;
  return {
    Authorization:   token,
    'x-device-id':   session.deviceId,
    'x-app-version': '0.4.5',
    'x-device-os':   'sdk',
    'content-type':  'application/json',
  };
}

// ─── Core fetch ───────────────────────────────────────────────────────────────

export async function nubraFetch<T = unknown>(
  path: string,
  session: NubraSession,
  options: { method?: 'GET' | 'POST'; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const url = new URL(path, baseUrl() + '/').toString();
  const res = await fetch(url, {
    method:  options.method || 'GET',
    headers: authHeaders(session),
    body:    options.body !== undefined ? JSON.stringify(options.body) : undefined,
    signal:  AbortSignal.timeout(options.timeoutMs ?? 25_000),
  });
  const text = await res.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!res.ok) {
    const p = payload as Record<string, unknown> | null;
    const detail = p?.error || p?.message || res.statusText;
    throw new NubraDataError(`${res.status}: ${detail}`, res.status);
  }
  return payload as T;
}

// ─── Unit helpers ─────────────────────────────────────────────────────────────

export function pointMs(point: unknown): number | null {
  const p = point as { ts?: unknown; timestamp?: unknown };
  const ts = Number(p?.ts ?? p?.timestamp);
  return Number.isFinite(ts) ? Math.floor(ts / 1_000_000) : null;
}

export function toRupees(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n / 100 : null;
}

export function pointNumber(point: unknown, rupeeValue = false): number {
  const p = point as { v?: unknown; value?: unknown };
  const raw = p?.v ?? p?.value;
  const value = rupeeValue ? toRupees(raw) : Number(raw);
  return Number.isFinite(value) ? (value as number) : 0;
}

export function extractSymbolData(
  data: unknown,
  symbol: string,
): Record<string, unknown> | null {
  const d = data as { result?: Array<{ values?: Array<Record<string, unknown>> }> };
  const result = d?.result?.[0]?.values || [];
  for (const entry of result) {
    if (entry[symbol]) return entry[symbol] as Record<string, unknown>;
    const firstKey = Object.keys(entry)[0];
    if (firstKey) return entry[firstKey] as Record<string, unknown>;
  }
  return null;
}

export function symbolDataHasPoints(symData: unknown): boolean {
  if (!symData || typeof symData !== 'object') return false;
  return Object.values(symData as Record<string, unknown>).some(
    (arr) => Array.isArray(arr) && arr.length,
  );
}

// ─── Refdata (instrument list) ────────────────────────────────────────────────
//
// All refdata now flows through instrumentCache — downloaded once on login,
// served from memory (or disk on restart) for every subsequent call.

import { getCachedRefdata } from './instrumentCache.js';

import { logger } from './logger.js';

const log = logger('nubra');

/**
 * Return the CE/PE rows for `symbol` on `date`.
 *
 * Reads from the instrument cache — the day's instrument list is downloaded
 * once (on login) and served from memory/disk afterwards, so this makes no
 * Nubra call on the hot path. Parsing (aliases, paise→rupee strikes, expiry
 * normalisation) lives in instrumentCache.parseRows.
 */
export async function rollingOptionRows(opts: {
  symbol: string;
  exchange?: string;
  date?: string;
  session: NubraSession;
}): Promise<OptionRow[]> {
  const { symbol, exchange = 'NSE', session } = opts;
  const day = (opts.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const sym = String(symbol).trim().toUpperCase();

  const rows = await getCachedRefdata(exchange, day, session);

  const out: OptionRow[] = [];
  for (const r of rows) {
    if (r.asset !== sym) continue;
    if (r.type !== 'OPT') continue;
    if (r.optionType !== 'CE' && r.optionType !== 'PE') continue;
    if (!r.expiry || !r.name || r.strike == null || !Number.isFinite(r.strike)) continue;
    out.push({
      name:    r.name,
      aliases: r.aliases,
      refId:   r.refId,
      expiry:  r.expiry,
      side:    r.optionType,
      strike:  r.strike,
    });
  }
  return out;
}

// ─── Timeseries ───────────────────────────────────────────────────────────────

interface TimeseriesQuery {
  exchange: string;
  type: string;
  values: string[];
  fields: string[];
  startDate: string;
  endDate: string;
  intraDay?: boolean;
  realTime?: boolean;
  interval?: string;
}

export async function fetchTimeseriesWithIntervals(
  query: Omit<TimeseriesQuery, 'interval'>,
  intervals: readonly string[],
  session: NubraSession,
): Promise<{ data: unknown; interval: string }> {
  let lastError: unknown = null;
  for (const interval of intervals) {
    try {
      const data = await nubraFetch('charts/timeseries', session, {
        method: 'POST',
        body:   { query: [{ ...query, interval }] },
      });
      return { data, interval };
    } catch (err) {
      lastError = err;
      if (!String((err as Error)?.message || '').startsWith('400:')) throw err;
    }
  }
  throw lastError || new NubraDataError('No supported chart interval returned data.', 502);
}

// ─── Option series parser ─────────────────────────────────────────────────────

export function parseRollingSeriesValues(
  values: unknown[],
  seriesByName: Map<string, NubraOptionSeries>,
  aliasToCanonical: Map<string, string>,
): void {
  for (const entry of values) {
    for (const [name, symData] of Object.entries(entry as Record<string, unknown>)) {
      const keyName = String(name || '').toUpperCase();
      if (!symbolDataHasPoints(symData)) continue;
      const canonicalName = aliasToCanonical.get(keyName) || keyName;

      const sd = symData as Record<string, unknown>;
      const parsePoints = (arr: unknown, rupee = false): NubraPoint[] =>
        (Array.isArray(arr) ? arr : [])
          .map((p) => ({ ts: pointMs(p)!, v: pointNumber(p, rupee) }))
          .filter((p) => Number.isFinite(p.ts) && Number.isFinite(p.v))
          .sort((a, b) => a.ts - b.ts);

      const close = parsePoints(sd?.close, true);
      const open  = parsePoints(sd?.open,  true);
      const bid   = parsePoints(sd?.l1bid, true);
      const ask   = parsePoints(sd?.l1ask, true);
      const priceFallback = close.length ? close : open;

      const series: NubraOptionSeries = {
        bid:   bid.length ? bid : priceFallback,
        ask:   ask.length ? ask : priceFallback,
        ltp:   close.length ? close : open,
        ivBid: parsePoints(sd?.iv_bid, false),
        ivAsk: parsePoints(sd?.iv_ask, false),
        ivMid: parsePoints(sd?.iv_mid, false),
        // Greeks stay in feed units — see NubraOptionSeries.
        delta: parsePoints(sd?.delta, false),
        gamma: parsePoints(sd?.gamma, false),
        vega:  parsePoints(sd?.vega,  false),
        theta: parsePoints(sd?.theta, false),
        // Counts, so the rupee flag stays off. `cumulative_oi` is the
        // documented field name; `oi` is accepted by the endpoint and answers
        // with nothing, which is how it was missed the first time.
        oi:     parsePoints(sd?.cumulative_oi, false),
        volume: parsePoints(sd?.cumulative_volume, false),
      };

      if ((series.bid.length || series.ask.length) && !seriesByName.has(canonicalName)) {
        seriesByName.set(canonicalName, series);
      }
      if ((series.bid.length || series.ask.length) && !seriesByName.has(keyName)) {
        seriesByName.set(keyName, series);
      }
    }
  }
}

// ─── Rolling series fetcher ───────────────────────────────────────────────────

/** Quote fields — the set this endpoint has always been asked for. */
const QUOTE_FIELDS = ['l1bid', 'l1ask', 'iv_bid', 'iv_ask', 'close'] as const;

/**
 * Greeks are requested per call, never by default.
 *
 * `vega` and `delta` are known-good on charts/timeseries — the reference
 * implementation requests exactly those two. `theta` and `gamma` are only
 * confirmed on the live socket, so asking for them here is an assumption, and
 * an unrecognised field name 400s the WHOLE batch rather than being ignored.
 *
 * Hence `greeksUnsupported` below: the first 400 that survives a retry without
 * greeks latches the flag, every later batch skips them, and the straddle chart
 * degrades to exactly its previous behaviour instead of failing outright. The
 * cost of being wrong is one wasted request per process, not a broken page.
 */
export type GreekFieldName = 'delta' | 'gamma' | 'vega' | 'theta';

/**
 * Non-greek extras, and the wire names they map to.
 *
 * `cumulative_oi` is the OI a contract carries, sampled per bar — not a change
 * and not an aggregate over the chain, despite the "cumulative" prefix, which
 * on this endpoint means "state as of this bar" rather than "sum since open".
 * Verified against the live feed: NIFTY 23950 CE walked 64,220 to 420,875 over
 * one session in 363 distinct steps.
 *
 * These are requested separately from the greeks because their availability
 * windows differ: measured on this feed, OI reaches back at least 180 days at
 * 1m while feed gamma stops after roughly a month. A caller wanting a
 * historical OI ladder must be able to ask for OI alone.
 */
export type ExtraFieldName = 'oi' | 'volume';

const EXTRA_WIRE: Record<ExtraFieldName, string> = {
  oi: 'cumulative_oi',
  volume: 'cumulative_volume',
};

/**
 * Latched when the feed proves it will not serve GREEK_FIELDS. Process-wide and
 * deliberately never reset: the answer is a property of the endpoint, not of a
 * request, so re-probing it on every batch would repeat the failure ~9 times a
 * session for a result already known.
 */
let greeksUnsupported = false;

async function fetchRollingBatch(opts: {
  batch: string[];
  start: string;
  end: string;
  interval: string;
  exchange: string;
  session: NubraSession;
  greeks?: readonly GreekFieldName[];
  extras?: readonly ExtraFieldName[];
}): Promise<unknown[]> {
  const { batch, start, end, interval, exchange, session } = opts;
  const asked = opts.greeks ?? [];
  /*
   * Extras ride on EVERY attempt, including the no-greeks retry.
   *
   * The greek retry exists because a 400 may be the greek field names; OI is a
   * different field family with a different availability window, and dropping
   * it alongside the greeks would silently return a session with no OI on any
   * contract older than the greek window — which is precisely the case the OI
   * history is wanted for.
   */
  const extraWire = (opts.extras ?? []).map((e) => EXTRA_WIRE[e]);
  const build = (withGreeks: boolean) => ({
    exchange, type: 'OPT', values: batch,
    fields: [
      ...QUOTE_FIELDS,
      ...(withGreeks && asked.length ? asked : []),
      ...extraWire,
    ],
    startDate: start, endDate: end, intraDay: false, realTime: false,
  });

  const hasPoints = (values: unknown[]) =>
    values.some((e) => Object.values(e as object).some(symbolDataHasPoints));

  const wantGreeks = asked.length > 0 && !greeksUnsupported;

  const attempt = async (withGreeks: boolean, iv: string): Promise<unknown[] | null> => {
    const { data } = await fetchTimeseriesWithIntervals(build(withGreeks), [iv], session);
    const values = (data as { result?: Array<{ values?: unknown[] }> })?.result?.[0]?.values || [];
    return hasPoints(values as unknown[]) ? values as unknown[] : null;
  };

  try {
    const hit = await attempt(wantGreeks, interval);
    if (hit) return hit;
  } catch (err) {
    const is400 = String((err as Error)?.message || '').startsWith('400:');

    // A 400 while asking for greeks is ambiguous — it may be the interval or it
    // may be the field names. Retrying the same interval WITHOUT greeks
    // separates the two: if that succeeds, the fields were the problem.
    if (is400 && wantGreeks) {
      try {
        const hit = await attempt(false, interval);
        greeksUnsupported = true;
        log.warn('charts/timeseries rejected greek fields — continuing without them');
        if (hit) return hit;
      } catch { /* not the greeks; fall through to the interval fallback */ }
    }

    if (is400 && interval === '1s') {
      const { data } = await fetchTimeseriesWithIntervals(build(asked.length > 0 && !greeksUnsupported), ['1m'], session);
      const values = (data as { result?: Array<{ values?: unknown[] }> })?.result?.[0]?.values || [];
      if (hasPoints(values as unknown[])) {
        return values as unknown[];
      }
    } else {
      throw err;
    }
  }
  return [];
}

/**
 * Fetch bid/ask/iv series for a list of option symbols.
 *
 * Symbols go out in batches of 8 (Nubra's hard per-request cap), but the batches
 * themselves run through a bounded worker pool instead of one-at-a-time, so wall
 * time is roughly ceil(batches / ROLLING_CONCURRENCY) round-trips rather than the
 * sum of all of them. Each batch retries on burst/transient failures, and a batch
 * that still fails only loses its own 8 symbols.
 *
 * `fallbackAliases` (canonical -> alternate names) lets the caller request one
 * name per option up front and only pay for alternates that are actually needed:
 * a second pooled pass retries alternates for canonicals that came back empty.
 * Sending every alias up front multiplies the batch count 2-4x for no data.
 *
 * Returns Map<symbolName, NubraOptionSeries>.
 */
export async function fetchRollingSeries(opts: {
  names: string[];
  start: string;
  end: string;
  interval: string;
  exchange: string;
  aliasToCanonical?: Map<string, string>;
  fallbackAliases?: Map<string, string[]>;
  session: NubraSession;
  /** Greeks to request. Omitted = none; see GreekFieldName for why it matters. */
  greeks?: readonly GreekFieldName[];
  /** OI and volume. Omitted = none; see ExtraFieldName. */
  extras?: readonly ExtraFieldName[];
}): Promise<Map<string, NubraOptionSeries>> {
  const { names, start, end, interval, exchange, session, greeks, extras } = opts;
  const aliasToCanonical = opts.aliasToCanonical ?? new Map<string, string>();
  const seriesByName = new Map<string, NubraOptionSeries>();
  let firstError: unknown = null;

  const fetchPooled = async (wanted: string[]): Promise<void> => {
    const unique = [...new Set(wanted)];
    if (!unique.length) return;

    const batches: string[][] = [];
    for (let i = 0; i < unique.length; i += ROLLING_BATCH_SIZE) {
      batches.push(unique.slice(i, i + ROLLING_BATCH_SIZE));
    }

    await runPool(
      batches.map((batch) => async () => {
        try {
          const values = await withRetry(
            () => fetchRollingBatch({ batch, start, end, interval, exchange, session, greeks, extras }),
          );
          // Synchronous, so concurrent batches can't interleave inside it.
          parseRollingSeriesValues(values, seriesByName, aliasToCanonical);
        } catch (err) {
          firstError ??= err;
        }
      }),
      ROLLING_CONCURRENCY,
    );
  };

  await fetchPooled(names);

  // Second pass — only for options the canonical name didn't resolve.
  const fallback = opts.fallbackAliases;
  if (fallback?.size) {
    const retryNames: string[] = [];
    for (const [canonical, aliases] of fallback) {
      if (seriesByName.has(canonical)) continue;
      for (const alias of aliases) {
        if (alias !== canonical && !seriesByName.has(alias)) retryNames.push(alias);
      }
    }
    if (retryNames.length) await fetchPooled(retryNames);
  }

  if (!seriesByName.size && firstError) throw firstError;
  return seriesByName;
}
