/**
 * Live rolling-ATM straddle — the intraday continuation of rollingStraddle.ts.
 *
 * Same algorithm, different clock. The historical engine walks a spot series
 * and carries option quotes forward to each bar; this one holds the latest
 * quote per contract in memory and recomputes on a timer as ticks land. The
 * selection rule is identical and deliberately so: ATM from spot, candidates at
 * ATM ± 2, cheapest mid wins, a confirmed change of strike is a roll. A live
 * point and a historical point are the same object, so the chart appends one to
 * the other without knowing which is which.
 *
 * Why recompute server-side instead of shipping raw ticks to the browser:
 * the cheapest-of-band rule is the product. Duplicating it in the client is how
 * the two drift apart — the reference implementation does exactly that and its
 * live line does not reconcile with its own history.
 *
 * Ticks arrive far faster than a chart can use (a 40-strike chain is hundreds
 * per second), so compute is throttled to one point per THROTTLE_MS. The
 * browser then tweens between points; see StraddleChart's live path.
 */

import { getCachedRefdata, resolveSpotCandidates, type InstrumentRow } from '../lib/instrumentCache.js';
import { toRupees } from '../lib/nubraData.js';
import type { NubraSession } from '../brokers/nubra.js';
import { startBridge, type BridgeEvent, type BridgeHandle } from '../feeds/adapters/nubra/liveBridge.js';
import { inferStep, nearestStrike, candidateStrikes, type StraddlePoint } from '../analytics/syntheticFuture.js';
import { straddleGreeks, yearsToExpiry } from '../analytics/black76.js';
import { sessionRange, type RollEvent } from './rollingStraddle.js';

// ── Tuning ───────────────────────────────────────────────────────────────────

const BAND = 2;   // priced candidates, matching the historical engine

/** One computed point per this many ms, however fast ticks arrive. */
const THROTTLE_MS = Number(process.env.QT_LIVE_THROTTLE_MS || 250);

/**
 * Depth/greeks are subscribed for ATM ± SUBSCRIBE_DEPTH strikes — wider than
 * the ±2 actually priced, so ordinary intraday drift never walks out of the
 * subscribed window. When it does anyway, the bridge is re-armed around the new
 * centre (REARM_DRIFT), rate-limited so a strike oscillating on the boundary
 * cannot respawn the process on every tick.
 */
const SUBSCRIBE_DEPTH = 8;
const REARM_DRIFT     = 4;
const REARM_MIN_MS    = 20_000;

/**
 * Emitted points kept for replay.
 *
 * The feed only ever sends the present, so a client that was not listening for
 * a while — a backgrounded tab whose socket was dropped, a laptop that slept, a
 * proxy that timed the connection out — has a hole nothing downstream can fill.
 * Retaining what was emitted turns that into a question the client can ask:
 * "give me everything after T". At one point per THROTTLE_MS (4/s by default)
 * 20k entries is ~80 minutes of session, which is longer than any gap worth
 * recovering — beyond that the historical catch-up path is the right answer,
 * and `complete: false` says so.
 */
const REPLAY_CAP = Number(process.env.QT_LIVE_REPLAY_CAP || 20_000);

/** Entries dropped per trim, so the cap costs one memmove per 2k points. */
const REPLAY_TRIM = Math.max(1, Math.floor(REPLAY_CAP / 10));

/**
 * Slack allowed between a client's last known point and the oldest point the
 * session can speak for, before the join counts as a hole. A first subscribe
 * marks the last HISTORICAL bar, a second or two older than the session itself.
 */
const REPLAY_JOIN_MS = 20_000;

// ── Public shapes ────────────────────────────────────────────────────────────

export type LiveStraddleEvent =
  | { event: 'status'; status: string; message?: string }
  | { event: 'point';  point: StraddlePoint; roll?: RollEvent }
  | { event: 'error';  message: string };

