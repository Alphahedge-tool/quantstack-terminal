/**
 * The feed contract.
 *
 * Every broker implements MarketDataFeed. Nothing outside `feeds/adapters/`
 * may import a broker-specific type — that rule is the whole point of this
 * file, and it is what lets a second feed be added without touching a single
 * consumer.
 *
 * Note what is NOT in any signature below: a session. Auth lives inside the
 * adapter, driven by AuthManager. The analytics engine has no idea a login
 * exists.
 *
 * Unit conventions, normalised by every adapter:
 *   timestamps  epoch MILLISECONDS  (Nubra sends nanoseconds)
 *   prices      RUPEES              (Nubra sends paise)
 *   IV          plain decimal, not basis points
 */

import type { InstrumentKey, InstrumentKind } from './identity.js';

export type FeedId = string;   // 'nubra' | 'zerodha' | 'nubra#2'

// ── Data shapes ──────────────────────────────────────────────────────────────

export interface Point { ts: number; v: number }

export interface Candle {
  ts: number;
  o: number; h: number; l: number; c: number;
  vol?: number;
  oi?:  number;
}

/** Bid/ask/IV/greek series for one option contract. Mirrors NubraOptionSeries. */
export interface OptionSeries {
  bid:   Point[];
  ask:   Point[];
  ltp:   Point[];
  ivBid: Point[];
  ivAsk: Point[];
  ivMid: Point[];
  /**
   * Per-leg greeks as the feed publishes them, in feed units — vega per vol
   * point and theta per day, which is what every broker greek stream means by
   * the words. Not all feeds carry them and not all history has them, so these
   * are optional and an absent array means "not published" rather than zero.
   */
  delta?: Point[];
  gamma?: Point[];
  vega?:  Point[];
  theta?: Point[];
}

export type UnderlyingKind = 'INDEX' | 'STOCK' | 'COMMODITY' | 'UNKNOWN';

/**
 * A tradable instrument, broker-neutral.
 *
 * There is deliberately no `symbol` field. The feed's own symbol stays inside
 * the adapter; a consumer that could read it would start passing it around,
 * and the failover guarantee would quietly rot.
 */
export interface Instrument {
  key:   InstrumentKey;
  /** Human-readable, for UI only — never for lookups. */
  label: string;
  kind:  UnderlyingKind;
  lot?:  number;
}

/** An asset that has a listed option chain — drives symbol search. */
export interface TradableAsset {
  asset:    string;
  exchange: string;
  kind:     UnderlyingKind;
  lot:      number;
  /** ISO `YYYY-MM-DD`, ascending. */
  expiries: string[];
}

export interface Tick {
  key: InstrumentKey;
  ts:  number;
  ltp?: number;
  bid?: number;
  ask?: number;
  iv?:  number;
}

// ── Capabilities ─────────────────────────────────────────────────────────────

/**
 * What this feed can actually serve. The router filters on this BEFORE
 * priority, so a feed that cannot answer is skipped rather than failed — a
 * capability mismatch must never count against a feed's health.
 */
export interface Capabilities {
  exchanges:   string[];        // ['NSE', 'MCX']
  intervals:   string[];        // ['1s', '1m']
  /** How far back this feed serves history, in days. */
  historyDays: number;
  optionChain: boolean;
  /** Returns IV directly (vs. us having to solve for it). */
  greeks:      boolean;
  /** Supports `subscribe()` for live ticks. */
  live:        boolean;
  /** Hard upstream cap on symbols per request. Nubra = 8. */
  maxSymbolsPerRequest: number;
}

/** The greeks a caller wants fetched. Omitted entirely = none. */
export type GreekField = 'delta' | 'gamma' | 'vega' | 'theta';

export interface SeriesRequest {
  keys:     InstrumentKey[];
  interval: string;
  /** Epoch ms, inclusive. */
  from:     number;
  to:       number;
  /**
   * Which greeks to request, if any.
   *
   * Opt-in per request, and worth being strict about: at 1s a session is ~23k
   * points PER FIELD PER CONTRACT, so each greek added here costs roughly a
   * fifth of the whole quote payload across 40–100 contracts. Asking for the
   * full set "just in case" was measurably the slowest thing this pipeline did.
   */
  greeks?:  readonly GreekField[];
}

