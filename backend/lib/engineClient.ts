/**
 * Client for `marketd` — the Go market engine.
 *
 * ── What this replaces, and what it does not ──
 *
 * `engine/liveStraddle.ts` does everything for a live contract: spawns the
 * bridge, parses every frame, keeps the books, runs the selection rule, derives
 * the greeks, throttles, and retains a replay window. All of that runs on the
 * event loop, beside every HTTP route the terminal serves.
 *
 * This file hands that whole job to another process and keeps only the parts
 * Node is actually the right place for:
 *
 *   - the LOGIN. marketd never authenticates. Node mints a token and passes it.
 *   - the CONTRACT TABLE. Refdata lives in `lib/instrumentCache.ts` with its
 *     alias handling, paise strikes and expiry formats. A second resolver in Go
 *     would be a second thing to keep right, and the two would drift.
 *   - the SPOT RESOLUTION. MCX prices off a future, not a cash leg, and which
 *     one is a question `resolveSpotCandidates` already answers.
 *
 * Everything after the subscription opens happens over there.
 *
 * ── Why the signature is identical to startLiveStraddle ──
 *
 * `startGoLiveStraddle` returns the same LiveStraddleHandle, emits the same
 * LiveStraddleEvent, and takes the same options. That is what lets
 * `live/wsStraddle.ts` choose between the two with one ternary instead of a
 * parallel code path — and what lets the flag be turned back off at any point
 * without a deploy.
 *
 * ── Why a local replay window on this side too ──
 *
 * marketd retains its own window and can answer a `resume` over the socket, but
 * `LiveStraddleHandle.replaySince` is SYNCHRONOUS: `wsStraddle`'s backfill runs
 * inside a message handler and has nowhere to await. Mirroring the emitted
 * points here keeps the handle a genuine drop-in. It costs the same points
 * twice in memory, which at 20k entries is a few megabytes — cheaper than
 * making every consumer of the handle async.
 */

import { WebSocket } from 'ws';
import { getCachedRefdata, resolveSpotCandidates, type InstrumentRow } from './instrumentCache.js';
import type { StraddlePoint } from '../analytics/syntheticFuture.js';
import type { RollEvent } from '../engine/rollingStraddle.js';
import type {
  LiveStraddleEvent, LiveStraddleOptions, LiveStraddleHandle, LiveReplay,
} from '../engine/liveStraddle.js';

import { logger } from './logger.js';

const log = logger('engine');

/**
 * Off unless asked for, exactly like the compute sidecar.
 *
 * The two engines are verified to agree by `scripts/verifyEngine.ts`, but
 * "agrees today on my contract" is not "agrees on every expiry in every
 * session". Opt-in means this can ship, run beside the TypeScript engine, and
 * be turned off from an env var rather than a rollback.
 */
const ENABLED = process.env.QT_GO_ENGINE === '1';

/**
 * One port variable, read by both halves — the same discipline computeClient.ts
 * arrived at after a mismatched pair looked exactly like a sidecar that was
 * down. `QT_MARKETD_URL` still wins outright, for an engine on another host.
 */
