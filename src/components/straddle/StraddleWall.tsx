/**
 * The straddle wall — NIFTY, BANKNIFTY, SENSEX and CRUDEOIL on one screen.
 *
 * Four ATM straddles, each on its own exchange and front expiry, live over the
 * same socket the single-contract chart uses.
 *
 * ── Two modes, because one axis cannot serve both questions ──
 *
 *   COMPARE   all four on one pane as percent change from their own session
 *             baseline. This is the mode the screen exists for: it answers "which
 *             one is bleeding hardest today" at a glance, and it is the only
 *             arrangement in which four contracts spanning 92 to 890 rupees of
 *             premium are all legible at once.
 *
 *   LEVELS    a 2×2 grid, one pane each, in rupees. Answers "how much premium is
 *             this actually carrying", which percent cannot, at the cost of no
 *             longer being a comparison.
 *
 * ── Colour ──
 *
 * One hue per SYMBOL, held across both modes and across the tiles. That is the
 * whole legend: once NIFTY is amber it is amber in the tile, in the line and in
 * the axis label, so no mode needs a key of its own. Up/down green and red are
 * deliberately NOT used for the lines — they already mean direction in the
 * change figures, and a green line for SENSEX beside a red change for SENSEX is
 * two contradictory signals in one tile.
 */

import { useMemo, useState } from 'react';
import { LayoutGrid, Rows3 } from 'lucide-react';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/Field';
import { EmptyState, Spinner } from '@/components/ui/States';
import { WallChart, type WallSeries } from './WallChart';
import { absoluteSeries, percentSeries, useStraddleWall, type WallLeg } from '@/hooks/straddleWall';
import { decimal } from '@/lib/format';
import { cssToken } from '@/lib/chartTheme';
import { cn } from '@/lib/cn';

/**
 * One hue per symbol, in the order of `WALL_SYMBOLS`.
 *
 * Drawn from the series and chart-N tokens rather than invented: these are the
 * project's categorical slots and are already checked for contrast against
 * `--surface-chart`. `--market-up` / `--market-down` are excluded on purpose —
 * see the note on colour above.
 *
 * Stored as TOKEN NAMES, not `var(...)` strings, and resolved to literals below.
 * lightweight-charts paints to a canvas and cannot resolve a CSS variable: a
 * `var()` reaches it as an unparseable string and every line renders BLACK.
 * Fallbacks are the token values from `tokens.css`, used only if this somehow
 * runs before the stylesheet applies.
 */
const HUE_TOKENS = [
  ['--series-iv', '#fdab43'],      // amber
  ['--series-sf', '#38bdf8'],      // blue
  ['--series-vega', '#b78af0'],    // violet
  ['--chart-3', '#9366c9'],        // purple
] as const;

/** Bucket size for the wall, in seconds. */
const STEP = 60;