export interface LiveStraddleOptions {
  symbol:    string;
  exchange:  string;
  /** ISO `YYYY-MM-DD` or compact `YYYYMMDD`. */
  expiry:    string;
  session:   NubraSession;
  /** Last known ATM, so depth can be subscribed before the first tick lands. */
  atmHint?:  number;
}

/** What a reconnecting client missed, as far back as the session still holds. */
export interface LiveReplay {
  points: StraddlePoint[];
  rolls:  RollEvent[];
  /**
   * True when the replay actually starts where the client left off. False means
   * the retained window no longer reaches `since` (or the session is younger
   * than it), so a hole remains and the caller must refill it from history.
   */
  complete: boolean;
}

export interface LiveStraddleHandle {
  stop(): void;
  /** Every point emitted after `sinceMs`, oldest first. */
  replaySince(sinceMs: number): LiveReplay;
  /** Timestamp of the newest emitted point, or null before the first one. */
  lastPointTime(): number | null;
}

// ── Tick field readers ───────────────────────────────────────────────────────
//
// Nubra's realtime payloads are not the REST payloads: field names vary by
// stream and by SDK version, prices are paise, and IV is sometimes a fraction.
// Every read goes through these so a renamed field degrades to "no quote"
// rather than to a plausible wrong number.

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return v && typeof v === 'object' ? v as Dict : null;
}

function refIdOf(v: unknown): string {
  const d = asDict(v);
  if (!d) return '';
  const raw = d.refId ?? d.ref_id ?? d.refid ?? d.refID ?? d.instrument_id;
  return raw == null ? '' : String(raw);
}

function rupees(v: unknown): number | null {
  const n = toRupees(v);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

/** Best price level from an orderbook side. */
function topOfBook(levels: unknown): number | null {
  if (!Array.isArray(levels) || !levels.length) return null;
  return rupees(asDict(levels[0])?.price);
}

const IV_KEYS = [
  'iv', 'IV', 'iv_mid', 'ivMid', 'iv_percent', 'ivPercent',
  'implied_volatility', 'impliedVolatility', 'volatility',
];

/** IV as a percentage. Feeds send either 0.184 or 18.4 for the same number. */
function ivOf(v: unknown): number | null {
  const d = asDict(v);
  if (!d) return null;
  const norm = (raw: unknown): number | null => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n <= 1 ? n * 100 : n;
  };
  for (const key of IV_KEYS) {
    const hit = norm(d[key]);
    if (hit != null) return hit;
  }
  const bid = norm(d.iv_bid ?? d.ivBid ?? d.bid_iv ?? d.bidIv);
  const ask = norm(d.iv_ask ?? d.ivAsk ?? d.ask_iv ?? d.askIv);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask;
}

function ltpOf(v: unknown): number | null {
  const d = asDict(v);
  if (!d) return null;
  return rupees(d.last_traded_price ?? d.ltp ?? d.lastPrice ?? d.close);
}

/**
 * One greek off a live payload.
 *
 * Plain number, never rupees: greeks are sensitivities, not premiums, and the
 * paise convention does not apply to them. Zero is rejected along with the
 * non-finite cases — a greek stream that has not populated a contract yet sends
 * 0 far more often than a real ATM straddle prints a true zero vega, and
 * treating those as observations drags the line to the floor. Delta is the one
 * greek that legitimately sits near zero for a straddle, so it is exempt.
 */
const GREEK_KEYS: Record<string, string[]> = {
  delta: ['delta', 'delta_value', 'deltaValue'],
  gamma: ['gamma', 'gamma_value', 'gammaValue'],
  vega:  ['vega',  'vega_value',  'vegaValue'],
  theta: ['theta', 'theta_value', 'thetaValue'],
};

function greekOf(v: unknown, name: keyof typeof GREEK_KEYS): number | null {
  const d = asDict(v);
  if (!d) return null;
  for (const key of GREEK_KEYS[name]) {
    const n = Number(d[key]);
    if (!Number.isFinite(n)) continue;
    if (n === 0 && name !== 'delta') continue;
    return n;
  }
  return null;
}

