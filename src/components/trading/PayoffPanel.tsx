/**
 * Payoff, greeks and risk for whatever is in the position book.
 *
 * ── One scenario, applied everywhere ──
 *
 * Three controls move one coherent state: spot, an IV shift, and days elapsed.
 * They feed the chart, the greeks and the metrics TOGETHER, so the panel can
 * never show a curve from one scenario beside greeks from another. That split is
 * easy to arrive at by accident when each widget reads the controls itself.
 *
 * ── It does not fetch positions ──
 *
 * They are passed in from the page, which already has them. Re-querying would
 * work (React Query dedupes by key) but the page also owns the live-quote
 * subscription these legs are marked from, and having one component own both
 * keeps the "who subscribes" answer to a single place — see `spotKeys`.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { PayoffChart } from './PayoffChart';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/States';
import { useOptionMarks } from '@/hooks/options';
import {
  daysToNearestExpiry,
  groupByUnderlying,
  inferSpot,
  solveMissingIv,
  spotSymbol,
  toInstrumentKey,
  toLegs,
} from '@/lib/options/fromPositions';
import { computePayoff, positionGreeks, totalPnl, type Scenario } from '@/lib/options/payoff';
import { cn } from '@/lib/cn';
import { decimal, signedCurrency } from '@/lib/format';
import { useQuoteStore } from '@/stores/quoteStore';
import type { InstrumentKey } from '@/lib/symbol';
import type { Position } from '@/schemas/trading';

/** Stable empty list — a fresh `[]` would re-run every memo below on each tick. */
const NO_POSITIONS: Position[] = [];

/** Infinity is a real answer for an uncapped strategy, and must read as one. */
function bound(value: number): string {
  return Math.abs(value) === Infinity ? 'Unlimited' : signedCurrency(value);
}

function toneOf(value: number): string {
  if (value > 0) return 'text-[var(--market-up)]';
  if (value < 0) return 'text-[var(--market-down)]';
  return 'text-[var(--text-primary)]';
}

