/**
 * Multi-day straddle backtest API:
 *   GET  /api/backtest/stream        ?symbol=&exchange=&from=&to=&…   (SSE)
 *   POST /api/backtest/run           { symbol, exchange?, from, to, … }
 *   GET  /api/backtest/cache-status
 *   POST /api/backtest/cache-clear   { prefix? }
 *
 * The SSE endpoint is the one the UI uses: a cold 60-day run takes minutes and
 * a single POST would sit silent behind proxy and browser idle timeouts. /run
 * exists for scripts and for ranges already warm in the day cache.
 */

import { route, readJSON, ApiError, errorStatus, errorBody } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { FeedError } from '../feeds/errors.js';
import {
  runBacktest, backtestCacheStats, clearBacktestCache,
  type BacktestOptions, type ExpiryRule,
} from '../engine/backtest.js';

// ─── Param parsing ────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Widest range accepted in one call — a guard against an accidental decade. */
const MAX_RANGE_DAYS = 400;

interface RawParams {
  symbol?: unknown; exchange?: unknown; from?: unknown; to?: unknown;
  expiryRule?: unknown; minDte?: unknown; maxDte?: unknown;
  interval?: unknown; concurrency?: unknown; refresh?: unknown;
}

function parseParams(raw: RawParams): Omit<BacktestOptions, 'feed'> {
  const symbol = String(raw.symbol || '').trim().toUpperCase();
  const from   = String(raw.from   || '').trim();
  const to     = String(raw.to     || '').trim();

  if (!symbol) throw new ApiError('symbol is required', 400);
  if (!DATE_RE.test(from)) throw new ApiError('from must be YYYY-MM-DD', 400);
  if (!DATE_RE.test(to))   throw new ApiError('to must be YYYY-MM-DD', 400);

  const spanDays = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`))
    / 86_400_000;
  if (!Number.isFinite(spanDays) || spanDays < 0) {
    throw new ApiError('to must be on or after from', 400);
  }
  if (spanDays > MAX_RANGE_DAYS) {
    throw new ApiError(
      `Range of ${Math.round(spanDays)} days exceeds the ${MAX_RANGE_DAYS}-day limit. `
      + 'Run it in slices — cached days make later slices cheap.',
      400,
    );
  }

  const rule = String(raw.expiryRule || 'front').trim() as ExpiryRule;
  if (rule !== 'front' && rule !== 'min-dte') {
    throw new ApiError("expiryRule must be 'front' or 'min-dte'", 400);
  }

  const num = (v: unknown): number | undefined => {
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  return {
    symbol,
    exchange:    String(raw.exchange || 'NSE').trim().toUpperCase(),
    from, to,
    expiryRule:  rule,
    minDte:      num(raw.minDte) ?? 0,
    maxDte:      num(raw.maxDte),
    interval:    String(raw.interval || '1m').trim(),
    concurrency: num(raw.concurrency),
    refresh:     raw.refresh === true || raw.refresh === 'true' || raw.refresh === '1',
  };
}

// ─── POST /api/backtest/run ───────────────────────────────────────────────────

route('POST', '/api/backtest/run', async (req) => {
  const feed   = await activeFeed();
  const body   = await readJSON<RawParams>(req);
  const params = parseParams(body);
  return runBacktest({ ...params, feed });
});

// ─── GET /api/backtest/stream (SSE) ───────────────────────────────────────────
//
// Events:
//   progress { stage, pct, message, done, total }
//   result   { ...BacktestResult }
//   error    { message }

route('GET', '/api/backtest/stream', async (_req, res, { query }) => {
  let params: Omit<BacktestOptions, 'feed'>;
  let feed;

  // Validation happens BEFORE the SSE headers go out, so a bad request is a
  // real 400 the browser surfaces rather than a 200 stream carrying an error.
  try {
    feed   = await activeFeed();
    params = parseParams({
      symbol:      query.get('symbol'),
      exchange:    query.get('exchange'),
      from:        query.get('from'),
      to:          query.get('to'),
      expiryRule:  query.get('expiryRule'),
      minDte:      query.get('minDte'),
      maxDte:      query.get('maxDte'),
      interval:    query.get('interval'),
      concurrency: query.get('concurrency'),
      refresh:     query.get('refresh'),
    });
  } catch (err) {
    res.writeHead(errorStatus(err), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(errorBody(err)));
    return;
  }

  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache, no-store',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });

  const emit = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const pingTimer = setInterval(() => {
    if (res.writableEnded) { clearInterval(pingTimer); return; }
    res.write(': ping\n\n');
  }, 15_000);

  // A long run left dangling after the user navigates away keeps hammering
  // Nubra for nothing. There is no cancellation token through the engine, but
  // dropping the emitter at least stops the writes and surfaces the abandon.
  let aborted = false;
  res.on('close', () => { aborted = true; });

  try {
    const result = await runBacktest(
      { ...params, feed },
      (p) => { if (!aborted) emit('progress', p); },
    );
    emit('result', result);
  } catch (err) {
    emit('error', {
      message: (err as Error)?.message || 'Backtest failed',
      ...(err instanceof FeedError
        ? { code: err.code === 'AUTH' ? 'FEED_AUTH_REQUIRED' : `FEED_${err.code}`, feed: err.feedId }
        : {}),
    });
  } finally {
    clearInterval(pingTimer);
    if (!res.writableEnded) res.end();
  }
});

// ─── Cache routes ─────────────────────────────────────────────────────────────

route('GET', '/api/backtest/cache-status', () => {
  const stats = backtestCacheStats();
  return {
    status: true,
    ...stats,
    mb: Number((stats.bytes / (1024 * 1024)).toFixed(2)),
  };
});

route('POST', '/api/backtest/cache-clear', async (req) => {
  const body   = await readJSON<{ prefix?: string }>(req);
  const prefix = body.prefix ? String(body.prefix).trim() : undefined;
  const removed = clearBacktestCache(prefix);
  return { status: true, removed, prefix: prefix ?? '(all)' };
});
