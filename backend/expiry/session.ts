/**
 * One live expiry-day session: the chain, the minute series, and the recorder.
 *
 * ── Why this is a store and not a route handler ──
 *
 * Every signal in the cockpit is a RATE — straddle decay per five minutes, IV
 * acceleration, whether the call wall has moved in the last half hour. None of
 * them can be computed from a snapshot, and the chain socket only ever gives
 * snapshots. So something has to sit between the two and remember: this is that
 * thing. It subscribes once per contract, samples the chain into one bar a
 * minute, and answers questions from the series it has accumulated.
 *
 * ── The recorder, and what it is actually for ──
 *
 * It was built on a wrong conclusion, which is worth recording because the
 * mistake is the instructive part: OI was believed to have no history, on the
 * evidence of a probe that asked for `oi`, `open_interest` and `openInterest` —
 * three plausible names, all of which `charts/timeseries` accepts and answers
 * with nothing. The documented field is `cumulative_oi`, it is served, and it
 * reaches back at least 180 days at one-minute resolution. Guessing a field
 * name produces exactly the same silence as a field that does not exist.
 *
 * So the whole cockpit IS backtestable — see `expiry/replay.ts`, which rebuilds
 * any past session from that history.
 *
 * The recorder stays, for two things history cannot give:
 *
 *   1. RESOLUTION. The socket publishes about once a second; the history
 *      endpoint's finest useful option interval here is a minute. A regime that
 *      turns inside sixty seconds is only visible in the recording.
 *   2. WHAT THE FEED PUBLISHED AT THE TIME. Vendors restate history; a bar
 *      written down as it arrived is evidence, and a bar fetched afterwards is
 *      whatever the vendor currently says. For research into what was knowable
 *      at 14:47, only the first one answers the question.
 *
 * Each bar is appended to a JSONL file per contract per day — a few megabytes a
 * session, and cheap insurance either way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  acquireChain, type ChainHandle, type ChainSnapshot,
} from '../assistant/chainFeed.js';
import { getEligible } from '../lib/instrumentCache.js';
import { requireSession } from '../lib/sessionStore.js';
import {
  atmView, buildLadder, classifyFlow, classifyRegime, expectedMovePct, gammaFlip,
  minutesToExpiry, oiMigration, pressureOf, realizedVolPct, wallsOf,
  type ExpiryBar, type Leg, type Migration, type Pressure, type Regime, type Rung,
} from '../analytics/expiryMetrics.js';

import { logger } from '../lib/logger.js';

const log = logger('expiry');

/* ── Shape ────────────────────────────────────────────────────────────────── */

export interface ExpiryState {
  symbol: string;
  exchange: string;
  expiry: string;
  /** Lot size, for display. NOT a GEX input — see `gexOf`, and the note there
   *  about this feed publishing OI in units rather than contracts. */
  lot: number;
  updatedAt: number;
  minutesToExpiry: number | null;
  /** Whether the chain has published anything yet. */
  live: boolean;
  spot: number | null;
  atmStrike: number | null;
  straddle: number | null;
  iv: number | null;
  skew: number | null;
  syntheticFuture: number | null;
  expectedMovePct: number | null;
  realizedVolPct: number | null;
  netGex: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  regime: Regime;
  regimeNote: string;
  pressure: Pressure;
  migration: Migration[];
  /** The strike ladder, ATM-centred and trimmed — see `LADDER_SPAN`. */
  ladder: Rung[];
  /** One bar a minute, oldest first. */
  bars: ExpiryBar[];
  /** How many bars have been written to disk this session. */
  recorded: number;
}

/* ── Tuning ───────────────────────────────────────────────────────────────── */

/**
 * Strikes either side of the ATM kept in the ladder and in the GEX sum.
 *
 * A NIFTY chain lists hundreds of strikes and the far wings carry OI that no
 * longer trades — stale positions from three months ago whose gamma is zero and
 * whose OI would still dominate a "max OI" scan. Twenty either side is about
 * ±4% on a weekly, which covers everything that can matter by 15:30.
 */