export interface CandleRequest {
  key:      InstrumentKey;
  interval: string;
  from:     number;
  to:       number;
}

/** What a feed actually delivered, when it could not deliver what was asked. */
export interface Degradation {
  /** Set when the feed served a coarser interval than requested. */
  interval?: string;
  reason:    string;
}

export interface SeriesResult {
  /** Keyed by `keyOf(instrumentKey)`. Missing keys returned no data. */
  series:     Map<string, OptionSeries>;
  interval:   string;
  degraded?:  Degradation;
}

export interface CandleResult {
  candles:   Candle[];
  interval:  string;
  degraded?: Degradation;
}

// ── The interface ────────────────────────────────────────────────────────────

export interface MarketDataFeed {
  readonly id: FeedId;
  readonly capabilities: Capabilities;

  // ── lifecycle. AuthManager owns when these are called. ──
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  /** Cheap liveness check for the health prober. Must not mutate state. */
  ping(): Promise<void>;

  // ── reference data ──
  /** Every option-bearing asset on an exchange for a date. */
  assets(exchange: string, date: string): Promise<TradableAsset[]>;
  /** Expiries for one asset, ISO, ascending. */
  expiries(asset: string, exchange: string, date: string): Promise<string[]>;
  /** Every listed contract for one asset+expiry. */
  chain(
    asset: string, exchange: string, date: string, expiry?: string,
  ): Promise<Instrument[]>;

  /**
   * Ordered underlying candidates for an asset, best first.
   *
   * Not simply "the spot": MCX has no cash leg, so the underlying is a specific
   * future — the first one expiring after the option expiry. And being the
   * right contract does not guarantee the feed carries a series for it (thin
   * mini futures go unquoted on some days), so this returns a fallback chain
   * rather than one answer. Anything past index 0 is a substitute and the
   * caller should report it as one.
   */
  underlyings(
    asset: string, exchange: string, date: string, expiry?: string,
  ): Promise<Instrument[]>;

  // ── time series ──
  candles(req: CandleRequest): Promise<CandleResult>;
  optionSeries(req: SeriesRequest): Promise<SeriesResult>;

  // ── live (optional until a feed implements it) ──
  subscribe?(keys: InstrumentKey[], cb: (t: Tick) => void): () => void;
}

// ── Capability matching ──────────────────────────────────────────────────────

/**
 * Can this feed serve this request at all?
 *
 * Used by the router at selection time. Returns a reason on failure so the
 * "no feed can serve this" error can say which constraint every feed failed.
 */
export function supports(
  cap: Capabilities,
  req: { exchange: string; interval?: string; from?: number; kind?: InstrumentKind },
): { ok: true } | { ok: false; reason: string } {
  const ex = req.exchange.toUpperCase();
  if (!cap.exchanges.includes(ex)) {
    return { ok: false, reason: `does not carry ${ex}` };
  }
  if (req.interval && !cap.intervals.includes(req.interval)) {
    return { ok: false, reason: `no ${req.interval} interval` };
  }
  if (req.from != null) {
    const ageDays = (Date.now() - req.from) / 86_400_000;
    if (ageDays > cap.historyDays) {
      return { ok: false, reason: `history limited to ${cap.historyDays}d` };
    }
  }
  if (req.kind === 'OPT' && !cap.optionChain) {
    return { ok: false, reason: 'no option chain' };
  }
  return { ok: true };
}

/**
 * The coarsest interval this feed can serve that is no finer than `wanted`.
 *
 * Returns null when the feed cannot serve the request at any resolution. Used
 * for the degrade-rather-than-refuse path: a 1s request against a 1m-only feed
 * returns '1m' plus a Degradation tag, instead of failing the whole chart.
 */
const INTERVAL_MS: Record<string, number> = {
  '1s': 1_000, '5s': 5_000, '15s': 15_000, '30s': 30_000,
  '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
  '30m': 1_800_000, '1h': 3_600_000, '1d': 86_400_000,
};

export function bestInterval(cap: Capabilities, wanted: string): string | null {
  if (cap.intervals.includes(wanted)) return wanted;
  const target = INTERVAL_MS[wanted];
  if (!target) return null;
  const coarser = cap.intervals
    .filter((i) => INTERVAL_MS[i] > target)
    .sort((a, b) => INTERVAL_MS[a] - INTERVAL_MS[b]);
  return coarser[0] ?? null;
}
