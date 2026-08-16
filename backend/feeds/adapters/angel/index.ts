/**
 * Angel One (SmartAPI) market-data adapter.
 *
 * What Angel is good for here, and what it is not:
 *
 *   reference data   excellent — one public 30 MB master covering NSE, BSE, MCX,
 *                    CDS and BCD, no session required. It is the backbone of the
 *                    canonical instrument table (instruments/loaders/angel.ts).
 *   live ticks       excellent — SmartStream V2, 1000 tokens, best-five depth.
 *   candles          good, down to 1 minute, 30 days back.
 *   option series    NOT AVAILABLE. Angel publishes no historical intraday
 *                    bid/ask or IV series at all, at any resolution.
 *
 * That last line is the reason `capabilities.intervals` stops at `1m` and
 * `optionSeries()` throws UNSUPPORTED rather than improvising. An adapter that
 * synthesised a bid/ask from candle closes would satisfy the type and quietly
 * feed the straddle engine a spread of zero — every metric downstream would then
 * be wrong in a way that looks plausible. Refusing lets the router fail the
 * request over to a feed that genuinely has the data, which is the behaviour the
 * whole layer exists to provide.
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
import { smartCall, smartHeaders, authHeaders } from './http.js';
import { angelCredentials, login, verify, logout, type AngelSession } from './session.js';
import { AngelStream } from './stream.js';

const FEED = 'angel';

const CAPABILITIES: Capabilities = {
  exchanges:   ['NSE', 'BSE', 'MCX', 'CDS', 'BCD'],
  // No sub-minute history. `1s` is deliberately absent so `supports()` skips
  // Angel for a 1s request instead of degrading it to something misleading.
  intervals:   ['1m', '3m', '5m', '15m', '30m', '1h', '1d'],
  historyDays: 30,
  optionChain: true,
  greeks:      false,
  live:        true,
  /** Angel's bulk quote accepts 50 tokens per call. */
  maxSymbolsPerRequest: 50,
};

/** QuantStack interval → Angel's enum. */
const INTERVALS: Record<string, string> = {
  '1m':  'ONE_MINUTE',
  '3m':  'THREE_MINUTE',
  '5m':  'FIVE_MINUTE',
  '15m': 'FIFTEEN_MINUTE',
  '30m': 'THIRTY_MINUTE',
  '1h':  'ONE_HOUR',
  '1d':  'ONE_DAY',
};

const CANDLE_PATH = '/rest/secure/angelbroking/historical/v1/getCandleData';

/** Indices, so the UI can group them and the engine can pick a spot leg. */
const INDEX_NAMES = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'NIFTYNXT50',
]);

function kindOf(row: InstrumentRow): UnderlyingKind {
  if (INDEX_NAMES.has(row.name)) return 'INDEX';
  if (row.exchange === 'MCX') return 'COMMODITY';
  if (row.exchange === 'NFO' || row.exchange === 'BFO' || row.exchange === 'NSE' || row.exchange === 'BSE') {
    return 'STOCK';
  }
  return 'UNKNOWN';
}

/**
 * Angel wants `YYYY-MM-DD HH:mm` in IST, with no timezone marker.
 *
 * Sending UTC produces a valid-looking response shifted by 5½ hours — candles
 * arrive, they are simply the wrong ones, which is far harder to notice than an
 * error would be.
 */
