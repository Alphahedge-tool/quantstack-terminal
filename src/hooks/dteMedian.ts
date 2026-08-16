/**
 * The previous N sessions that carried the same DTE, and their median.
 *
 * ── Finding the cohort ──
 *
 * "The last five 4-DTE sessions" is not a date arithmetic problem, because the
 * expiry calendar shifts. For a weekly contract the same DTE recurs every seven
 * days, so `date − 7k` is the right FIRST GUESS — but an exchange holiday moves
 * an expiry and the guess misses. So each candidate is verified against
 * `/api/straddle/expiries` as of that date, which returns the contracts that
 * were actually listed then, and a miss falls back to scanning the days around
 * it. Verified against the live backend: past-dated lookups resolve correctly.
 *
 * ── Cost ──
 *
 * One cheap expiries lookup per candidate (typically five in total), then one
 * session walk per match. The walks are the expensive part — measured at ~1.3s
 * cold, ~0.2s warm — so they run in parallel through `useQueries`, each under
 * the SAME cache key the main chart uses. A cohort session already on screen
 * elsewhere costs nothing to include.
 */

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { keys, retryPolicy } from '@/hooks/queries';
import { straddleExpiriesResponse, straddleHistoryResponse } from '@/schemas/market';
import {
  addDays,
  dteBetween,
  isWeekend,
  medianProfile,
  rebaseSession,
  type MedianProfile,
  type RebasedSession,
} from '@/lib/straddle/dteMedian';

/**
 * How many calendar days back to walk before giving up on finding N matches.
 *
 * At weekly cadence five matches sit inside 35 days; 140 leaves room for a
 * holiday-broken stretch without ever becoming an unbounded search.
 */
const MAX_LOOKBACK_DAYS = 140;

export interface CohortSession {
  date: string;
  expiry: string;
}

/**
 * Resolve the previous `count` sessions at the same DTE as `date`/`expiry`.
 *
 * ── Exhaustive, day by day ──
 *
 * An earlier version stepped back in 7-day jumps, on the reasoning that a
 * weekly expiry puts the same DTE on the same weekday every week. That is true
 * in a clean cycle and WRONG the moment a holiday moves an expiry: the matching
 * session that week lands on a different weekday, the jump-and-probe misses it,
 * and the cohort silently reaches an extra week further back. The result still
 * looks like five sessions at the right DTE — it is just not the five MOST
 * RECENT ones, which is the whole basis for calling it typical of now.
 *
 * So every trading day is checked in order and the first `count` matches win.
 * That is roughly 25 lookups for five weekly matches instead of five. They are
 * cheap (a cached expiry list), they run once per contract, and the answer is
 * correct rather than usually-correct.
 */
async function resolveCohort(
  symbol: string,
  exchange: string,
  expiry: string,
  date: string,
  count: number,
  signal: AbortSignal | undefined,
): Promise<{ targetDte: number; sessions: CohortSession[]; scanned: number }> {
  const targetDte = dteBetween(date, expiry);
  const sessions: CohortSession[] = [];
  let scanned = 0;
  if (targetDte < 0) return { targetDte, sessions, scanned };

  for (let back = 1; back <= MAX_LOOKBACK_DAYS && sessions.length < count; back += 1) {
    const candidate = addDays(date, -back);
    if (isWeekend(candidate)) continue;
    scanned += 1;

    let listed: string[];
    try {
      const response = await api.get('/api/straddle/expiries', straddleExpiriesResponse, {
        query: { symbol, exchange, date: candidate },
        signal,
      });
      listed = response.expiries;
    } catch {
      // A date the feed cannot answer for is not a failure of the cohort — it
      // is one candidate that did not work out. Keep walking.
      continue;
    }

    const hit = listed.find((e) => dteBetween(candidate, e) === targetDte);
    if (hit) sessions.push({ date: candidate, expiry: hit });
  }

  return { targetDte, sessions, scanned };
}

export interface DteMedianResult {
  /** DTE of the contract being compared against. */
  targetDte: number;
  /** Sessions the search found — may be fewer than asked for. */
  cohort: CohortSession[];
  /** Sessions that actually returned usable points, rebased. */
  sessions: RebasedSession[];
  profile: MedianProfile;
  /** Found but returned nothing the engine could walk. */
  emptySessions: string[];
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

/**
 * Median session profile at this contract's DTE.
 *
 * `count` defaults to five. That is few enough to stay inside the current
 * volatility regime — five weekly cycles is roughly five weeks — and enough
 * that a median is a middle value rather than a coin flip between two.
 */
export function useDteMedian(
  symbol: string,
  exchange: string,
  expiry: string,
  date: string,
  count = 5,
  enabled = true,
): DteMedianResult {
  const ready = enabled && Boolean(symbol && expiry && date);

  const cohortQuery = useQuery({
    queryKey: ['straddle', 'dte-cohort', symbol, exchange, expiry, date, count],
    queryFn: ({ signal }) => resolveCohort(symbol, exchange, expiry, date, count, signal),
    enabled: ready,
    // The expiry calendar for past dates is immutable. Re-walking it costs a
    // dozen round trips to learn nothing.
    staleTime: 60 * 60_000,
    retry: retryPolicy,
  });

  const cohort = cohortQuery.data?.sessions ?? [];

  /*
   * One query per cohort session, under the main chart's own key.
   *
   * Sharing `keys.straddleHistory` is deliberate: the cohort frequently
   * includes a session the user has already opened in another slot, and a
   * second key would recompute a walk that is sitting in the cache.
   */
  const histories = useQueries({
    queries: cohort.map((session) => ({
      queryKey: keys.straddleHistory(symbol, exchange, session.expiry, session.date),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.post(
          '/api/straddle/history',
          straddleHistoryResponse,
          { symbol, exchange, expiry: session.expiry, date: session.date },
          { signal },
        ),
      // A completed session is finished history and never changes.
      staleTime: 24 * 60 * 60_000,
      retry: retryPolicy,
    })),
  });

  const { sessions, emptySessions } = useMemo(() => {
    const rebased: RebasedSession[] = [];
    const empty: string[] = [];

    histories.forEach((query, index) => {
      const session = cohort[index];
      if (!session || !query.data) return;
      const one = rebaseSession(session.date, session.expiry, query.data.points);
      // A candidate date that was not really a trading day resolves an expiry
      // but walks to nothing. Named rather than silently dropped — a cohort of
      // three presented as five would overstate the median's support.
      if (one) rebased.push(one);
      else empty.push(session.date);
    });

    return { sessions: rebased, emptySessions: empty };
  }, [histories, cohort]);

  const profile = useMemo(() => medianProfile(sessions), [sessions]);

  return {
    targetDte: cohortQuery.data?.targetDte ?? -1,
    cohort,
    sessions,
    profile,
    emptySessions,
    isLoading: ready && (cohortQuery.isLoading || histories.some((q) => q.isLoading)),
    isFetching: cohortQuery.isFetching || histories.some((q) => q.isFetching),
    error: cohortQuery.error ?? histories.find((q) => q.error)?.error ?? null,
  };
}
