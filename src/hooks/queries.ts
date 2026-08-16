/**
 * Server state. Every backend read the app performs is declared here, so the
 * cache keys, poll intervals and retry policy live in one file rather than
 * being re-decided per component.
 */

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { api, ApiFailure } from '@/lib/api';
import { useUiStore } from '@/stores/uiStore';
import {
  ordersResponse,
  tradesResponse,
  positionsResponse,
  holdingsResponse,
  fundsResponse,
  tradingControlResponse,
} from '@/schemas/trading';
import {
  feedsResponse,
  healthResponse,
  instrumentSearchResponse,
  expiriesResponse,
  straddleExpiriesResponse,
  straddleHistoryResponse,
  bandGreeksResponse,
  riskReversalResponse,
  type BandGreeks,
  type RiskReversal,
} from '@/schemas/market';
import { streamResult } from '@/lib/sse';

/**
 * Query keys, built from one factory.
 *
 * The books are keyed on the broker filter because `?broker=` changes the
 * result — keying only on the book name would serve one account's rows from
 * cache while the header said "all accounts".
 */
export const keys = {
  health: ['health'] as const,
  brokers: ['trading', 'brokers'] as const,
  orders: (broker: string) => ['trading', 'orders', broker] as const,
  trades: (broker: string) => ['trading', 'trades', broker] as const,
  positions: (broker: string) => ['trading', 'positions', broker] as const,
  holdings: (broker: string) => ['trading', 'holdings', broker] as const,
  funds: (broker: string) => ['trading', 'funds', broker] as const,
  feeds: ['feeds'] as const,
  instrumentSearch: (q: string, exchange: string) =>
    ['instruments', 'search', q, exchange] as const,
  expiries: (symbol: string, exchange: string) =>
    ['instruments', 'expiries', symbol, exchange] as const,
  // `date` is part of both keys. The expiry list for a past session is not the
  // list for today's — one contract may have expired in between — and a session
  // walk is entirely date-scoped, so omitting it would serve Tuesday's chart
  // under Wednesday's heading.
  straddleExpiries: (symbol: string, exchange: string, date: string) =>
    ['straddle', 'expiries', symbol, exchange, date] as const,
  straddleHistory: (symbol: string, exchange: string, expiry: string, date: string) =>
    ['straddle', 'history', symbol, exchange, expiry, date] as const,
  // The delta band and the target delta are part of these keys because they are
  // part of the MEASUREMENT: a 0.05–0.60 basket and a 0.20–0.40 one are
  // different baskets over the same session, and a 0.25 risk reversal is not a
  // 0.10 one. The backend keys its own cache the same way.
  bandGreeks: (symbol: string, exchange: string, expiry: string, date: string, band: string) =>
    ['straddle', 'band-greeks', symbol, exchange, expiry, date, band] as const,
  riskReversal: (symbol: string, exchange: string, expiry: string, date: string, delta: string) =>
    ['straddle', 'risk-reversal', symbol, exchange, expiry, date, delta] as const,
};

/**
 * Shared retry policy.
 *
 * An auth failure must NOT be retried: the session is gone, three more attempts
 * will fail identically, and the delay only postpones the sign-in prompt the
 * user actually needs. A 4xx is likewise a bad request, not a flaky one.
 */
export function retryPolicy(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiFailure) {
    if (error.isAuth) return false;
    if (error.status >= 400 && error.status < 500) return false;
  }
  return failureCount < 2;
}

/** Poll interval shared by the books, driven by the user's refresh setting. */
function useRefreshMs(): number {
  return useUiStore((s) => s.refreshMs);
}

function useBroker(): string {
  return useUiStore((s) => s.brokerFilter);
}

type Extra<T> = Omit<UseQueryOptions<T, Error, T>, 'queryKey' | 'queryFn'>;

/* ── Health & control plane ───────────────────────────────────────────────── */

export function useHealth() {
  return useQuery({
    queryKey: keys.health,
    queryFn: ({ signal }) => api.get('/api/health', healthResponse, { signal }),
    refetchInterval: 15_000,
    retry: retryPolicy,
  });
}

export function useBrokers() {
  return useQuery({
    queryKey: keys.brokers,
    queryFn: ({ signal }) => api.get('/api/trading', tradingControlResponse, { signal }),
    refetchInterval: 20_000,
    retry: retryPolicy,
  });
}

/**
 * Every feed's health and session.
 *
 * `refetchInterval` is a parameter because the sign-in screen watches this at a
 * different cadence than the rest of the app: there, a feed that finishes its
 * background auto-login has to stop reading as failed within a few seconds of
 * doing so, and 20s of a red badge over a working session is long enough for
 * someone to start debugging a login that already succeeded.
 */
