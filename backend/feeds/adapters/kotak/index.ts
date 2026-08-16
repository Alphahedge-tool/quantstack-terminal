/**
 * Kotak Neo market-data adapter.
 *
 *   reference data   good, but authenticated and awkward — a list of per-segment
 *                    CSVs behind a shifting endpoint (instruments/loaders/kotak.ts).
 *   live ticks       good — HSM, 200 instruments, bid/ask, self-describing scale.
 *   candles          NOT SERVED. Kotak's historical API is not part of the Neo
 *                    Trade API surface this adapter speaks.
 *   option series    NOT SERVED, same as the other two.
 *
 * So Kotak's role here is a live-tick and instrument source — a third leg for
 * the live router to switch onto — rather than a history provider. Declaring
 * that honestly in `capabilities` is what keeps the router from sending it work
 * it cannot do.
 */

import type {
  MarketDataFeed, Capabilities, TradableAsset, Instrument,
  CandleRequest, CandleResult, SeriesRequest, SeriesResult, Tick,
  UnderlyingKind,
} from '../../types.js';
import type { InstrumentKey } from '../../identity.js';
import { FeedError, classify } from '../../errors.js';
import { instruments } from '../../../instruments/store.js';
import { segmentOf } from '../../../instruments/symbol.js';
import { ensureMaster } from '../../../instruments/manager.js';
import type { InstrumentRow } from '../../../instruments/types.js';
import { login, kotakCredentials, kotakCall, type KotakSession } from './session.js';
import { KotakStream } from './stream.js';

const CAPABILITIES: Capabilities = {
  exchanges:   ['NSE', 'BSE', 'MCX', 'CDS', 'BCD'],
  // Empty, and deliberately so: `supports()` will refuse every candle request,
  // which is exactly right for a feed that serves no history. An adapter that
  // listed intervals it cannot serve would be chosen and then fail.
  intervals:   [],
  historyDays: 0,
  optionChain: true,
  greeks:      false,
  live:        true,
  maxSymbolsPerRequest: 200,
};

const INDEX_NAMES = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX',
]);

function kindOf(row: InstrumentRow): UnderlyingKind {
  if (INDEX_NAMES.has(row.name)) return 'INDEX';
  if (row.exchange === 'MCX') return 'COMMODITY';
  return 'STOCK';
}

export class KotakFeed implements MarketDataFeed {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private session: KotakSession | null = null;
  private stream:  KotakStream  | null = null;

  constructor(private readonly instance?: string) {
    this.id = instance ? `kotak#${instance}` : 'kotak';
  }