const LADDER_SPAN = 20;

/** Minutes of series kept in memory. A session is 375 minutes; this covers it
 *  with room for a pre-open subscription. */
const MAX_BARS = 420;

/** How long a session stays subscribed after its last reader leaves. The
 *  cockpit polls every few seconds, so this only fires when a tab closes. */
const IDLE_MS = 3 * 60_000;

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RECORD_DIR = path.join(__dir, '..', 'cache', 'expiry');

/* ── State ────────────────────────────────────────────────────────────────── */

interface Entry {
  key: string;
  symbol: string;
  exchange: string;
  expiry: string;
  lot: number;
  handle: ChainHandle | null;
  bars: ExpiryBar[];
  ladder: Rung[];
  /** Last ltp per `strike|side`, so a flow can be classified against a price move. */
  lastLtp: Map<string, number>;
  lastOi: Map<string, number>;
  spots: number[];
  recorded: number;
  recordPath: string;
  lastBarMinute: number;
  lastTouched: number;
  timer: NodeJS.Timeout | null;
}

const entries = new Map<string, Entry>();

const keyOf = (exchange: string, symbol: string, expiry: string) =>
  `${exchange}|${symbol}|${expiry}`;

const normalise = (expiry: string) => expiry.replace(/-/g, '').trim();

/* ── Sampling ─────────────────────────────────────────────────────────────── */

/** Flatten a chain snapshot into the ladder's input, trimmed to the ATM window. */
function legsNear(snap: ChainSnapshot, reference: number): Leg[] {
  const strikes = [...new Set([...snap.quotes.values()].map((q) => q.strike))]
    .sort((a, b) => a - b);
  if (!strikes.length) return [];

  let atmIndex = 0;
  let gap = Infinity;
  strikes.forEach((strike, i) => {
    const d = Math.abs(strike - reference);
    if (d < gap) { gap = d; atmIndex = i; }
  });

  const lo = strikes[Math.max(0, atmIndex - LADDER_SPAN)];
  const hi = strikes[Math.min(strikes.length - 1, atmIndex + LADDER_SPAN)];

  const legs: Leg[] = [];
  for (const q of snap.quotes.values()) {
    if (q.strike < lo || q.strike > hi) continue;
    legs.push({
      strike: q.strike,
      side: q.side,
      ltp: q.ltp,
      iv: q.iv,
      oi: q.oi,
      prevOi: q.prevOi,
      volume: q.volume,
      delta: q.delta,
      gamma: q.gamma,
      vega: q.vega,
      theta: q.theta,
    });
  }
  return legs;
}

/**
 * Fold one chain snapshot into the session.
 *
 * Called on every publish — roughly once a second — but only APPENDS a bar when
 * the minute rolls over. The ladder and the last-known values are refreshed
 * every time, so the cockpit's top line is as live as the socket while the
 * series stays one-a-minute, which is the resolution every rate in
 * `expiryMetrics` is defined at.
 */