/**
 * Orderbook and greeks payloads arrive variously as an object, an array, or an
 * object wrapping one of `data` / `values` / `items`. Walk all of them.
 */
function eachPayload(payload: unknown, visit: (row: Dict) => void): void {
  if (!payload) return;
  if (Array.isArray(payload)) {
    for (const item of payload) eachPayload(item, visit);
    return;
  }
  const d = asDict(payload);
  if (!d) return;
  for (const nested of [d.data, d.values, d.items]) {
    if (Array.isArray(nested)) eachPayload(nested, visit);
  }
  visit(d);
}

// ── Engine ───────────────────────────────────────────────────────────────────

interface Leg {
  bid: number | null; ask: number | null; iv: number | null; hasBook: boolean;
  delta: number | null; gamma: number | null; vega: number | null; theta: number | null;
}

/** Straddle greek = CE + PE; null only when neither leg published one. */
function sumLeg(a: number | null, b: number | null): number | null {
  return a == null && b == null ? null : (a ?? 0) + (b ?? 0);
}

export async function startLiveStraddle(
  opts: LiveStraddleOptions,
  emit: (e: LiveStraddleEvent) => void,
): Promise<LiveStraddleHandle> {
  const symbol   = opts.symbol.trim().toUpperCase();
  const exchange = opts.exchange.trim().toUpperCase();
  // Refdata and Nubra's option subscription both key on the compact form.
  const expiry   = opts.expiry.replace(/-/g, '').trim();
  const today    = istToday();

  // ── Contract table ─────────────────────────────────────────────────────────

  const rows = (await getCachedRefdata(exchange, today, opts.session))
    .filter((r) => r.asset === symbol && r.type === 'OPT' && r.expiry === expiry
                && r.strike != null && r.optionType && r.refId);

  if (!rows.length) {
    throw new Error(`No ${exchange} ${symbol} option contracts for expiry ${expiry} on ${today}`);
  }

  const strikes = [...new Set(rows.map((r) => r.strike!))].sort((a, b) => a - b);
  const step    = inferStep(strikes);

  const refByLeg  = new Map<string, string>();          // `strike|side` → refId
  const legByRef  = new Map<string, { strike: number; side: 'CE' | 'PE' }>();
  for (const row of rows as (InstrumentRow & { strike: number; optionType: 'CE' | 'PE' })[]) {
    const legKey = `${row.strike}|${row.optionType}`;
    if (refByLeg.has(legKey)) continue;                 // first row wins, as elsewhere
    refByLeg.set(legKey, row.refId);
    legByRef.set(row.refId, { strike: row.strike, side: row.optionType });
  }

  // MCX prices off a future, not a cash leg — same resolution the historical
  // engine uses, so live and history follow the same underlying.
  const spotRef = (await resolveSpotCandidates(symbol, exchange, today, expiry, opts.session))[0];
  if (!spotRef) throw new Error(`No underlying instrument for ${exchange} ${symbol}`);

  // ── Live state ─────────────────────────────────────────────────────────────

  const bookByRef  = new Map<string, Dict>();
  const greekByRef = new Map<string, Dict>();
  const tickByRef  = new Map<string, Dict>();
  let spot: number | null = null;

  let prevStrike: number | null = null;
  // Previous bar's greeks, so a roll can report the step it caused.
  let prevVega:  number | null = null;
  let prevTheta: number | null = null;
  let bridge: BridgeHandle | null = null;
  let subscribedCentre: number | null = null;
  let lastRearmAt = 0;
  let throttleTimer: NodeJS.Timeout | null = null;
  let pendingAt: number | null = null;
  let stopped = false;

  /** Rolling window of what has been emitted — see REPLAY_CAP. */
  const replay: Array<{ point: StraddlePoint; roll?: RollEvent }> = [];
  const startedAt = Date.now();

  // ── Bridge lifecycle ───────────────────────────────────────────────────────

  const refIdsAround = (centre: number): string[] => {
    const out: string[] = [];
    for (let i = -SUBSCRIBE_DEPTH; i <= SUBSCRIBE_DEPTH; i++) {
      const strike = nearestStrike(centre + i * step, strikes, step);
      for (const side of ['CE', 'PE'] as const) {
        const ref = refByLeg.get(`${strike}|${side}`);
        if (ref && !out.includes(ref)) out.push(ref);
      }
    }
    return out;
  };

  const spawnBridge = (centre: number | null): void => {
    bridge?.stop();
    subscribedCentre = centre;
    lastRearmAt = Date.now();
    bridge = startBridge(
      {
        environment: /uat/i.test(process.env.NUBRA_BASE_URL || '') ? 'uat' : 'prod',
        token:       opts.session.sessionToken.replace(/^Bearer /, '').trim(),
        deviceId:    opts.session.deviceId,
        symbol,
        spotSymbol:  spotRef.symbol,
        exchange,
        interval:    '1m',
        expiry,
        refIds:      centre == null ? [] : refIdsAround(centre),
      },
      onBridgeEvent,
      (code) => {
        if (stopped) return;
        emit({ event: 'status', status: 'disconnected', message: `Live bridge exited (${code ?? 'signal'})` });
      },
    );
  };

  /**
   * Re-subscribe depth around a new centre.
   *
   * Also the path that arms depth for the first time: without an atmHint there
   * is no centre to subscribe until a chain tick reveals the underlying's
   * price, so the bridge starts on chain+ohlcv alone and gains depth here.
   */
  const rearmIfDrifted = (atm: number): void => {
    if (stopped) return;
    const drifted = subscribedCentre == null
      || Math.abs(atm - subscribedCentre) > REARM_DRIFT * step;
    if (!drifted) return;
    if (Date.now() - lastRearmAt < REARM_MIN_MS) return;
    emit({ event: 'status', status: 'resubscribing', message: `Depth re-armed around ${atm}` });
    spawnBridge(atm);
  };

  // ── Tick ingestion ─────────────────────────────────────────────────────────

  function onBridgeEvent(e: BridgeEvent): void {
    if (stopped) return;
    switch (e.event) {
      case 'option': {
        const chain = asDict(e.data);
        if (!chain) return;
        const px = rupees(chain.current_price);
        if (px != null) spot = px;
        for (const side of ['ce', 'pe'] as const) {
          const legs = chain[side];
          if (!Array.isArray(legs)) continue;
          for (const leg of legs) {
            const ref = refIdOf(leg);
            if (!ref) continue;
            tickByRef.set(ref, { ...tickByRef.get(ref), ...asDict(leg) });
          }
        }
        schedule(e.received_at_ms);
        return;
      }
      case 'orderbook':
        eachPayload(e.data, (row) => {
          const ref = refIdOf(row);
          if (ref) bookByRef.set(ref, row);
        });
        schedule(e.received_at_ms);
        return;
      case 'greeks':
        eachPayload(e.data, (row) => {
          const ref = refIdOf(row);
          if (ref) greekByRef.set(ref, { ...greekByRef.get(ref), ...row });
        });
        schedule(e.received_at_ms);
        return;
      case 'ohlcv': {
        // Only a fallback: the chain's current_price is the same underlying and
        // updates far more often, so this matters mainly before the first chain
        // tick arrives.
        const px = ltpOf(asDict(e.data));
        if (px != null && spot == null) spot = px;
        return;
      }
      case 'status':
        emit({ event: 'status', status: String(e.status || 'status'), message: e.message ? String(e.message) : undefined });
        return;
      case 'error':
        emit({ event: 'error', message: String(e.message || 'Live feed error') });
        return;
      case 'log':
        emit({ event: 'status', status: 'log', message: String(e.message || '').slice(0, 200) });
        return;
      default:
        return;
    }
  }

  function schedule(receivedAtMs?: number): void {
    pendingAt = receivedAtMs || Date.now();
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      const at = pendingAt ?? Date.now();
      pendingAt = null;
      compute(at);
    }, THROTTLE_MS);
  }

  // ── The straddle rule, on live quotes ──────────────────────────────────────

  function readLeg(strike: number, side: 'CE' | 'PE'): Leg | null {
    const ref = refByLeg.get(`${strike}|${side}`);
    if (!ref) return null;
    const book  = bookByRef.get(ref);
    const greek = greekByRef.get(ref);
    const tick  = tickByRef.get(ref);

    // Depth is the honest quote; LTP stands in when the book has not arrived
    // for this contract, which is common for the outer strikes of the band.
    const fallback = ltpOf(book) ?? ltpOf(tick) ?? ltpOf(greek);
    const bid = topOfBook(book?.bids) ?? fallback;
    const ask = topOfBook(book?.asks) ?? fallback;
    // The greeks stream is the authoritative source; the chain tick carries
    // them too on some builds, so it stands in when depth has not arrived.
    return {
      bid, ask,
      iv: ivOf(greek) ?? ivOf(tick),
      hasBook: Boolean(book?.bids && book?.asks),
      delta: greekOf(greek, 'delta') ?? greekOf(tick, 'delta'),
      gamma: greekOf(greek, 'gamma') ?? greekOf(tick, 'gamma'),
      vega:  greekOf(greek, 'vega')  ?? greekOf(tick, 'vega'),
      theta: greekOf(greek, 'theta') ?? greekOf(tick, 'theta'),
    };
  }

  function compute(atMs: number): void {
    if (stopped || spot == null || spot <= 0) return;

    const atm = nearestStrike(spot, strikes, step);
    rearmIfDrifted(atm);

    let best: {
      strike: number; bid: number; ask: number; mid: number;
      call: number; put: number; iv: number | null;
      greeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null };
    } | null = null;

    for (const strike of candidateStrikes(atm, strikes, step, BAND)) {
      const ce = readLeg(strike, 'CE');
      const pe = readLeg(strike, 'PE');
      if (!ce?.bid || !ce.ask || !pe?.bid || !pe.ask) continue;

      const bid = ce.bid + pe.bid;
      const ask = ce.ask + pe.ask;
      const mid = (bid + ask) / 2;
      const ivs = [ce.iv, pe.iv].filter((v): v is number => v != null && v > 0);
      if (!best || mid < best.mid) {
        best = {
          strike, bid, ask, mid,
          call: (ce.bid + ce.ask) / 2,
          put:  (pe.bid + pe.ask) / 2,
          iv:   ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null,
          greeks: {
            delta: sumLeg(ce.delta, pe.delta),
            gamma: sumLeg(ce.gamma, pe.gamma),
            vega:  sumLeg(ce.vega,  pe.vega),
            theta: sumLeg(ce.theta, pe.theta),
          },
        };
      }
    }

    if (!best) return;   // nothing in the band is two-sided yet

    const isRoll = prevStrike != null && prevStrike !== best.strike;
    const synFuture = best.strike + best.call - best.put;

    // Greeks of the straddle currently held. Feed first, Black-76 to fill in —
    // the same order and the same units as the historical engine, so a live
    // point appended to a loaded session does not step at the join.
    let greeks: { delta: number | null; gamma: number | null; vega: number | null; theta: number | null } | null = null;
    let greekSource: 'feed' | 'black76' | undefined;

    if (best.greeks.vega != null || best.greeks.theta != null) {
      greeks = best.greeks;
      greekSource = 'feed';
    } else if (best.iv != null && best.iv > 0) {
      const T = yearsToExpiry(atMs, expiry);
      const g = straddleGreeks(synFuture, best.strike, T, best.iv / 100);
      if (g) { greeks = g; greekSource = 'black76'; }
    }

    const point: StraddlePoint = {
      time:            atMs,
      spot,
      atmStrike:       best.strike,
      // Put-call parity on the selected strike, same identity the historical
      // engine plots: F = K + CE − PE.
      syntheticFuture: synFuture,
      callLtp:         best.call,
      putLtp:          best.put,
      straddlePrice:   best.mid,
      straddleBid:     best.bid,
      straddleAsk:     best.ask,
      ...(best.iv != null ? { iv: best.iv } : {}),
      ...(greeks?.vega  != null ? { vega:  greeks.vega  } : {}),
      ...(greeks?.theta != null ? { theta: greeks.theta } : {}),
      ...(greeks?.delta != null ? { delta: greeks.delta } : {}),
      ...(greeks?.gamma != null ? { gamma: greeks.gamma } : {}),
      ...(greekSource ? { greekSource } : {}),
      isRollEvent:     isRoll,
    };

    const roll: RollEvent | undefined = isRoll ? {
      time:          atMs,
      fromStrike:    prevStrike!,
      toStrike:      best.strike,
      synFuture:     point.syntheticFuture,
      straddlePrice: best.mid,
      vegaJump:  point.vega  != null && prevVega  != null ? point.vega  - prevVega  : null,
      thetaJump: point.theta != null && prevTheta != null ? point.theta - prevTheta : null,
    } : undefined;

    prevStrike = best.strike;
    if (point.vega  != null) prevVega  = point.vega;
    if (point.theta != null) prevTheta = point.theta;

    // Retained BEFORE the emit, so a replay asked for from inside a send path
    // can never be missing the point that is going out right now.
    replay.push({ point, roll });
    if (replay.length > REPLAY_CAP) replay.splice(0, REPLAY_TRIM);

    emit({ event: 'point', point, ...(roll ? { roll } : {}) });
  }

  // ── Start ──────────────────────────────────────────────────────────────────

  spawnBridge(opts.atmHint && opts.atmHint > 0 ? nearestStrike(opts.atmHint, strikes, step) : null);
  emit({
    event: 'status',
    status: 'starting',
    message: `${symbol} ${expiry} · ${strikes.length} strikes · underlying ${spotRef.symbol}`,
  });

  return {
    stop() {
      stopped = true;
      if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
      bridge?.stop();
      bridge = null;
    },

    replaySince(sinceMs: number): LiveReplay {
      // Linear from the front: this runs once per reconnect, not per tick, and
      // the window is bounded by REPLAY_CAP.
      let from = replay.length;
      for (let i = 0; i < replay.length; i++) {
        if (replay[i].point.time > sinceMs) { from = i; break; }
      }
      const slice = replay.slice(from);

      /**
       * Does the replay actually reach back to where the client left off?
       *
       * Measured against the oldest thing this session can still speak for —
       * its first retained point, or its own start before any point exists.
       * Anything earlier than that belongs to history, not to the feed, whether
       * it fell out of the window or the session simply had not begun.
       *
       * REPLAY_JOIN_MS of slack keeps the ordinary case quiet: on a first
       * subscribe the client's mark is the last historical bar, a second or two
       * before the session opens, and that is not a gap worth reloading a
       * session over.
       */
      const floor = replay.length ? replay[0].point.time : startedAt;
      const complete = sinceMs >= floor - REPLAY_JOIN_MS;

      return {
        points: slice.map((e) => e.point),
        rolls:  slice.flatMap((e) => (e.roll ? [e.roll] : [])),
        complete,
      };
    },

    lastPointTime() {
      return replay.length ? replay[replay.length - 1].point.time : null;
    },
  };
}

// ── Session window ───────────────────────────────────────────────────────────

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/**
 * Is this exchange trading right now?
 *
 * Shares sessionRange with the historical engine, so MCX's 09:00–23:55 window
 * is defined exactly once — a live feed that ran past the chart's own session
 * bounds would append points the history could never contain.
 */
export function isMarketOpen(exchange: string, now = Date.now()): boolean {
  const { start, end } = sessionRange(istToday(), exchange);
  return now >= start && now <= end;
}

export function msUntilClose(exchange: string, now = Date.now()): number {
  return sessionRange(istToday(), exchange).end - now;
}
