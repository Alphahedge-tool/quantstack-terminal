/**
 * Rolling ATM Straddle Engine — the heart of the system.
 *
 * Algorithm per bar (ported from Alphahedge's rollingStraddle.js + enhanced):
 *
 *   1. For each spot bar: ATM = nearestStrike(spot, strikes, step)
 *   2. Candidates = ATM ± BAND strikes
 *   3. For each candidate:
 *        - advanceQuote(CE) → bid/ask/iv at this timestamp
 *        - advanceQuote(PE) → bid/ask/iv at this timestamp
 *        - Straddle bid  = CE bid + PE bid
 *        - Straddle ask  = CE ask + PE ask
 *        - Straddle mid  = (bid + ask) / 2
 *        - Synthetic F   = strike + CE ltp - PE ltp
 *   4. Pick the CHEAPEST straddle (lowest mid) from candidates
 *      (Alphahedge's "lowest ATM±2 straddle" logic)
 *   5. A ROLL EVENT occurs when ATM strike changes from previous bar
 *
 * The resulting StraddlePoint[] drives both the chart and the P&L tracker.
 */

import { ROLLING_INTERVALS, ROLLING_CONCURRENCY } from '../lib/nubraData.js';
import type { Instrument, MarketDataFeed } from '../feeds/types.js';
import { keyOf, normalizeExpiry, type InstrumentKey } from '../feeds/identity.js';
import { FeedError } from '../feeds/errors.js';
import {
  inferStep,
  nearestStrike,
  candidateStrikes,
  advanceQuote,
  ivMidOf,
  type StraddlePoint,
  type QuoteCursor,
} from '../analytics/syntheticFuture.js';
import { applyModelledVol, type ModelRequest } from '../analytics/volPass.js';
import { RingBuffer } from './ringBuffer.js';

import { logger } from '../lib/logger.js';

const log = logger('straddle');

// ─── Constants ────────────────────────────────────────────────────────────────

const BAND = 2;   // ATM ± 2 strikes as candidates

/**
 * Straddle greek = CE leg + PE leg.
 *
 * A leg the feed published no greek for contributes nothing and leaves the sum
 * null, rather than being counted as a zero-vega leg — a half-populated sum
 * reads as a genuine halving of the position's exposure, which is worse than
 * having no number at all.
 */
function sumLeg(a: number | null, b: number | null): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

// Session window as UTC ms offsets within a day. IST is UTC+5:30 year-round.
//
//   NSE / BSE  09:15–15:30 IST  →  03:45–10:00 UTC
//   MCX        09:00–23:30 IST  →  03:30–18:00 UTC, extended to 23:55 IST
//              (18:25 UTC) in the months US markets run standard time.
//
// MCX takes the WIDER 23:55 end in both cases. A day that actually closed at
// 23:30 just has no bars in the tail, which costs nothing; a hardcoded 23:30
// would silently drop the last 25 minutes of every extended session — and that
// tail is where the evening commodity move usually lands.
const SESSION_IST: Record<string, { open: [number, number]; close: [number, number] }> = {
  MCX: { open: [9, 0], close: [23, 55] },
};
const DEFAULT_SESSION_IST = { open: [9, 15], close: [15, 30] } as const;

const IST_OFFSET_MIN = 5 * 60 + 30;

export function sessionRange(dateISO: string, exchange = 'NSE'): { start: number; end: number } {
  const [year, month, day] = dateISO.split('-').map(Number);
  const win = SESSION_IST[exchange.toUpperCase()] ?? DEFAULT_SESSION_IST;
  const utcMinutes = ([h, m]: readonly [number, number]) => h * 60 + m - IST_OFFSET_MIN;
  return {
    start: Date.UTC(year, month - 1, day, 0, utcMinutes(win.open), 0, 0),
    end:   Date.UTC(year, month - 1, day, 0, utcMinutes(win.close), 0, 0),
  };
}

