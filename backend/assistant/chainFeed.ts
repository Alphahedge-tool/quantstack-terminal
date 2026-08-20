/**
 * Live option-chain subscriptions, shared and ref-counted.
 *
 * ── Why this is not just "start a bridge" ──
 *
 * A chain subscription costs 20 session-weight against a 50,000 budget, and it
 * is a whole child process. The assistant will be asked for the same chain over
 * and over: three watches on NIFTY strikes, a chat question about the PCR, and
 * a background buildup scan are four consumers of ONE subscription. Starting a
 * bridge per consumer would burn weight linearly, fork four pythons, and — the
 * part that actually breaks — give each consumer a different view of the same
 * chain, because they would arrive at different moments.
 *
 * So: one bridge per `exchange:symbol:expiry`, ref-counted. Consumers acquire
 * and release; the process starts on the first acquire and stops a grace period
 * after the last release. The grace matters — a user flipping between two
 * strikes on the same chain should not respawn python each time.
 *
 * ── What it publishes ──
 *
 * A normalised `ChainSnapshot`: every strike, both sides, with ltp/iv/oi/volume
 * and greeks, plus the underlying. That is the single shape the monitor, the
 * tools and the cards all read, so none of them ever touches a bridge payload.
 *
 * The `option` channel is the right source here (not `greeks`): it carries OI,
 * and OI is the entire point of this feature. `greeks` is per-refId and cheaper
 * but publishes no open interest, so it cannot answer the question the user is
 * actually asking.
 */

import { startBridge, type BridgeEvent, type BridgeHandle } from '../feeds/adapters/nubra/liveBridge.js';
import { getCachedRefdata, todayIST } from '../lib/instrumentCache.js';
import type { NubraSession } from '../brokers/nubra.js';
import type { OptionSide } from './types.js';

import { logger } from '../lib/logger.js';

const log = logger('iris/chain');

// ── Shapes ───────────────────────────────────────────────────────────────────

/** One contract's live state. All prices in rupees, IV in percent. */
export interface ChainQuote {
  strike:  number;
  side:    OptionSide;
  refId?:  string;
  ltp?:    number;
  iv?:     number;
  oi?:     number;
  prevOi?: number;
  volume?: number;
  delta?:  number;
  gamma?:  number;
  vega?:   number;
  theta?:  number;
  ts:      number;
}

export interface ChainSnapshot {
  exchange: string;
  symbol:   string;
  expiry:   string;
  /** Underlying price, when the chain published one. */
  spot?:    number;
  /** At-the-money strike as the feed computed it. */
  atm?:     number;
  /** `strike|side` → quote. */
  quotes:   Map<string, ChainQuote>;
  updatedAt: number;
}

export interface ChainHandle {
  readonly key: string;
  /** Latest snapshot, or null before the first payload lands. */
  snapshot(): ChainSnapshot | null;
  release(): void;
}

export type ChainListener = (snap: ChainSnapshot) => void;

export const legKey = (strike: number, side: OptionSide): string => `${strike}|${side}`;

// ── Payload normalisation ────────────────────────────────────────────────────

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Dict) : null;

/**
 * Paise → rupees, tolerating the several spellings the feed uses.
 *
 * Zero is treated as "no print" rather than a real price: a chain publishes 0
 * for contracts that have not traded, and carrying that through would show a
 * deep wing as free and drag any average that includes it to the floor.
 */
function rupees(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return undefined;
  return n / 100;
}

