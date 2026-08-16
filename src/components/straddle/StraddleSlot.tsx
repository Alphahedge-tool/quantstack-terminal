/**
 * One chart slot in the layout grid.
 *
 * ── Why the slot owns its contract AND its chart kind ──
 *
 * The reason to want more than one chart is to compare things a single chart
 * cannot express — the front expiry against the next, or the premium against
 * the skew that is driving it. So both axes of that comparison live here, in
 * the slot, exactly as the contract selector does in a TradingView pane.
 *
 * The session DATE stays on the page. The page is answering "what happened on
 * this day"; letting each slot wander to its own day would put unrelated
 * sessions side by side under one heading and quietly invite a comparison that
 * means nothing.
 */

import { Panel, PanelHeader } from '@/components/ui/Panel';
import { Select, SegmentedControl } from '@/components/ui/Field';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { useMemo, useState } from 'react';
import { StraddleChart } from '@/components/chart/StraddleChart';
import { GreeksChart } from '@/components/chart/GreeksChart';
import { SkewChart } from '@/components/chart/SkewChart';
import { X } from 'lucide-react';
import { UNDERLYINGS, useStraddleContract } from './useStraddleContract';
import { useBandGreeks, useRiskReversal } from '@/hooks/queries';
import { useDteMedian } from '@/hooks/dteMedian';
import {
  medianProfile, openAnchor, projectToPoints, unitScales, type CompareUnits,
} from '@/lib/straddle/dteMedian';
import { DteMedianTable } from './DteMedianTable';
import { CHART_KINDS, specFor, type ChartKind } from './registry';
import { EmptySlot } from './EmptySlot';
import { cn } from '@/lib/cn';

export interface SlotConfig {
  id: string;
  symbol: string;
  /** The user's preference. The expiry actually in force is resolved against
   *  the live list — see `useStraddleContract`. */
  expiry: string;
  /** `null` means the slot is empty and shows the picker. */
  kind: ChartKind | null;
}

interface Props {
  slot: SlotConfig;
  date: string;
  /** A CSS length — see `LayoutSpec.height`. */
  height: string;
  dense: boolean;
  /** Focus drives the page's stat strip. Only meaningful past one slot. */
  focused: boolean;
  showFocus: boolean;
  onFocus: () => void;
  onChange: (next: Partial<SlotConfig>) => void;
}