  withInstance(instance: string): KotakFeed {
    return new KotakFeed(instance);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.session) return;
    try {
      const creds = await kotakCredentials(this.instance);
      this.session = await login(creds);
      await ensureMaster('kotak', {
        accessToken: this.session.tradeToken,
        baseUrl:     this.session.baseUrl,
      });
    } catch (err) {
      this.session = null;
      throw classify(err, this.id);
    }
  }

  async disconnect(): Promise<void> {
    this.stream?.close();
    this.stream  = null;
    this.session = null;
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  /**
   * Liveness via the positions report.
   *
   * Not ideal — it is a portfolio read rather than a dedicated probe — but Neo
   * exposes no cheap identity endpoint, and this is the lightest authenticated
   * call that fails cleanly on a dead trade token.
   */
  async ping(): Promise<void> {
    try {
      await kotakCall(this.requireSession(), '/Positions/2.0/positions/todays');
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /** Shared with the trading adapter — see the note in the Angel adapter. */
  requireSession(): KotakSession {
    if (!this.session) {
      throw new FeedError('AUTH', `${this.id} is not connected`, { feedId: this.id });
    }
    return this.session;
  }

  private async master(): Promise<void> {
    const s = this.requireSession();
    await ensureMaster('kotak', { accessToken: s.tradeToken, baseUrl: s.baseUrl });
  }

  // ── reference data ─────────────────────────────────────────────────────────

  async assets(exchange: string, _date: string): Promise<TradableAsset[]> {
    await this.master();
    const byAsset = new Map<string, { row: InstrumentRow; expiries: Set<string> }>();

    for (const row of instruments.segmentRows('kotak', segmentOf(exchange, 'OPT'))) {
      if (row.optionType !== 'CE' && row.optionType !== 'PE') continue;
      if (!row.expiry) continue;
      const hit = byAsset.get(row.name);
      if (hit) hit.expiries.add(row.expiry);
      else byAsset.set(row.name, { row, expiries: new Set([row.expiry]) });
    }

    return [...byAsset].map(([asset, { row, expiries }]) => ({
      asset,
      exchange: exchange.toUpperCase(),
      kind:     kindOf(row),
      lot:      row.lotsize,
      expiries: [...expiries].sort(),
    })).sort((a, b) => a.asset.localeCompare(b.asset));
  }

  async expiries(asset: string, exchange: string, _date: string): Promise<string[]> {
    await this.master();
    const want = asset.toUpperCase();
    const out = new Set<string>();
    for (const row of instruments.segmentRows('kotak', segmentOf(exchange, 'OPT'))) {
      if (row.name === want && row.expiry && (row.optionType === 'CE' || row.optionType === 'PE')) {
        out.add(row.expiry);
      }
    }
    return [...out].sort();
  }

  async chain(
    asset: string, exchange: string, _date: string, expiry?: string,
  ): Promise<Instrument[]> {
    await this.master();
    const want = asset.toUpperCase();
    const out: Instrument[] = [];

    for (const row of instruments.segmentRows('kotak', segmentOf(exchange, 'OPT'))) {
      if (row.name !== want) continue;
      if (row.optionType !== 'CE' && row.optionType !== 'PE') continue;
      if (expiry && row.expiry !== expiry) continue;
      if (row.strike == null) continue;

      out.push({
        key: {
          exchange: exchange.toUpperCase(), asset: want, kind: 'OPT',
          expiry: row.expiry, strike: row.strike, side: row.optionType,
        },
        label: row.symbol,
        kind:  kindOf(row),
        lot:   row.lotsize,
      });
    }

    return out.sort((a, b) =>
      (a.key.strike ?? 0) - (b.key.strike ?? 0)
      || (a.key.side ?? '').localeCompare(b.key.side ?? ''));
  }

  async underlyings(
    asset: string, exchange: string, _date: string, expiry?: string,
  ): Promise<Instrument[]> {
    await this.master();
    const want = asset.toUpperCase();
    const ex   = exchange.toUpperCase();

    const spot = instruments.resolve('kotak', want, ex);
    if (spot) {
      return [{
        key: { exchange: ex, asset: want, kind: 'SPOT' },
        label: spot.symbol, kind: kindOf(spot), lot: spot.lotsize,
      }];
    }

    const futures = instruments.segmentRows('kotak', segmentOf(ex, 'FUT'))
      .filter((r) => r.name === want && r.instrumentType === 'FUT' && r.expiry)
      .sort((a, b) => a.expiry.localeCompare(b.expiry));

    const eligible = expiry ? futures.filter((f) => f.expiry >= expiry) : futures;

    return (eligible.length ? eligible : futures).map((row) => ({
      key:   { exchange: ex, asset: want, kind: 'FUT' as const, expiry: row.expiry },
      label: row.symbol,
      kind:  kindOf(row),
      lot:   row.lotsize,
    }));
  }

  // ── time series ────────────────────────────────────────────────────────────

  async candles(_req: CandleRequest): Promise<CandleResult> {
    throw new FeedError(
      'UNSUPPORTED',
      'Kotak Neo serves no historical candles through this API — use another feed',
      { feedId: this.id },
    );
  }

  async optionSeries(_req: SeriesRequest): Promise<SeriesResult> {
    throw new FeedError(
      'UNSUPPORTED',
      'Kotak publishes no historical bid/ask or IV series — use a feed that carries them',
      { feedId: this.id },
    );
  }

  // ── live ───────────────────────────────────────────────────────────────────

  subscribe(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    const session = this.requireSession();
    this.stream?.close();
    const stream = new KotakStream(session);
    this.stream = stream;

    const stop = stream.open(keys, cb);
    return () => {
      stop();
      if (this.stream === stream) this.stream = null;
    };
  }
}

export const kotakFeed = new KotakFeed();
