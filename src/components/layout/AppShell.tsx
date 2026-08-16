/**
 * The frame every page renders inside.
 *
 * Fixed viewport height with a single scroll region in the middle. A terminal
 * that lets the document scroll ends up with the top bar sliding away exactly
 * when the user is scanning a long book — the one moment the health indicators
 * need to stay visible.
 */

import { Outlet } from 'react-router-dom';
import { SideNav } from './SideNav';
import { StatusBar } from './StatusBar';
import { TopBar } from './TopBar';
import { useLiveQuoteChannel } from '@/hooks/useLiveQuotes';

export function AppShell() {
  // Mounted once, here. The socket outlives every page below it.
  useLiveQuoteChannel();

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--surface-canvas)]">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <SideNav />

        {/* The ground. Panels sit ON this, darker than it, separated by the
            container gap — that gap is what lets the ground show through and
            makes the cards read as objects. */}
        <main
          className="min-w-0 flex-1 overflow-auto bg-[var(--surface-blue)]"
          style={{ padding: 'var(--container-gap)' }}
        >
          <Outlet />
        </main>
      </div>

      <StatusBar />
    </div>
  );
}

/**
 * Page header, used by every route for its title row. Kept here rather than in
 * each page so the vertical rhythm between the header and the first panel is
 * identical everywhere.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-[var(--container-gap)] flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[length:var(--type-title)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 text-[length:var(--type-caption)] text-[var(--text-secondary)]">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}
