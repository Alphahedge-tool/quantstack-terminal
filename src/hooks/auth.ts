/**
 * Server state for the sign-in surface.
 *
 * Separate from `hooks/queries.ts` — which declares the reads the app performs
 * continuously — because these are different in kind. `useSavedAccounts`
 * fetches CREDENTIALS, on demand, for one broker, and it must not become part
 * of a poll set that runs all day on every screen: the page should never hold
 * secrets for accounts nobody asked about.
 *
 * The connect and Zerodha calls are mutations, which `queries.ts` has none of.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiFailure } from '@/lib/api';
import { keys, retryPolicy, useFeeds } from '@/hooks/queries';
import { feedIdFor, type BrokerId } from '@/lib/brokers';
import {
  feedLoginResponse,
  savedAccountsResponse,
  zerodhaCallbackResponse,
  zerodhaLoginUrlResponse,
  type SavedAccount,
} from '@/schemas/auth';

export const authKeys = {
  savedAccounts: (broker: string) => ['auth', 'saved-accounts', broker] as const,
};

/* ── Stored credentials ───────────────────────────────────────────────────── */

/**
 * Saved accounts for one broker, best-default first (the backend sorts them).
 *
 * `null` fetches nothing: the request fires only once a broker is chosen, which
 * is what keeps unrelated secrets out of the page.
 *
 * `gcTime` is short on purpose. The default 5 minutes would leave MPINs and
 * base32 TOTP secrets sitting in the query cache long after the form closed,
 * for no benefit — refetching them takes one round trip to localhost.
 */
export function useSavedAccounts(broker: BrokerId | null) {
  return useQuery({
    queryKey: authKeys.savedAccounts(broker ?? ''),
    queryFn: ({ signal }) =>
      api.get('/api/brokers/accounts', savedAccountsResponse, {
        query: { broker: broker ?? '' },
        signal,
      }),
    enabled: Boolean(broker),
    // Credentials do not change while a form is open, and re-fetching them
    // would overwrite whatever is being typed into the pre-filled fields.
    staleTime: 5 * 60_000,
    gcTime: 30_000,
    retry: retryPolicy,
  });
}

export type { SavedAccount };

/* ── Feed state, per broker ───────────────────────────────────────────────── */

export interface FeedState {
  /** Registered in QT_FEEDS. False means it cannot be connected at all. */
  configured: boolean;
  connected: boolean;
  /** A login is in flight on the backend — not a failure, and not idle. */
  loggingIn: boolean;
  lastError: string | null;
  connectedAt: number | null;
  /** Epoch ms before which the backend will refuse another login attempt. */
  retryAfter: number | null;
  /** OPEN means the router has taken this feed out of rotation. */
  breakerOpen: boolean;
}

const UNCONFIGURED: FeedState = {
  configured: false,
  connected: false,
  loggingIn: false,
  lastError: null,
  connectedAt: null,
  retryAfter: null,
  breakerOpen: false,
};

/**
 * What the BACKEND thinks is connected.
 *
 * Connection state belongs to the backend, not to this tab. It auto-logs-in
 * every feed in `QT_FEEDS` at boot, so a broker is usually already live —
 * serving the books and the charts — before this screen has been touched.
 * Rendering a local "not connected" over that shows an error on a session the
 * terminal is happily trading through.
 */
export function useFeedStates() {
  const feeds = useFeeds(5_000);

  const stateOf = (broker: BrokerId): FeedState => {
    const id = feedIdFor(broker);
    const rows = feeds.data?.feeds ?? [];
    // Match the family too, so `angel#2` answers for `angel` when only one
    // instance is configured.
    const row = rows.find((f) => f.id === id) ?? rows.find((f) => f.broker === id);
    if (!row) return UNCONFIGURED;
    return {
      configured: true,
      connected: Boolean(row.connected),
      loggingIn: Boolean(row.auth?.loggingIn),
      lastError: row.auth?.lastError ?? null,
      connectedAt: row.auth?.connectedAt ?? null,
      retryAfter: row.auth?.retryAfter ?? null,
      breakerOpen: row.breaker?.state === 'OPEN',
    };
  };

  return { stateOf, loaded: feeds.isSuccess, error: feeds.error, refetch: feeds.refetch };
}

