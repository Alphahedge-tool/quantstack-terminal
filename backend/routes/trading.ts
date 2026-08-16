/**
 * Trading reads, broker-neutral.
 *
 *   GET /api/trading            which brokers are configured, and their state
 *   GET /api/trading/orders     order book, across every broker or one
 *   GET /api/trading/trades     fills
 *   GET /api/trading/positions  net positions
 *   GET /api/trading/holdings   demat holdings
 *   GET /api/trading/funds      margin and cash, per broker
 *
 * Routes are `/api/trading/*`, not `/api/angel/*`. That is the point: the UI
 * asks for "my positions" and gets every account it has, each row tagged with
 * where it came from. Adding a fifth broker changes nothing here.
 *
 * ── Aggregation and partial failure ──
 *
 * One broker being down must not blank the whole screen. Every endpoint queries
 * all brokers in parallel and returns whatever succeeded, alongside an `errors`
 * array naming what did not. A caller that ignores `errors` sees fewer rows; a
 * caller that reads it can say "Kotak is unavailable" — which beats an empty
 * table that looks like a flat book.
 *
 * These are all READS. There is no order-placement route, by design — see the
 * note at the top of trading/types.ts.
 */

import { route, ApiError } from '../server.js';
import { brokers, brokerById } from '../trading/registry.js';
import type { TradingBroker } from '../trading/types.js';
import { pricingBrokersFor } from '../trading/contract.js';
import { ensureConnected } from '../feeds/authManager.js';
import { feedById } from '../feeds/registry.js';
import { FeedError } from '../feeds/errors.js';

/** A row tagged with the account it came from. */
type Tagged<T> = T & { broker: string; feedId: string };

interface Aggregate<T> {
  status: boolean;
  rows:   Array<Tagged<T>>;
  errors: Array<{ broker: string; message: string; code: string }>;
}

/** The brokers a request targets — one if `broker=` is given, else all. */
function targets(query: URLSearchParams): TradingBroker[] {
  const want = query.get('broker');
  if (!want) return brokers();
  const hit = brokerById(want);
  if (!hit) throw new ApiError(`Unknown trading broker: ${want}`, 404);
  return [hit];
}

/**
 * Run one book across every target broker.
 *
 * Connects on demand: a route that returned "not logged in" and left it to the
 * caller to POST a login first is the behaviour `feeds/access.ts` exists to
 * avoid, and the same reasoning applies here.
 */
async function collect<T>(
  list: TradingBroker[],
  can: (b: TradingBroker) => boolean,
  read: (b: TradingBroker) => Promise<T[]>,
): Promise<Aggregate<T>> {
  const rows:   Array<Tagged<T>> = [];
  const errors: Aggregate<T>['errors'] = [];

  await Promise.all(list.map(async (b) => {
    if (!can(b)) {
      // A capability gap is not an error worth surfacing as a failure — the
      // broker simply does not publish this book. Silently contributing zero
      // rows is correct, and saying so in `errors` would cry wolf on every poll.
      return;
    }
    try {
      const feed = feedById(b.id);
      if (feed) await ensureConnected(feed);
      for (const row of await read(b)) {
        rows.push({ ...row, broker: b.broker, feedId: b.id });
      }
    } catch (err) {
      const fe = err instanceof FeedError ? err : null;
      errors.push({
        broker:  b.id,
        message: (err as Error).message,
        code:    fe?.code ?? 'INTERNAL',
      });
    }
  }));

  // Always `true`. `status: false` is this API's signal that the REQUEST failed,
  // and `lib/api.ts` turns it into a thrown ApiFailure — which would replace the
  // book with a crash banner on the one case that matters most: every broker
  // signed out, where the useful UI is a "sign in" prompt and an empty table.
  // Per-broker outcomes belong in `errors`, and the client reads them there.
  return { status: true, rows, errors };
}

// ── control plane ────────────────────────────────────────────────────────────

route('GET', '/api/trading', () => ({
  status: true,
  brokers: brokers().map((b) => ({
    id:           b.id,
    broker:       b.broker,
    connected:    b.isConnected(),
    capabilities: b.capabilities,
  })),
}));

// ── books ────────────────────────────────────────────────────────────────────

route('GET', '/api/trading/orders', async (_req, _res, { query }) => {
  // `rows` is renamed, not spread alongside — returning both would ship the
  // entire book twice in every response.
  const { rows, errors } = await collect(targets(query), (b) => b.capabilities.orders, (b) => b.orders());
  return { status: true, orders: rows, errors };
});

route('GET', '/api/trading/trades', async (_req, _res, { query }) => {
  const { rows, errors } = await collect(targets(query), (b) => b.capabilities.trades, (b) => b.trades());
  return { status: true, trades: rows, errors };
});

/**
 * Net positions.
 *
 * Each row carries `pricedBy` — the brokers whose feed could supply a live price
 * for that contract. Kotak's position report has no price in it at all, so this
 * is how the UI knows a Kotak position can be priced by the Angel feed rather
 * than showing a blank LTP.
 */
route('GET', '/api/trading/positions', async (_req, _res, { query }) => {
  const { rows, errors } = await collect(targets(query), (b) => b.capabilities.positions, (b) => b.positions());
  return {
    status: true,
    positions: rows.map((p) => ({ ...p, pricedBy: pricingBrokersFor(p.contract) })),
    errors,
  };
});

route('GET', '/api/trading/holdings', async (_req, _res, { query }) => {
  const { rows, errors } = await collect(targets(query), (b) => b.capabilities.holdings, (b) => b.holdings());
  return { status: true, holdings: rows, errors };
});

/**
 * Funds, per broker.
 *
 * Not aggregated into one number. Cash in a Zerodha account cannot margin an
 * Angel position, so a single total would be a figure that is true of no
 * account and misleading about all of them.
 */
route('GET', '/api/trading/funds', async (_req, _res, { query }) => {
  const list = targets(query);
  const funds: Array<{ broker: string; feedId: string; available: number; used: number; total: number; source: string }> = [];
  const errors: Array<{ broker: string; message: string; code: string }> = [];

  await Promise.all(list.map(async (b) => {
    if (!b.capabilities.funds) return;
    try {
      const feed = feedById(b.id);
      if (feed) await ensureConnected(feed);
      funds.push({ broker: b.broker, feedId: b.id, ...await b.funds() });
    } catch (err) {
      const fe = err instanceof FeedError ? err : null;
      errors.push({ broker: b.id, message: (err as Error).message, code: fe?.code ?? 'INTERNAL' });
    }
  }));

  // Consistent with the books above: the request succeeded even when no broker
  // could answer. Throwing here would make the account strip retry-storm on
  // every poll while signed out, which is the normal state before a login.
  return { status: true, funds, errors };
});
