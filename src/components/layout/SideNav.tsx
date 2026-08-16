/**
 * Primary navigation.
 *
 * Grouped by what the user is doing, not by which backend route serves it:
 * "Trading" is the live book, "Analytics" is derived work, "System" is the
 * plumbing. A flat list of nine items reads as nine equally-important things,
 * which none of them are.
 *
 * Collapses to icons. The collapsed width is a token so the main grid can
 * reserve exactly the right column without duplicating the number.
 */

import { NavLink } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Briefcase,
  ChevronLeft,
  LayoutDashboard,
  Layers,
  Radio,
  Receipt,
  ScrollText,
  Scale,
  Search,
  Wallet,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUiStore } from '@/stores/uiStore';

interface NavItem {
  to: string;
  label: string;
  icon: typeof Activity;
}

const GROUPS: Array<{ heading: string; items: NavItem[] }> = [
  {
    heading: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }],
  },
  {
    heading: 'Trading',
    items: [
      { to: '/positions', label: 'Positions', icon: Layers },
      { to: '/orders', label: 'Orders', icon: ScrollText },
      { to: '/trades', label: 'Trades', icon: Receipt },
      { to: '/holdings', label: 'Holdings', icon: Briefcase },
      { to: '/funds', label: 'Funds', icon: Wallet },
    ],
  },
  {
    heading: 'Analytics',
    items: [
      { to: '/straddle', label: 'Straddle', icon: BarChart3 },
      { to: '/analysis', label: 'Analysis Sheets', icon: Scale },
      { to: '/instruments', label: 'Instruments', icon: Search },
    ],
  },
  {
    heading: 'System',
    items: [{ to: '/feeds', label: 'Feeds', icon: Radio }],
  },
];

export function SideNav() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggle = useUiStore((s) => s.toggleSidebar);

  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col border-r border-[var(--chrome-border-subtle)]',
        'bg-[var(--chrome-panel)] transition-[width] duration-200',
      )}
      style={{
        width: collapsed ? 'var(--sidebar-collapsed)' : 'var(--sidebar-width)',
      }}
    >
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {GROUPS.map((group) => (
          <div key={group.heading} className="mb-4 px-2 last:mb-0">
            {/* The heading is replaced by a rule when collapsed rather than
                hidden outright — the grouping is still information. */}
            {collapsed ? (
              <div className="mx-2 mb-2 h-px bg-[var(--chrome-border-subtle)]" />
            ) : (
              <p className="qs-label mb-1.5 px-2 text-[var(--text-disabled)]">{group.heading}</p>
            )}

            <ul className="space-y-0.5">
              {group.items.map(({ to, label, icon: Icon }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    // `end` only on the index route: without it, "/" matches
                    // every path and the dashboard stays highlighted forever.
                    end={to === '/'}
                    title={collapsed ? label : undefined}
                    className={({ isActive }) =>
                      cn(
                        'group relative flex items-center gap-2.5 rounded-[var(--radius-sm)]',
                        'px-2.5 py-2 text-[length:var(--type-control)] font-medium',
                        'transition-colors duration-100',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'bg-[var(--accent-info-soft)] text-[var(--accent-info)]'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--chrome-hover)] hover:text-[var(--text-primary)]',
                      )
                    }
                  >
                    {({ isActive }) => (
                      <>
                        {/* Active marker on the rail edge. Gives the state a
                            second cue besides colour, which matters for anyone
                            who reads the teal and the grey as similar. */}
                        {isActive ? (
                          <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-r-full bg-[var(--accent-info)]" />
                        ) : null}
                        <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                        {collapsed ? null : <span className="truncate">{label}</span>}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <button
        onClick={toggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'flex h-9 shrink-0 items-center gap-2 border-t border-[var(--chrome-border-subtle)]',
          'px-4 text-[length:var(--type-micro)] text-[var(--text-tertiary)]',
          'transition-colors hover:bg-[var(--chrome-hover)] hover:text-[var(--text-primary)]',
          collapsed && 'justify-center px-0',
        )}
      >
        <ChevronLeft
          size={14}
          className={cn('transition-transform duration-200', collapsed && 'rotate-180')}
        />
        {collapsed ? null : <span>Collapse</span>}
      </button>
    </nav>
  );
}
