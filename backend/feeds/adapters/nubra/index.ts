/**
 * Nubra adapter — implements MarketDataFeed over the existing Nubra client.
 *
 * PHASE 1: this is a wrapper, not a rewrite. Every call delegates to the code
 * already in `lib/nubraData.ts`, `lib/instrumentCache.ts` and
 * `brokers/nubra.ts`, which is battle-tested and stays put. What changes is
 * only the shape of the boundary:
 *
 *   - the session becomes private state here instead of a parameter threaded
 *     through five call levels
 *   - symbol resolution (aliases, paise strikes, YYYYMMDD expiries) stops at
 *     this file — callers speak InstrumentKey
 *   - upstream failures come out as FeedError, so the router can classify them
 *
 * Nubra quirks preserved deliberately:
 *   - 8 symbols per timeseries request (hard upstream cap)
 *   - a 400 on '1s' means "interval unsupported", not a bad request — it falls
 *     back to '1m' and reports a Degradation rather than throwing
 */

import { login, type NubraSession, type NubraCredentials } from '../../../brokers/nubra.js';
import {
  fetchRollingSeries,
  fetchTimeseriesWithIntervals,
  extractSymbolData,
  pointMs,
  pointNumber,
  toRupees,
  ROLLING_BATCH_SIZE,
  type NubraOptionSeries,
} from '../../../lib/nubraData.js';
import {
  startBridge, type BridgeEvent, type BridgeHandle,
} from './liveBridge.js';
import {
  getCachedRefdata,
  getCachedExpiries,
  searchEligible,
  ensureWarm,
  warmInstrumentCache,
  resolveSpotCandidates,
  type InstrumentRow,
} from '../../../lib/instrumentCache.js';
import { getSession, setSession, clearSession } from '../../../lib/sessionStore.js';
import { credentialsFor } from '../../../lib/credentialStore.js';

import { FeedError, classify } from '../../errors.js';
import {
  keyOf, parseKey, normalizeExpiry, type InstrumentKey,
} from '../../identity.js';
import type {
  Capabilities, CandleRequest, CandleResult, Instrument, MarketDataFeed,
  OptionSeries, SeriesRequest, SeriesResult, Tick, TradableAsset, UnderlyingKind,
} from '../../types.js';

// ── Capabilities ─────────────────────────────────────────────────────────────

