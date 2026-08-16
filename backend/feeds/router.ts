/**
 * FeedRouter — one MarketDataFeed standing in for all of them.
 *
 * Consumers cannot tell it apart from a single feed, which is the point: the
 * straddle engine holds a `MarketDataFeed` and never learns that three brokers
 * exist, that one of them is down, or that the answer came from the second one.
 *
 * Selection runs on EVERY call rather than being sticky. That is what makes
 * recovery free — when a downed feed's breaker closes again, the very next
 * request goes back to it, with no reconnect step and no restart.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { canAttempt, recordFailure, recordSuccess, stateOf } from './breaker.js';
import { ensureConnected, withAuth } from './authManager.js';
import { classify, FeedError } from './errors.js';
import { feeds } from './registry.js';
import {
  bestInterval, supports,
  type CandleRequest, type CandleResult, type Capabilities, type Degradation,
  type Instrument, type MarketDataFeed, type SeriesRequest, type SeriesResult,
  type TradableAsset,
} from './types.js';
import type { InstrumentKind } from './identity.js';

/** What a call needs, for capability matching. */
interface Need {
  exchange: string;
  interval?: string;
  from?:     number;
  kind?:     InstrumentKind;
}

interface Attempt<T> {
  /** `interval` is the one the feed can actually serve, after degradation. */
  run: (feed: MarketDataFeed, interval: string) => Promise<T>;
}

/** Which feed served a call, for response tagging. */
export interface Provenance {
  feed:      string;
  degraded?: Degradation;
}

/** Everything that served one logical request. */
export interface ProvenanceReport {
  /** Feed ids that answered, in the order they first did. */
  feeds:     string[];
  /** True when more than one feed contributed — i.e. a failover happened. */
  mixed:     boolean;
  degraded?: Degradation;
}

/**
 * Per-request provenance.
 *
 * A single mutable "last feed served" field would be wrong the moment two
 * requests overlap, and a straddle mislabelled with the wrong broker is worse
 * than one with no label at all — the whole reason to record provenance is to
 * answer "which feed priced this?" when two brokers disagree. AsyncLocalStorage
 * scopes it to the request that actually caused the calls.
 */
const provenance = new AsyncLocalStorage<{ feeds: string[]; degraded?: Degradation }>();

/**
 * Run `fn`, collecting which feeds served it.
 *
 * Note a request can legitimately touch more than one feed: the chain may come
 * from feed 1 and the series from feed 2 if the first fails in between. That is
 * reported as `mixed`, not hidden.
 */
export async function withProvenance<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; provenance: ProvenanceReport }> {
  const store = { feeds: [] as string[], degraded: undefined as Degradation | undefined };
  const result = await provenance.run(store, fn);
  return {
    result,
    provenance: {
      feeds:    store.feeds,
      mixed:    store.feeds.length > 1,
      degraded: store.degraded,
    },
  };
}

export class FeedRouter implements MarketDataFeed {
  readonly id = 'router';

  /** Union of every registered feed — the router can do what any feed can do. */
  get capabilities(): Capabilities {
    const all = feeds().map((f) => f.feed.capabilities);
    return {
      exchanges:   [...new Set(all.flatMap((c) => c.exchanges))],
      intervals:   [...new Set(all.flatMap((c) => c.intervals))],
      historyDays: Math.max(0, ...all.map((c) => c.historyDays)),
      optionChain: all.some((c) => c.optionChain),
      greeks:      all.some((c) => c.greeks),
      live:        all.some((c) => c.live),
      maxSymbolsPerRequest: Math.max(1, ...all.map((c) => c.maxSymbolsPerRequest)),
    };
  }

  /**
   * The feed that served the most recent call, process-wide.
   *
   * Diagnostics and tests only — it is racy under concurrent requests by
   * construction. Anything user-facing must use `withProvenance`.
   */
  lastProvenance: Provenance | null = null;

  // ── core selection ─────────────────────────────────────────────────────────

