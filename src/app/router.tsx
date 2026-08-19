/**
 * Route table.
 *
 * Every page is a child of AppShell, so the shell — and with it the live quote
 * socket — mounts once and survives navigation. A page that owned its own
 * socket would drop the tape on every route change.
 *
 * `/login` is the one exception and sits OUTSIDE the shell. It has to: the shell
 * opens the quote socket and starts polling every book the moment it mounts, and
 * none of that should run for someone who has not chosen an account yet.
 * Everything under `/` is wrapped in RequireSession, which bounces here.
 */

import { createBrowserRouter } from 'react-router-dom';
import { AppShell } from '@/components/layout/AppShell';
import { RequireSession } from '@/components/auth/RequireSession';
import { LoginPage } from '@/pages/LoginPage';
import { DashboardPage } from '@/pages/DashboardPage';
import { PositionsPage } from '@/pages/PositionsPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { TradesPage } from '@/pages/TradesPage';
import { HoldingsPage } from '@/pages/HoldingsPage';
import { FundsPage } from '@/pages/FundsPage';
import { InstrumentsPage } from '@/pages/InstrumentsPage';
import { AnalysisPage } from '@/pages/AnalysisPage';
import { FeedsPage } from '@/pages/FeedsPage';
import { NotFoundPage } from '@/pages/NotFoundPage';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: (
      <RequireSession>
        <AppShell />
      </RequireSession>
    ),
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'positions', element: <PositionsPage /> },
      { path: 'orders', element: <OrdersPage /> },
      { path: 'trades', element: <TradesPage /> },
      { path: 'holdings', element: <HoldingsPage /> },
      { path: 'funds', element: <FundsPage /> },
      { path: 'instruments', element: <InstrumentsPage /> },
      { path: 'analysis', element: <AnalysisPage /> },
      {
        // Lazy for the same reason as /straddle — it pulls the charting engine.
        path: 'wall',
        lazy: async () => ({ Component: (await import('@/pages/WallPage')).WallPage }),
      },
      {
        // Same reason again: the cockpit's tape is a canvas chart.
        path: 'expiry',
        lazy: async () => ({ Component: (await import('@/pages/ExpiryPage')).ExpiryPage }),
      },
      {
        /**
         * The one lazy route.
         *
         * It is the only page that pulls the canvas charting engine — ~180kB
         * that a trader watching the order book never needs. `lazy` rather than
         * `React.lazy`: the data router awaits the module as part of the
         * navigation, so there is no flash of a Suspense fallback where a page
         * used to be.
         */
        path: 'straddle',
        lazy: async () => ({ Component: (await import('@/pages/StraddlePage')).StraddlePage }),
      },
      { path: 'feeds', element: <FeedsPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