/** Latest trading date (skip weekends). */
export function latestTradingDate(): string {
  const d = new Date();
  // If before 9:15 IST (03:45 UTC), use previous trading day
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─── Result types ─────────────────────────────────────────────────────────────

export interface RollingStraddleResult {
  status:          true;
  symbol:          string;
  exchange:        string;
  expiry:          string;
  date:            string;
  interval:        string;
  step:            number;
  band:            number;
  strikesChecked:  number;
  entryPrice:      number | null;       // 9:15 AM synthetic future
  entryStraddle:   number | null;       // 9:15 AM straddle price
  /**
   * Opening greeks of the rolling straddle — the baseline every vega/theta
   * line is read against, exactly as entryStraddle serves the price line.
   * Above the baseline = vega building; below = vega bleeding.
   */
  entryVega:       number | null;
  entryTheta:      number | null;
  /**
   * Fraction of bars carrying greeks, and how much of that was modelled rather
   * than fed. Without these a vega line that is flat because the feed went
   * silent looks identical to one that is flat because vol did not move.
   */
  greekCoverage:   number | null;
  greekModelledFraction: number | null;
  currentStrike:   number | null;
  points:          StraddlePoint[];
  rollEvents:      RollEvent[];
  lastSpot:        number | null;
  timings?:        Record<string, number>;  // per-stage ms, for diagnosing slow loads
}

export interface RollEvent {
  time:       number;
  fromStrike: number;
  toStrike:   number;
  synFuture:  number;
  straddlePrice: number;
  /**
   * What the roll did to the position's greeks — the greek analogue of
   * rollCostPoints. Rolling into a nearer-the-money strike re-buys vega and
   * re-buys negative theta; both are costs the straddle price alone hides.
   * Null when either side of the step had no greek published.
   */
  vegaJump?:  number | null;
  thetaJump?: number | null;
}

export interface RollingStraddleError {
  status:  false;
  message: string;
}

// ─── Engine ───────────────────────────────────────────────────────────────────

type ProgressCb = (stage: string, pct: number, message: string) => void;

export async function computeRollingStraddle(
  opts: {
    symbol:   string;
    exchange?: string;
    expiry?:  string;
    date?:    string;
    /**
     * Where the data comes from. Any feed — or the router standing in for all
     * of them. The engine no longer knows which broker answered, or that a
     * login was involved.
     */
    feed:     MarketDataFeed;
    /**
     * Interval preference, tried in order. Defaults to ROLLING_INTERVALS
     * (1s then 1m) for the live chart. The backtester passes ['1m'] — at 1s a
     * single session is ~23k points and a multi-month run would be tens of
     * millions, for metrics that are identical at minute resolution.
     */
    intervals?: readonly string[];
    /**
     * Window override in epoch ms, clamped to the exchange session for `date`.
     * Defaults to the whole session.
     *
     * The catch-up path (engine/straddleCatchUp.ts) uses this to recompute only
     * the bars a cached session is missing. A windowed run is a normal run over
     * fewer bars: `entryPrice`, `entryVega` and friends are then the FIRST BAR
     * OF THE WINDOW, not the 9:15 open, so a caller merging a tail into a
     * cached session must keep the cached baselines.
     */
    from?:    number;
    to?:      number;
  },
  onProgress?: ProgressCb,
): Promise<RollingStraddleResult | RollingStraddleError> {
  const prog = onProgress ?? (() => {}); // no-op if not provided
  const symbol   = opts.symbol.trim().toUpperCase();
  const exchange = (opts.exchange || 'NSE').toUpperCase();
  const date     = opts.date || latestTradingDate();
  // Epoch ms throughout. Converting to the wire format (ISO strings for Nubra)
  // is the adapter's job now — the engine does not know what a feed's API looks
  // like, which is the point.
  const session   = sessionRange(date, exchange);
  const start     = opts.from != null ? Math.max(session.start, opts.from) : session.start;
  const end       = opts.to   != null ? Math.min(session.end,   opts.to)   : session.end;
  if (start >= end) {
    return { status: false, message: 'Requested window is outside the trading session' };
  }
  const feed      = opts.feed;
  const intervals = opts.intervals?.length ? opts.intervals : ROLLING_INTERVALS;

  // Per-stage timings — so "it's slow" can be pinned on a stage instead of guessed.
  const t0 = Date.now();
  const timings: Record<string, number> = {};
  const mark = (stage: string, from: number) => { timings[stage] = Date.now() - from; };

  // ── 1. Option refdata → expiry ───────────────────────────────────────────
  //
  // This used to run in parallel with the spot fetch, because refdata meant
  // downloading the day's whole instrument list. It now comes from the
  // instrument cache (memory, or disk after a restart), so the sequencing is
  // effectively free — and it has to come first: for MCX the spot instrument
  // is the future underlying the CHOSEN expiry, which isn't known until here.

  prog('spot', 10, `Loading ${symbol} option chain…`);
  const tRef = Date.now();
  const expiries = await feed.expiries(symbol, exchange, date);
  mark('refdata', tRef);

  if (!expiries.length) return { status: false, message: `No option expiries for ${exchange} ${symbol}` };

  // Expiries are canonical ISO now, but callers (and cached URLs) may still
  // pass the compact YYYYMMDD refdata form, so both are accepted.
  const wanted = normalizeExpiry(opts.expiry);
  const expiry = wanted && expiries.includes(wanted) ? wanted : expiries[0];

  const rows = await feed.chain(symbol, exchange, date, expiry);
  if (!rows.length) return { status: false, message: 'No option rows for selected expiry' };

  // ── 2. Spot close series ─────────────────────────────────────────────────

  // Ordered candidates, not one name: the correct underlying is unambiguous
  // (see resolveSpotCandidates) but Nubra does not always carry a series for
  // it — thin MCX mini futures go unquoted on some days, and losing the spot
  // series drops the entire session. The fallbacks track the same commodity.
  const spotCandidates = await feed.underlyings(symbol, exchange, date, expiry);
  if (!spotCandidates.length) {
    return { status: false, message: `No underlying instrument for ${exchange} ${symbol}` };
  }
  const spotRef = spotCandidates[0];

  let resolvedInterval: string = intervals[0];

  const loadSpot = async (): Promise<{
    points: Array<{ ts: number; spot: number }>;
    interval: string; ref: Instrument; error: unknown;
  }> => {
    let error: unknown = null;
    // A candidate the feed does not carry is expected — that is what the
    // fallback chain is for. A candidate that failed because the PROVIDER is
    // broken is not, and the two must not end up as the same message.
    let fault: FeedError | null = null;

    for (const ref of spotCandidates) {
      for (const interval of intervals) {
        try {
          const { candles } = await feed.candles({
            key: ref.key, interval, from: start, to: end,
          });
          const points = candles
            .map((c) => ({ ts: c.ts, spot: c.c }))
            .filter((p) => Number.isFinite(p.ts) && p.spot > 0)
            .sort((a, b) => a.ts - b.ts);
          if (points.length) return { points, interval, ref, error: null };
        } catch (err) {
          error ??= err;
          if (err instanceof FeedError && err.code === 'AUTH') throw err;
          if (err instanceof FeedError && err.countsAsFailure) fault ??= err;
        }
      }
    }

    // Every candidate failed, and at least one failed because the feed itself
    // is unhealthy. Rethrowing keeps the classification: the route answers 502
    // with code FEED_TRANSIENT instead of a 404 carrying a raw broker string,
    // so the UI can say "the data provider is failing" rather than implying
    // this symbol has no data.
    if (fault) throw fault;

    return { points: [], interval: intervals[0], ref: spotRef, error };
  };

  prog('spot', 15, `Fetching ${spotRef.label} spot…`);
  const tSpot = Date.now();
  const spot = await loadSpot();
  mark('spot', tSpot);
  prog('spot', 25, `Got ${spot.points.length} spot bars`);

  const spotPoints = spot.points;
  if (!spotPoints.length) {
    const tried = spotCandidates.map((c) => c.label).join(', ');
    const msg = (spot.error as Error)?.message
      || `No spot data for ${exchange} ${symbol} — tried ${tried}`;
    return { status: false, message: msg };
  }
  resolvedInterval = spot.interval;

  // Anything but the first candidate is a stand-in for the true underlying.
  // Surfaced rather than silently absorbed: the basis between a mini and its
  // full-size contract is small but real, and a session priced off a
  // substitute should be identifiable as one.
  const spotSubstitute = spot.ref.label !== spotRef.label ? spot.ref.label : null;
  if (spotSubstitute) {
    log.warn(
      `${exchange} ${symbol} ${date}: no series for ${spotRef.label}, `
      + `using ${spotSubstitute} as the underlying`,
    );
  }

  // Strike and side now come off the canonical key, not a broker's row shape.
  const strikes  = [...new Set(rows.map((r) => r.key.strike!))].sort((a, b) => a - b);
  const step     = inferStep(strikes);
  const rowByKey = new Map(rows.map((r) => [`${r.key.strike}|${r.key.side}`, r]));

  // ── 3. Determine which strikes we need ───────────────────────────────────

  const requiredStrikes = new Set<number>();
  for (const pt of spotPoints) {
    const atm = nearestStrike(pt.spot, strikes, step);
    for (const s of candidateStrikes(atm, strikes, step, BAND)) requiredStrikes.add(s);
  }

  // ── 4. Build symbol list ─────────────────────────────────────────────────

  // Canonical keys, not symbol strings. Alias handling — a Nubra row carries up
  // to 8 spellings of the SAME instrument, and naively sending all of them
  // tripled the batch count against an 8-per-request cap — now lives inside the
  // adapter, which is the only layer that knows aliases exist. What survives
  // here is the property that matters: one entry per contract.
  const optionKeys: InstrumentKey[] = [];
  for (const strike of requiredStrikes) {
    const ce = rowByKey.get(`${strike}|CE`);
    const pe = rowByKey.get(`${strike}|PE`);
    if (ce) optionKeys.push(ce.key);
    if (pe) optionKeys.push(pe.key);
  }

  if (!optionKeys.length) return { status: false, message: 'No CE/PE symbols found around ATM±2' };
  prog('options', 35, `Fetching ${optionKeys.length} option series…`);

  // ── 5. Fetch option bid/ask/iv series ────────────────────────────────────

  const tSeries = Date.now();
  const fetchSeries = (interval: string) => feed.optionSeries({
    keys: optionKeys, interval, from: start, to: end,
    // Only what the chart plots. delta and gamma would each add ~23k points
    // per contract at 1s for a number nothing on this path reads.
    greeks: ['vega', 'theta'],
  });

  let { series: seriesByKey } = await fetchSeries(resolvedInterval);

  // A feed that resolved the spot at 1s but has no option series there is a
  // real case (thin contracts), and dropping to 1m recovers the session.
  if (!seriesByKey.size && resolvedInterval !== '1m') {
    const fallback = await fetchSeries('1m');
    if (fallback.series.size) {
      seriesByKey = fallback.series;
      resolvedInterval = '1m';
    }
  }

  mark('optionSeries', tSeries);

  if (!seriesByKey.size) {
    return { status: false, message: `No option chart series for ${exchange} ${symbol} ${expiry}` };
  }
  prog('series', 60, `Got ${seriesByKey.size} option series — computing straddle…`);

  // ── 6. Walk spot bars → compute synthetic future + cheapest straddle ─────

  const tWalk = Date.now();
  const cursorByName = new Map<string, QuoteCursor>();
  const points: StraddlePoint[] = [];
  const rollEvents: RollEvent[] = [];
  let prevStrike: number | null = null;
  let entryPrice: number | null = null;
  let entryStraddle: number | null = null;

  /**
   * Bars the feed could not fully answer, resolved in ONE batch after the walk.
   *
   * This used to be an inline Black-76 inversion per bar — ~22k bounded Newton
   * solves on the same thread that serves every live socket, which is the exact
   * cost the Go sidecar exists to take. Collecting them makes the work a batch
   * worth handing across a process boundary, and leaves the walk doing only
   * what it alone can do: pick the strike.
   *
   * The greek baselines and coverage counters moved with it — they depend on
   * values that do not exist yet at this point in the loop. See `volPass`.
   */
  const pending: ModelRequest[] = [];

  const spotLen = spotPoints.length;

  for (let si = 0; si < spotLen; si++) {
    // Emit progress every ~25% of bars
    if (si > 0 && si % Math.floor(spotLen / 4) === 0) {
      prog('compute', 60 + Math.floor((si / spotLen) * 30),
        `Computing bar ${si}/${spotLen}…`);
    }
    const pt = spotPoints[si];
    const atm = nearestStrike(pt.spot, strikes, step);

    // Find cheapest straddle among ATM±BAND candidates
    let best: {
      strike: number; bid: number; ask: number; mid: number;
      callLtp: number; putLtp: number; synFuture: number; ivMid: number | null;
      /** CE + PE, or null when neither leg published that greek at this bar. */
      greeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null };
    } | null = null;

    for (const strike of candidateStrikes(atm, strikes, step, BAND)) {
      const ce = rowByKey.get(`${strike}|CE`);
      const pe = rowByKey.get(`${strike}|PE`);
      if (!ce || !pe) continue;

      const ceQ = advanceQuote(keyOf(ce.key), seriesByKey, cursorByName, pt.ts);
      const peQ = advanceQuote(keyOf(pe.key), seriesByKey, cursorByName, pt.ts);

      const ceBid = ceQ.bid; const ceAsk = ceQ.ask;
      const peBid = peQ.bid; const peAsk = peQ.ask;

      const bid = ceBid + peBid;
      const ask = ceAsk + peAsk;
      if (bid <= 0 || ask <= 0) continue;

      const mid       = (bid + ask) / 2;
      const callLtp   = (ceQ.bid + ceQ.ask) / 2;  // mid as LTP proxy
      const putLtp    = (peQ.bid + peQ.ask) / 2;
      const synFuture = strike + callLtp - putLtp;
      const ivMid     = ivMidOf(ceQ) != null && ivMidOf(peQ) != null
        ? ((ivMidOf(ceQ)! + ivMidOf(peQ)!) / 2) * 100
        : ivMidOf(ceQ) != null ? ivMidOf(ceQ)! * 100
        : ivMidOf(peQ) != null ? ivMidOf(peQ)! * 100
        : null;

      const greeks = {
        delta: sumLeg(ceQ.delta, peQ.delta),
        gamma: sumLeg(ceQ.gamma, peQ.gamma),
        vega:  sumLeg(ceQ.vega,  peQ.vega),
        theta: sumLeg(ceQ.theta, peQ.theta),
      };

      if (!best || mid < best.mid) {
        best = { strike, bid, ask, mid, callLtp, putLtp, synFuture, ivMid, greeks };
      }
    }

    if (!best) continue;

    // Roll event detection. The push is deferred until after the greeks are
    // resolved below, so the event can record what the roll did to vega and
    // theta — the greek analogue of rollCostPoints.
    const isRollEvent = prevStrike !== null && prevStrike !== best.strike;
    const fromStrike  = prevStrike;
    prevStrike = best.strike;

    // 9:15 AM entry reference — first bar
    if (entryPrice === null)   entryPrice   = best.synFuture;
    if (entryStraddle === null) entryStraddle = best.mid;

    // IV from the feed when it has one. Nubra only publishes iv_bid/iv_ask for
    // about the last three months; everything older is inverted from the
    // straddle itself, which happens in the batch pass after this loop rather
    // than here — see `pending` above and analytics/volPass.ts.
    let iv: number | undefined;
    let ivSource: 'feed' | 'black76' | undefined;

    if (best.ivMid != null && best.ivMid > 0) {
      iv = best.ivMid;
      ivSource = 'feed';
    }

    // ── Greeks of the straddle actually held at this bar ──────────────────
    //
    // Feed first: these are the broker's own numbers for the exact contracts
    // being priced, so they carry the smile the model does not. Vega and theta
    // are taken as a pair from ONE source so a bar can never mix a fed vega
    // with a modelled theta. Where the feed is silent — most of any backtest
    // window — the pass fills them in from the vol it solves for.
    let vega:  number | undefined;
    let theta: number | undefined;
    let delta: number | undefined;
    let gamma: number | undefined;
    let greekSource: 'feed' | 'black76' | undefined;

    const hasFedGreeks = best.greeks.vega != null || best.greeks.theta != null;
    if (hasFedGreeks) {
      vega  = best.greeks.vega  ?? undefined;
      theta = best.greeks.theta ?? undefined;
      delta = best.greeks.delta ?? undefined;
      gamma = best.greeks.gamma ?? undefined;
      greekSource = 'feed';
    }

    // Queue whatever the feed left short. A bar with a fed vol but no greeks
    // carries that vol along (`fedIv`) so the pass derives greeks from the
    // feed's own number instead of solving for a second, slightly different
    // one.
    if (iv == null || !hasFedGreeks) {
      pending.push({
        index:      points.length,
        time:       pt.ts,
        straddle:   best.mid,
        forward:    best.synFuture,
        strike:     best.strike,
        ...(iv != null ? { fedIv: iv } : {}),
        wantGreeks: !hasFedGreeks,
      });
    }

    if (isRollEvent) {
      rollEvents.push({
        time:          pt.ts,
        fromStrike:    fromStrike!,
        toStrike:      best.strike,
        synFuture:     best.synFuture,
        straddlePrice: best.mid,
        // What the roll itself did to the position's greeks — filled in by the
        // pass, which is the first point at which both sides of the step are
        // known. A roll into a richer strike re-buys vega; one late in the day
        // usually re-buys theta too.
        vegaJump:  null,
        thetaJump: null,
      });
    }

    points.push({
      time:            pt.ts,
      spot:            pt.spot,
      atmStrike:       best.strike,
      syntheticFuture: best.synFuture,
      callLtp:         best.callLtp,
      putLtp:          best.putLtp,
      straddlePrice:   best.mid,
      straddleBid:     best.bid,
      straddleAsk:     best.ask,
      iv,
      ivSource,
      vega,
      theta,
      delta,
      gamma,
      greekSource,
      isRollEvent,
    });
  }

  if (!points.length) return { status: false, message: 'No complete straddle points found' };

  mark('walk', tWalk);

  /*
   * Everything the feed did not carry, in one batch.
   *
   * Awaited rather than fired and forgotten: the points are the response, and
   * a chart drawn before its IV line arrived would just be the old blank series
   * with extra steps. What the await buys is that the solving happens in the Go
   * sidecar when one is running — off the thread that serves the live sockets.
   */
  const tVol = Date.now();
  const vol = await applyModelledVol(expiry, points, rollEvents, pending);
  mark('modelledVol', tVol);

  const { entryVega, entryTheta, greekBars, modelledGreekBars } = vol;
  timings.total = Date.now() - t0;
  log.info(
    `${exchange} ${symbol} ${expiry} ${date} @${resolvedInterval} — `
    + `${points.length} pts, ${optionKeys.length} contracts, ${requiredStrikes.size} strikes, `
    + `greeks ${points.length ? Math.round((greekBars / points.length) * 100) : 0}%`
    + `${greekBars ? ` (${Math.round((modelledGreekBars / greekBars) * 100)}% modelled)` : ''}, `
    + `concurrency ${ROLLING_CONCURRENCY} | `
    + `vol ${vol.source}:${vol.solved}/${vol.requested} in ${vol.tookMs}ms | `
    + Object.entries(timings).map(([k, v]) => `${k} ${v}ms`).join(' · '),
  );

  return {
    timings,
    status:         true,
    symbol, exchange, expiry, date,
    interval:       resolvedInterval,
    step, band: BAND,
    strikesChecked: requiredStrikes.size,
    entryPrice,
    entryStraddle,
    entryVega,
    entryTheta,
    greekCoverage:         points.length ? greekBars / points.length : null,
    greekModelledFraction: greekBars ? modelledGreekBars / greekBars : null,
    currentStrike:  points[points.length - 1]?.atmStrike ?? null,
    lastSpot:       spotPoints[spotPoints.length - 1]?.spot ?? null,
    points,
    rollEvents,
  };
}