function sample(entry: Entry, snap: ChainSnapshot): void {
  const spot = snap.spot ?? null;
  const reference = spot ?? snap.atm ?? 0;
  if (!(reference > 0)) return;

  const legs = legsNear(snap, reference);
  if (!legs.length) return;

  const ladder = buildLadder(legs, reference);

  // Flow needs a price change, which needs a previous price. First pass through
  // leaves everything `flat` rather than comparing against zero — a leg going
  // from "unknown" to 42 is not a rally.
  for (const rung of ladder) {
    for (const side of ['call', 'put'] as const) {
      const leg = rung[side];
      if (!leg) continue;
      const k = `${rung.strike}|${side}`;
      const ltp = leg.ltp ?? null;
      const oi = leg.oi ?? null;
      const prevLtp = entry.lastLtp.get(k);
      const prevOi = entry.lastOi.get(k);
      if (ltp != null && oi != null && prevLtp != null && prevOi != null) {
        const flow = classifyFlow(ltp - prevLtp, oi - prevOi);
        if (side === 'call') rung.callFlow = flow; else rung.putFlow = flow;
      }
      if (ltp != null) entry.lastLtp.set(k, ltp);
      if (oi != null) entry.lastOi.set(k, oi);
    }
  }

  entry.ladder = ladder;
  entry.lastTouched = Date.now();

  if (spot != null) {
    entry.spots.push(spot);
    if (entry.spots.length > 60) entry.spots.shift();
  }

  const atm = atmView(ladder, reference);
  const walls = wallsOf(ladder);
  const netGex = ladder.reduce((s, r) => s + r.netGex, 0);

  const minute = Math.floor(snap.updatedAt / 60_000);
  const bar: ExpiryBar = {
    time: minute * 60_000,
    spot,
    atmStrike: atm.strike,
    straddle: atm.straddle,
    iv: atm.iv,
    skew: atm.skew,
    syntheticFuture: atm.syntheticFuture,
    netGex,
    gammaFlip: gammaFlip(ladder),
    callWall: walls.callWall,
    putWall: walls.putWall,
    callOi: ladder.reduce((s, r) => s + r.callOi, 0),
    putOi: ladder.reduce((s, r) => s + r.putOi, 0),
    volume: ladder.reduce(
      (s, r) => s + (r.call?.volume ?? 0) + (r.put?.volume ?? 0), 0,
    ),
    expectedMovePct: expectedMovePct(atm.straddle, spot),
    realizedVolPct: realizedVolPct(entry.spots),
  };

  if (minute === entry.lastBarMinute) {
    // Same minute: overwrite. The bar is the minute's LAST state, matching how
    // every other series in this product is bucketed.
    entry.bars[entry.bars.length - 1] = bar;
    return;
  }

  entry.lastBarMinute = minute;
  entry.bars.push(bar);
  if (entry.bars.length > MAX_BARS) entry.bars.shift();
  record(entry, bar, ladder);
}

/* ── The recorder ─────────────────────────────────────────────────────────── */

/**
 * Append one minute to the session's file.
 *
 * JSONL, one object per line: appendable without reading, survives a crash
 * mid-write with at most one broken last line, and greppable. The full ladder
 * rides along with the bar — the whole point is the OI and gamma per strike,
 * which is exactly what a summary row would throw away.
 *
 * Failures are logged once and never retried. A recorder that could take the
 * live cockpit down with it would be a bad trade: the research corpus is worth
 * a lot less than the session it is recorded from.
 */
function record(entry: Entry, bar: ExpiryBar, ladder: Rung[]): void {
  const line = JSON.stringify({
    ...bar,
    ladder: ladder.map((r) => ({
      k: r.strike,
      co: r.callOi, po: r.putOi,
      cl: r.call?.ltp ?? null, pl: r.put?.ltp ?? null,
      ci: r.call?.iv ?? null, pi: r.put?.iv ?? null,
      cg: r.call?.gamma ?? null, pg: r.put?.gamma ?? null,
      cv: r.call?.volume ?? null, pv: r.put?.volume ?? null,
      cx: r.callGex, px: r.putGex,
    })),
  });

  try {
    fs.appendFileSync(entry.recordPath, `${line}\n`, 'utf8');
    entry.recorded += 1;
  } catch (e) {
    if (entry.recorded >= 0) {
      log.warn(`recording to ${entry.recordPath} failed: ${(e as Error).message}`);
      entry.recorded = -1;   // latched: say it once, not once a minute
    }
  }
}

/* ── Lifecycle ────────────────────────────────────────────────────────────── */

