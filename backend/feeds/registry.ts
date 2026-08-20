/**
 * Feed registry — turns configuration into an ordered list of live adapters.
 *
 * Config lives in one env var so adding a broker is a one-line change:
 *
 *   QT_FEEDS=nubra:1,zerodha:2,angelone:3      # id:priority, lower wins
 *
 * An unknown id is a hard startup error rather than a silent skip: a typo that
 * quietly drops your only feed is worse than a crash at boot.
 */

import type { FeedId, MarketDataFeed } from './types.js';
import { nubraFeed }   from './adapters/nubra/index.js';
import { angelFeed }   from './adapters/angel/index.js';
import { zerodhaFeed } from './adapters/zerodha/index.js';
import { kotakFeed }   from './adapters/kotak/index.js';

import { logger } from '../lib/logger.js';

const log = logger('feeds');

export interface RegisteredFeed {
  feed:     MarketDataFeed;
  priority: number;
  /** Adapter family — `nubra` for both `nubra` and `nubra#2`. */
  broker:   string;
  /** Instance suffix, or undefined for a single-account feed. */
  instance?: string;
}

/** Every adapter that exists in this build, keyed by broker family. */
const AVAILABLE: Record<string, (instance?: string) => MarketDataFeed> = {
  nubra:   (i) => (i ? nubraFeed.withInstance(i)   : nubraFeed),
  angel:   (i) => (i ? angelFeed.withInstance(i)   : angelFeed),
  zerodha: (i) => (i ? zerodhaFeed.withInstance(i) : zerodhaFeed),
  kotak:   (i) => (i ? kotakFeed.withInstance(i)   : kotakFeed),
};

/**
 * Spellings that mean the same adapter.
 *
 * The broker cards in the UI and the Supabase rows both say `angelone`, so
 * `QT_FEEDS=angelone:2` has to work — failing at boot over a naming difference
 * nobody agreed on in the first place is a bad trade.
 */
const FEED_ALIASES: Record<string, string> = {
  angelone: 'angel',
  smartapi: 'angel',
  kite:     'zerodha',
};

const DEFAULT_SPEC = 'nubra:1';

/**
 * A feed id is `broker` or `broker#instance`.
 *
 * The instance suffix exists so two accounts on the same broker can spread rate
 * limits later (`QT_FEEDS=nubra#1:1,nubra#2:2`) without renaming every feed id
 * in configs, logs and cache keys at that point. Nothing needs it today; the
 * shape is here because retrofitting it is expensive and allowing it is free.
 */
export function splitFeedId(id: FeedId): { broker: string; instance?: string } {
  const [raw, instance] = id.split('#');
  const broker = raw.toLowerCase();
  return { broker: FEED_ALIASES[broker] ?? broker, instance: instance || undefined };
}

function parseSpec(spec: string): Array<{ id: FeedId; priority: number }> {
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry, i) => {
      // Split on the LAST colon: `nubra#2:1` must not break at `nubra#2`.
      const cut  = entry.lastIndexOf(':');
      const id   = (cut < 0 ? entry : entry.slice(0, cut)).trim().toLowerCase();
      const prio = cut < 0 ? NaN : Number(entry.slice(cut + 1).trim());
      return { id, priority: Number.isFinite(prio) ? prio : i + 1 };
    });
}

let registry: RegisteredFeed[] | null = null;

/** Ordered by priority, best first. Built once, memoised. */
export function feeds(): RegisteredFeed[] {
  if (registry) return registry;

  const spec    = process.env.QT_FEEDS || DEFAULT_SPEC;
  const wanted  = parseSpec(spec).map((w) => ({ ...w, ...splitFeedId(w.id) }));
  const unknown = wanted.filter((w) => !AVAILABLE[w.broker]).map((w) => w.id);

  if (unknown.length) {
    throw new Error(
      `QT_FEEDS names ${unknown.length > 1 ? 'feeds' : 'a feed'} with no adapter: `
      + `${unknown.join(', ')}. Available: ${Object.keys(AVAILABLE).join(', ')}`,
    );
  }

  const dupes = wanted.map((w) => w.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dupes.length) {
    throw new Error(`QT_FEEDS lists ${dupes[0]} more than once`);
  }

  registry = wanted
    .map((w) => ({
      feed:     AVAILABLE[w.broker](w.instance),
      priority: w.priority,
      broker:   w.broker,
      instance: w.instance,
    }))
    .sort((a, b) => a.priority - b.priority);

  log.info(
    { feeds: registry.map((r) => ({ id: r.feed.id, priority: r.priority })) },
    `feeds registered: ${registry.map((r) => r.feed.id).join(' → ')}`,
  );
  return registry;
}

/**
 * One feed by id, or null.
 *
 * Accepts aliases, so `/api/feeds/login {id:"angelone"}` reaches the same feed
 * the UI's broker card is named after.
 */
export function feedById(id: FeedId): MarketDataFeed | null {
  const { broker, instance } = splitFeedId(id);
  const canonical = instance ? `${broker}#${instance}` : broker;
  return feeds().find((r) => r.feed.id === canonical)?.feed ?? null;
}

/** The highest-priority feed, regardless of health. Phase 1 callers use this. */
export function primaryFeed(): MarketDataFeed {
  const first = feeds()[0];
  if (!first) throw new Error('No data feeds configured — set QT_FEEDS');
  return first.feed;
}

/** Test seam: forget the memoised registry so QT_FEEDS can be re-read. */
export function resetRegistry(): void {
  registry = null;
}

/**
 * Test seam: replace the registry with hand-built feeds.
 *
 * Failover cannot be verified against a live broker — you would have to wait
 * for a real outage — so the router is exercised against MockFeeds installed
 * here. Production never calls this; `feeds()` is memoised from QT_FEEDS.
 */
export function installTestFeeds(
  list: Array<{ feed: MarketDataFeed; priority: number }>,
): void {
  registry = list
    .map(({ feed, priority }) => ({ feed, priority, ...splitFeedId(feed.id) }))
    .sort((a, b) => a.priority - b.priority);
}

/** Undo installTestFeeds. */
export function restoreFeeds(): void {
  registry = null;
}