  /**
   * Try each eligible feed in priority order until one answers.
   *
   * The classification of the failure decides everything: a NOT_FOUND stops the
   * walk (asking a second broker for data that does not exist just multiplies
   * the latency), while a TRANSIENT moves on and counts against the feed's
   * breaker.
   */
  private async route<T>(
    need: Need,
    label: string,
    { run }: Attempt<T>,
  ): Promise<T> {
    const candidates = feeds();
    if (!candidates.length) {
      throw new FeedError('INTERNAL', 'No data feeds configured — set QT_FEEDS', {});
    }

    const skipped: string[] = [];
    let lastFault: FeedError | null = null;

    for (const { feed } of candidates) {
      const cap = feed.capabilities;

      // Interval is deliberately EXCLUDED from this check. supports() is the
      // strict test — it would reject a 1m-only feed for a 1s request, which is
      // the very case the degradation below exists to rescue. Exchange, history
      // depth and instrument kind have no coarser equivalent, so they stay.
      const can = supports(cap, { exchange: need.exchange, from: need.from, kind: need.kind });
      if (!can.ok) { skipped.push(`${feed.id}: ${can.reason}`); continue; }

      // Degrade rather than refuse: a 1s request against a 1m-only feed returns
      // minute bars with a tag, so a live chart keeps drawing.
      let interval  = need.interval ?? '';
      let degraded: Degradation | undefined;
      if (need.interval) {
        const usable = bestInterval(cap, need.interval);
        if (!usable) { skipped.push(`${feed.id}: no interval for ${need.interval}`); continue; }
        if (usable !== need.interval) {
          interval = usable;
          degraded = {
            interval: usable,
            reason: `${feed.id} served ${usable}; ${need.interval} not available`,
          };
        }
      }

      if (!canAttempt(feed.id)) {
        skipped.push(`${feed.id}: breaker ${stateOf(feed.id)}`);
        continue;
      }

      try {
        // withAuth, not a bare ensureConnected: a session can die BETWEEN the
        // connect check and the call, and mid-request is in fact when it usually
        // surfaces. withAuth drops the dead session and logs in once more before
        // giving up on this feed — without it an expired token fails over to the
        // backup on every request and the primary never recovers.
        const out = await withAuth(feed, () => run(feed, interval));
        recordSuccess(feed.id);
        this.lastProvenance = { feed: feed.id, degraded };

        const store = provenance.getStore();
        if (store) {
          if (!store.feeds.includes(feed.id)) store.feeds.push(feed.id);
          if (degraded) store.degraded = degraded;
        }

        if (degraded) {
          console.warn(`[router] ${label}: ${degraded.reason}`);
        }
        return out;
      } catch (err) {
        const fe = classify(err, feed.id);

        if (fe.countsAsFailure) recordFailure(feed.id, fe.message);
        else                    recordSuccess(feed.id);

        if (!fe.shouldFailover) throw fe;

        lastFault = fe;
        skipped.push(`${feed.id}: ${fe.code}`);
        console.warn(`[router] ${label}: ${feed.id} failed (${fe.code}) — trying next feed`);
      }
    }

    // Nothing served it. Report why each feed was passed over: "no feed
    // available" without the reasons is the least actionable error there is.
    throw lastFault ?? new FeedError(
      'UNSUPPORTED',
      `No feed could serve ${label} — ${skipped.join(' | ')}`,
      {},
    );
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    const results = await Promise.allSettled(
      feeds().map(({ feed }) => ensureConnected(feed)),
    );
    if (results.every((r) => r.status === 'rejected')) {
      throw new FeedError('AUTH', 'No configured feed could be connected', {});
    }
  }

  async disconnect(): Promise<void> {
    await Promise.allSettled(feeds().map(({ feed }) => feed.disconnect()));
  }

  /** True if ANY feed is usable — the router serves as long as one does. */
  isConnected(): boolean {
    return feeds().some(({ feed }) => feed.isConnected());
  }

  async ping(): Promise<void> {
    await this.route({ exchange: this.capabilities.exchanges[0] ?? 'NSE' }, 'ping', {
      run: (feed) => feed.ping(),
    });
  }

  // ── reference data ─────────────────────────────────────────────────────────

  assets(exchange: string, date: string): Promise<TradableAsset[]> {
    return this.route({ exchange }, `assets(${exchange})`, {
      run: (feed) => feed.assets(exchange, date),
    });
  }

  expiries(asset: string, exchange: string, date: string): Promise<string[]> {
    return this.route({ exchange }, `expiries(${exchange}:${asset})`, {
      run: (feed) => feed.expiries(asset, exchange, date),
    });
  }

  chain(asset: string, exchange: string, date: string, expiry?: string): Promise<Instrument[]> {
    return this.route({ exchange, kind: 'OPT' }, `chain(${exchange}:${asset})`, {
      run: (feed) => feed.chain(asset, exchange, date, expiry),
    });
  }

  underlyings(asset: string, exchange: string, date: string, expiry?: string): Promise<Instrument[]> {
    return this.route({ exchange }, `underlyings(${exchange}:${asset})`, {
      run: (feed) => feed.underlyings(asset, exchange, date, expiry),
    });
  }

  // ── series ─────────────────────────────────────────────────────────────────

  candles(req: CandleRequest): Promise<CandleResult> {
    return this.route(
      { exchange: req.key.exchange, interval: req.interval, from: req.from, kind: req.key.kind },
      `candles(${req.key.asset} ${req.interval})`,
      { run: (feed, interval) => feed.candles({ ...req, interval }) },
    );
  }

  optionSeries(req: SeriesRequest): Promise<SeriesResult> {
    const first = req.keys[0];
    if (!first) return Promise.resolve({ series: new Map(), interval: req.interval });

    return this.route(
      { exchange: first.exchange, interval: req.interval, from: req.from, kind: 'OPT' },
      `optionSeries(${first.asset} ×${req.keys.length})`,
      { run: (feed, interval) => feed.optionSeries({ ...req, interval }) },
    );
  }
}

export const router = new FeedRouter();