export function StraddleSlot({
  slot, date, height, dense, focused, showFocus, onFocus, onChange,
}: Props) {
  const { available, expiry, expiries, history, points, rolls, exchange } =
    useStraddleContract(slot.symbol, slot.expiry, date);

  /**
   * The two basket queries are declared unconditionally but `enabled` only for
   * the kind this slot is showing.
   *
   * Hooks cannot be called conditionally, and the alternative — a component per
   * kind, each calling its own hook — would duplicate the header, the contract
   * selectors and all four load states three times. `enabled` costs nothing
   * when false; a cold band-greeks basket is a 30-series walk and must not be
   * started by a slot that is drawing something else.
   */
  const greeks = useBandGreeks(slot.symbol, exchange, slot.kind === 'greeks' ? expiry : '', date);
  const skew = useRiskReversal(slot.symbol, exchange, slot.kind === 'skew' ? expiry : '', date);

  /**
   * The DTE-median comparison.
   *
   * Anchored to the date the ENGINE walked, not to the `date` prop: the prop is
   * blank for "the latest session", and a cohort has to count backwards from a
   * real date. `history.data.date` is the day the backend actually resolved.
   */
  const [compareMode, setCompareMode] = useState<'none' | 'dte-median'>('none');
  /**
   * Chart or table, for the comparison only.
   *
   * Not a slot-wide setting. There is no table of a candle chart worth having,
   * and a view switch that sat on the header permanently would be disabled in
   * every state except this one.
   */
  const [compareView, setCompareView] = useState<'chart' | 'table'>('chart');
  /**
   * Raw or rebased, for the chart AND the table together.
   *
   * One piece of state, not one per view. Reading 256.15 in the table and 192.99
   * on the chart for the same session and the same minute is how a correct
   * number gets mistaken for a bug.
   *
   * Raw is the default: it is what the straddle actually traded at, so it can be
   * checked against that session's own chart. Rebased is the interpretation, and
   * an interpretation is a thing to opt into.
   */
  const [compareUnits, setCompareUnits] = useState<CompareUnits>('raw');
  const anchorDate = history.data?.date || date;
  const dteMedian = useDteMedian(
    slot.symbol,
    exchange,
    expiry,
    anchorDate,
    5,
    slot.kind === 'straddle' && compareMode === 'dte-median',
  );

  /**
   * The overlay, in premium points on today's timestamps.
   *
   * Pooling happens as an index — five contracts at five spot levels cannot be
   * averaged in points — and this multiplies it back by TODAY's open so the
   * line shares the candles' axis. See `projectToPoints`.
   */
  /**
   * Today's opening anchor. The SAME definition the cohort was anchored with —
   * today arrives at 1-second and the cohort at 1-minute, so a first-print
   * anchor here would be drawn from a 60x denser sample of the noisiest minute
   * in the session and the two sides of the ratio would not match.
   */
  const todayOpen = useMemo(() => openAnchor(points) ?? 0, [points]);

  /**
   * The cohort pooled in the chosen unit.
   *
   * Re-pooled rather than rescaled, because in raw units each session carries
   * its own factor and the min/median/max must be taken AFTER those factors are
   * applied — the ordering of the five values differs between the two units.
   */
  const scaledProfile = useMemo(
    () => medianProfile(
      dteMedian.sessions,
      undefined,
      unitScales(dteMedian.sessions, compareUnits, todayOpen),
    ),
    [dteMedian.sessions, compareUnits, todayOpen],
  );

  const compare = useMemo(() => {
    if (compareMode !== 'dte-median' || !scaledProfile.points.length) return null;
    const first = points[0]?.time;
    if (!first) return null;
    return {
      label: `${compareUnits === 'raw' ? 'Raw' : 'Rebased'} median ` +
        `${dteMedian.sessions.length} × ${dteMedian.targetDte} DTE`,
      data: projectToPoints(scaledProfile, first),
    };
  }, [
    compareMode, scaledProfile, compareUnits,
    dteMedian.sessions.length, dteMedian.targetDte, points,
  ]);

  const query =
    slot.kind === 'greeks'
      ? greeks
      : slot.kind === 'skew'
        ? skew
        : history;

  const rows =
    slot.kind === 'greeks'
      ? greeks.data?.points ?? []
      : slot.kind === 'skew'
        ? skew.data?.points ?? []
        : points;

  const spec = slot.kind ? specFor(slot.kind) : null;
  const Icon = spec?.icon;

  const controls = (
    <div className="flex items-center gap-2">
      {slot.kind && query.isFetching ? <Spinner /> : null}

      {/* Only while a comparison is running — see `compareView`. Placed first
          so it does not shift the contract selectors when it appears. */}
      {slot.kind === 'straddle' && compareMode === 'dte-median' ? (
        <>
          {/* Units first: it changes what the numbers MEAN, where the view
              switch only changes how they are drawn. */}
          <SegmentedControl
            value={compareUnits}
            options={[
              { value: 'raw', label: 'Raw' },
              { value: 'rebased', label: 'Rebased' },
            ]}
            onChange={setCompareUnits}
          />
          <SegmentedControl
            value={compareView}
            options={[
              { value: 'chart', label: 'Chart' },
              { value: 'table', label: 'Table' },
            ]}
            onChange={setCompareView}
          />
        </>
      ) : null}

      {slot.kind ? (
        <>
          <Select
            aria-label="Chart"
            value={slot.kind}
            options={CHART_KINDS.map((c) => ({ value: c.kind, label: c.label }))}
            onChange={(e) => onChange({ kind: e.target.value as ChartKind })}
            className={dense ? 'w-32' : 'w-40'}
          />
          <Select
            aria-label="Underlying"
            value={slot.symbol}
            options={UNDERLYINGS.map((u) => ({ value: u.value, label: `${u.value} · ${u.exchange}` }))}
            // Clearing the expiry is not optional: the old one belongs to the
            // old underlying and names a contract that does not exist.
            onChange={(e) => onChange({ symbol: e.target.value, expiry: '' })}
            className={dense ? 'w-28' : 'w-36'}
          />
          <Select
            aria-label="Expiry"
            value={expiry}
            options={
              available.length
                ? available.map((e) => ({ value: e, label: e }))
                : [{ value: '', label: expiries.isLoading ? 'Loading…' : 'No expiries' }]
            }
            onChange={(e) => onChange({ expiry: e.target.value })}
            className={dense ? 'w-28' : 'w-36'}
          />
          {/* Clearing returns the slot to the picker rather than removing the
              pane — the layout decides how many panes there are, and a close
              button that silently changed the layout would fight it. */}
          <Button
            variant="ghost"
            size="sm"
            iconOnly
            title="Clear this pane"
            aria-label="Clear this pane"
            onClick={() => onChange({ kind: null })}
          >
            <X size={13} />
          </Button>
        </>
      ) : null}
    </div>
  );

  return (
    <Panel
      flush
      className={cn(
        'transition-shadow duration-100',
        // A ring, not a border: a border would change the panel's box and shift
        // every neighbour by a pixel each time focus moved.
        showFocus && focused && 'ring-1 ring-[var(--accent-info)]',
      )}
    >
      {/* Focus follows a click anywhere in the slot, including on the chart —
          which is why this is a wrapper and not a handler on the header. */}
      <div onPointerDownCapture={onFocus} className="flex min-h-0 flex-col">
        <PanelHeader
          // Always dense, not only in the small layouts. Even at one chart this
          // header is a caption on the plot, not a section heading.
          dense
          title={slot.kind ? `${slot.symbol} ${expiry || '—'}` : 'Empty pane'}
          subtitle={slot.kind ? `${exchange} · ${spec?.label}` : undefined}
          icon={Icon ? <Icon size={14} /> : undefined}
          actions={controls}
        />

        {!slot.kind ? (
          <EmptySlot height={height} onPick={(kind) => onChange({ kind })} />
        ) : query.isLoading ? (
          <div className="relative p-4">
            <div className="qs-skeleton" style={{ height }} />
            {/* A cold contract walks the whole session across every strike the
                spot visited. Say so, or a correct-but-slow first load reads as
                a hang. */}
            <p className="absolute inset-x-0 top-1/2 -translate-y-1/2 px-4 text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
              {spec?.slow
                ? `Walking the option chain for ${spec.label.toLowerCase()} — the first load of a contract takes a while, then it is cached.`
                : 'Computing the session walk — the first load of a contract can take 20 seconds or so, then it is cached.'}
            </p>
          </div>
        ) : query.error ? (
          <div className="p-4">
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title="Nothing recorded"
              hint={
                expiry
                  ? 'The engine has no points for this contract on this session.'
                  : 'Pick an expiry to load a session.'
              }
            />
          </div>
        ) : slot.kind === 'greeks' ? (
          <GreeksChart points={greeks.data?.points ?? []} height={height} dense={dense} />
        ) : slot.kind === 'skew' ? (
          <SkewChart points={skew.data?.points ?? []} height={height} dense={dense} />
        ) : compareMode === 'dte-median' && compareView === 'table' ? (
          /* Scrolls inside the slot's own height rather than growing it — a
             375-row table that lengthened the pane would push every other slot
             off the page the moment the comparison was switched on. */
          <div className="min-h-0 overflow-auto" style={{ height }}>
            <DteMedianTable
              profile={scaledProfile}
              sessions={dteMedian.sessions}
              scales={unitScales(dteMedian.sessions, compareUnits, todayOpen)}
              units={compareUnits}
              todayOpen={todayOpen}
              todayPoints={points}
            />
          </div>
        ) : (
          <StraddleChart
            points={points}
            rollEvents={rolls}
            height={height}
            dense={dense}
            compare={compare}
            compareValue={compareMode}
            compareOptions={[
              { value: 'none', label: 'No comparison' },
              { value: 'dte-median', label: 'Median 5 × same DTE' },
            ]}
            onCompareChange={(value) => setCompareMode(value as 'none' | 'dte-median')}
            compareNote={compareNote(dteMedian, compareMode, compareUnits)}
            // Raw sessions traded at their own levels, so sharing the premium
            // axis would autoscale to the cohort and squeeze today's candles.
            compareScale={compareUnits === 'raw' ? 'separate' : 'shared'}
          />
        )}
      </div>
    </Panel>
  );
}