export function StraddleWall({ date = '' }: { date?: string }) {
  const [mode, setMode] = useState<'compare' | 'levels'>('compare');
  const legs = useStraddleWall(date);

  /*
   * Resolved once, on mount, and used for BOTH the canvas lines and the DOM
   * swatches. A literal works in both places; a `var()` works in only one, and
   * using each form where it fits is how the two drift out of step and the
   * legend stops matching the chart.
   */
  const hues = useMemo(
    () => HUE_TOKENS.map(([name, fallback]) => cssToken(name, fallback)),
    [],
  );

  const ready = legs.filter((leg) => leg.points.length > 0);
  const loading = legs.some((leg) => leg.isLoading);
  const fetching = legs.some((leg) => leg.isFetching);

  /** Percent series for every leg that has both points and a trusted baseline. */
  const compareSeries = useMemo<WallSeries[]>(
    () =>
      legs
        .map((leg, i) => ({
          key: leg.symbol,
          label: leg.symbol,
          colour: hues[i % hues.length],
          data: percentSeries(leg, STEP),
        }))
        .filter((s) => s.data.length > 0),
    [legs, hues],
  );

  return (
    /*
     * `min-h-0 flex-1` is not decoration.
     *
     * `Panel` is `flex min-h-0 flex-col` but carries no flex basis of its own, so
     * inside the page's column it sizes to its CONTENT. That was invisible while
     * the charts asserted their own height; the moment they switched to filling
     * the space, the content area had nothing to fill and collapsed to zero —
     * header and tiles rendered, the chart did not.
     *
     * The chain has to be unbroken from the viewport down: `h-dvh` shell →
     * `h-full` page → `flex-1` panel → `flex-1` content → `h-full` chart.
     */
    <Panel flush className="min-h-0 flex-1">
      <PanelHeader
        icon={mode === 'compare' ? <Rows3 size={14} /> : <LayoutGrid size={14} />}
        title="Straddle wall"
        subtitle={
          mode === 'compare'
            ? 'Percent change from each session’s own open — directly comparable'
            : 'Premium in rupees, one scale per contract'
        }
        actions={
          <div className="flex items-center gap-2">
            {fetching ? <Spinner /> : null}
            <span className="qs-num text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
              <span className="text-[var(--text-primary)]">{ready.length}</span> / {legs.length} loaded
            </span>
            <SegmentedControl
              value={mode}
              options={[
                { value: 'compare', label: 'Compare' },
                { value: 'levels', label: 'Levels' },
              ]}
              onChange={(v) => setMode(v as 'compare' | 'levels')}
            />
          </div>
        }
      />

      <div className="grid gap-2 border-b border-[var(--border-subtle)] px-3 py-2 sm:grid-cols-2 lg:grid-cols-4">
        {legs.map((leg, i) => (
          <LegTile key={leg.symbol} leg={leg} colour={hues[i % hues.length]} />
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && !ready.length ? (
          <div className="space-y-3">
            <div className="qs-skeleton h-72" />
            <p className="text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
              Walking four option chains. Each is a cold session walk the first
              time — 20 seconds or so apiece, then cached.
            </p>
          </div>
        ) : !ready.length ? (
          <EmptyState
            title="No sessions"
            hint="None of the four contracts returned points for this session."
          />
        ) : mode === 'compare' ? (
          /* Same floor as the Levels grid, for the same reason: fill the window,
             but scroll rather than collapse to a sliver on a very short one. */
          <div className="h-full min-h-[18rem]">
            <WallChart
              series={compareSeries}
              unit="%"
              height="100%"
              caption="Straddle premium · % from session open"
            />
          </div>
        ) : (
          /*
           * A 2×2 that FILLS the space rather than asserting a height.
           *
           * Each cell used to be `clamp(17rem, 36vh, 30rem)`, so two rows came to
           * ~72vh before the tile strip, the panel header and the app chrome were
           * counted — the total could not fit and the wall scrolled. A wall you
           * scroll is not a wall.
           *
           * `grid-rows-2` with `h-full` divides whatever is left instead, so the
           * panes shrink to fit any window. `min-h-0` on the container is what
           * lets them: without it a grid row's implicit `auto` minimum keeps each
           * cell at its content height and the overflow comes straight back.
           *
           * The floor is the one case where scrolling is correct — below about
           * 22rem of plot a chart stops being readable, so a very short window
           * gets a scrollbar rather than four unusable slivers.
           */
          <div className="grid h-full min-h-[22rem] grid-rows-2 gap-3 md:grid-cols-2">
            {legs.map((leg, i) => (
              <LevelPane key={leg.symbol} leg={leg} colour={hues[i % hues.length]} />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * One leg in rupees, on its own scale.
 *
 * Sized by the GRID, not by itself — `h-full` plus `min-h-0`. It used to carry
 * its own `clamp()` height, which is what made two rows overflow the window, and
 * which also let the placeholder for a dataless leg be a different height from
 * its neighbours and stagger the row.
 */
function LevelPane({ leg, colour }: { leg: WallLeg; colour: string }) {
  const series = useMemo<WallSeries[]>(() => {
    const data = absoluteSeries(leg, STEP);
    return data.length ? [{ key: leg.symbol, label: leg.symbol, colour, data }] : [];
  }, [leg, colour]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-[var(--radius-md)] border border-[var(--border-subtle)]">
      {series.length ? (
        /* `flex-1 min-h-0` rather than relying on `height: 100%` alone: as a flex
           item, a percentage height resolves against the container but does not
           stop the item from refusing to shrink below its content. The flex pair
           is what actually lets the pane get short, and it is also what keeps the
           border and the plot agreeing on where the cell ends — the disagreement
           that clipped the bottom axis label. */
        <div className="min-h-0 flex-1">
          <WallChart
            series={series}
            unit="abs"
            height="100%"
            caption={`${leg.symbol} · ${leg.exchange} · ${leg.expiry || '—'}`}
          />
        </div>
      ) : (
        <div className="grid flex-1 place-items-center px-3 text-center">
          <div>
            <p className="qs-label text-[var(--text-secondary)]">{leg.symbol}</p>
            <p className="mt-1 text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
              {leg.error
                ? 'The engine could not walk this contract.'
                : leg.isLoading
                  ? 'Walking the option chain…'
                  : `No points for ${leg.exchange} ${leg.expiry || 'front expiry'}.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One symbol's current state.
 *
 * The tiles carry the LEVEL, which is exactly what the compare chart gives up by
 * normalising. Both readings are on screen at once, so switching mode is never
 * needed to answer "and what is it actually trading at".
 */
function LegTile({ leg, colour }: { leg: WallLeg; colour: string }) {
  const price = leg.last?.straddlePrice ?? null;
  const change = price != null && leg.open != null ? price - leg.open : null;
  const pct = change != null && leg.open ? (change / leg.open) * 100 : null;

  const tone =
    change == null || change === 0
      ? 'var(--text-secondary)'
      : change > 0
        ? 'var(--market-up)'
        : 'var(--market-down)';

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2">
      <div className="flex items-center gap-2">
        {/* The swatch IS the legend. No mode needs a key of its own because the
            hue is constant across tile, line and axis label. */}
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: colour }}
          aria-hidden="true"
        />
        <span className="qs-label truncate text-[var(--text-secondary)]">{leg.symbol}</span>
        <span
          className={cn(
            'ml-auto size-1.5 shrink-0 rounded-full',
            leg.live === 'live' && 'animate-pulse',
          )}
          style={{
            backgroundColor:
              leg.live === 'live' ? 'var(--market-up)'
                : leg.live === 'error' ? 'var(--market-down)'
                  : leg.live === 'idle' ? 'var(--text-disabled)'
                    : 'var(--series-iv)',
          }}
          title={`Feed: ${leg.live}`}
        />
      </div>

      <p className="qs-num text-[length:var(--type-h3)] leading-tight text-[var(--text-primary)]">
        {price == null ? '—' : decimal(price)}
      </p>

      <p className="qs-num text-[length:var(--type-micro)]" style={{ color: tone }}>
        {change == null
          ? '—'
          : `${change > 0 ? '+' : ''}${decimal(change)}  ${pct == null ? '' : `(${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`}`}
      </p>

      <p className="truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
        {leg.exchange} · {leg.expiry || '—'}
        {leg.open != null ? ` · open ${decimal(leg.open)}` : ''}
      </p>
    </div>
  );
}