const PORT = process.env.QT_MARKETD_PORT || '3152';
const HTTP_BASE = (process.env.QT_MARKETD_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws');
const LIVE_PATH = '/ws/live/straddle';

/** How long to wait for the socket to open before giving up on the engine. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * How long a failure keeps the engine out of rotation.
 *
 * Without it, an engine that is not running turns every subscribe into a failed
 * connection plus the TypeScript start — strictly slower than never having
 * enabled it.
 */
const COOLDOWN_MS = 60_000;

/** Mirrors QT_LIVE_REPLAY_CAP on the TypeScript engine. */
const REPLAY_CAP = Number(process.env.QT_LIVE_REPLAY_CAP || 20_000);
const REPLAY_TRIM = Math.max(1, Math.floor(REPLAY_CAP / 10));

/** See engine/liveStraddle.ts — the same slack, for the same reason. */
const REPLAY_JOIN_MS = 20_000;

let disabledUntil = 0;
let healthy: boolean | null = null;

export function goEngineEnabled(): boolean {
  return ENABLED;
}

export function goEngineUrl(): string {
  return HTTP_BASE;
}

/** Why the engine is not being used right now, for the health route. */
export function goEngineStatus(): {
  enabled: boolean; url: string; healthy: boolean | null; cooldownMs: number;
} {
  return {
    enabled: ENABLED,
    url: HTTP_BASE,
    healthy,
    cooldownMs: Math.max(0, disabledUntil - Date.now()),
  };
}

/** Take the engine out of rotation for a cooldown. */
export function markGoEngineDown(reason: string): void {
  healthy = false;
  disabledUntil = Date.now() + COOLDOWN_MS;
  log.warn(`Go market engine disabled for ${COOLDOWN_MS / 1000}s: ${reason}`);
}

/**
 * Is the engine up and willing?
 *
 * Probed per session start rather than once and cached: unlike the batch
 * solver, a live session is long-lived and expensive to start on the wrong
 * side, so paying one HTTP round trip to be sure is worth it.
 */
export async function goEngineReady(): Promise<boolean> {
  if (!ENABLED) return false;
  if (Date.now() < disabledUntil) return false;
  try {
    const res = await fetch(`${HTTP_BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    healthy = res.ok;
    if (!res.ok) {
      markGoEngineDown(`health → ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    markGoEngineDown(`unreachable at ${HTTP_BASE} (${(e as Error).message})`);
    return false;
  }
}

// ── Wire shapes ──────────────────────────────────────────────────────────────

interface ContractRow { strike: number; side: 'CE' | 'PE'; refId: string }

interface EngineFrame {
  event: 'status' | 'point' | 'bar' | 'state' | 'error' | 'backfill' | 'pong';
  point?: StraddlePoint;
  roll?: RollEvent;
  status?: string;
  message?: string;
  feed?: string;
  bar?: unknown;
  points?: StraddlePoint[];
  rolls?: RollEvent[];
  complete?: boolean;
}

// ── Contract resolution ──────────────────────────────────────────────────────

/**
 * Build the option table marketd needs.
 *
 * The filter is the same one `engine/liveStraddle.ts` applies, deliberately:
 * this expiry, this asset, options only, with a strike, a side and a refId. A
 * row missing any of those cannot be subscribed and would only widen the band
 * with a strike that never quotes.
 */
async function contractsFor(
  symbol: string,
  exchange: string,
  expiry: string,
  today: string,
  session: LiveStraddleOptions['session'],
): Promise<ContractRow[]> {
  const rows = (await getCachedRefdata(exchange, today, session)).filter(
    (r: InstrumentRow) =>
      r.asset === symbol && r.type === 'OPT' && r.expiry === expiry
      && r.strike != null && r.optionType && r.refId,
  );

  const seen = new Set<string>();
  const out: ContractRow[] = [];
  for (const row of rows) {
    const key = `${row.strike}|${row.optionType}`;
    // First row wins, as everywhere else: a strike listed twice is the same
    // contract under two rows, and taking the later one would silently change
    // which refId the session watches.
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      strike: row.strike as number,
      side: row.optionType as 'CE' | 'PE',
      refId: row.refId as string,
    });
  }
  return out;
}

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ── The client ───────────────────────────────────────────────────────────────

/**
 * Start a live straddle on the Go engine.
 *
 * Throws for anything that makes the contract unservable — no refdata, no
 * underlying, engine unreachable — which is the same contract
 * `startLiveStraddle` has, and is what lets the caller fall back to it.
 */
