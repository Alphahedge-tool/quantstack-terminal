/**
 * Surface, expiry and asset fetching for Analysis Sheets.
 *
 * ── Why this polls slowly ──
 *
 * A surface call walks a whole session of option series for ~34 contracts, on
 * each of two legs. Implied vol is also a slow variable: the thing these sheets
 * measure moves over minutes, not ticks. Polling at book speed would cost far
 * more than it tells you, and on a feed with a historical rate limit the second
 * leg would simply queue behind the first.
 *
 * 30 seconds, then — which is what the reference implementation settled on for
 * the same reasons.
 */

import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from '@/lib/api';
import { retryPolicy } from '@/hooks/queries';
import {
  assetSearchResponse,
  expiriesResponse,
  surfaceResponse,
} from '@/schemas/surface';
import type { Surface } from '@/lib/options/ivArbitrage';

const SURFACE_MS = 30_000;

export const surfaceKeys = {
  assets: (exchange: string) => ['surface', 'assets', exchange] as const,
  expiries: (symbol: string, exchange: string) =>
    ['surface', 'expiries', symbol, exchange] as const,
  surface: (symbol: string, exchange: string, expiry: string, width: number) =>
    ['surface', 'iv', symbol, exchange, expiry, width] as const,
};

/** Option-bearing assets on one exchange, for the symbol picker. */
export function useAssetOptions(exchange: string) {
  const query = useQuery({
    queryKey: surfaceKeys.assets(exchange),
    queryFn: ({ signal }) =>
      api.get('/api/instruments/search', assetSearchResponse, {
        query: { q: '', exchange, limit: 100 },
        signal,
      }),
    enabled: Boolean(exchange),
    // The listed-asset set changes when the exchange publishes a new master,
    // which is daily at most.
    staleTime: 60 * 60_000,
    placeholderData: keepPreviousData,
    retry: retryPolicy,
  });

  const results = useMemo(
    () => [...(query.data?.instruments ?? [])].sort((a, b) => a.asset.localeCompare(b.asset)),
    [query.data?.instruments],
  );

  return { results, isLoading: query.isLoading };
}

export function useExpiries(symbol: string, exchange: string) {
  const query = useQuery({
    queryKey: surfaceKeys.expiries(symbol, exchange),
    queryFn: ({ signal }) =>
      api.get('/api/instruments/expiries', expiriesResponse, {
        query: { symbol, exchange },
        signal,
      }),
    enabled: Boolean(symbol && exchange),
    staleTime: 60 * 60_000,
    placeholderData: keepPreviousData,
    retry: retryPolicy,
  });

  return { expiries: query.data?.expiries ?? [], isLoading: query.isLoading };
}

/**
 * The surface plus the two fields the route reports that the comparison maths
 * has no use for.
 *
 * `basis` matters to the CALLER even though `ivArbitrage` never reads it: it is
 * forward minus spot, and it is the offset between the strike the route centres
 * its window on and the strike anchors are measured from. See `widthFor`.
 */
export type FetchedSurface = Surface & {
  basis?: number | null;
  date?: string;
};

export interface SurfaceResult {
  surface: FetchedSurface | null;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

/**
 * Both legs' surfaces, in ONE `useQueries`.
 *
 * Not two `useQuery` calls. A comparison of two surfaces fetched independently
 * can render mid-flight with leg A refreshed and leg B thirty seconds stale,
 * and every spread on screen is then measured across a time gap that nothing
 * on screen discloses. Batched, the pair settles together.
 *
 * `width` is per leg, and it is a cost as much as a setting: each extra step is
 * two more contracts to walk a session for. Per leg because the ladders differ
 * — reaching 500 points takes 5 strikes on a ladder stepping 100 and 10 on one
 * stepping 50, and a single shared number would either starve the fine ladder
 * or double the fetch on the coarse one. See `widthFor` in `AnalysisSheets`.
 */
export function useSurfacePair(
  legs: Array<{ symbol: string; exchange: string; expiry: string; width: number }>,
): SurfaceResult[] {
  const results = useQueries({
    queries: legs.map((leg) => {
      // Clamped to what the route accepts. Asking for 40 does not fail loudly,
      // it silently returns 20 — and the query key would then claim a width the
      // data does not have.
      const width = Math.min(20, Math.max(1, Math.round(leg.width)));
      return {
      queryKey: surfaceKeys.surface(leg.symbol, leg.exchange, leg.expiry, width),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.get('/api/options/surface', surfaceResponse, {
          query: {
            symbol: leg.symbol,
            exchange: leg.exchange,
            expiry: leg.expiry,
            width,
          },
          signal,
        }),
      enabled: Boolean(leg.symbol && leg.expiry),
      refetchInterval: SURFACE_MS,
      // Held across a leg change so the table does not blank for the ~2s a cold
      // surface takes — the previous pair stays legible until the new one lands.
      placeholderData: keepPreviousData,
      retry: retryPolicy,
      };
    }),
  });

  return results.map((q) => ({
    // A surface with no rows is not a surface. Returning null rather than an
    // empty shell keeps every "do we have both legs" check to one truthiness
    // test instead of also asking about `rows.length`.
    surface: q.data?.rows.length ? (q.data as FetchedSurface) : null,
    isLoading: q.isLoading,
    isFetching: q.isFetching,
    error: q.error,
  }));
}
