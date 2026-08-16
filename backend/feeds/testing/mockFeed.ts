/**
 * A MarketDataFeed backed by arithmetic instead of a broker.
 *
 * This exists because it can: once the engine takes a feed rather than a Nubra
 * session, the whole straddle pipeline can be driven from synthetic data with
 * no network, no login and no cached refdata. That is the actual test of
 * whether the de-sessioning worked — if anything broker-shaped were still
 * reachable from the engine, this file could not compile.
 *
 * It also gives phase 4 its fault-injection harness: `fail` makes any call
 * throw a chosen FeedError so the circuit breaker can be exercised
 * deterministically rather than by waiting for a real outage.
 */

import { FeedError, type FeedErrorCode } from '../errors.js';
import { keyOf, optionKey, spotKey, type InstrumentKey } from '../identity.js';
import type {
  Candle, CandleRequest, CandleResult, Capabilities, Instrument, MarketDataFeed,
  OptionSeries, Point, SeriesRequest, SeriesResult, TradableAsset,
} from '../types.js';

export interface MockSpec {
  id?:        string;
  asset?:     string;
  exchange?:  string;
  expiry?:    string;
  /** Strike ladder, rupees. */
  strikes?:   number[];
  /** One entry per bar: the underlying price. */
  spotPath?:  number[];
  /** Bar spacing, ms. */
  barMs?:     number;
  /** First bar timestamp, ms. */
  startMs?:   number;
  capabilities?: Partial<Capabilities>;
}

const DEFAULTS = {
  asset:    'MOCKIDX',
  exchange: 'NSE',
  expiry:   '2026-08-13',
  strikes:  [24000, 24100, 24200, 24300, 24400, 24500, 24600, 24700, 24800, 24900, 25000],
  spotPath: [24500, 24500, 24500, 24600, 24600, 24600],
  barMs:    60_000,
  startMs:  Date.UTC(2026, 7, 12, 3, 45, 0, 0),
};

/**
 * Call premium falls as the strike rises; put premium is flat.
 *
 * Straddle mid is therefore monotonically decreasing in strike, which makes
 * "cheapest within ATM±2" always the top of the window — so when the window
 * slides with the spot, the selected strike must move with it. That is exactly
 * the roll the engine is supposed to detect, made deterministic.
 */
function callPremium(strike: number, base: number): number {
  return 500 - ((strike - base) / 100) * 10;
}
const PUT_PREMIUM = 500;

export class MockFeed implements MarketDataFeed {
  readonly id: string;
  readonly capabilities: Capabilities;

  private readonly spec: Required<Omit<MockSpec, 'id' | 'capabilities'>>;

  /** Set to make every data call throw. Cleared by `heal()`. */
  private failure: { code: FeedErrorCode; message: string } | null = null;

  /** Per-method failures, so one stage can break while the rest still works. */
  private readonly methodFailures = new Map<string, { code: FeedErrorCode; message: string }>();

  /** Per-method call counts, for asserting the router did not double-fetch. */
  readonly calls = { chain: 0, expiries: 0, candles: 0, optionSeries: 0, connect: 0 };

  private connected = false;

  constructor(spec: MockSpec = {}) {
    this.id   = spec.id ?? 'mock';
    this.spec = {
      asset:    spec.asset    ?? DEFAULTS.asset,
      exchange: spec.exchange ?? DEFAULTS.exchange,
      expiry:   spec.expiry   ?? DEFAULTS.expiry,
      strikes:  spec.strikes  ?? DEFAULTS.strikes,
      spotPath: spec.spotPath ?? DEFAULTS.spotPath,
      barMs:    spec.barMs    ?? DEFAULTS.barMs,
      startMs:  spec.startMs  ?? DEFAULTS.startMs,
    };
    this.capabilities = {
      exchanges:   [this.spec.exchange],
      intervals:   ['1s', '1m'],
      historyDays: 3650,
      optionChain: true,
      greeks:      true,
      live:        false,
      maxSymbolsPerRequest: 8,
      ...spec.capabilities,
    };
  }

  // ── fault injection ────────────────────────────────────────────────────────

  fail(code: FeedErrorCode, message = `${code} injected`): this {
    this.failure = { code, message };
    return this;
  }

  /**
   * Break one call while the rest keeps working.
   *
   * Reproduces the shape of a real partial outage — Nubra's refdata answering
   * 200 while charts/timeseries 500s — which a whole-feed failure cannot.
   */
  failOn(method: 'candles' | 'optionSeries' | 'chain' | 'expiries' | 'underlyings',
         code: FeedErrorCode, message = `${code} injected on ${method}`): this {
    this.methodFailures.set(method, { code, message });
    return this;
  }