export function PayoffPanel({ positions }: { positions: Position[] }) {
  // One payoff per underlying — a price axis cannot serve NIFTY and SENSEX at
  // once. See `groupByUnderlying` for what merging them actually produced.
  const groups = useMemo(() => groupByUnderlying(positions), [positions]);
  const [asset, setAsset] = useState<string | null>(null);
  const active = groups.find((g) => g.asset === asset) ?? groups[0];
  const scoped = active?.positions ?? NO_POSITIONS;

  const keys = useMemo<InstrumentKey[]>(
    () =>
      scoped
        .map((p) => p.contract.key)
        .filter((k): k is NonNullable<typeof k> => k != null)
        .map(toInstrumentKey),
    [scoped],
  );

  const { marks, warning } = useOptionMarks(keys);
  const feedLegs = useMemo(() => toLegs(scoped, marks), [scoped, marks]);

  /*
   * The underlying, live.
   *
   * Read from the quote store rather than subscribed here: the page owns the
   * single server-side subscription set and already includes the spot keys.
   * Without a live spot the whole curve anchors to `inferSpot`'s fallback — the
   * mean of the strikes held — which for an options-only book never changes, so
   * the chart looks alive while the one number saying WHERE YOU ARE sits still.
   */
  const liveSpot = useQuoteStore((s) =>
    active ? (s.quotes[spotSymbol(active.asset)]?.ltp ?? 0) : 0,
  );

  const baseSpot = useMemo(
    () => inferSpot(scoped, feedLegs, liveSpot),
    [scoped, feedLegs, liveSpot],
  );

  // Feed IV first; solve from the broker's own mark only for what it missed.
  const { legs, solved } = useMemo(
    () => solveMissingIv(feedLegs, scoped, baseSpot),
    [feedLegs, scoped, baseSpot],
  );

  // Offsets, not absolutes — a moving market keeps the shift the user dialled in
  // rather than snapping the control back on every poll.
  const [spotShiftPct, setSpotShiftPct] = useState(0);
  const [ivShiftPts, setIvShiftPts] = useState(0);
  const [daysElapsed, setDaysElapsed] = useState(0);

  const spot = baseSpot * (1 + spotShiftPct / 100);
  const dirty = spotShiftPct !== 0 || ivShiftPts !== 0 || daysElapsed !== 0;

  const scenario: Scenario = useMemo(
    () => ({ spot, ivShiftPts, daysElapsed, now: Date.now() }),
    [spot, ivShiftPts, daysElapsed],
  );

  const atmIv = useMemo(() => {
    const ivs = legs.map((l) => l.iv).filter((v): v is number => v != null && v > 0);
    return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0;
  }, [legs]);

  /*
   * The spot that defines the PLOTTED RANGE, quantised.
   *
   * `priceRange` derives the x-axis from spot, so feeding it a live tick makes
   * the axis crawl continuously and resamples the whole curve several times a
   * second — the plot shimmers and every label drifts while conveying nothing.
   * Rounding to ~0.2% keeps the curve still until the market has actually moved.
   *
   * Only the RANGE uses this. Each sample is valued at its own underlying, so
   * the curve's shape is unaffected, and the marker and greeks use the exact
   * live price.
   */
  const curveSpot = useMemo(() => {
    if (!(spot > 0)) return spot;
    const step = Math.max(1, Math.round(spot * 0.002));
    return Math.round(spot / step) * step;
  }, [spot]);

  const curveScenario: Scenario = useMemo(
    () => ({ ...scenario, spot: curveSpot }),
    [scenario, curveSpot],
  );

  const realised = active?.realised ?? 0;

  const payoff = useMemo(
    () => computePayoff(legs, curveScenario, { atmIv, realised }),
    [legs, curveScenario, atmIv, realised],
  );

  // Greeks read the EXACT spot: delta and gamma at a rounded price are a
  // different position's greeks, and these are the numbers used to hedge.
  const greeks = useMemo(() => positionGreeks(legs, scenario), [legs, scenario]);

  const horizonLabel = daysElapsed === 0 ? 'Now' : `T+${daysElapsed}d`;

  /*
   * P&L at the current spot, on the scenario horizon.
   *
   * Deliberately NOT read off the plotted curve. The samples are a grid roughly
   * 100 points apart, and once the range spot is quantised for a stable axis no
   * sample sits exactly at the live price — picking the nearest is then wrong by
   * up to half a grid step, which at a delta of 16 per point is several hundred
   * rupees showing as a payoff figure that disagrees with the book for no
   * visible reason.
   *
   * With the scenario untouched the honest answer is the BOOK's own number:
   * positions are already marked to live ticks, so this matches the total beside
   * it exactly. Once a control moves the book cannot answer any more — the
   * question is hypothetical — so the strategy is valued at the dialled-in
   * scenario, at `spot` rather than at the nearest grid point.
   */
  const currentPnl = useMemo(() => {
    if (!dirty) return scoped.reduce((sum, p) => sum + p.pnl, 0) + realised;
    const modelled = totalPnl(legs, spot, scenario, false) + realised;
    return Number.isFinite(modelled)
      ? modelled
      : totalPnl(legs, spot, scenario, true) + realised;
  }, [dirty, scoped, realised, legs, spot, scenario]);

  const maxDays = Math.max(1, Math.ceil(daysToNearestExpiry(legs) ?? 30));

  if (legs.length === 0) {
    return (
      <EmptyState
        title="No open derivative positions"
        hint="Option and future positions appear here as a combined payoff, with aggregate greeks and the risk on the strategy as a whole."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 p-3">
      {groups.length > 1 ? (
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Underlying">
          {groups.map((group) => (
            <button
              key={group.asset}
              type="button"
              role="tab"
              aria-selected={group.asset === active?.asset}
              onClick={() => setAsset(group.asset)}
              className={cn(
                'rounded-[var(--radius-xs)] px-2 py-1 text-[length:var(--type-micro)] font-semibold',
                group.asset === active?.asset
                  ? 'bg-[var(--accent-info-soft)] text-[var(--accent-info)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
              )}
            >
              {group.asset}
              <span className="ml-1 opacity-60">{group.positions.length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {/* IV is what makes every forward-looking number here possible, so its
          absence is stated at the top rather than left to be inferred from a
          missing curve. */}
      {warning || !payoff.ivComplete ? (
        <Notice tone="warning">
          {warning ??
            `No implied vol for ${greeks.missing.length || 'some'} leg(s)` +
              `${greeks.missing.length ? `: ${greeks.missing.join(', ')}` : ''}.` +
              ' The expiry payoff is exact; greeks and the T+n curve are unavailable.'}
        </Notice>
      ) : null}

      {solved.length > 0 && greeks.complete ? (
        <Notice tone="info">
          IV solved from the last traded price for {solved.length} leg(s) ({solved.join(', ')}) —
          the feed carries no vol for these. A stale print gives a stale vol.
        </Notice>
      ) : null}

      <div className="grid grid-cols-3 gap-3">
        <Slider
          label="Underlying"
          value={`${decimal(spot, 0)}${spotShiftPct !== 0 ? ` (${spotShiftPct > 0 ? '+' : ''}${spotShiftPct}%)` : ''}`}
          min={-10}
          max={10}
          step={0.25}
          current={spotShiftPct}
          onChange={setSpotShiftPct}
        />
        <Slider
          label="IV shift"
          value={`${ivShiftPts > 0 ? '+' : ''}${ivShiftPts} pts`}
          min={-15}
          max={15}
          step={0.5}
          current={ivShiftPts}
          onChange={setIvShiftPts}
        />
        <Slider
          label="Days"
          value={horizonLabel}
          min={0}
          max={maxDays}
          step={1}
          current={daysElapsed}
          onChange={setDaysElapsed}
        />
      </div>

      <PayoffChart
        payoff={payoff}
        legs={legs}
        spot={spot}
        horizonLabel={horizonLabel}
        height={240}
      />

      {/*
        Risk and greeks in ONE grid, not two stacked strips — each strip costs a
        label row, a value row and its padding, and in a half-width container
        that height comes straight out of the plot.

        Greek units are the ones a trader reads, not the raw derivatives: vega
        per vol POINT (the model gives per 1.00 of vol) and theta per DAY (the
        model gives per year). See black76.ts.
      */}
      <div className="grid grid-cols-3 gap-x-3 gap-y-2 border-t border-[var(--container-rule)] pt-3 sm:grid-cols-5">
        <Metric label={`P&L ${horizonLabel}`} value={signedCurrency(currentPnl)} tone={toneOf(currentPnl)} />
        <Metric
          label="Max profit"
          value={bound(payoff.maxProfit)}
          tone={payoff.maxProfit === Infinity ? 'text-[var(--market-up)]' : toneOf(payoff.maxProfit)}
        />
        <Metric
          label="Max loss"
          value={bound(payoff.maxLoss)}
          tone={payoff.maxLoss === -Infinity ? 'text-[var(--market-down)]' : toneOf(payoff.maxLoss)}
        />
        <Metric
          label="Breakeven"
          value={payoff.breakevens.length ? payoff.breakevens.map((b) => decimal(b, 0)).join('  ') : '—'}
          tone="text-[var(--text-secondary)]"
        />
        <Metric
          label={`Net ${payoff.netPremium >= 0 ? 'credit' : 'debit'}`}
          value={signedCurrency(payoff.netPremium)}
          tone={toneOf(payoff.netPremium)}
        />

        {[
          { name: 'Delta', value: greeks.delta, digits: 2 },
          { name: 'Gamma', value: greeks.gamma, digits: 4 },
          { name: 'Vega/pt', value: greeks.vega / 100, digits: 0 },
          { name: 'Theta/day', value: greeks.theta / 365, digits: 0 },
        ].map((greek) => (
          <Metric
            key={greek.name}
            label={greek.name}
            value={
              greeks.complete
                ? `${greek.value > 0 ? '+' : ''}${greek.value.toFixed(greek.digits)}`
                : '—'
            }
            tone={greeks.complete ? toneOf(greek.value) : 'text-[var(--text-disabled)]'}
          />
        ))}

        {dirty ? (
          <div className="col-span-full">
            <Button
              icon={<RotateCcw size={12} />}
              onClick={() => {
                setSpotShiftPct(0);
                setIvShiftPts(0);
                setDaysElapsed(0);
              }}
            >
              Reset scenario
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="min-w-0">
      <span className="flex items-baseline justify-between gap-1">
        <span className="qs-label truncate">{label}</span>
        <span className="qs-num shrink-0 text-[length:var(--type-micro)] text-[var(--text-primary)]">
          {value}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(event) => onChange(Number(event.target.value))}
        className="mt-1 h-1 w-full cursor-pointer appearance-none rounded-full bg-[var(--control-border)] accent-[var(--accent-info)]"
      />
    </label>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="min-w-0">
      <div className="qs-label truncate">{label}</div>
      <div className={cn('qs-num truncate text-[length:var(--type-caption)] font-semibold', tone)}>
        {value}
      </div>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'info'; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-[var(--radius-sm)] px-2.5 py-1.5',
        'text-[length:var(--type-micro)] leading-snug text-[var(--text-secondary)]',
        tone === 'warning' ? 'bg-[var(--status-warning-soft)]' : 'bg-[var(--accent-info-soft)]',
      )}
    >
      <AlertTriangle
        size={12}
        className={cn(
          'mt-0.5 shrink-0',
          tone === 'warning' ? 'text-[var(--status-warning)]' : 'text-[var(--accent-info)]',
        )}
      />
      <span className="min-w-0">{children}</span>
    </div>
  );
}
