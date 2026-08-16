/**
 * One QueryClient for the app.
 *
 * The defaults here are tuned for a screen that is left open all day on data
 * that goes stale in seconds — which is close to the opposite of the library's
 * defaults, so they are all set explicitly rather than inherited.
 */

import { QueryClient } from '@tanstack/react-query';
import { retryPolicy } from '@/hooks/queries';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: retryPolicy,
      // Books are stale the instant they arrive; the interval, not staleTime,
      // is what governs their cadence. Anything with a real shelf life sets its
      // own staleTime at the hook.
      staleTime: 0,
      // Keep polling a terminal that has lost focus — a trader watching a chart
      // on the other monitor still needs this one's P&L to be current.
      refetchIntervalInBackground: true,
      // Refetch on focus is redundant on top of a poll and doubles the request
      // rate every time the user alt-tabs back.
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
  },
});