function istStamp(ms: number): string {
  const ist = new Date(ms + 5.5 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}`
    + ` ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}`;
}

/** Angel's candle row: `[timestamp, o, h, l, c, volume]`. */
type RawCandle = [string, number, number, number, number, number];

export class AngelFeed implements MarketDataFeed {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private session: AngelSession | null = null;
  private stream:  AngelStream  | null = null;

  constructor(private readonly instance?: string) {
    this.id = instance ? `angel#${instance}` : FEED;
  }

  withInstance(instance: string): AngelFeed {
    return new AngelFeed(instance);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Log in, and make sure the canonical master is loaded.
   *
   * The master load is part of connecting rather than lazy, because every other
   * method resolves through it — a connected feed with no instrument table can
   * answer nothing, and discovering that one request at a time produces a
   * scattering of "not found" errors instead of one clear failure here.
   */
  async connect(): Promise<void> {
    if (this.session) return;
    try {
      const creds = await angelCredentials(this.instance);
      this.session = await login(creds);
      await ensureMaster('angel');
    } catch (err) {
      this.session = null;
      throw classify(err, this.id);
    }
  }

  async disconnect(): Promise<void> {
    this.stream?.close();
    this.stream = null;
    const s = this.session;
    this.session = null;
    if (s) await logout(s);
  }

  isConnected(): boolean {
    return this.session !== null;
  }

  async ping(): Promise<void> {
    try {
      await verify(this.requireSession());
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Forget the session (and its socket) so the next connect() logs in again.
   *
   * Not the same as `disconnect()`: there is no logout call, because the only
   * thing that gets us here is a token the broker has already rejected.
   */
  private dropSession(): void {
    this.stream?.close();
    this.stream  = null;
    this.session = null;
  }

  /**
   * Re-throw as a FeedError, dropping the session when the TOKEN is the problem.
   *
   * This is the fix for a feed that reports itself signed in while nothing it
   * does succeeds. Angel answers an expired JWT with HTTP 200 and
   * `status: false`, which http.ts maps to AUTH — but `isConnected()` only asks
   * whether `session` is non-null, and `connect()` returns early when it is. So
   * without clearing it here the sequence is: token expires → every call throws
   * AUTH → `ensureConnected()` sees `isConnected() === true` and no-ops → the
   * session is never replaced. The account shows as connected forever and every
   * request behind it fails.
   */
  private fail(err: unknown): never {
    const fe = classify(err, this.id);
    if (fe.code === 'AUTH') this.dropSession();
    throw fe;
  }

  /**
   * Force a fresh login and hand back the new session.
   *
   * For the live socket, which cannot recover on its own: its credentials are
   * baked into the handshake headers, so once they expire every reconnect is
   * refused identically until someone logs in again.
   */
  private async reauthenticate(): Promise<AngelSession> {
    // Deliberately NOT dropSession() — that closes the very stream asking for
    // this, and it is about to reuse the session we are returning.
    this.session = null;
    await this.connect();
    return this.requireSession();
  }

  /**
   * The live session, or an AUTH error the router can act on.
   *
   * Public because the trading adapter shares this session rather than opening a
   * second one. Two logins for one account would double the TOTP traffic and,
   * on Angel, can invalidate the first session — so there is exactly one, and
   * the feed adapter owns it.
   */
  requireSession(): AngelSession {
    if (!this.session) {
      throw new FeedError('AUTH', `${this.id} is not connected`, { feedId: this.id });
    }
    return this.session;
  }

  private headers(): Record<string, string> {
    const s = this.requireSession();
    return authHeaders(smartHeaders(s.apiKey), s.jwtToken);
  }

  // ── reference data ─────────────────────────────────────────────────────────

  /**
   * Every option-bearing asset on an exchange.
   *
   * Served entirely from the local canonical table — no network call. `date` is
   * accepted for interface compatibility but ignored: Angel publishes only the
   * CURRENT master, so it cannot answer "what was listed last Tuesday". A
   * historical date silently returning today's list is the honest behaviour
   * here, because expired contracts simply are not in the file.
   */
  async assets(exchange: string, _date: string): Promise<TradableAsset[]> {
    await ensureMaster('angel');
    const segment = segmentOf(exchange, 'OPT');

    const byAsset = new Map<string, { row: InstrumentRow; expiries: Set<string> }>();
    for (const row of this.rowsFor(segment)) {
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
    await ensureMaster('angel');
    const want = asset.toUpperCase();
    const out = new Set<string>();
    for (const row of this.rowsFor(segmentOf(exchange, 'OPT'))) {
      if (row.name === want && row.expiry && (row.optionType === 'CE' || row.optionType === 'PE')) {
        out.add(row.expiry);
      }
    }
    return [...out].sort();
  }

  async chain(
    asset: string, exchange: string, _date: string, expiry?: string,
  ): Promise<Instrument[]> {
    await ensureMaster('angel');
    const want = asset.toUpperCase();
    const out: Instrument[] = [];

    for (const row of this.rowsFor(segmentOf(exchange, 'OPT'))) {
      if (row.name !== want) continue;
      if (row.optionType !== 'CE' && row.optionType !== 'PE') continue;
      if (expiry && row.expiry !== expiry) continue;
      if (row.strike == null) continue;

      out.push({
        key: {
          exchange: exchange.toUpperCase(),
          asset:    want,
          kind:     'OPT',
          expiry:   row.expiry,
          strike:   row.strike,
          side:     row.optionType,
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

  /**
   * Underlying candidates, best first.
   *
   * On NSE and BSE that is the cash index or stock. MCX has no cash leg at all,
   * so the underlying is the first FUTURE expiring on or after the option's
   * expiry — and because a thin contract can go unquoted on any given day, the
   * later futures follow as fallbacks rather than being discarded.
   */
  async underlyings(
    asset: string, exchange: string, _date: string, expiry?: string,
  ): Promise<Instrument[]> {
    await ensureMaster('angel');
    const want = asset.toUpperCase();
    const ex   = exchange.toUpperCase();

    const spot = instruments.resolve('angel', want, ex);
    if (spot) {
      return [{
        key:   { exchange: ex, asset: want, kind: 'SPOT' },
        label: spot.symbol,
        kind:  kindOf(spot),
        lot:   spot.lotsize,
      }];
    }

    const futures = this.rowsFor(segmentOf(ex, 'FUT'))
      .filter((r) => r.name === want && r.instrumentType === 'FUT' && r.expiry)
      .sort((a, b) => a.expiry.localeCompare(b.expiry));

    // A future expiring BEFORE the option cannot be its underlying — it settles
    // first and stops printing while the option is still live.
    const eligible = expiry ? futures.filter((f) => f.expiry >= expiry) : futures;

    return (eligible.length ? eligible : futures).map((row) => ({
      key:   { exchange: ex, asset: want, kind: 'FUT' as const, expiry: row.expiry },
      label: row.symbol,
      kind:  kindOf(row),
      lot:   row.lotsize,
    }));
  }

  /** Every Angel row on one segment. Indexed by the store, so this is a lookup. */
  private rowsFor(segment: string): readonly InstrumentRow[] {
    return instruments.segmentRows('angel', segment);
  }

  // ── time series ────────────────────────────────────────────────────────────

  async candles(req: CandleRequest): Promise<CandleResult> {
    const interval = INTERVALS[req.interval];
    if (!interval) {
      throw new FeedError(
        'UNSUPPORTED',
        `Angel has no ${req.interval} candles (supports ${Object.keys(INTERVALS).join(', ')})`,
        { feedId: this.id },
      );
    }

    await ensureMaster('angel');

    /**
     * Index spot has no history here.
     *
     * Angel's getCandleData answers an index token with an empty array — not an
     * error, just nothing — at every interval and every date range. Verified
     * against a live account: RELIANCE returns 361 bars for a session and
     * NIFTY18AUG2624600CE returns 375, while NIFTY index returns 0 for the same
     * window.
     *
     * Returning that empty array would be the damaging outcome. The router would
     * count it as a successful answer, stop looking, and hand the caller a chart
     * with no data — when Nubra carries index history back ten years. UNSUPPORTED
     * says "ask someone else" and does not count against Angel's health, which is
     * exactly right: this is a capability gap, not a fault.
     */
    if (req.key.kind === 'SPOT' && INDEX_NAMES.has(req.key.asset.toUpperCase())) {
      throw new FeedError(
        'UNSUPPORTED',
        `Angel serves no historical candles for the ${req.key.asset} index — use a feed that does`,
        { feedId: this.id },
      );
    }

    const row = instruments.resolve(
      'angel', symbolOf(req.key), segmentOf(req.key.exchange, req.key.kind),
    );
    if (!row) {
      throw new FeedError('NOT_FOUND', `Angel does not list ${symbolOf(req.key)}`, { feedId: this.id });
    }

    try {
      const raw = await smartCall<RawCandle[]>('POST', CANDLE_PATH, this.headers(), {
        exchange:    row.brexchange || row.exchange,
        symboltoken: row.token,
        interval,
        fromdate:    istStamp(req.from),
        todate:      istStamp(req.to),
      });

      const candles: Candle[] = (Array.isArray(raw) ? raw : []).map((c) => ({
        ts:  Date.parse(c[0]),
        o:   Number(c[1]), h: Number(c[2]), l: Number(c[3]), c: Number(c[4]),
        vol: Number(c[5]) || undefined,
      })).filter((c) => Number.isFinite(c.ts));

      return { candles, interval: req.interval };
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Not served. See the file header.
   *
   * Thrown as UNSUPPORTED specifically so the router treats it as a capability
   * gap and moves on, without the breaker counting it against Angel's health.
   */
  async optionSeries(_req: SeriesRequest): Promise<SeriesResult> {
    throw new FeedError(
      'UNSUPPORTED',
      'Angel publishes no historical bid/ask or IV series — use a feed that carries them',
      { feedId: this.id },
    );
  }

  // ── live ───────────────────────────────────────────────────────────────────

  /**
   * SmartStream V2 ticks.
   *
   * One socket per adapter instance: Angel counts sockets per client code, and
   * opening a second for a second chart is how an account gets throttled. The
   * LiveRouter above already funnels every consumer through one subscription,
   * so this replaces rather than adds.
   */
  subscribe(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    const session = this.requireSession();
    this.stream?.close();
    const stream = new AngelStream(session, () => this.reauthenticate());
    this.stream = stream;

    const stop = stream.open(keys, cb);
    return () => {
      stop();
      if (this.stream === stream) this.stream = null;
    };
  }
}

export const angelFeed = new AngelFeed();
