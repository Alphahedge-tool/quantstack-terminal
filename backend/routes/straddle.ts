/**
 * Rolling Straddle API routes:
 *   GET  /api/straddle/expiries         ?symbol=&exchange=&date=
 *   GET  /api/straddle/snapshot         ?symbol=&exchange=&date=&expiries=exp1,exp2,...
 *   POST /api/straddle/history          { symbol, exchange?, expiry?, date? }
 *   GET  /api/straddle/risk-reversal    ?symbol=&exchange=&expiry=&date=&delta=&tol=
 *   GET  /api/straddle/status           → session summary
 *   GET  /api/straddle/cache-status     → cache entries + hit rate
 *   POST /api/straddle/cache-invalidate { symbol, exchange, expiry, date }
 */

import { route, readJSON, ApiError } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { FeedError } from '../feeds/errors.js';
import { withProvenance } from '../feeds/router.js';
import { normalizeExpiry } from '../feeds/identity.js';
import { sessionStatus } from '../lib/sessionStore.js';
import { computeRollingStraddle, latestTradingDate } from '../engine/rollingStraddle.js';
import {
  computeBandGreeks, DEFAULT_DELTA_MIN, DEFAULT_DELTA_MAX,
} from '../engine/bandGreeks.js';
import { atmSnapshot } from '../engine/atmSnapshot.js';
import {
  computeRiskReversal, DEFAULT_TARGET_DELTA, DEFAULT_DELTA_TOLERANCE,
} from '../engine/riskReversal.js';
import {
  catchUpBandGreeks, catchUpRiskReversal, catchUpStraddle, needsCatchUp,
} from '../engine/straddleCatchUp.js';
import {
  cacheKey, getComputed, setComputed, invalidate, cacheStatus,
} from '../lib/computeCache.js';

// ── Hit / miss counters (for diagnostics) ─────────────────────────────────
let hits = 0, misses = 0;