function plain(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * IV, normalised to percent.
 *
 * The feed is inconsistent about whether IV is a fraction or a percentage —
 * 0.1048 and 10.48 both occur for the same contract across channels. Anything
 * at or below 1 is read as a fraction and scaled; above 1 it is already
 * percent. A real option never has 1% IV, so the boundary is safe.
 */
function ivPercent(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n <= 1 ? n * 100 : n;
}

/** One `ce[]`/`pe[]` row from the option channel. */
function readQuote(row: Dict, side: OptionSide, ts: number): ChainQuote | null {
  const strike = rupees(row.sp ?? row.strike_price ?? row.strikePrice);
  if (strike == null) return null;

  return {
    strike,
    side,
    refId:  row.ref_id != null ? String(row.ref_id) : undefined,
    ltp:    rupees(row.ltp ?? row.last_traded_price),
    iv:     ivPercent(row.iv),
    oi:     plain(row.oi ?? row.open_interest),
    prevOi: plain(row.prev_oi ?? row.previous_open_interest),
    volume: plain(row.volume),
    delta:  plain(row.delta),
    gamma:  plain(row.gamma),
    vega:   plain(row.vega),
    theta:  plain(row.theta),
    ts,
  };
}

// ── Subscription registry ────────────────────────────────────────────────────

interface Entry {
  key:       string;
  exchange:  string;
  symbol:    string;
  expiry:    string;
  bridge:    BridgeHandle | null;
  snapshot:  ChainSnapshot;
  listeners: Set<ChainListener>;
  refs:      number;
  /** Set while waiting out the grace period after the last release. */
  reaper:    NodeJS.Timeout | null;
  /** Consecutive bridge exits, for backoff on a feed that will not stay up. */
  restarts:  number;
  restartTimer: NodeJS.Timeout | null;
  /** Throttled publish loop — see PUBLISH_MS. */
  pump:      NodeJS.Timeout | null;
}

const entries = new Map<string, Entry>();

/**
 * How long a chain stays subscribed after its last consumer leaves.
 *
 * 30s: long enough that navigating between strikes or asking a follow-up
 * question reuses the live process, short enough that an abandoned chain does
 * not hold 20 weight for the rest of the session.
 */
const GRACE_MS = Number(process.env.QT_ASSISTANT_CHAIN_GRACE_MS || 30_000);

/** Emitted no faster than this, however hard the chain prints. */
const PUBLISH_MS = Number(process.env.QT_ASSISTANT_CHAIN_THROTTLE_MS || 1_000);

const RESTART_BACKOFF = [1_000, 2_000, 5_000, 15_000, 30_000];

function keyOf(exchange: string, symbol: string, expiry: string): string {
  return `${exchange}:${symbol}:${expiry}`;
}

function environment(): 'prod' | 'uat' {
  return /uat/i.test(process.env.NUBRA_BASE_URL || '') ? 'uat' : 'prod';
}

/**
 * Is the Indian cash/derivatives market open right now?
 *
 * 09:15–15:30 IST, Monday to Friday. Deliberately ignores trading holidays:
 * the only consumer is the post-market decision below, and being wrong on a
 * holiday means asking for live data that is silent — which is exactly what
 * happens today anyway, so a holiday calendar would add a maintenance burden
 * for no behavioural gain. MCX runs later, and treating its evening session as
 * closed is the same harmless error in the same direction.
 */
function marketIsOpen(now = new Date()): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

/**
 * Whether to ask for the post-market snapshot.
 *
 * Automatic, because the alternative is a terminal that silently shows nothing
 * every evening and a developer who concludes the feed is broken. `1`/`0`
 * force it either way for testing the opposite branch.
 */
function wantPostMarket(): boolean {
  const forced = process.env.QT_ASSISTANT_POST_MARKET;
  if (forced === '1') return true;
  if (forced === '0') return false;
  return !marketIsOpen();
}

/**
 * Resolve the underlying instrument the chain should stream alongside.
 *
 * The option channel publishes `currentprice`, but not always and not on every
 * packet, so the spot symbol is subscribed too. Without it, a chain that has
 * not printed an underlying yet has no spot at all and ATM-relative answers
 * ("what's the ATM straddle") cannot be computed.
 */
async function spotSymbolFor(
  symbol: string, exchange: string, session: NubraSession,
): Promise<string | undefined> {
  try {
    const rows = await getCachedRefdata(exchange, todayIST(), session);
    const cash = rows.find((r) => r.asset === symbol && r.type !== 'OPT' && r.type !== 'FUT');
    if (cash) return cash.name;
    const fut = rows
      .filter((r) => r.asset === symbol && r.type === 'FUT' && r.expiry)
      .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))[0];
    return fut?.name;
  } catch {
    return undefined;
  }
}