export function useFeeds(refetchInterval = 20_000) {
  return useQuery({
    queryKey: keys.feeds,
    queryFn: ({ signal }) => api.get('/api/feeds', feedsResponse, { signal }),
    refetchInterval,
    retry: retryPolicy,
  });
}

/* ── Books ────────────────────────────────────────────────────────────────── */

export function useOrders(extra?: Extra<ReturnType<typeof ordersResponse.parse>>) {
  const broker = useBroker();
  const refetchInterval = useRefreshMs();
  return useQuery({
    queryKey: keys.orders(broker),
    queryFn: ({ signal }) =>
      api.get('/api/trading/orders', ordersResponse, { query: { broker }, signal }),
    refetchInterval,
    retry: retryPolicy,
    ...extra,
  });
}

export function useTrades(extra?: Extra<ReturnType<typeof tradesResponse.parse>>) {
  const broker = useBroker();
  const refetchInterval = useRefreshMs();
  return useQuery({
    queryKey: keys.trades(broker),
    queryFn: ({ signal }) =>
      api.get('/api/trading/trades', tradesResponse, { query: { broker }, signal }),
    refetchInterval,
    retry: retryPolicy,
    ...extra,
  });
}

export function usePositions(extra?: Extra<ReturnType<typeof positionsResponse.parse>>) {
  const broker = useBroker();
  const refetchInterval = useRefreshMs();
  return useQuery({
    queryKey: keys.positions(broker),
    queryFn: ({ signal }) =>
      api.get('/api/trading/positions', positionsResponse, { query: { broker }, signal }),
    refetchInterval,
    retry: retryPolicy,
    ...extra,
  });
}

export function useHoldings(extra?: Extra<ReturnType<typeof holdingsResponse.parse>>) {
  const broker = useBroker();
  return useQuery({
    queryKey: keys.holdings(broker),
    queryFn: ({ signal }) =>
      api.get('/api/trading/holdings', holdingsResponse, { query: { broker }, signal }),
    // Holdings settle overnight; polling them at the book cadence is pure load.
    refetchInterval: 60_000,
    retry: retryPolicy,
    ...extra,
  });
}

export function useFunds(extra?: Extra<ReturnType<typeof fundsResponse.parse>>) {
  const broker = useBroker();
  return useQuery({
    queryKey: keys.funds(broker),
    queryFn: ({ signal }) =>
      api.get('/api/trading/funds', fundsResponse, { query: { broker }, signal }),
    refetchInterval: 30_000,
    retry: retryPolicy,
    ...extra,
  });
}

/* ── Instruments ──────────────────────────────────────────────────────────── */

export function useInstrumentSearch(query: string, exchange: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: keys.instrumentSearch(trimmed, exchange),
    queryFn: ({ signal }) =>
      api.get('/api/instruments/search', instrumentSearchResponse, {
        query: { q: trimmed, exchange, limit: 60 },
        signal,
      }),
    // A one-character query matches most of the master and is never what the
    // user meant yet; waiting for the second keystroke saves the round trip.
    enabled: trimmed.length >= 2,
    // The instrument master changes daily at most — re-running the same search
    // while the user tabs around is wasted work.
    staleTime: 5 * 60_000,
    retry: retryPolicy,
  });
}

export function useExpiries(symbol: string, exchange: string) {
  return useQuery({
    queryKey: keys.expiries(symbol, exchange),
    queryFn: ({ signal }) =>
      api.get('/api/instruments/expiries', expiriesResponse, {
        query: { symbol, exchange },
        signal,
      }),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
    retry: retryPolicy,
  });
}

/* ── Straddle analytics ───────────────────────────────────────────────────── */

/**
 * Expiries listed for a session.
 *
 * `date` is optional and empty means "the backend's latest trading date" —
 * which is what the user wants on a Saturday, and is a decision only the
 * backend can make correctly since it owns the holiday calendar. Sending an
 * empty string would be a different thing from omitting the parameter, so the
 * query object is built conditionally.
 */
export function useStraddleExpiries(symbol: string, exchange: string, date = '') {
  return useQuery({
    queryKey: keys.straddleExpiries(symbol, exchange, date),
    queryFn: ({ signal }) =>
      api.get('/api/straddle/expiries', straddleExpiriesResponse, {
        query: { symbol, exchange, ...(date ? { date } : {}) },
        signal,
      }),
    enabled: Boolean(symbol),
    staleTime: 5 * 60_000,
    retry: retryPolicy,
  });
}