// GET /api/straddle/expiries
route('GET', '/api/straddle/expiries', async (_req, _res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = query.get('symbol');
  const exchange = query.get('exchange') || 'NSE';
  const date     = query.get('date')     || latestTradingDate();
  if (!symbol) throw new ApiError('symbol is required', 400);

  const expiries = await feed.expiries(symbol, exchange, date);
  return { status: true, symbol, exchange, date, expiries };
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/straddle/snapshot?symbol=NIFTY&exchange=NSE&date=2026-08-10&expiries=2026-08-14,2026-08-21
//
// Lightweight endpoint for the multi-expiry overlay panel. Returns the last
// data point (ATM straddle price, IV, synthetic future) for each requested
// expiry without streaming the full time series.
//
// For each expiry:
//   1. If the session is already in the compute cache, extract the last point.
//   2. Otherwise, compute the full session (it gets cached for future calls).
// ─────────────────────────────────────────────────────────────────────────────
route('GET', '/api/straddle/snapshot', async (_req, _res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = String(query.get('symbol')   || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const date     = String(query.get('date')     || latestTradingDate()).trim();
  const rawList  = String(query.get('expiries') || '').trim();

  if (!symbol)  throw new ApiError('symbol is required', 400);
  if (!rawList) throw new ApiError('expiries is required', 400);

  const expiryList = rawList
    .split(',')
    .map((e) => normalizeExpiry(e.trim()))
    .filter((e): e is string => !!e);

  if (!expiryList.length) throw new ApiError('No valid expiries provided', 400);

  // Superset of AtmSnapshot: the cache-hit path reads a charted session's last
  // point, which carries no `spot`/`ts` of its own, so both are optional here.
  interface Snapshot {
    expiry:           string;
    straddleMid:      number | null;
    straddleBid:      number | null;
    straddleAsk:      number | null;
    iv:               number | null;
    atmStrike:        number | null;
    syntheticFuture:  number | null;
    spot?:            number | null;
    ts?:              number | null;
    error?:           string;
  }

  const snapshots: Snapshot[] = [];

  // Process expiries concurrently (but with a reasonable cap)
  const tasks = expiryList.map(async (expiry): Promise<Snapshot> => {
    const key = cacheKey(symbol, exchange, expiry, date);

    // ── Cache hit: extract last point ─────────────────────────────────────
    const cached = getComputed(key);
    if (cached?.points?.length) {
      const last = cached.points[cached.points.length - 1];
      return {
        expiry,
        straddleMid:     last.straddlePrice ?? null,
        straddleBid:     last.straddleBid   ?? null,
        straddleAsk:     last.straddleAsk   ?? null,
        iv:              last.iv            ?? null,
        atmStrike:       last.atmStrike     ?? null,
        syntheticFuture: last.syntheticFuture ?? null,
      };
    }

    // ── Cache miss: read the ATM directly ─────────────────────────────────
    //
    // This used to run the full rolling engine and take the last point — one
    // number for a ~22k-point session walk across every strike the spot
    // visited. Callers ask for several expiries at once (the compare panel, the
    // term-structure view), so a cold request meant several full sessions
    // computed serially before anything rendered. atmSnapshot answers the same
    // question over a short end-of-session window with ten contracts, and
    // deliberately does NOT populate the session cache: a snapshot is not a
    // session, and writing a stub under that key would make the chart's own
    // request a cache hit on data it cannot draw.
    try {
      return await atmSnapshot({ symbol, exchange, date, expiry, feed });
    } catch (err) {
      // Don't let one failing expiry kill the whole response
      return {
        expiry,
        straddleMid: null, straddleBid: null, straddleAsk: null,
        iv: null, atmStrike: null, syntheticFuture: null,
        error: (err as Error)?.message || 'Snapshot failed',
      };
    }
  });

  const results = await Promise.all(tasks);
  for (const snap of results) snapshots.push(snap);

  return { status: true, symbol, exchange, date, snapshots };
});

// POST /api/straddle/history
// Body: { symbol, exchange?, expiry?, date? }
route('POST', '/api/straddle/history', async (req) => {
  const feed    = await activeFeed();
  const body    = await readJSON<{
    symbol?: string; exchange?: string; expiry?: string; date?: string;
  }>(req);

  const symbol   = String(body.symbol   || '').trim().toUpperCase();
  const exchange = String(body.exchange || 'NSE').trim().toUpperCase();
  // Normalised before it reaches the cache key: a client sending 20260811 and
  // one sending 2026-08-11 mean the same contract and must share one entry.
  const expiry   = normalizeExpiry(String(body.expiry || '').trim()) ?? '';
  const date     = String(body.date     || latestTradingDate()).trim();

  if (!symbol) throw new ApiError('symbol is required', 400);

  // ── Cache lookup ─────────────────────────────────────────────────────────
  const key    = cacheKey(symbol, exchange, expiry, date);
  const cached = getComputed(key);
  if (cached) {
    hits++;
    // One-shot JSON has nowhere to stream a tail into, so the top-up happens
    // before the response rather than after it. The SSE route (/stream, what
    // the chart uses) sends the cached session first and appends instead.
    let payload = cached;
    if (needsCatchUp(cached, date, exchange)) {
      try {
        const tail = await catchUpStraddle(cached, { symbol, exchange, expiry, date, feed });
        if (tail) {
          setComputed(key, tail.merged, date);
          payload = tail.merged;
        }
      } catch (err) {
        console.warn(`[straddle] catch-up failed for ${key}:`, (err as Error)?.message);
      }
    }
    // Surface cache hit to caller
    return { ...payload, _cache: 'HIT', _hitRate: `${hits}/${hits + misses}` };
  }
  misses++;

  // ── Cache miss → compute ─────────────────────────────────────────────────
  console.log(`[straddle] MISS ${key} — computing…`);
  const t0 = Date.now();
  const { result, provenance } = await withProvenance(
    () => computeRollingStraddle({ symbol, exchange, expiry, date, feed }),
  );

  if (!result.status) throw new ApiError(result.message as string, 404);

  // Store in cache (TTL depends on whether date is today or historical)
  setComputed(key, result, date);

  const elapsed = Date.now() - t0;
  console.log(`[straddle] DONE ${key} in ${elapsed}ms — ${result.points.length} pts`);

  return {
    ...result,
    _cache: 'MISS',
    _computeMs: elapsed,
    _feed: provenance.feeds.join('+') || null,
    ...(provenance.mixed    ? { _failedOver: true }             : {}),
    ...(provenance.degraded ? { _degraded: provenance.degraded } : {}),
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/straddle/band-greeks?symbol=&exchange=&expiry=&date=&dMin=&dMax=
//
// Delta-band vega & theta on the rolling ATM. Server-Sent Events, same shape as
// /stream — the band walk fetches 60–100 contracts, which is well past what a
// request should sit silent through.
//
// The delta band is part of the cache key: 0.05–0.60 and 0.20–0.40 are
// different baskets over the same session and must not share an entry.
// ─────────────────────────────────────────────────────────────────────────────
route('GET', '/api/straddle/band-greeks', async (_req, res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = String(query.get('symbol')   || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const expiry   = normalizeExpiry(String(query.get('expiry') || '').trim()) ?? '';
  const date     = String(query.get('date')     || latestTradingDate()).trim();

  // A non-numeric or out-of-range band falls back to the default rather than
  // producing an empty basket the caller cannot explain.
  const band = (raw: string | null, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
  };
  const deltaMin = band(query.get('dMin'), DEFAULT_DELTA_MIN);
  const deltaMax = band(query.get('dMax'), DEFAULT_DELTA_MAX);

  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('symbol is required');
    return;
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection':    'keep-alive',
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

  try {
    // Same cache → top-up order as /stream: the cached basket is drawn first,
    // then the bars since it was written are walked and appended.
    const key = `${cacheKey(symbol, exchange, expiry, date)}|band:${deltaMin}-${deltaMax}`;
    const cached = getComputed(key);
    if (cached) {
      hits++;
      // `resume` is what makes a tail walk correct here; an entry cached before
      // it existed has to be recomputed in full rather than continued.
      const catchingUp = Boolean(cached.resume) && needsCatchUp(cached, date, exchange);
      emit('progress', { stage: 'cache', pct: 100, message: 'Loaded from cache' });
      emit('result',   { ...cached, _cache: 'HIT', _catchUp: catchingUp });

      if (catchingUp) {
        emit('progress', { stage: 'catchup', pct: 100, message: 'Checking for new bars…' });
        try {
          const tail = await catchUpBandGreeks(cached, {
            symbol, exchange, expiry, date, feed, deltaMin, deltaMax,
          });
          if (tail) {
            setComputed(key, tail.merged, date);
            emit('append', {
              points:    tail.points,
              rollCount: tail.merged.rollCount,
              coverage:  tail.merged.coverage,
              legsUsed:  tail.merged.legsUsed,
              _computeMs: tail.computeMs,
            });
          } else {
            emit('append', { points: [] });
          }
        } catch (err) {
          console.warn(`[bandGreeks] catch-up failed for ${key}:`, (err as Error)?.message);
          emit('append', { points: [], _error: (err as Error)?.message || 'Catch-up failed' });
        }
      }

      res.end();
      clearInterval(pingTimer);
      return;
    }
    misses++;

    emit('progress', { stage: 'init', pct: 5, message: `Starting ${symbol} band greeks…` });

    const t0 = Date.now();
    const { result, provenance } = await withProvenance(() => computeBandGreeks(
      { symbol, exchange, expiry, date, deltaMin, deltaMax, feed },
      (stage, pct, message) => emit('progress', { stage, pct, message }),
    ));

    if (!result.status) {
      emit('error', { message: result.message });
      res.end();
      clearInterval(pingTimer);
      return;
    }

    setComputed(key, result, date);

    emit('progress', { stage: 'done', pct: 100, message: 'Complete' });
    emit('result', {
      ...result,
      _cache: 'MISS',
      _computeMs: Date.now() - t0,
      _feed: provenance.feeds.join('+') || null,
      ...(provenance.mixed    ? { _failedOver: true }              : {}),
      ...(provenance.degraded ? { _degraded: provenance.degraded } : {}),
    });
    res.end();

  } catch (err) {
    emit('error', {
      message: (err as Error)?.message || 'Internal error',
      ...(err instanceof FeedError
        ? { code: err.code === 'AUTH' ? 'FEED_AUTH_REQUIRED' : `FEED_${err.code}`, feed: err.feedId }
        : {}),
    });
    res.end();
  } finally {
    clearInterval(pingTimer);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/straddle/risk-reversal?symbol=&exchange=&expiry=&date=&delta=&tol=
//
// Risk-reversal skew: (IV of the OTM put − IV of the OTM call) / ATM IV, with
// both wings picked at a target delta. Server-Sent Events, same shape as
// /band-greeks — the walk fetches ~34 contracts and inverts vols per bar, which
// is more than a request should sit silent through.
//
// The target delta is part of the cache key: a 0.25 risk reversal and a 0.10 one
// are different measurements over the same session and must not share an entry.
// ─────────────────────────────────────────────────────────────────────────────
route('GET', '/api/straddle/risk-reversal', async (_req, res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = String(query.get('symbol')   || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const expiry   = normalizeExpiry(String(query.get('expiry') || '').trim()) ?? '';
  const date     = String(query.get('date')     || latestTradingDate()).trim();

  // A delta outside (0, 1) is not a wing at all, so it falls back rather than
  // producing a series of nulls the caller cannot explain.
  const unit = (raw: string | null, fallback: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
  };
  const targetDelta = unit(query.get('delta'), DEFAULT_TARGET_DELTA);
  const tolerance   = unit(query.get('tol'),   DEFAULT_DELTA_TOLERANCE);

  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('symbol is required');
    return;
  }

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection':    'keep-alive',
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

  try {
    // Same cache → top-up order as /stream and /band-greeks: the cached session
    // is drawn first, then the bars since it was written are walked and appended.
    const key = `${cacheKey(symbol, exchange, expiry, date)}|rr:${targetDelta}-${tolerance}`;
    const cached = getComputed(key);
    if (cached) {
      hits++;
      const catchingUp = Boolean(cached.resume) && needsCatchUp(cached, date, exchange);
      emit('progress', { stage: 'cache', pct: 100, message: 'Loaded from cache' });
      emit('result',   { ...cached, _cache: 'HIT', _catchUp: catchingUp });

      if (catchingUp) {
        emit('progress', { stage: 'catchup', pct: 100, message: 'Checking for new bars…' });
        try {
          const tail = await catchUpRiskReversal(cached, {
            symbol, exchange, expiry, date, feed, targetDelta, tolerance,
          });
          if (tail) {
            setComputed(key, tail.merged, date);
            emit('append', {
              points:      tail.points,
              rollCount:   tail.merged.rollCount,
              coverage:    tail.merged.coverage,
              feedIvShare: tail.merged.feedIvShare,
              _computeMs:  tail.computeMs,
            });
          } else {
            emit('append', { points: [] });
          }
        } catch (err) {
          console.warn(`[riskReversal] catch-up failed for ${key}:`, (err as Error)?.message);
          emit('append', { points: [], _error: (err as Error)?.message || 'Catch-up failed' });
        }
      }

      res.end();
      clearInterval(pingTimer);
      return;
    }
    misses++;

    emit('progress', { stage: 'init', pct: 5, message: `Starting ${symbol} skew…` });

    const t0 = Date.now();
    const { result, provenance } = await withProvenance(() => computeRiskReversal(
      { symbol, exchange, expiry, date, targetDelta, tolerance, feed },
      (stage, pct, message) => emit('progress', { stage, pct, message }),
    ));

    if (!result.status) {
      emit('error', { message: result.message });
      res.end();
      clearInterval(pingTimer);
      return;
    }

    setComputed(key, result, date);

    emit('progress', { stage: 'done', pct: 100, message: 'Complete' });
    emit('result', {
      ...result,
      _cache: 'MISS',
      _computeMs: Date.now() - t0,
      _feed: provenance.feeds.join('+') || null,
      ...(provenance.mixed    ? { _failedOver: true }              : {}),
      ...(provenance.degraded ? { _degraded: provenance.degraded } : {}),
    });
    res.end();

  } catch (err) {
    emit('error', {
      message: (err as Error)?.message || 'Internal error',
      ...(err instanceof FeedError
        ? { code: err.code === 'AUTH' ? 'FEED_AUTH_REQUIRED' : `FEED_${err.code}`, feed: err.feedId }
        : {}),
    });
    res.end();
  } finally {
    clearInterval(pingTimer);
  }
});

// GET /api/straddle/status
route('GET', '/api/straddle/status', () => {
  return { status: true, session: sessionStatus() };
});

// GET /api/straddle/cache-status
route('GET', '/api/straddle/cache-status', () => {
  return {
    status: true,
    hits,
    misses,
    hitRate: hits + misses === 0 ? '0%' : `${((hits / (hits + misses)) * 100).toFixed(1)}%`,
    ...cacheStatus(),
  };
});

// POST /api/straddle/cache-invalidate
// Force re-fetch (e.g. after market hours to get final data)
route('POST', '/api/straddle/cache-invalidate', async (req) => {
  const body = await readJSON<{
    symbol?: string; exchange?: string; expiry?: string; date?: string;
  }>(req);

  if (!body.symbol) throw new ApiError('symbol is required', 400);

  const key = cacheKey(
    String(body.symbol   || '').toUpperCase(),
    String(body.exchange || 'NSE').toUpperCase(),
    String(body.expiry   || ''),
    String(body.date     || ''),
  );
  invalidate(key);
  return { status: true, invalidated: key };
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/straddle/stream?symbol=NIFTY&exchange=NSE&expiry=20260811&date=2026-08-07
//
// Server-Sent Events (SSE) endpoint.
// Emits a stream of progress events then the final result — so the browser can
// show "Fetching spot data…" → "Computing straddle…" → chart renders.
//
// Event types:
//   progress  { stage, pct }        — e.g. { stage: 'spot', pct: 20 }
//   result    { ...straddleResult } — the full payload (same as POST /history)
//   error     { message }           — if something went wrong
// ─────────────────────────────────────────────────────────────────────────────
route('GET', '/api/straddle/stream', async (req, res, { query }) => {
  const feed     = await activeFeed();
  const symbol   = String(query.get('symbol')   || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const expiry   = normalizeExpiry(String(query.get('expiry') || '').trim()) ?? '';
  const date     = String(query.get('date')     || latestTradingDate()).trim();

  if (!symbol) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('symbol is required');
    return;
  }

  // SSE headers — no buffering, keep connection alive
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',             // Disable Nginx buffering if proxied
    'Access-Control-Allow-Origin': '*',
  });

  /** Emit one SSE event */
  const emit = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Keep-alive ping every 15s so the connection doesn't time out
  const pingTimer = setInterval(() => {
    if (res.writableEnded) { clearInterval(pingTimer); return; }
    res.write(': ping\n\n');
  }, 15_000);

  try {
    // ── Cache hit: draw the cached session, then top it up ────────────────
    //
    // Order matters, and it is the whole point of this branch: the cached
    // session goes out first so the chart is on screen immediately, and only
    // then are the bars since it was cached fetched and appended. The client
    // opens the live socket after the `append`, so the live line continues from
    // the real present instead of from wherever the cache happened to stop.
    const key    = cacheKey(symbol, exchange, expiry, date);
    const cached = getComputed(key);
    if (cached) {
      hits++;
      const catchingUp = needsCatchUp(cached, date, exchange);
      emit('progress', { stage: 'cache', pct: 100, message: 'Loaded from cache' });
      emit('result',   { ...cached, _cache: 'HIT', _catchUp: catchingUp });

      // Exactly one `append` follows whenever `_catchUp` was true, including on
      // failure — the client waits for it before going live, so a silent path
      // here would leave the live feed permanently disarmed.
      if (catchingUp) {
        emit('progress', { stage: 'catchup', pct: 100, message: 'Checking for new ticks…' });
        try {
          const tail = await catchUpStraddle(cached, { symbol, exchange, expiry, date, feed });
          if (tail) {
            setComputed(key, tail.merged, date);
            emit('append', {
              points:        tail.points,
              rollEvents:    tail.rollEvents,
              currentStrike: tail.merged.currentStrike,
              lastSpot:      tail.merged.lastSpot,
              greekCoverage: tail.merged.greekCoverage,
              greekModelledFraction: tail.merged.greekModelledFraction,
              strikesChecked: tail.merged.strikesChecked,
              _computeMs:    tail.computeMs,
            });
          } else {
            emit('append', { points: [], rollEvents: [] });
          }
        } catch (err) {
          // Best-effort by design: the cached session is already drawn, and a
          // failed top-up must not take it off the screen.
          console.warn(`[straddle] catch-up failed for ${key}:`, (err as Error)?.message);
          emit('append', { points: [], rollEvents: [], _error: (err as Error)?.message || 'Catch-up failed' });
        }
      }

      res.end();
      clearInterval(pingTimer);
      return;
    }
    misses++;

    // ── Cache miss: stream progress while computing ───────────────────────
    emit('progress', { stage: 'init',    pct: 5,  message: `Starting ${symbol} straddle…` });

    // We pass an onProgress callback into the engine
    const t0 = Date.now();
    const { result, provenance } = await withProvenance(() => computeRollingStraddle(
      { symbol, exchange, expiry, date, feed },
      (stage: string, pct: number, message: string) => emit('progress', { stage, pct, message }),
    ));

    if (!result.status) {
      emit('error', { message: result.message });
      res.end();
      clearInterval(pingTimer);
      return;
    }

    setComputed(key, result, date);

    emit('progress', { stage: 'done', pct: 100, message: 'Complete' });
    emit('result', {
      ...result,
      _cache: 'MISS',
      _computeMs: Date.now() - t0,
      _feed: provenance.feeds.join('+') || null,
      ...(provenance.mixed    ? { _failedOver: true }             : {}),
      ...(provenance.degraded ? { _degraded: provenance.degraded } : {}),
    });
    res.end();

  } catch (err) {
    // Same shape as the JSON error path, so an SSE consumer can branch on
    // `code` too — the login redirect must fire whether the straddle was
    // requested over POST or over the event stream.
    emit('error', {
      message: (err as Error)?.message || 'Internal error',
      ...(err instanceof FeedError
        ? { code: err.code === 'AUTH' ? 'FEED_AUTH_REQUIRED' : `FEED_${err.code}`, feed: err.feedId }
        : {}),
    });
    res.end();
  } finally {
    clearInterval(pingTimer);
  }
});
