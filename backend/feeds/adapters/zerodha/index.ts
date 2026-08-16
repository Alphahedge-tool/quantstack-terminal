/**
 * Zerodha (Kite Connect) market-data adapter.
 *
 * Strengths and limits, stated up front for the same reason as the Angel
 * adapter — the router picks on capabilities, so an overstated one is a bug that
 * surfaces as bad data rather than an error:
 *
 *   reference data   good, but AUTHENTICATED — the master needs a live access
 *                    token, so it cannot be warmed at boot.
 *   live ticks       excellent — 3000 tokens, full depth, exchange timestamps.
 *   candles          1-minute back 60 days, longer for coarser intervals.
 *   option series    NOT AVAILABLE, same as Angel. Kite publishes no historical
 *                    bid/ask or IV series.
 *   MCX              options are NOT carried. Kite lists MCX futures but its
 *                    option coverage is not something to route a straddle to.
 */

import type {
  MarketDataFeed, Capabilities, TradableAsset, Instrument,
  CandleRequest, CandleResult, SeriesRequest, SeriesResult, Candle, Tick,
  UnderlyingKind,
} from '../../types.js';
import type { InstrumentKey } from '../../identity.js';
import { FeedError, classify } from '../../errors.js';
import { instruments } from '../../../instruments/store.js';
import { symbolOf, segmentOf } from '../../../instruments/symbol.js';
import { ensureMaster } from '../../../instruments/manager.js';
import type { InstrumentRow } from '../../../instruments/types.js';
import {
  login, zerodhaCredentials, kiteCall, type ZerodhaSession,
} from './session.js';
import {
  loadSession, saveSession, clearSession, nextSixAmIST,
} from '../../../lib/sessionCache.js';
import { ZerodhaStream } from './stream.js';

const CAPABILITIES: Capabilities = {
  // MCX is deliberately absent. Kite's MCX option coverage is thin enough that
  // claiming it would have the router send commodity straddles here and get
  // silence back — a capability list is a promise, not an aspiration.
  exchanges:   ['NSE', 'BSE', 'CDS', 'BCD'],
  intervals:   ['1m', '3m', '5m', '15m', '30m', '1h', '1d'],
  historyDays: 60,
  optionChain: true,
  greeks:      false,
  live:        true,
  /** Kite's quote endpoint accepts 500 instruments per call. */
  maxSymbolsPerRequest: 500,
};

const INTERVALS: Record<string, string> = {
  '1m': 'minute', '3m': '3minute', '5m': '5minute',
  '15m': '15minute', '30m': '30minute', '1h': '60minute', '1d': 'day',
};

const INDEX_NAMES = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'NIFTYNXT50',
]);

function kindOf(row: InstrumentRow): UnderlyingKind {
  if (INDEX_NAMES.has(row.name)) return 'INDEX';
  if (row.exchange === 'MCX') return 'COMMODITY';
  return 'STOCK';
}