/**
 * The session walk behind the straddle chart.
 *
 * POST, not GET — the backend takes this one as a JSON body. On a cache miss it
 * computes a whole session (thousands of bars across every strike the spot
 * visited), so this can legitimately take seconds on the first request for a
 * contract; the page shows a skeleton rather than a spinner-in-a-box for that
 * reason.
 *
 * No `refetchInterval`. A completed session is immutable history, and the
 * backend tops up today's tail on its own via the catch-up path — re-POSTing on
 * a timer would risk kicking off a fresh full compute on every cache expiry.
 */
export function useStraddleHistory(
  symbol: string,
  exchange: string,
  expiry: string,
  date = '',
) {
  return useQuery({
    queryKey: keys.straddleHistory(symbol, exchange, expiry, date),
    queryFn: ({ signal }) =>
      api.post(
        '/api/straddle/history',
        straddleHistoryResponse,
        { symbol, exchange, expiry, ...(date ? { date } : {}) },
        { signal },
      ),
    enabled: Boolean(symbol && expiry),
    // A past session is finished history and never changes. Today's tail is
    // topped up by the backend's own catch-up path on each request, so a short
    // staleTime is only useful for the live case.
    staleTime: 60_000,
    retry: retryPolicy,
  });
}

/* ── Band greeks & risk reversal ──────────────────────────────────────────── */

/**
 * The delta window for the band-greeks basket.
 *
 * ── These are sent explicitly, and must be ──
 *
 * The backend documents defaults of 0.05/0.60 and applies them when the
 * parameter is ABSENT from its own engine call — but the route's query parser
 * reads them as:
 *
 *     const n = Number(raw);
 *     return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
 *
 * and `Number(null)` is `0`, which is finite and inside [0, 1]. So omitting
 * `dMin`/`dMax` does not fall back — it asks for the band 0 to 0, which no
 * strike is ever inside. Confirmed against the live backend: without them the
 * response comes back `legsUsed: 0, coverage: 0` and every greek null, which
 * renders as a legitimately empty chart rather than as an error. With them,
 * `legsUsed: 24, coverage: 1`.
 *
 * Sending them always is correct regardless — the band is part of what the
 * chart is claiming to show, so it should be stated rather than inherited.
 */
export const DELTA_BAND = { min: 0.05, max: 0.6 } as const;
export const TARGET_DELTA = 0.25;

/**
 * Vega and theta across the delta band.
 *
 * Served over SSE, not JSON: the basket fetches 60–100 option series and walks
 * the session, which is well past what a request should sit silent through.
 * `streamResult` folds the `append` frame — the bars recorded since the entry
 * was cached — into the result before it resolves, so a component never sees
 * the session in two pieces.
 */
export function useBandGreeks(symbol: string, exchange: string, expiry: string, date = '') {
  const band = `${DELTA_BAND.min}-${DELTA_BAND.max}`;
  return useQuery({
    queryKey: keys.bandGreeks(symbol, exchange, expiry, date, band),
    queryFn: ({ signal }) =>
      streamResult(
        '/api/straddle/band-greeks',
        { symbol, exchange, expiry, date, dMin: DELTA_BAND.min, dMax: DELTA_BAND.max },
        bandGreeksResponse,
        { signal, merge: mergePoints },
      ),
    enabled: Boolean(symbol && expiry),
    staleTime: 60_000,
    retry: retryPolicy,
  });
}

/** The 25-delta risk reversal — the put/call IV skew at the wings. */
export function useRiskReversal(symbol: string, exchange: string, expiry: string, date = '') {
  return useQuery({
    queryKey: keys.riskReversal(symbol, exchange, expiry, date, String(TARGET_DELTA)),
    queryFn: ({ signal }) =>
      streamResult(
        '/api/straddle/risk-reversal',
        { symbol, exchange, expiry, date, delta: TARGET_DELTA },
        riskReversalResponse,
        { signal, merge: mergePoints },
      ),
    enabled: Boolean(symbol && expiry),
    staleTime: 60_000,
    retry: retryPolicy,
  });
}

/**
 * Fold an `append` frame onto a cached session.
 *
 * The appended bars are the tail AFTER the cached ones, so they concatenate —
 * but the boundary is checked rather than trusted. A duplicate or out-of-order
 * timestamp would throw inside lightweight-charts and take the chart down,
 * which is a poor outcome for a catch-up that only ever adds a few bars.
 */
function mergePoints<T extends BandGreeks | RiskReversal>(result: T, append: unknown): T {
  const tail = (append as { points?: Array<{ time: number }> })?.points;
  if (!Array.isArray(tail) || tail.length === 0) return result;
  const lastTime = result.points[result.points.length - 1]?.time ?? -Infinity;
  const fresh = tail.filter((p) => typeof p?.time === 'number' && p.time > lastTime);
  if (!fresh.length) return result;
  return { ...result, points: [...result.points, ...fresh] } as T;
}