/* ── Connect ──────────────────────────────────────────────────────────────── */

/** The message a caller can put on screen, from whatever the request threw. */
function reasonFor(error: unknown): string {
  if (error instanceof ApiFailure) return error.message;
  if (error instanceof Error) return error.message;
  return 'The connect request failed.';
}

/**
 * Sign one feed in through the backend.
 *
 * Every broker goes through `POST /api/feeds/login`, which logs in whichever
 * feed is registered in `QT_FEEDS` using the credentials in Supabase — the
 * browser never sends credentials anywhere itself.
 *
 * Resolves rather than throws on a refusal. A failed sign-in is an ordinary
 * outcome of this screen, and the caller wants the reason next to the account
 * card, not an unhandled rejection.
 */
export function useConnectFeed() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: boolean; message: string }, never, BrokerId>({
    mutationFn: async (broker) => {
      try {
        const out = await api.post('/api/feeds/login', feedLoginResponse, {
          id: feedIdFor(broker),
        });
        // `status: true` only means the request was understood. The session is
        // what we asked for, and the route reports it separately.
        if (out.status && out.connected !== false) return { ok: true, message: '' };
        return {
          ok: false,
          message: 'The backend accepted the request but no session was established.',
        };
      } catch (error) {
        return { ok: false, message: reasonFor(error) };
      }
    },
    onSettled: () => {
      // The feed row is the authority on what happened; refresh it either way.
      void queryClient.invalidateQueries({ queryKey: keys.feeds });
      void queryClient.invalidateQueries({ queryKey: keys.brokers });
    },
  });
}

/* ── Zerodha's browser login ──────────────────────────────────────────────── */

/**
 * Kite Connect has no login endpoint. The backend drives Kite's own web login
 * headlessly for the daily case, but two situations need a real browser:
 *
 *   • the FIRST connection of an account to an API app, where Kite parks on an
 *     "Authorize" screen that only a human click clears;
 *   • an account with no TOTP secret stored, where headless cannot run at all.
 *
 * Both end with Kite redirecting to a `request_token`, which the backend
 * exchanges for an access token valid until ~6 AM next morning.
 */
export async function fetchZerodhaLoginUrl(): Promise<{ url: string; error?: string }> {
  try {
    const out = await api.get('/api/brokers/zerodha/login-url', zerodhaLoginUrlResponse);
    return { url: out.loginUrl };
  } catch (error) {
    return { url: '', error: reasonFor(error) };
  }
}

/**
 * Hand a `request_token` back for exchange.
 *
 * Kite honours the token once and for a few minutes, so this is
 * fire-and-report: there is no retry that could work with the same value. The
 * caller keeps its paste box open on failure, because the fix is to run the
 * login again and paste a fresh token.
 */
export function useZerodhaToken() {
  const queryClient = useQueryClient();

  return useMutation<{ ok: boolean; message: string }, never, string>({
    mutationFn: async (requestToken) => {
      try {
        const out = await api.post('/api/brokers/zerodha/callback', zerodhaCallbackResponse, {
          request_token: requestToken.trim(),
        });
        return { ok: true, message: out.message || 'Zerodha connected.' };
      } catch (error) {
        return { ok: false, message: reasonFor(error) };
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.feeds });
    },
  });
}

/**
 * Pull a request token out of whatever was pasted.
 *
 * People paste the whole redirected URL as often as the bare token — it is
 * right there in the address bar — and silently failing on that is a pointless
 * dead end.
 */
export function extractRequestToken(pasted: string): string {
  const text = pasted.trim();
  if (!text) return '';
  const match = /[?&]request_token=([^&\s]+)/.exec(text);
  return match ? decodeURIComponent(match[1]) : text;
}
