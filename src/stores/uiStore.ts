/**
 * Shell UI state — the things that must survive a route change but are not
 * server data. Anything the backend owns belongs in TanStack Query instead;
 * mirroring it here is how two sources of truth start disagreeing.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Density = 'comfortable' | 'compact';

interface UiState {
  sidebarCollapsed: boolean;
  /** Row height for every data table. Traders working a wide book want compact;
   *  it is a preference, so it persists. */
  density: Density;
  /** Poll interval for the book queries, in ms. Exposed because the right value
   *  depends on the market: 2s during expiry, 30s on a quiet afternoon. */
  refreshMs: number;
  /** `broker=` filter applied to every book route. Empty means all accounts. */
  brokerFilter: string;

  toggleSidebar: () => void;
  setDensity: (density: Density) => void;
  setRefreshMs: (ms: number) => void;
  setBrokerFilter: (broker: string) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      density: 'comfortable',
      refreshMs: 5000,
      brokerFilter: '',

      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setDensity: (density) => set({ density }),
      setRefreshMs: (refreshMs) => set({ refreshMs }),
      setBrokerFilter: (brokerFilter) => set({ brokerFilter }),
    }),
    {
      name: 'quantstack.ui',
      // brokerFilter is deliberately NOT persisted. Coming back tomorrow to a
      // book silently filtered to one account is how a position gets missed.
      partialize: (s) => ({
        sidebarCollapsed: s.sidebarCollapsed,
        density: s.density,
        refreshMs: s.refreshMs,
      }),
    },
  ),
);