export async function startGoLiveStraddle(
  opts: LiveStraddleOptions,
  emit: (e: LiveStraddleEvent) => void,
): Promise<LiveStraddleHandle> {
  const symbol = opts.symbol.trim().toUpperCase();
  const exchange = opts.exchange.trim().toUpperCase();
  const expiry = opts.expiry.replace(/-/g, '').trim();
  const today = istToday();

  const contracts = await contractsFor(symbol, exchange, expiry, today, opts.session);
  if (!contracts.length) {
    throw new Error(`No ${exchange} ${symbol} option contracts for expiry ${expiry} on ${today}`);
  }

  const spotRef = (await resolveSpotCandidates(symbol, exchange, today, expiry, opts.session))[0];
  if (!spotRef) throw new Error(`No underlying instrument for ${exchange} ${symbol}`);

  const socket = new WebSocket(`${WS_BASE}${LIVE_PATH}`, {
    handshakeTimeout: CONNECT_TIMEOUT_MS,
    // A full contract table on a wide chain is a few hundred KB; the default
    // limit would reject exactly the widest expiries.
    maxPayload: 16 * 1024 * 1024,
  });

  /** Emitted points, mirrored so replaySince can stay synchronous. */
  const replay: Array<{ point: StraddlePoint; roll?: RollEvent }> = [];
  const startedAt = Date.now();
  let stopped = false;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Go engine did not accept a connection within ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    socket.once('open', () => {
      clearTimeout(timer);
      socket.send(JSON.stringify({
        type: 'subscribe',
        symbol,
        exchange,
        expiry,
        spotSymbol: spotRef.symbol,
        contracts,
        atmHint: opts.atmHint,
        // The token goes over loopback to a process that will hand it straight
        // to the broker. It is not stored there and not logged there — see the
        // Spec.Redacted note in backend-go/feed/feed.go.
        token: opts.session.sessionToken.replace(/^Bearer /, '').trim(),
        deviceId: opts.session.deviceId,
        environment: /uat/i.test(process.env.NUBRA_BASE_URL || '') ? 'uat' : 'prod',
        interval: '1m',
        throttleMs: Number(process.env.QT_LIVE_THROTTLE_MS || 250),
        replayCap: REPLAY_CAP,
      }));
      resolve();
    });

    socket.once('error', (err: Error) => {
      clearTimeout(timer);
      markGoEngineDown(err.message);
      reject(err);
    });
  });

  socket.on('message', (raw: Buffer) => {
    if (stopped) return;
    let frame: EngineFrame;
    try {
      frame = JSON.parse(raw.toString('utf8')) as EngineFrame;
    } catch {
      return;
    }

    switch (frame.event) {
      case 'point': {
        if (!frame.point) return;
        replay.push({ point: frame.point, roll: frame.roll });
        if (replay.length > REPLAY_CAP) replay.splice(0, REPLAY_TRIM);
        emit({ event: 'point', point: frame.point, ...(frame.roll ? { roll: frame.roll } : {}) });
        return;
      }
      case 'status':
        emit({
          event: 'status',
          // The feed name rides in the status so a failover is visible to the
          // client rather than only in marketd's log.
          status: String(frame.status || 'status'),
          message: frame.feed ? `[${frame.feed}] ${frame.message ?? ''}`.trim() : frame.message,
        });
        return;
      case 'error':
        emit({ event: 'error', message: String(frame.message || 'Live feed error') });
        return;
      case 'state':
        emit({ event: 'status', status: `market-${frame.status}`, message: undefined });
        return;
      case 'bar':
      case 'backfill':
      case 'pong':
        // Bars and pongs are marketd's own additions; the backfill it sends on
        // subscribe is redundant here because this side mirrors the points
        // itself. Dropped rather than forwarded, so the wire protocol the
        // browser sees is exactly the one wsStraddle already defines.
        return;
      default:
        return;
    }
  });

  socket.on('close', () => {
    if (stopped) return;
    emit({ event: 'status', status: 'disconnected', message: 'Go engine closed the connection' });
  });

  socket.on('error', (err: Error) => {
    if (stopped) return;
    markGoEngineDown(err.message);
    emit({ event: 'error', message: `Go engine: ${err.message}` });
  });

  emit({
    event: 'status',
    status: 'starting',
    message: `${symbol} ${expiry} · ${contracts.length} contracts · underlying ${spotRef.symbol} · go engine`,
  });

  return {
    stop() {
      stopped = true;
      try {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: 'stop' }));
      } catch { /* closing anyway */ }
      socket.close();
    },

    replaySince(sinceMs: number): LiveReplay {
      let from = replay.length;
      for (let i = 0; i < replay.length; i++) {
        if (replay[i].point.time > sinceMs) { from = i; break; }
      }
      const slice = replay.slice(from);
      // The same floor rule the TypeScript engine uses: measured against the
      // oldest point this session can speak for, or its own start before any
      // point exists. Anything earlier belongs to history, not to the feed.
      const floor = replay.length ? replay[0].point.time : startedAt;
      return {
        points: slice.map((e) => e.point),
        rolls: slice.flatMap((e) => (e.roll ? [e.roll] : [])),
        complete: sinceMs >= floor - REPLAY_JOIN_MS,
      };
    },

    lastPointTime() {
      return replay.length ? replay[replay.length - 1].point.time : null;
    },
  };
}
