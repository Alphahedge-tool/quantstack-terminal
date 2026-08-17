/**
 * The straddle wall.
 *
 * Lazy-loaded, like `/straddle`: it pulls the canvas charting engine (~180kB)
 * and it is one route among a dozen that mostly render tables.
 *
 * ── `h-full`, not `flex-1` ──
 *
 * `AppShell` renders the outlet inside a plain `<main>`, which is a BLOCK
 * element — so `flex-1` on this wrapper matches nothing and the page has no
 * definite height. Every pane below then falls back to its own intrinsic size,
 * which is what put a scrollbar under the Levels grid. `main` itself is a flex
 * item of an `h-dvh` column, so its height IS definite and `h-full` resolves
 * against it.
 */

import { StraddleWall } from '@/components/straddle/StraddleWall';

export function WallPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* No date picker. The wall is a live comparison of four contracts on the
          CURRENT session — the backend's latest trading date, which is what the
          empty string asks for. Choosing a past day is what the straddle page is
          for, and it can do that one contract at a time with a full chart. */}
      <StraddleWall />
    </div>
  );
}