/** Kite wants `YYYY-MM-DD HH:mm:ss` in IST. Same trap as Angel — see istStamp there. */
function istStamp(ms: number): string {
  const ist = new Date(ms + 5.5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`
    + ` ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}

type RawCandle = [string, number, number, number, number, number];

export class ZerodhaFeed implements MarketDataFeed {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private session: ZerodhaSession | null = null;
  private stream:  ZerodhaStream  | null = null;

  constructor(private readonly instance?: string) {
    this.id = instance ? `zerodha#${instance}` : 'zerodha';
  }

  withInstance(instance: string): ZerodhaFeed {
    return new ZerodhaFeed(instance);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Headless login, then load the master.
   *
   * The order is forced: Kite's instrument file is authenticated, so unlike
   * Angel the master cannot exist before the session does.
   */
  async connect(): Promise<void> {
    if (this.session) return;
    try {
      // 1. Reuse yesterday's token if it is still alive.
      //
      // Deliberately BEFORE credentials are resolved. `zerodhaCredentials()`
      // throws unless the full HEADLESS set is present — user id, password,
      // TOTP secret — and an account signed in through the browser has none of
      // them. Asking for them first meant the cached token could never be
      // reached by the very accounts that depend on it: a restart threw
      // "credentials missing" while a perfectly good session sat on disk.
      //
      // Kite's access token lasts until roughly 6 AM the next morning, so a
      // restart at 11 AM has a perfectly good one on disk. Re-running the
      // headless web login instead spends a TOTP code and several seconds for
      // nothing — and on the first connection of an app it can land on the
      // Authorize screen, turning a silent restart into a login that needs a
      // human. Revalidated rather than trusted: an expiry is the broker's
      // promise, and a token can be revoked early by logging in elsewhere.
      const cached = loadSession<ZerodhaSession>(this.id);
      if (cached?.accessToken) {
        try {
          await kiteCall(cached, '/user/profile');
          this.session = cached;
          console.log(`[${this.id}] reusing cached session for ${cached.userId}`);
        } catch {
          console.log(`[${this.id}] cached session rejected — logging in again`);
          clearSession(this.id);
        }
      }

      // 2. No usable cache — fall back to a headless login, which is where the
      //    full credential set is genuinely needed. Throws NeedsAuthorizeError
      //    when Kite wants the one-time browser Authorize click, which the
      //    route layer turns into a login URL rather than a dead end.
      if (!this.session) {
        const creds = await zerodhaCredentials(this.instance);
        this.session = await login(creds);
        saveSession(this.id, this.session, nextSixAmIST());
      }

      await ensureMaster('zerodha', {
        apiKey:      this.session.apiKey,
        accessToken: this.session.accessToken,
      });
    } catch (err) {
      this.session = null;
      throw classify(err, this.id);
    }
  }

  /**
   * Install a session produced by the MANUAL browser login.
   *
   * The callback route owns the request-token exchange, because the redirect
   * lands on the server rather than in this adapter. Cached on the same terms
   * as a headless login, so the popup is needed once and not again tomorrow.
   */
  async adoptSession(session: ZerodhaSession): Promise<void> {
    this.session = session;
    saveSession(this.id, session, nextSixAmIST());
    await ensureMaster('zerodha', {
      apiKey:      session.apiKey,
      accessToken: session.accessToken,
    });
  }

  async disconnect(): Promise<void> {
    this.stream?.close();
    this.stream  = null;
    this.session = null;
    // Deliberately NOT clearSession(): disconnect is also how a dead session is
    // dropped mid-request, and the cached copy is the same token. It is cleared
    // where it is actually found to be bad — in connect() above.
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  /** `/user/profile` is the cheapest authenticated read Kite offers. */
  async ping(): Promise<void> {
    try {
      await kiteCall(this.requireSession(), '/user/profile');
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /** Shared with the trading adapter — see the note in the Angel adapter. */
  requireSession(): ZerodhaSession {
    if (!this.session) {
      throw new FeedError('AUTH', `${this.id} is not connected`, { feedId: this.id });
    }
    return this.session;
  }

  /** The master is session-bound, so every reference-data call re-checks it. */
  private async master(): Promise<void> {
    const s = this.requireSession();
    await ensureMaster('zerodha', { apiKey: s.apiKey, accessToken: s.accessToken });
  }

  // ── reference data ─────────────────────────────────────────────────────────

  async assets(exchange: string, _date: string): Promise<TradableAsset[]> {
    await this.master();
    const byAsset = new Map<string, { row: InstrumentRow; expiries: Set<string> }>();

    for (const row of instruments.segmentRows('zerodha', segmentOf(exchange, 'OPT'))) {
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
    for (const row of instruments.segmentRows('zerodha', segmentOf(exchange, 'OPT'))) {
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

    for (const row of instruments.segmentRows('zerodha', segmentOf(exchange, 'OPT'))) {
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

    const spot = instruments.resolve('zerodha', want, ex);
    if (spot) {
      return [{
        key: { exchange: ex, asset: want, kind: 'SPOT' },
        label: spot.symbol, kind: kindOf(spot), lot: spot.lotsize,
      }];
    }

    const futures = instruments.segmentRows('zerodha', segmentOf(ex, 'FUT'))
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

  async candles(req: CandleRequest): Promise<CandleResult> {
    const interval = INTERVALS[req.interval];
    if (!interval) {
      throw new FeedError(
        'UNSUPPORTED',
        `Kite has no ${req.interval} candles (supports ${Object.keys(INTERVALS).join(', ')})`,
        { feedId: this.id },
      );
    }

    await this.master();
    const row = instruments.resolve(
      'zerodha', symbolOf(req.key), segmentOf(req.key.exchange, req.key.kind),
    );
    if (!row) {
      throw new FeedError('NOT_FOUND', `Kite does not list ${symbolOf(req.key)}`, { feedId: this.id });
    }

    try {
      const out = await kiteCall<{ candles?: RawCandle[] }>(
        this.requireSession(),
        `/instruments/historical/${row.token}/${interval}`,
        { query: { from: istStamp(req.from), to: istStamp(req.to) } },
      );

      const candles: Candle[] = (out.candles ?? []).map((c) => ({
        ts: Date.parse(c[0]),
        o: Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]),
        vol: Number(c[5]) || undefined,
      })).filter((c) => Number.isFinite(c.ts));

      return { candles, interval: req.interval };
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /** Not served — see the file header, and the equivalent note in the Angel adapter. */
  async optionSeries(_req: SeriesRequest): Promise<SeriesResult> {
    throw new FeedError(
      'UNSUPPORTED',
      'Kite publishes no historical bid/ask or IV series — use a feed that carries them',
      { feedId: this.id },
    );
  }

  // ── live ───────────────────────────────────────────────────────────────────

  subscribe(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    const session = this.requireSession();
    this.stream?.close();
    const stream = new ZerodhaStream(session);
    this.stream = stream;

    const stop = stream.open(keys, cb);
    return () => {
      stop();
      if (this.stream === stream) this.stream = null;
    };
  }
}

export const zerodhaFeed = new ZerodhaFeed();
