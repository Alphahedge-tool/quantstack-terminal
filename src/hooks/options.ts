/**
 * Option marks — the implied vol behind the payoff.
 *
 * Kept out of `hooks/queries.ts` for the same reason the auth hooks are: this
 * is a POST whose key is a set of contracts chosen at render time, not one of
 * the app's standing reads.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { retryPolicy } from '@/hooks/queries';
import { keyOf, type InstrumentKey } from '@/lib/symbol';
import { optionMarksResponse, type OptionMark } from '@/schemas/options';

/** The backend refuses more than 200 keys, and says so with a 400. */
const MAX_KEYS = 200;

/**
 * Marks for a set of contracts.
 *
 * ── Cadence ──
 *
 * 15s, not the book's 5s. IV moves far more slowly than price, and the
 * underlying call walks a whole session of option series per request — polling
 * it at tick speed would cost far more than it tells you.
 *
 * ── The key ──
 *
 * The sorted, joined contract ids. Keying on the array itself would miss the
 * cache on every render, and keying on its length would serve one strategy's
 * vols for another after a leg was rolled.
 */
export function useOptionMarks(keys: InstrumentKey[]) {
  const ids = useMemo(() => keys.map(keyOf).sort(), [keys]);
  const fingerprint = ids.join('|');

  const query = useQuery({
    queryKey: ['options', 'marks', fingerprint],
    queryFn: ({ signal }) =>
      api.post('/api/options/marks', optionMarksResponse, { keys }, { signal }),
    enabled: ids.length > 0 && ids.length <= MAX_KEYS,
    refetchInterval: 15_000,
    // Keep the previous vols on screen while a new set loads. A payoff that
    // blanks every time a leg changes is worse than one a few seconds stale.
    placeholderData: (previous) => previous,
    staleTime: 10_000,
    retry: retryPolicy,
  });

  const marks = useMemo(
    () => new Map<string, OptionMark>((query.data?.marks ?? []).map((m) => [m.key, m])),
    [query.data],
  );

  return {
    marks,
    /** Set when the feed could not price these — the expiry curve is still exact. */
    warning:
      query.data?.warning ??
      (ids.length > MAX_KEYS
        ? `Too many legs to price (${ids.length}; the limit is ${MAX_KEYS}).`
        : undefined),
    isLoading: query.isLoading,
    error: query.error,
  };
}