// ─── Ring buffer for live tick accumulation ───────────────────────────────────

export class StraddleSession {
  readonly symbol:   string;
  readonly exchange: string;
  readonly expiry:   string;
  readonly buffer:   RingBuffer;

  entryPrice:    number | null = null;
  entryStraddle: number | null = null;
  currentStrike: number | null = null;
  rollCount:     number = 0;

  constructor(symbol: string, exchange: string, expiry: string, capacity = 8_192) {
    this.symbol   = symbol;
    this.exchange = exchange;
    this.expiry   = expiry;
    this.buffer   = new RingBuffer(capacity);
  }

  pushPoint(p: StraddlePoint): void {
    if (this.entryPrice   === null) this.entryPrice   = p.syntheticFuture;
    if (this.entryStraddle === null) this.entryStraddle = p.straddlePrice;
    if (p.isRollEvent) this.rollCount++;
    this.currentStrike = p.atmStrike;
    this.buffer.push({
      time:            p.time,
      spot:            p.spot,
      atmStrike:       p.atmStrike,
      syntheticFuture: p.syntheticFuture,
      callLtp:         p.callLtp,
      putLtp:          p.putLtp,
      straddlePrice:   p.straddlePrice,
      isRollEvent:     p.isRollEvent ? 1 : 0,
    });
  }

  summary() {
    return {
      symbol:        this.symbol,
      exchange:      this.exchange,
      expiry:        this.expiry,
      entryPrice:    this.entryPrice,
      entryStraddle: this.entryStraddle,
      currentStrike: this.currentStrike,
      rollCount:     this.rollCount,
      tickCount:     this.buffer.length,
      last:          this.buffer.last(),
    };
  }
}