async function open(exchange: string, symbol: string, expiry: string): Promise<Entry> {
  const key = keyOf(exchange, symbol, expiry);
  const existing = entries.get(key);
  if (existing) {
    existing.lastTouched = Date.now();
    return existing;
  }

  const session = requireSession();
  const eligible = await getEligible(symbol, exchange, todayISO(), session);

  fs.mkdirSync(RECORD_DIR, { recursive: true });

  const entry: Entry = {
    key, symbol, exchange, expiry,
    // Carried for display only. The GEX maths deliberately does NOT use it —
    // this feed publishes OI in units, not contracts. See `gexOf`.
    lot: eligible?.lot || 0,
    handle: null,
    bars: [],
    ladder: [],
    lastLtp: new Map(),
    lastOi: new Map(),
    spots: [],
    recorded: 0,
    recordPath: path.join(RECORD_DIR, `${exchange}_${symbol}_${expiry}_${todayISO()}.jsonl`),
    lastBarMinute: 0,
    lastTouched: Date.now(),
    timer: null,
  };
  entries.set(key, entry);

  entry.handle = await acquireChain(
    { exchange, symbol, expiry, session },
    (snap) => {
      try {
        sample(entry, snap);
      } catch (e) {
        log.warn(`${key} sample failed: ${(e as Error).message}`);
      }
    },
  );

  // Idle release. The cockpit polls, so "nobody asked in three minutes" is the
  // only reliable signal that the tab is gone — there is no socket to close.
  entry.timer = setInterval(() => {
    if (Date.now() - entry.lastTouched < IDLE_MS) return;
    log.info(`${key} idle — releasing the chain`);
    close(key);
  }, 60_000);
  entry.timer.unref?.();

  log.info(`watching ${symbol} ${expiry} on ${exchange} — lot ${entry.lot}, recording to ${path.basename(entry.recordPath)}`);
  return entry;
}

function close(key: string): void {
  const entry = entries.get(key);
  if (!entry) return;
  if (entry.timer) clearInterval(entry.timer);
  entry.handle?.release();
  entries.delete(key);
}

function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/* ── Public API ───────────────────────────────────────────────────────────── */

/**
 * The cockpit's whole state for one contract.
 *
 * Acquiring is idempotent and the first call is the slow one — a cold chain has
 * to spawn and authenticate before its first packet, which is why `live` is
 * part of the answer instead of this waiting for data that may be twenty
 * seconds away.
 */
export async function expiryState(
  exchange: string, symbol: string, rawExpiry: string,
): Promise<ExpiryState> {
  const expiry = normalise(rawExpiry);
  const entry = await open(exchange.toUpperCase(), symbol.toUpperCase(), expiry);

  const snap = entry.handle?.snapshot() ?? null;
  const last = entry.bars[entry.bars.length - 1] ?? null;
  const walls = wallsOf(entry.ladder);
  const { regime, note } = classifyRegime(entry.bars);

  return {
    symbol: entry.symbol,
    exchange: entry.exchange,
    expiry: entry.expiry,
    lot: entry.lot,
    updatedAt: snap?.updatedAt ?? 0,
    minutesToExpiry: minutesToExpiry(Date.now(), entry.expiry),
    live: Boolean(snap),
    spot: last?.spot ?? snap?.spot ?? null,
    atmStrike: last?.atmStrike ?? null,
    straddle: last?.straddle ?? null,
    iv: last?.iv ?? null,
    skew: last?.skew ?? null,
    syntheticFuture: last?.syntheticFuture ?? null,
    expectedMovePct: last?.expectedMovePct ?? null,
    realizedVolPct: last?.realizedVolPct ?? null,
    netGex: last?.netGex ?? null,
    gammaFlip: last?.gammaFlip ?? null,
    callWall: walls.callWall,
    putWall: walls.putWall,
    maxPain: walls.maxPain,
    regime,
    regimeNote: note,
    pressure: pressureOf(entry.bars),
    migration: oiMigration(entry.bars),
    ladder: entry.ladder,
    bars: entry.bars,
    recorded: entry.recorded,
  };
}

/** What is being watched and recorded, for the status route. */
export function expiryStats(): Array<{
  key: string; bars: number; recorded: number; strikes: number; file: string;
}> {
  return [...entries.values()].map((e) => ({
    key: e.key,
    bars: e.bars.length,
    recorded: e.recorded,
    strikes: e.ladder.length,
    file: path.basename(e.recordPath),
  }));
}

/** Release everything. Used by the shutdown path. */
export function closeAllExpiry(): void {
  for (const key of [...entries.keys()]) close(key);
}