/**
 * The one line that says what the overlay is and whether to trust it.
 *
 * The sample count is not decoration. A median of five weekly sessions is a
 * typical day; a median of two is a midpoint between two days, and the line
 * looks identical either way. Stating the support is the only thing that tells
 * them apart.
 */
function compareNote(
  result: ReturnType<typeof useDteMedian>,
  mode: 'none' | 'dte-median',
  units: CompareUnits,
): string | undefined {
  if (mode !== 'dte-median') return undefined;
  if (result.isLoading) return 'Finding and walking the last 5 sessions at this DTE…';
  if (result.error) return 'Could not load the comparison.';
  if (!result.profile.points.length) {
    return result.cohort.length
      ? `Found ${result.cohort.length} session(s) at ${result.targetDte} DTE, but none had data.`
      : `No session in the last 16 weekly cycles carried ${result.targetDte} DTE.`;
  }

  const parts = [
    `${result.sessions.length} session${result.sessions.length === 1 ? '' : 's'}`,
    // Says which axis the overlay is on, because in raw units it is NOT the
    // premium scale and a line that shares a pane without sharing a number line
    // is the easiest thing on this chart to misread.
    units === 'raw' ? 'raw · own scale' : "rebased to today's open",
    result.sessions.map((s) => s.date.slice(5)).join(' '),
  ];
  if (result.sessions.length < 3) parts.push('thin cohort — indicative only');
  if (result.emptySessions.length) parts.push(`${result.emptySessions.length} had no data`);
  return parts.join(' · ');
}