// Sourced from what the existing code actually exercises, not from Nubra's
// docs: ROLLING_INTERVALS is ['1s','1m'] and the batch cap is the documented
// hard limit in nubraData.ts.
//
// Two of these were wrong on the first pass, both by declaring LESS than Nubra
// serves — and the router skips a feed that says it cannot help, so under-
// declaring turns working requests into "no feed could serve this":
//
//   exchanges   — must not be QT_INSTRUMENT_EXCHANGES. That var is the list to
//                 pre-DOWNLOAD on login (NSE,MCX); what Nubra can SERVE is
//                 wider, and there is BSE refdata in the cache to prove it.
//                 Warming and capability are different questions.
//   historyDays — a guessed 180 would have refused the 2026-01-15 refdata
//                 already on disk, 206 days back. Nubra's real limit is
//                 unknown and varies by exchange (MCX carries nothing before
//                 2026-03-05), so this gate is deliberately wide: the empty-
//                 refdata path already reports absence precisely, and a
//                 guessed number can only invent refusals.
const NUBRA_CAPABILITIES: Capabilities = {
  exchanges: (process.env.QT_NUBRA_EXCHANGES || 'NSE,BSE,MCX')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  intervals:   ['1s', '1m'],
  historyDays: Number(process.env.NUBRA_HISTORY_DAYS || 3650),
  optionChain: true,
  greeks:      true,     // iv_bid / iv_ask / iv_mid come back on the series
  /**
   * Live ticks — `subscribe()` below, greeks by refId plus index for the
   * underlyings, over the Python SDK bridge.
   *
   * OPT-IN, and deliberately so. Nubra's socket is a child process that needs
   * python with `nubra_python_sdk` installed (QT_PYTHON to point at a venv). If
   * that is missing the bridge dies AFTER `subscribe()` has returned, and the
   * router has no error channel at that point: it parks a feed whose subscribe
   * THROWS, but a feed that returns cleanly and then goes quiet stays selected
   * and simply never ticks. Declaring `live` unconditionally would therefore let
   * a host without python silently starve the position book of prices.
   *
   * So the operator turns it on once the bridge is known to run:
   *   QT_NUBRA_LIVE=1
   */
  live:        /^(1|true|yes)$/i.test(process.env.QT_NUBRA_LIVE || ''),
  maxSymbolsPerRequest: ROLLING_BATCH_SIZE,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Trading date (IST) for an epoch-ms instant. Refdata is keyed by IST day. */
function istDate(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
}

function kindOf(row: InstrumentRow): UnderlyingKind {
  switch (row.assetType) {
    case 'INDEX_FO':                    return 'INDEX';
    case 'STOCK_FO': case 'STOCKS':     return 'STOCK';
    case 'COM_FO':   case 'COM_INDEX_FO': return 'COMMODITY';
    default: return row.exchange === 'MCX' ? 'COMMODITY' : 'UNKNOWN';
  }
}

/** Nubra's row → canonical key. Returns null for rows we cannot address. */
function keyForRow(row: InstrumentRow): InstrumentKey | null {
  const expiry = normalizeExpiry(row.expiry);
  if (row.type === 'OPT') {
    if (!expiry || row.strike == null || !row.optionType) return null;
    return {
      exchange: row.exchange, asset: row.asset, kind: 'OPT',
      expiry, strike: row.strike, side: row.optionType,
    };
  }
  if (row.type === 'FUT') {
    return { exchange: row.exchange, asset: row.asset, kind: 'FUT', expiry };
  }
  return { exchange: row.exchange, asset: row.asset, kind: 'SPOT' };
}

type Dict = Record<string, unknown>;

/**
 * Realtime payloads arrive as an object, an array, or an envelope with the rows
 * under `data` / `values` / `items`, varying by stream and SDK version. Same
 * shape-tolerance as engine/liveStraddle.ts — keep the two in step.
 */
function eachRow(payload: unknown, visit: (row: Dict) => void): void {
  if (!payload) return;
  if (Array.isArray(payload)) {
    for (const item of payload) eachRow(item, visit);
    return;
  }
  if (typeof payload !== 'object') return;
  const d = payload as Dict;
  for (const nested of [d.data, d.values, d.items]) {
    if (Array.isArray(nested)) eachRow(nested, visit);
  }
  visit(d);
}

/** Paise → rupees, rejecting the zeros a stream sends for "no print yet". */
function rupeesOf(value: unknown): number | null {
  if (value == null) return null;
  const n = toRupees(value);
  return n != null && Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Streamed IV → the decimal that `Tick.iv` is defined as (0.1048 = 10.48%).
 *
 * Nubra sends either 0.184 or 18.4 for the same number depending on stream and
 * SDK version, and the docs type the field as a bare float without saying
 * which. The threshold is the one engine/liveStraddle.ts already settled on,
 * applied in the opposite direction: anything above 1 is read as a percent.
 *
 * That misreads a genuine 150%-vol decimal (1.5) as 1.5% — accepted knowingly,
 * because a 15% vol arriving as 15.0 is the overwhelmingly more common case and
 * both readings cannot be satisfied at once. A contract printing above 100% vol
 * on this screen is worth distrusting anyway.
 */
function ivDecimal(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const decimal = n > 1 ? n / 100 : n;
  return decimal > 0 && decimal <= 3 ? decimal : null;
}

function toOptionSeries(s: NubraOptionSeries): OptionSeries {
  // Already normalised to ms + rupees by parseRollingSeriesValues. The shapes
  // are identical; the cast is a rename, not a conversion.
  return s;
}

// ── Adapter ──────────────────────────────────────────────────────────────────

export class NubraFeed implements MarketDataFeed {
  readonly id: string;
  readonly capabilities = NUBRA_CAPABILITIES;

  /**
   * Session storage.
   *
   * The DEFAULT instance (no suffix) reads and writes the process-wide
   * sessionStore, because routes, the straddle engine and the backtester all
   * still call requireSession() directly — until phase 2 removes those, there
   * has to be exactly one place the session lives or they would disagree.
   *
   * A suffixed instance (`nubra#2`) keeps its own session here instead. That is
   * what makes two accounts on one broker possible without them clobbering
   * each other. Phase 4's AuthManager takes over both cases.
   */
  private ownSession: NubraSession | null = null;

  constructor(private readonly instance?: string) {
    this.id = instance ? `nubra#${instance}` : 'nubra';
  }

  /**
   * A second account on the same broker.
   *
   * The suffix names a Supabase `broker_accounts` row by client code or alias
   * (`nubra#I01LI8`), and falls back to `NUBRA_<INSTANCE>_*` env vars. Credential
   * resolution itself lives in lib/credentialStore.ts — see `connect()`.
   */
  withInstance(instance: string): NubraFeed {
    return new NubraFeed(instance);
  }

  private readSession(): NubraSession | null {
    return this.instance ? this.ownSession : getSession();
  }

  private writeSession(s: NubraSession | null): void {
    if (this.instance) { this.ownSession = s; return; }
    if (s) setSession(s); else clearSession();
  }

  /**
   * Symbol resolution table, per `EXCHANGE|DATE`.
   *
   * Built lazily from the instrument cache — which is itself memory- then
   * disk-backed, so this costs one pass over rows already in RAM.
   */
  private readonly symbolIndex = new Map<string, {
    toNative:  Map<string, string>;     // keyOf(key) → nubra canonical name
    aliases:   Map<string, string[]>;   // nubra canonical name → alternates
    toKey:     Map<string, string>;     // any nubra name (upper) → keyOf(key)
    spotType:  Map<string, string>;     // asset → nubra `type` for its cash leg
  }>();

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Headless TOTP login. Idempotent — returns immediately if a live session
   * already exists. AuthManager (phase 4) owns single-flighting this; until
   * then the existing in-process session store is the single instance.
   *
   * Credentials come from Supabase when it is configured, falling back to
   * NUBRA_* env vars (see lib/credentialStore.ts). An instance suffix selects a
   * specific account by client code or alias — `nubra#I01LI8`.
   */
  async connect(): Promise<void> {
    if (this.readSession()) return;

    const resolved = await credentialsFor('nubra', {
      select:    this.instance,
      envPrefix: this.instance ? `NUBRA_${this.instance.toUpperCase()}_` : 'NUBRA_',
    });

    if (!resolved) {
      const p = this.instance ? `NUBRA_${this.instance.toUpperCase()}_` : 'NUBRA_';
      throw new FeedError(
        'AUTH',
        `${this.id} credentials missing — add an enabled, auto_login row to Supabase`
        + ` broker_accounts, or set ${p}PHONE, ${p}MPIN and ${p}TOTP_SECRET`,
        { feedId: this.id },
      );
    }

    const cr: NubraCredentials = {
      phone:      resolved.phone,
      mpin:       resolved.mpin,
      totpSecret: resolved.totpSecret,
      env:        resolved.env,
      deviceId:   this.instance ? `quantstack-${this.instance}` : undefined,
    };

    console.log(
      `[${this.id}] Logging in as ${resolved.label}`
      + ` (${resolved.env ?? 'default'}, credentials from ${resolved.source})`,
    );

    try {
      this.writeSession(await login(cr));
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  async disconnect(): Promise<void> {
    this.writeSession(null);
    this.symbolIndex.clear();
  }

  isConnected(): boolean {
    return this.readSession() !== null;
  }

  /**
   * Liveness probe for the health prober.
   *
   * Warming the instrument cache is the cheapest call that actually exercises
   * an authenticated round-trip; once warm it is a no-op read, so probing every
   * 30s costs nothing after the first hit.
   */
  async ping(): Promise<void> {
    const session = this.session();
    try {
      await ensureWarm(session);
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /** The live session, or an AUTH error the router knows how to act on. */
  private session(): NubraSession {
    const s = this.readSession();
    if (!s) throw new FeedError('AUTH', `${this.id} is not connected`, { feedId: this.id });
    return s;
  }

  // ── reference data ─────────────────────────────────────────────────────────

  async assets(exchange: string, _date: string): Promise<TradableAsset[]> {
    const session = this.session();
    try {
      await ensureWarm(session);
      return searchEligible('', exchange, 10_000).map((e) => ({
        asset:    e.asset,
        exchange: e.exchange,
        kind:     e.kind as UnderlyingKind,
        lot:      e.lot,
        expiries: e.expiries.map((x) => normalizeExpiry(x)!).filter(Boolean),
      }));
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  async expiries(asset: string, exchange: string, date: string): Promise<string[]> {
    try {
      const raw = await getCachedExpiries(asset, exchange, date, this.session());
      return raw.map((x) => normalizeExpiry(x)!).filter(Boolean).sort();
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  async chain(
    asset: string, exchange: string, date: string, expiry?: string,
  ): Promise<Instrument[]> {
    const index = await this.index(exchange, date);
    const rows  = await this.rows(exchange, date);
    const want  = normalizeExpiry(expiry);
    const sym   = asset.trim().toUpperCase();

    const out: Instrument[] = [];
    for (const row of rows) {
      if (row.asset !== sym || row.type !== 'OPT') continue;
      const key = keyForRow(row);
      if (!key) continue;
      if (want && key.expiry !== want) continue;
      out.push({ key, label: row.name, kind: kindOf(row), lot: row.lot });
    }
    void index;   // built above so the caller's next optionSeries() is a hit
    return out;
  }

  /**
   * Ordered underlying candidates.
   *
   * Wraps resolveSpotCandidates, whose ordering rules (correct future first,
   * then that asset's other futures, then the sibling mini/full contract, then
   * the bare asset) were derived from real MCX data and are preserved exactly.
   * The translation back to keys goes through the symbol index, so a candidate
   * that cannot be addressed canonically is dropped rather than guessed at.
   */
  async underlyings(
    asset: string, exchange: string, date: string, expiry?: string,
  ): Promise<Instrument[]> {
    const refs  = await this.spotCandidates(asset, exchange, date, expiry);
    const index = await this.index(exchange, date);

    const out: Instrument[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const ks = index.toKey.get(ref.symbol.toUpperCase());
      const key = ks
        ? parseKey(ks)
        // INDEX and STOCK underlyings have no contract row of their own — they
        // are addressed by asset name, which is exactly what a SPOT key is.
        : { exchange: exchange.toUpperCase(), asset: ref.symbol.toUpperCase(), kind: 'SPOT' as const };

      const id = keyOf(key);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        key,
        label: ref.symbol,
        kind:  (ref.kind as UnderlyingKind) ?? 'UNKNOWN',
      });
    }
    return out;
  }

  // ── time series ────────────────────────────────────────────────────────────

  /**
   * Candles for a single instrument.
   *
   * Only `close` is requested — everything downstream (spot series for the
   * straddle engine, backtest bars) uses closes, and asking for OHLC would
   * multiply the payload for fields nothing reads.
   */
  async candles(req: CandleRequest): Promise<CandleResult> {
    const session = this.session();
    const date    = istDate(req.from);
    const index   = await this.index(req.key.exchange, date);
    const native  = await this.nativeSymbol(req.key, date);
    if (!native) {
      throw new FeedError(
        'NOT_FOUND',
        `Nubra has no instrument for ${keyOf(req.key)} on ${date}`,
        { feedId: this.id },
      );
    }

    // '1s' first, '1m' as the documented fallback: Nubra answers 400 for an
    // unsupported interval, which is a capability limit, not a malformed
    // request. fetchTimeseriesWithIntervals already encodes that walk.
    const ladder = req.interval === '1s' ? ['1s', '1m'] : [req.interval];

    try {
      const { data, interval } = await fetchTimeseriesWithIntervals(
        {
          exchange: req.key.exchange,
          type:     req.key.kind === 'OPT' ? 'OPT'
                  : req.key.kind === 'FUT' ? 'FUT'
                  : index.spotType.get(req.key.asset.toUpperCase()) ?? 'INDEX',
          values:   [native],
          fields:   ['close'],
          startDate: new Date(req.from).toISOString(),
          endDate:   new Date(req.to).toISOString(),
          intraDay:  false,
          realTime:  false,
        },
        ladder,
        session,
      );

      const symData = extractSymbolData(data, native);
      const raw     = (symData?.close ?? []) as unknown[];
      const candles = raw
        .map((p) => {
          const ts = pointMs(p);
          const c  = pointNumber(p, true);
          return ts != null && Number.isFinite(c) ? { ts, o: c, h: c, l: c, c } : null;
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => a.ts - b.ts);

      return {
        candles,
        interval,
        degraded: interval === req.interval ? undefined : {
          interval,
          reason: `Nubra served ${interval}; ${req.interval} unavailable for this instrument`,
        },
      };
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /**
   * Bid/ask/IV series for many option contracts.
   *
   * The 8-per-request cap, the bounded worker pool and the alias retry pass all
   * live in fetchRollingSeries and stay there — this method's job is only to
   * translate keys in and keys out.
   */
  async optionSeries(req: SeriesRequest): Promise<SeriesResult> {
    const session = this.session();
    if (!req.keys.length) {
      return { series: new Map(), interval: req.interval };
    }

    const date  = istDate(req.from);
    const index = await this.index(req.keys[0].exchange, date);

    // Request one name per contract; alternates are only paid for if the
    // canonical name comes back empty (fetchRollingSeries' second pass).
    const names: string[]  = [];
    const fallback = new Map<string, string[]>();
    const nativeToKey = new Map<string, string>();

    for (const key of req.keys) {
      const ks     = keyOf(key);
      const native = index.toNative.get(ks);
      if (!native) continue;
      names.push(native);
      nativeToKey.set(native.toUpperCase(), ks);
      const alts = index.aliases.get(native);
      if (alts?.length) {
        fallback.set(native, alts);
        for (const a of alts) nativeToKey.set(a.toUpperCase(), ks);
      }
    }

    if (!names.length) {
      throw new FeedError(
        'NOT_FOUND',
        `Nubra carries none of the ${req.keys.length} requested contracts on ${date}`,
        { feedId: this.id },
      );
    }

    try {
      const raw = await fetchRollingSeries({
        names,
        start:    new Date(req.from).toISOString(),
        end:      new Date(req.to).toISOString(),
        interval: req.interval,
        exchange: req.keys[0].exchange,
        aliasToCanonical: new Map(
          [...index.toKey.keys()].map((n) => [n, n]),
        ),
        fallbackAliases: fallback,
        session,
        greeks: req.greeks,
        extras: req.extras,
      });

      const series = new Map<string, OptionSeries>();
      for (const [name, s] of raw) {
        const ks = nativeToKey.get(name.toUpperCase());
        // fetchRollingSeries indexes under both the canonical name and every
        // alias that returned data, so the same series arrives more than once.
        // First writer wins — they are the same object.
        if (ks && !series.has(ks)) series.set(ks, toOptionSeries(s));
      }
      return { series, interval: req.interval };
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  // ── Nubra-specific extras (used during migration, not part of the contract) ─

  /**
   * Ordered spot/underlying candidates for an asset.
   *
   * MCX has no cash leg — the underlying is a specific future, and thin mini
   * contracts go unquoted on some days, so the engine needs a fallback chain
   * rather than one name. Stays Nubra-shaped until phase 3 gives the contract a
   * proper `underlyingFor(key)`.
   */
  async spotCandidates(
    asset: string, exchange: string, date: string, expiry?: string,
  ) {
    try {
      return await resolveSpotCandidates(asset, exchange, date, expiry, this.session());
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  /** Kick off the background instrument-master download. Fire and forget. */
  warm(): Promise<void> {
    const s = this.readSession();
    return s ? warmInstrumentCache(s) : Promise.resolve();
  }

  // ── symbol index ───────────────────────────────────────────────────────────

  /**
   * InstrumentKey → the name Nubra's timeseries API expects.
   *
   * SPOT falls through to the bare asset name when refdata has no row for it:
   * an index has no listed contract of its own, and NIFTY/BANKNIFTY are
   * addressed by name — the same rule resolveSpotRef applies for INDEX.
   */
  private async nativeSymbol(key: InstrumentKey, date: string): Promise<string | null> {
    const index = await this.index(key.exchange, date);
    const hit   = index.toNative.get(keyOf(key));
    if (hit) return hit;
    return key.kind === 'SPOT' ? key.asset.toUpperCase() : null;
  }

  // ── live ───────────────────────────────────────────────────────────────────

  /**
   * Live ticks for an arbitrary set of contracts.
   *
   * Options go on the `greeks` stream by refId, NOT on the `option` chain
   * stream, for three reasons in ascending order of importance:
   *
   *   · Weight. Greeks costs 1 session-weight per contract against a chain's
   *     20 per key, out of 50,000 per session. Only what is on screen is paid
   *     for.
   *   · Payload. A chain frame carries every listed strike whether or not the
   *     caller asked for it.
   *   · Expressiveness — the decisive one. A chain subscribes ASSET:EXPIRY, and
   *     this method's contract is "these keys", which routinely spans two
   *     underlyings and two expiries at once. No set of chain keys says that.
   *
   * Greeks carries iv, delta, gamma, theta, vega AND last_traded_price per
   * contract, so one subscription per contract covers price and vol together.
   * Underlyings ride the `index` stream (also weight 1) so spot ticks with the
   * premium rather than lagging it.
   *
   * Synchronous by contract, like every other adapter's `subscribe`, but the
   * refId resolution behind it is not — so the bridge starts on a later turn
   * and ticks begin arriving once it does. Stopping before then is safe.
   */
  subscribe(keys: InstrumentKey[], cb: (t: Tick) => void): () => void {
    // Fail loudly and NOW if there is no session. The caller (live/wsQuotes.ts)
    // catches this and tells the browser the contracts are not being carried,
    // which is a far better outcome than a silent process that never ticks.
    const session = this.session();
    if (!keys.length) return () => {};

    let bridge: BridgeHandle | null = null;
    let stopped = false;

    /** refId → the key that asked for it. */
    const keyByRef = new Map<string, InstrumentKey>();
    /** Streamed index name → key, for the underlyings. */
    const keyByIndex = new Map<string, InstrumentKey>();

    const emitTick = (key: InstrumentKey, raw: Dict, receivedAtMs?: number): void => {
      const ltp = rupeesOf(raw.last_traded_price ?? raw.ltp ?? raw.index_value);
      const iv = ivDecimal(raw.iv);
      if (ltp == null && iv == null) return;
      cb({ key, ts: receivedAtMs || Date.now(), ...(ltp != null ? { ltp } : {}), ...(iv != null ? { iv } : {}) });
    };

    const onEvent = (e: BridgeEvent): void => {
      if (stopped) return;
      if (e.event === 'greeks') {
        eachRow(e.data, (row) => {
          const ref = String(row.ref_id ?? row.refId ?? '');
          const key = ref ? keyByRef.get(ref) : undefined;
          if (key) emitTick(key, row, e.received_at_ms);
        });
        return;
      }
      if (e.event === 'index') {
        eachRow(e.data, (row) => {
          const name = String(row.indexname ?? row.index_name ?? '').toUpperCase();
          const key = name ? keyByIndex.get(name) : undefined;
          if (key) emitTick(key, row, e.received_at_ms);
        });
        return;
      }
      if (e.event === 'error') {
        console.warn(`[nubra/live] ${String(e.message || 'bridge error')}`);
      }
    };

    void (async () => {
      try {
        const date = istDate(Date.now());
        const indexSymbols = new Set<string>();

        // Refdata per exchange, because refIds live in the instrument master and
        // a key set can span exchanges.
        for (const exchange of new Set(keys.map((k) => k.exchange.toUpperCase()))) {
          const rows = await this.rows(exchange, date);
          if (stopped) return;

          const refByKey = new Map<string, string>();
          const nameByKey = new Map<string, string>();
          for (const row of rows) {
            const rowKey = keyForRow(row);
            if (!rowKey) continue;
            const ks = keyOf(rowKey);
            if (row.refId && !refByKey.has(ks)) refByKey.set(ks, row.refId);
            if (row.name && !nameByKey.has(ks)) nameByKey.set(ks, row.name);
          }

          for (const key of keys) {
            if (key.exchange.toUpperCase() !== exchange) continue;
            const ks = keyOf(key);

            if (key.kind === 'OPT') {
              const ref = refByKey.get(ks);
              if (ref) keyByRef.set(ref, key);
              continue;
            }

            // An index has no listed contract of its own, so it falls back to
            // the bare asset — the same rule `nativeSymbol` applies for SPOT.
            const name = nameByKey.get(ks) ?? (key.kind === 'SPOT' ? key.asset.toUpperCase() : null);
            if (name) {
              indexSymbols.add(name.toUpperCase());
              keyByIndex.set(name.toUpperCase(), key);
            }
          }
        }

        const refIds = [...keyByRef.keys()];
        if (stopped || (!refIds.length && !indexSymbols.size)) return;

        bridge = startBridge(
          {
            environment: /uat/i.test(process.env.NUBRA_BASE_URL || '') ? 'uat' : 'prod',
            token: session.sessionToken.replace(/^Bearer /, '').trim(),
            deviceId: session.deviceId,
            mode: 'quotes',
            exchange: keys[0].exchange.toUpperCase(),
            refIds,
            indexSymbols: [...indexSymbols],
          },
          onEvent,
          (code) => {
            if (!stopped) console.warn(`[nubra/live] bridge exited (${code ?? 'signal'})`);
          },
        );

        // Stopped while refdata was resolving: the handle only exists now, so
        // this is where that race is closed.
        if (stopped) bridge.stop();
      } catch (err) {
        if (!stopped) console.warn(`[nubra/live] could not start: ${(err as Error).message}`);
      }
    })();

    return () => {
      stopped = true;
      bridge?.stop();
      bridge = null;
    };
  }

  private async rows(exchange: string, date: string): Promise<InstrumentRow[]> {
    try {
      return await getCachedRefdata(exchange.toUpperCase(), date, this.session());
    } catch (err) {
      throw classify(err, this.id);
    }
  }

  private async index(exchange: string, date: string) {
    const cacheKey = `${exchange.toUpperCase()}|${date}`;
    const hit = this.symbolIndex.get(cacheKey);
    if (hit) return hit;

    const rows     = await this.rows(exchange, date);
    const toNative = new Map<string, string>();
    const aliases  = new Map<string, string[]>();
    const toKey    = new Map<string, string>();
    const spotType = new Map<string, string>();

    for (const row of rows) {
      const key = keyForRow(row);
      if (!key || !row.name) continue;
      const ks = keyOf(key);

      // Nubra's timeseries `type` for an asset's cash leg is INDEX for an index
      // and STOCK for equity. Sending the wrong one returns zero points rather
      // than an error, so it is derived from refdata, never assumed.
      if (!spotType.has(row.asset)) {
        const k = kindOf(row);
        if (k === 'INDEX' || k === 'STOCK') spotType.set(row.asset, k);
      }
      // Refdata can list the same contract more than once across aliases; the
      // first row is the canonical one (instrumentCache puts the primary
      // trading symbol at aliases[0]).
      if (!toNative.has(ks)) toNative.set(ks, row.name);
      const alts = row.aliases.filter((a) => a && a !== row.name);
      if (alts.length) aliases.set(row.name, alts);
      for (const n of [row.name, ...row.aliases]) {
        if (n) toKey.set(n.toUpperCase(), ks);
      }
    }

    const built = { toNative, aliases, toKey, spotType };
    this.symbolIndex.set(cacheKey, built);
    return built;
  }
}

/** The default (unsuffixed) instance, sharing the process-wide session store. */
export const nubraFeed = new NubraFeed();