  heal(): this {
    this.failure = null;
    this.methodFailures.clear();
    return this;
  }

  private guard(method?: string): void {
    const scoped = method ? this.methodFailures.get(method) : undefined;
    if (scoped) {
      throw new FeedError(scoped.code, scoped.message, { feedId: this.id });
    }
    if (this.failure) {
      throw new FeedError(this.failure.code, this.failure.message, { feedId: this.id });
    }
    if (!this.connected) {
      throw new FeedError('AUTH', `${this.id} is not connected`, { feedId: this.id });
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.calls.connect++;
    if (this.failure?.code === 'AUTH') {
      throw new FeedError('AUTH', this.failure.message, { feedId: this.id });
    }
    this.connected = true;
  }

  async disconnect(): Promise<void> { this.connected = false; }
  isConnected(): boolean { return this.connected; }
  async ping(): Promise<void> { this.guard(); }

  // ── reference data ─────────────────────────────────────────────────────────

  async assets(): Promise<TradableAsset[]> {
    this.guard();
    return [{
      asset:    this.spec.asset,
      exchange: this.spec.exchange,
      kind:     'INDEX',
      lot:      50,
      expiries: [this.spec.expiry],
    }];
  }

  async expiries(): Promise<string[]> {
    this.calls.expiries++;
    this.guard('expiries');
    return [this.spec.expiry];
  }

  async chain(): Promise<Instrument[]> {
    this.calls.chain++;
    this.guard('chain');
    const out: Instrument[] = [];
    for (const strike of this.spec.strikes) {
      for (const side of ['CE', 'PE'] as const) {
        const key = optionKey(this.spec.exchange, this.spec.asset, this.spec.expiry, strike, side);
        out.push({ key, label: `${this.spec.asset}${strike}${side}`, kind: 'INDEX', lot: 50 });
      }
    }
    return out;
  }

  async underlyings(): Promise<Instrument[]> {
    this.guard('underlyings');
    return [{
      key:   spotKey(this.spec.exchange, this.spec.asset),
      label: this.spec.asset,
      kind:  'INDEX',
    }];
  }

  // ── series ─────────────────────────────────────────────────────────────────

  private barTs(i: number): number {
    return this.spec.startMs + i * this.spec.barMs;
  }

  async candles(req: CandleRequest): Promise<CandleResult> {
    this.calls.candles++;
    this.guard('candles');
    if (req.key.kind !== 'SPOT') {
      throw new FeedError('NOT_FOUND', `mock has no candles for ${keyOf(req.key)}`, { feedId: this.id });
    }
    const candles: Candle[] = this.spec.spotPath.map((v, i) => {
      const ts = this.barTs(i);
      return { ts, o: v, h: v, l: v, c: v };
    });
    return { candles, interval: req.interval };
  }

  async optionSeries(req: SeriesRequest): Promise<SeriesResult> {
    this.calls.optionSeries++;
    this.guard('optionSeries');

    const base   = this.spec.strikes[0];
    const series = new Map<string, OptionSeries>();

    for (const key of req.keys) {
      if (key.strike == null || !key.side) continue;
      if (!this.spec.strikes.includes(key.strike)) continue;

      const v = key.side === 'CE' ? callPremium(key.strike, base) : PUT_PREMIUM;
      const flat = (n: number): Point[] =>
        this.spec.spotPath.map((_, i) => ({ ts: this.barTs(i), v: n }));

      series.set(keyOf(key), {
        bid:   flat(v),
        ask:   flat(v),
        ltp:   flat(v),
        ivBid: flat(0.12),
        ivAsk: flat(0.14),
        ivMid: flat(0.13),
      });
    }

    return { series, interval: req.interval };
  }

  // ── expectations, so tests assert against the spec, not magic numbers ──────

  /** The straddle mid the engine should compute at `strike`. */
  expectedMid(strike: number): number {
    return callPremium(strike, this.spec.strikes[0]) + PUT_PREMIUM;
  }

  /** Every key the chain exposes, in engine order. */
  keysFor(strike: number): { ce: InstrumentKey; pe: InstrumentKey } {
    return {
      ce: optionKey(this.spec.exchange, this.spec.asset, this.spec.expiry, strike, 'CE'),
      pe: optionKey(this.spec.exchange, this.spec.asset, this.spec.expiry, strike, 'PE'),
    };
  }

  get date(): string {
    return new Date(this.spec.startMs).toISOString().slice(0, 10);
  }

  get asset(): string { return this.spec.asset; }
  get exchange(): string { return this.spec.exchange; }
}
