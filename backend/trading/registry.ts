/**
 * Which brokers can be traded against.
 *
 * Configured independently of `QT_FEEDS`, because the two roles genuinely come
 * apart. Nubra is the best market-data feed here and cannot place or report an
 * order; Kotak is the reverse. Forcing one list would mean either trading
 * against a broker you only wanted data from, or losing a position book because
 * that broker's tick socket is unhealthy.
 *
 *   QT_BROKERS=angel,zerodha,kotak       # unordered; every one is queried
 *
 * Defaults to whatever appears in QT_FEEDS and has a trading adapter, so the
 * common single-broker setup needs no second variable.
 */

import type { TradingBroker } from './types.js';
import { feeds, splitFeedId } from '../feeds/registry.js';
import { AngelTrading }   from './adapters/angel.js';
import { ZerodhaTrading } from './adapters/zerodha.js';
import { KotakTrading }   from './adapters/kotak.js';
import { AngelFeed }   from '../feeds/adapters/angel/index.js';
import { ZerodhaFeed } from '../feeds/adapters/zerodha/index.js';
import { KotakFeed }   from '../feeds/adapters/kotak/index.js';

import { logger } from '../lib/logger.js';

const log = logger('trading/registry');

/**
 * Broker family → how to build a trading adapter from its feed adapter.
 *
 * The feed instance is the argument because it owns the session. Building one
 * from a broker name alone would mean a second login for the same account.
 */
const BUILDERS: Record<string, (feed: unknown) => TradingBroker | null> = {
  angel:   (f) => (f instanceof AngelFeed   ? new AngelTrading(f)   : null),
  zerodha: (f) => (f instanceof ZerodhaFeed ? new ZerodhaTrading(f) : null),
  kotak:   (f) => (f instanceof KotakFeed   ? new KotakTrading(f)   : null),
};

let registry: TradingBroker[] | null = null;

/**
 * Every configured trading broker.
 *
 * A name in QT_BROKERS with no matching FEED is an error rather than a skip: the
 * trading adapter has no way to log in on its own, so it would be permanently
 * disconnected and the reason would not be obvious from anywhere.
 */
export function brokers(): TradingBroker[] {
  if (registry) return registry;

  const configured = feeds();
  const spec = process.env.QT_BROKERS?.trim();

  const wanted = spec
    ? spec.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    // Default: every configured feed that has a trading adapter.
    : configured.map((r) => r.feed.id).filter((id) => BUILDERS[splitFeedId(id).broker]);

  const out: TradingBroker[] = [];
  const missing: string[] = [];

  for (const id of wanted) {
    const { broker } = splitFeedId(id);
    const build = BUILDERS[broker];
    if (!build) { missing.push(`${id} (no trading adapter)`); continue; }

    // A suffixed broker id names one exact account. Falling back by family for
    // `angel#2` could silently attach the first Angel session instead; family
    // fallback is only valid for the unsuffixed shorthand `angel`.
    const feed = configured.find((r) => r.feed.id === id)
      ?? (id === broker ? configured.find((r) => r.broker === broker) : undefined);
    if (!feed) { missing.push(`${id} (not in QT_FEEDS)`); continue; }

    const adapter = build(feed.feed);
    if (adapter) out.push(adapter);
    else missing.push(`${id} (feed/adapter mismatch)`);
  }

  if (missing.length && spec) {
    throw new Error(
      `QT_BROKERS names brokers that cannot be traded: ${missing.join(', ')}. `
      + 'Every trading broker must also appear in QT_FEEDS — that is where its session lives.',
    );
  }

  registry = out;
  log.info(
    out.length
      ? `[trading] enabled: ${out.map((b) => b.id).join(', ')}`
      : '[trading] no trading brokers configured',
  );
  return registry;
}

export function brokerById(id: string): TradingBroker | null {
  const { broker, instance } = splitFeedId(id);
  const canonical = instance ? `${broker}#${instance}` : broker;
  return brokers().find((b) => b.id === canonical) ?? null;
}

/** Test seam. */
export function resetBrokers(): void {
  registry = null;
}
