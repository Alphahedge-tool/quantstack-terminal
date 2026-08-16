/**
 * The gate in front of the terminal.
 *
 * ── What this is honestly doing ──
 *
 * This is NOT a security boundary. The backend has no user authentication in
 * front of it; anyone who can reach port 3101 can call every route directly.
 * What this enforces is that a person has chosen WHICH account they are working
 * in before the terminal paints — which matters because every book route is
 * filtered by broker and a page rendered with no account selected shows numbers
 * without saying whose they are.
 *
 * It also keeps the shell's cost off the sign-in screen: AppShell opens the live
 * quote socket and starts polling the books on mount, and doing that behind a
 * login page is work for a session that may not exist.
 *
 * The redirect carries the path it bounced, so signing in lands where the user
 * was actually going rather than dumping everyone on the dashboard.
 */

import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';

export function RequireSession({ children }: { children: ReactNode }) {
  const location = useLocation();
  const accounts = useAuthStore((s) => s.accounts);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);

  // Checked against the list, not just for a non-null id: an account removed in
  // another tab leaves a persisted id pointing at nothing, and trusting it would
  // admit a session whose account no longer exists.
  const signedIn = accounts.some((account) => account.id === activeAccountId);

  if (!signedIn) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  return <>{children}</>;
}