function publish(entry: Entry): void {
  const snap = entry.snapshot;
  for (const listener of entry.listeners) {
    try {
      listener(snap);
    } catch (err) {
      // One bad consumer must not stop the others from seeing the tick.
      log.warn(`listener threw on ${entry.key}: ${(err as Error).message}`);
    }
  }
}

function handleEvent(entry: Entry, e: BridgeEvent): void {
  if (e.event === 'error') {
    log.warn(`${entry.key}: ${e.message}`);
    return;
  }
  if (e.event !== 'option') return;

  const d = asDict(e.data);
  if (!d) return;

  const ts = Number(e.received_at_ms) || Date.now();
  const snap = entry.snapshot;

  for (const [field, side] of [['ce', 'CE'], ['pe', 'PE']] as const) {
    const rows = d[field];
    if (!Array.isArray(rows)) continue;
    for (const raw of rows) {
      const row = asDict(raw);
      if (!row) continue;
      const q = readQuote(row, side, ts);
      if (!q) continue;
      // Merge rather than replace: successive packets carry different subsets
      // (one has greeks, the next only OI), and replacing would make every
      // field the current packet omits flicker to undefined.
      const prev = snap.quotes.get(legKey(q.strike, side));
      snap.quotes.set(legKey(q.strike, side), prev ? { ...prev, ...stripUndefined(q) } : q);
    }
  }

  const spot = rupees(d.currentprice ?? d.current_price ?? d.cp);
  if (spot != null) snap.spot = spot;
  const atm = rupees(d.atm);
  if (atm != null) snap.atm = atm;

  snap.updatedAt = ts;
}

function stripUndefined(q: ChainQuote): Partial<ChainQuote> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined) out[k] = v;
  return out as Partial<ChainQuote>;
}

function spawn(entry: Entry, session: NubraSession, spotSymbol?: string): void {
  entry.bridge = startBridge(
    {
      environment: environment(),
      token:       session.sessionToken.replace(/^Bearer /, '').trim(),
      deviceId:    session.deviceId,
      exchange:    entry.exchange,
      symbol:      entry.symbol,
      spotSymbol,
      expiry:      entry.expiry,
      interval:    '1m',
      postMarket:  wantPostMarket(),
      // Empty: the chain stream carries every strike already, and naming refIds
      // would additionally open orderbook+greeks per contract for depth this
      // consumer does not need. See liveBridge's straddle mode.
      refIds:      [],
    },
    (e) => handleEvent(entry, e),
    (code) => {
      entry.bridge = null;
      if (!entry.refs) return;   // released while dying — let it go

      // Backoff, because a bridge that exits instantly (bad token, missing
      // python) would otherwise respawn in a tight loop forever.
      const delay = RESTART_BACKOFF[Math.min(entry.restarts, RESTART_BACKOFF.length - 1)];
      entry.restarts++;
      log.warn(
        `${entry.key} bridge exited (${code ?? 'signal'}) — retrying in ${delay}ms`,
      );
      entry.restartTimer = setTimeout(() => {
        entry.restartTimer = null;
        if (entry.refs) spawn(entry, session, spotSymbol);
      }, delay);
      entry.restartTimer.unref?.();
    },
  );

  // A bridge that survives its first minute is healthy; reset the backoff so a
  // transient failure hours later does not start at a 30s delay.
  const settle = setTimeout(() => { entry.restarts = 0; }, 60_000);
  settle.unref?.();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire a live chain. Idempotent per key — callers share one process.
 *
 * The returned handle is the ONLY way to release; losing it leaks a reference
 * and holds the subscription for the process lifetime, so consumers store it
 * for the whole time they need the chain and release in their teardown path.
 */
export async function acquireChain(
  opts: { exchange: string; symbol: string; expiry: string; session: NubraSession },
  listener?: ChainListener,
): Promise<ChainHandle> {
  const exchange = opts.exchange.trim().toUpperCase();
  const symbol   = opts.symbol.trim().toUpperCase();
  const expiry   = opts.expiry.replace(/-/g, '').trim();
  const key      = keyOf(exchange, symbol, expiry);

  let entry = entries.get(key);

  if (!entry) {
    entry = {
      key, exchange, symbol, expiry,
      bridge: null,
      snapshot: { exchange, symbol, expiry, quotes: new Map(), updatedAt: 0 },
      listeners: new Set(),
      refs: 0,
      reaper: null,
      restarts: 0,
      restartTimer: null,
      pump: null,
    };
    entries.set(key, entry);

    const spotSymbol = await spotSymbolFor(symbol, exchange, opts.session);
    spawn(entry, opts.session, spotSymbol);

    const pump = setInterval(() => {
      const e = entries.get(key);
      if (!e) return;
      if (e.snapshot.updatedAt) publish(e);
    }, PUBLISH_MS);
    pump.unref?.();
    entry.pump = pump;
  }

  // A pending reap means the chain was about to be dropped; this acquire saves
  // it, and the process never restarts.
  if (entry.reaper) {
    clearTimeout(entry.reaper);
    entry.reaper = null;
  }

  entry.refs++;
  if (listener) entry.listeners.add(listener);

  let released = false;
  const held = entry;

  return {
    key,
    snapshot: () => (held.snapshot.updatedAt ? held.snapshot : null),
    release() {
      if (released) return;    // double-release must not drop someone else's ref
      released = true;
      if (listener) held.listeners.delete(listener);
      held.refs = Math.max(0, held.refs - 1);
      if (held.refs > 0) return;

      held.reaper = setTimeout(() => teardown(held), GRACE_MS);
      held.reaper.unref?.();
    },
  };
}

function teardown(entry: Entry): void {
  if (entry.refs > 0) return;
  entry.bridge?.stop();
  entry.bridge = null;
  if (entry.restartTimer) clearTimeout(entry.restartTimer);
  if (entry.pump) clearInterval(entry.pump);
  entry.listeners.clear();
  entries.delete(entry.key);
}

/** Snapshot for a chain that is already subscribed, without acquiring one. */
export function peekChain(
  exchange: string, symbol: string, expiry: string,
): ChainSnapshot | null {
  const entry = entries.get(keyOf(exchange.toUpperCase(), symbol.toUpperCase(), expiry.replace(/-/g, '')));
  return entry?.snapshot.updatedAt ? entry.snapshot : null;
}

/** What is live right now — for the status line and the feeds page. */
export function chainStats(): Array<{ key: string; refs: number; strikes: number; updatedAt: number }> {
  return [...entries.values()].map((e) => ({
    key: e.key,
    refs: e.refs,
    strikes: e.snapshot.quotes.size,
    updatedAt: e.snapshot.updatedAt,
  }));
}

/**
 * Wait for a chain to publish its first payload.
 *
 * A question asked the instant a chain is acquired has nothing to read, and
 * answering "no data" there would be wrong — the data is a few seconds away.
 * Resolves with null on timeout so the caller can say so rather than hang.
 *
 * ── Why the default is 20s and not 5 ──
 *
 * A cold chain is a python cold start: spawn, import the Nubra SDK,
 * authenticate, subscribe, wait for the first packet. Measured against a live
 * PROD session that is comfortably past 8s, and an 8s budget produced exactly
 * the wrong answer — "the feed may still be connecting" on a chain that went on
 * to deliver 462 strikes moments later. A warm chain returns on the first poll
 * regardless, so the long ceiling costs nothing in the common case and only
 * applies to the first question about a symbol.
 */
export async function firstSnapshot(
  handle: ChainHandle, timeoutMs = Number(process.env.QT_ASSISTANT_FIRST_TICK_MS || 20_000),
): Promise<ChainSnapshot | null> {
  const existing = handle.snapshot();
  if (existing) return existing;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 150));
    const snap = handle.snapshot();
    if (snap) return snap;
  }
  return null;
}
