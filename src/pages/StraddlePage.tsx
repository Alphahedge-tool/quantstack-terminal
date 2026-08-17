/**
 * Rolling straddle analytics.
 *
 * Backed by `POST /api/straddle/history`, which returns the engine's full
 * session walk. Note the endpoint split: `/snapshot` takes `expiries=a,b,c` and
 * returns one LAST value per expiry for a term-structure comparison — it is not
 * a time series and cannot draw this chart.
 *
 * ── One chart, two panes ──
 *
 * This page used to stack three independent SVG charts, because the SVG
 * `LineChart` takes one y-axis by construction and premium, IV and the
 * synthetic future are three units. That constraint was right; the cost was
 * three separate time axes and three separate zoom states, so panning one left
 * the others behind. `StraddleChart` keeps the constraint and drops the cost —
 * panes that share one time scale and one crosshair, each with its own price
 * scale.
 *
 * ── Layouts ──
 *
 * Beyond one chart, the page is a grid of independent slots, each with its own
 * underlying and expiry. What makes that worth building is the comparison a
 * single chart cannot express: front expiry against next, index against index.
 * The session date stays on the page rather than in the slots — see
 * `StraddleSlot` for why.
 */

import { useCallback, useMemo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Input } from '@/components/ui/Field';
import { Badge, DeltaText } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DetailValue, StatStrip, Trend } from '@/components/straddle/StatStrip';
import { LAYOUTS, LayoutPicker, type LayoutId } from '@/components/straddle/LayoutPicker';
import { StraddleSlot, type SlotConfig } from '@/components/straddle/StraddleSlot';
import type { ChartKind } from '@/components/straddle/registry';
import { todayIST, useStraddleContract } from '@/components/straddle/useStraddleContract';
import { useLiveStraddle } from '@/hooks/useLiveStraddle';
import { decimal, expiryLabel, percent, signed } from '@/lib/format';
import { istClockSeconds } from '@/lib/chartTheme';

/**
 * Today in IST, as `YYYY-MM-DD`.
 *
 * Only used as the date picker's `max`. `toISOString()` would give the UTC day,
 * which before 05:30 IST is yesterday — the picker would refuse the session the
 * user is currently sitting in.
 */
function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

let nextSlotId = 1;
const makeSlot = (
  symbol: string,
  expiry: string,
  kind: ChartKind | null,
): SlotConfig => ({
  id: `slot-${nextSlotId++}`,
  symbol,
  expiry,
  kind,
});

/** A zero-height-cost view of where the current premium sits inside today's
 *  observed range. It adds context the last price alone cannot carry without
 *  duplicating the full chart immediately below. */
function SessionRange({
  low,
  high,
  current,
  signedBy,
}: {
  low: number | null;
  high: number | null;
  current: number | null;
  signedBy: number | null;
}) {
  if (low == null || high == null || current == null) {
    return <span className="text-[length:var(--type-micro)] text-[var(--text-disabled)]">Range unavailable</span>;
  }

  const rawPosition = high > low ? ((current - low) / (high - low)) * 100 : 50;
  const position = Math.min(98, Math.max(2, rawPosition));
  const colour =
    signedBy == null || signedBy === 0
      ? 'var(--accent-info)'
      : signedBy > 0
        ? 'var(--market-up)'
        : 'var(--market-down)';
  const label = `Session range ${decimal(low)} to ${decimal(high)}; current ${decimal(current)}`;

  return (
    <div role="img" aria-label={label} title={label} className="flex min-w-0 items-center gap-2">
      <span className="qs-num shrink-0 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
        L {decimal(low)}
      </span>
      <span className="relative h-1 min-w-10 flex-1 overflow-visible rounded-full bg-[var(--border-default)]">
        <span
          className="absolute inset-y-0 left-0 rounded-full opacity-45"
          style={{ width: `${position}%`, backgroundColor: colour }}
        />
        <span
          className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--container-blue)]"
          style={{ left: `${position}%`, backgroundColor: colour, boxShadow: `0 0 5px ${colour}` }}
        />
      </span>
      <span className="qs-num shrink-0 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
        H {decimal(high)}
      </span>
    </div>
  );
}

export function StraddlePage() {
  const [layout, setLayout] = useState<LayoutId>('1');
  const [slots, setSlots] = useState<SlotConfig[]>([makeSlot('NIFTY', '', 'straddle')]);
  const [focusedId, setFocusedId] = useState<string>(() => slots[0].id);

  /**
   * Empty means "whatever the backend calls the latest trading date".
   *
   * Deliberately not pre-filled with today: on a Sunday, or a holiday, or
   * before the open, today has no session and a pre-filled picker would send
   * the user straight into an empty chart. The backend owns the exchange
   * calendar, so the default is its call to make.
   */
  const [date, setDate] = useState('');

  const spec = LAYOUTS.find((l) => l.id === layout) ?? LAYOUTS[0];

  const changeLayout = useCallback((next: LayoutId) => {
    const target = LAYOUTS.find((l) => l.id === next) ?? LAYOUTS[0];
    setLayout(next);
    setSlots((current) => {
      if (current.length >= target.slots) {
        // Shrinking KEEPS the trimmed slots' configs out of state but never
        // reorders the survivors — going 4 → 1 → 4 should not shuffle the
        // charts the user arranged.
        return current.slice(0, target.slots);
      }
      /**
       * A new pane inherits the CONTRACT but not the CHART.
       *
       * The first slot keeps what it was showing — splitting must never disturb
       * the chart you were already reading. The new one carries the same symbol
       * and expiry, because comparing two analytics of the same contract is the
       * common case and re-picking them would be three edits — but its `kind`
       * is null, so it opens the picker instead of cloning.
       *
       * Cloning the chart too was the earlier behaviour, on the TradingView
       * logic that you split a pane to vary one field of what you were looking
       * at. That holds when panes differ by symbol; here they mostly differ by
       * WHICH ANALYTIC, so a clone is a copy you have to throw away before the
       * pane is useful.
       */
      const grown = [...current];
      const seed = current[current.length - 1];
      while (grown.length < target.slots) grown.push(makeSlot(seed.symbol, seed.expiry, null));
      return grown;
    });
  }, []);

  const updateSlot = useCallback((id: string, next: Partial<SlotConfig>) => {
    setSlots((current) => current.map((s) => (s.id === id ? { ...s, ...next } : s)));
  }, []);

  const visible = useMemo(() => slots.slice(0, spec.slots), [slots, spec.slots]);

  // Focus can be left pointing at a slot that a layout change removed.
  const focused = visible.find((s) => s.id === focusedId) ?? visible[0];

  /**
   * The stat strip describes the FOCUSED slot.
   *
   * Same hook the slot itself calls, so the query key matches and TanStack
   * Query serves both from one request — the strip adds no network cost. The
   * alternative, aggregating all four slots into one strip, would produce
   * numbers true of no contract on screen.
   */
  const summary = useStraddleContract(focused.symbol, focused.expiry, date);
  const {
    last: walkedLast, history, expiry, rolls: walkedRolls, rawRollCount, exchange, open,
  } = summary;

  /**
   * The strip's live feed.
   *
   * The strip was showing the last WALKED point, which on a live session is
   * whatever the session walk returned when it last ran — so the premium, spot,
   * synthetic future, IV and greeks above the chart all sat frozen minutes
   * behind the line moving underneath them. Reading a stale level as the current
   * one is the single most expensive mistake this page can invite.
   *
   * This is not a second connection. `useLiveStraddle` keys its session by
   * contract and reference-counts it, so the focused slot and this strip share
   * one socket and one buffer — which also means they cannot disagree about the
   * last trade, as two independent feeds eventually would.
   *
   * No `onGap` here: the slot owns that reload and it is the same query. Two
   * throttles against one endpoint would just race each other.
   */
  const liveEnabled =
    Boolean(expiry) && Boolean(history.data?.date) && history.data?.date === todayIST();
  const live = useLiveStraddle({
    symbol: focused.symbol,
    exchange,
    expiry,
    atmHint: walkedLast?.atmStrike ?? null,
    since: walkedLast?.time ?? null,
    enabled: liveEnabled,
  });

  /*
   * Live wins when it has anything, because it is by definition newer — the
   * session walk cannot produce a point ahead of the socket. Falls back to the
   * walk for a historical session, where `live.last` is null.
   */
  const last = live.last ?? walkedLast;
  const rolls = useMemo(
    () => (live.rolls.length ? [...walkedRolls, ...live.rolls] : walkedRolls),
    [walkedRolls, live.rolls],
  );

  /**
   * The opening baseline is `open.straddle`, NOT the backend's `entryStraddle`.
   *
   * `entryStraddle` is the engine's first bar, which on a contract that has not
   * printed yet carries the previous session's marks. On CRUDEOILM 2026-08-14
   * that made it 182.30 against a real open of 294.88, and every figure hung
   * off it came out with the wrong SIGN — the strip read +64.08 on a day the
   * straddle decayed. `sessionOpenOf` skips the carry-over; see it for how.
   */
  const entry = open.straddle;
  const change =
    last?.straddlePrice != null && entry != null ? last.straddlePrice - entry : null;
  const marketTone =
    change == null || change === 0
      ? 'var(--accent-info)'
      : change > 0
        ? 'var(--market-up)'
        : 'var(--market-down)';
  const coverage = history.data?.greekCoverage ?? null;
  const session = history.data?.date || date || 'latest session';
  const spot = last?.spot ?? history.data?.lastSpot ?? null;
  const syntheticFuture = last?.syntheticFuture ?? null;

  /**
   * ATM implied volatility, and where it came from.
   *
   * Formatted here rather than with `percent()`, which prepends a sign — right
   * for a change, wrong for a level. "+8.11%" reads as a move of eight points
   * of vol rather than a vol of eight.
   *
   * The source rides along because a fed vol and a locally inverted one are not
   * the same claim, and the difference is invisible in the number itself.
   */
  const atmIv = last?.iv ?? null;
  const ivFromFeed = last?.ivSource === 'feed';

  /**
   * The direction arrows, all measured from the same trusted session open.
   *
   * Against the OPEN rather than the previous bar: at one-second resolution a
   * bar-to-bar arrow flips several times a second on a quiet market and becomes
   * a flickering ornament, and it answers a question ("did the last tick go
   * up?") nobody asks of a header. It is also the baseline the straddle's own
   * Change uses, so the whole strip means one thing by "up".
   *
   * All four now come from `open`, which skips the stale carry-over bar. That
   * bar was why ATM IV showed a rising arrow on a session where the plotted
   * line fell from 50% to 43% — the arrow was measured from a 31.09% mark left
   * over from the day before.
   */
  const since = (now: number | null, then: number | null) =>
    now != null && then != null ? now - then : null;

  const spotTrend = since(spot, open.spot);
  const sfTrend = since(syntheticFuture, open.syntheticFuture);
  const ivTrend = since(atmIv, open.iv);
  const basis = syntheticFuture != null && spot != null ? syntheticFuture - spot : null;
  const changePct = entry != null && entry !== 0 && change != null ? (change / entry) * 100 : null;
  const snapshot = last?.time ? istClockSeconds(Math.floor(last.time / 1000)) : null;
  const atmStrike =
    history.data?.currentStrike != null
      ? decimal(history.data.currentStrike, 0)
      : last?.atmStrike != null
        ? decimal(last.atmStrike, 0)
        : '—';

  /**
   * The high/low band, over the trusted region only.
   *
   * Including the carry-over bar made it the session LOW on CRUDEOILM — 182.30
   * against a real trading low near 241 — which put the current 246.38 in the
   * middle of the band when it was actually sitting close to the bottom of the
   * day. The band read as "mid-range, nothing to see" on a session that had
   * decayed to its lows.
   */
  const sessionRange = { low: open.low, high: open.high };

  const multi = spec.slots > 1;

  const compactStats = [
    {
      label: 'Straddle',
      value: decimal(last?.straddlePrice),
      detail: `${focused.symbol} ${expiryLabel(expiry)}`,
    },
    {
      label: 'Change',
      value: signed(change),
      signedBy: change,
      detail: `${percent(changePct)} · open ${decimal(entry)}`,
    },
    {
      label: 'ATM IV',
      value: atmIv != null ? `${decimal(atmIv)}%` : '—',
      tone: 'var(--series-iv)',
      trend: ivTrend,
      detail:
        atmIv == null
          ? 'no vol'
          : `${ivFromFeed ? 'feed' : 'model'}${coverage != null ? ` · ${(coverage * 100).toFixed(0)}% cover` : ''}`,
    },
    {
      label: 'Syn. future',
      // Same identity tones as the wide header above, so the two layouts do not
      // teach the reader two different colour languages at two window widths.
      value: decimal(syntheticFuture),
      tone: 'var(--series-sf)',
      trend: sfTrend,
      detail: (
        <>
          basis {signed(basis)} ·{' '}
          <DetailValue
            k="spot"
            v={decimal(spot)}
            tone="var(--series-vega)"
            trend={spotTrend}
          />
        </>
      ),
    },
    {
      label: 'ATM',
      value: atmStrike,
      detail: rawRollCount
        ? `${rolls.length} settled · ${rawRollCount} raw`
        : 'no rolls',
    },
  ];

  const controls = (
    <div className="flex items-center gap-2">
      <LayoutPicker value={layout} onChange={changeLayout} />

      <Input
        type="date"
        aria-label="Session date"
        title="Session date — blank means the latest trading day"
        value={date}
        max={istToday()}
        onChange={(e) => setDate(e.target.value)}
        className="w-36 sm:w-40"
      />

      {/* Only offered once there is something to undo. A permanently visible
          reset on a control that is already at its default is a dead button. */}
      {date ? (
        <Button variant="ghost" size="sm" onClick={() => setDate('')} title="Back to the latest session">
          <RotateCcw size={13} /> Latest
        </Button>
      ) : null}
    </div>
  );

  return (
    <>
      {/* On wide screens this becomes a single quote rail: identity, market
          context, and controls share one 64px command deck. Below 2xl it falls
          back to the compact two-row header so nothing becomes unreadably
          narrow just to preserve the effect. */}
      <section className="qs-container relative isolate mb-[var(--container-gap)] overflow-hidden 2xl:h-16 before:pointer-events-none before:absolute before:inset-x-8 before:top-0 before:z-10 before:h-px before:bg-[linear-gradient(90deg,transparent,var(--accent-info),transparent)] before:opacity-60">
        <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 bg-[var(--container-head)] px-3 py-1.5 [background-image:var(--elevation-header)] lg:h-9 lg:flex-nowrap lg:py-0 2xl:grid 2xl:h-full 2xl:min-h-0 2xl:grid-cols-[12.5rem_minmax(0,1fr)_auto] 2xl:gap-0 2xl:divide-x 2xl:divide-[var(--container-rule)] 2xl:bg-transparent 2xl:p-0 2xl:[background-image:none]">
          <div className="flex min-w-0 flex-1 items-baseline gap-3 2xl:h-full 2xl:flex-col 2xl:items-start 2xl:justify-center 2xl:gap-0.5 2xl:bg-[var(--container-head)] 2xl:px-3 2xl:[background-image:var(--elevation-header)]">
            <h1 className="shrink-0 text-[length:var(--type-title)] font-semibold leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)] 2xl:text-[length:var(--type-control)]">
              Rolling straddle
            </h1>
            <p className="min-w-0 truncate text-[length:var(--type-micro)] text-[var(--text-secondary)]">
              {focused.symbol} · {expiryLabel(expiry)} · {exchange}
              {snapshot ? ` · ${snapshot} IST` : multi ? ` · ${session}` : ''}
            </p>
          </div>

          <div className="hidden h-full min-w-0 grid-cols-[1.35fr_0.85fr_1fr_1fr] divide-x divide-[var(--container-rule)] 2xl:grid">
            <div className="relative flex min-w-0 flex-col justify-center gap-1 px-3">
              <span
                aria-hidden
                className="absolute inset-y-3 left-0 w-0.5 rounded-r-full"
                style={{ backgroundColor: marketTone }}
              />
              <div className="flex min-w-0 items-baseline gap-2 whitespace-nowrap">
                <span className="qs-label">Straddle</span>
                <strong className="qs-num text-[length:var(--type-title)] leading-tight tracking-[var(--tracking-tight)] text-[var(--text-primary)]">
                  {decimal(last?.straddlePrice)}
                </strong>
                <DeltaText value={change} className="text-[length:var(--type-control)]">
                  {signed(change)}
                </DeltaText>
                <span className="qs-num truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                  {percent(changePct)}
                </span>
              </div>
              <SessionRange
                low={sessionRange.low}
                high={sessionRange.high}
                current={last?.straddlePrice ?? null}
                signedBy={change}
              />
            </div>

            {/*
              ATM IV sits beside the premium it is derived from, not out at the
              end with the strike — reading the two together is the job, which
              is also why they share a pane on the chart.

              Amber is `--series-iv`: the same token as the IV line and the
              left-hand axis it is plotted against, so the header, the axis and
              the line are one object. 9.08:1 on this surface.
            */}
            <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="qs-label">ATM IV</span>
                <span className="flex min-w-0 items-baseline gap-1">
                  <strong className="qs-num truncate text-[length:var(--type-control)] text-[var(--series-iv)]">
                    {atmIv != null ? `${decimal(atmIv)}%` : '—'}
                  </strong>
                  <Trend value={ivTrend} label="ATM IV" />
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[length:var(--type-micro)]">
                {/* A fed vol is a quote; an inverted one is a model output. The
                    number looks identical either way, so the label is the only
                    thing that separates them. */}
                <span className="text-[var(--text-secondary)]">
                  {atmIv == null ? 'no vol' : ivFromFeed ? 'feed' : 'model'}
                </span>
                {coverage != null ? (
                  <span className="qs-num text-[var(--text-tertiary)]">
                    {(coverage * 100).toFixed(0)}% cover
                  </span>
                ) : null}
              </div>
            </div>

            <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
              {/*
                These two carry the colour of their own line on the chart below
                — the synthetic future in `--series-sf`, spot in `--series-vega`,
                the same tokens `StraddleChart` paints them with.

                White said only "this is a number". Tinted, the eye walks from
                the figure in the header straight to the line that produced it
                without going via a legend, which is the entire reason a terminal
                colours its tickers. Both clear AA on the container surface —
                8.03:1 and 6.48:1 — and neither is in the green/red family, so
                an identity colour is never mistaken for a direction.
              */}
              <div className="flex items-baseline justify-between gap-2">
                <span className="qs-label">Syn. future</span>
                <span className="flex min-w-0 items-baseline gap-1">
                  <strong className="qs-num truncate text-[length:var(--type-control)] text-[var(--series-sf)]">
                    {decimal(syntheticFuture)}
                  </strong>
                  <Trend value={sfTrend} label="Synthetic future" />
                </span>
              </div>
              <div className="flex min-w-0 items-baseline justify-between gap-2 text-[length:var(--type-micro)]">
                <span className="truncate text-[var(--text-secondary)]">
                  {/* The word stays quiet and only the figure is tinted — the
                      same two-level split the chart readout uses. */}
                  Spot{' '}
                  <span className="qs-num font-semibold text-[var(--series-vega)]">
                    {decimal(spot)}
                  </span>{' '}
                  <Trend value={spotTrend} label="Spot" />
                </span>
                <span className="shrink-0 text-[var(--text-tertiary)]">
                  Basis <DeltaText value={basis}>{signed(basis)}</DeltaText>
                </span>
              </div>
            </div>

            <div className="flex min-w-0 flex-col justify-center gap-1 px-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="qs-label">ATM strike</span>
                <strong className="qs-num truncate text-[length:var(--type-control)] text-[var(--text-primary)]">
                  {atmStrike}
                </strong>
              </div>
              <div className="flex items-baseline justify-between gap-2 text-[length:var(--type-micro)]">
                <span className="text-[var(--text-secondary)]">
                  {rolls.length} settled
                </span>
                <span className="qs-num text-[var(--text-tertiary)]">
                  {rawRollCount} raw rolls
                </span>
              </div>
            </div>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-2 overflow-x-auto 2xl:ml-0 2xl:h-full 2xl:bg-[var(--container-head)] 2xl:px-3 2xl:[background-image:var(--elevation-header)]">
            {controls}
          </div>
        </div>

        <div className="2xl:hidden">
          <StatStrip embedded stats={compactStats} />
        </div>
      </section>

      {coverage != null && coverage <= 0.8 ? (
        // Promoted out of the panel header and shown only when it is bad news.
        // A flat IV line because the feed went quiet looks identical to a flat
        // one because vol did not move, and coverage is the only thing that
        // tells them apart — but a green "100%" badge on every chart in a grid
        // of four is four pieces of furniture saying nothing happened.
        <div className="qs-container mb-[var(--container-gap)] flex flex-wrap items-center gap-2 px-3 py-2">
          {/* The number in the badge, the sentence beside it — Badge is
              uppercase and nowrap by design, which is right for a token and
              wrong for prose. */}
          <Badge tone={coverage > 0.4 ? 'warning' : 'danger'} mono>
            {(coverage * 100).toFixed(0)}% coverage
          </Badge>
          <span className="text-[length:var(--type-caption)] text-[var(--text-secondary)]">
            The feed supplied greeks for part of {focused.symbol} {expiry || '—'}. A flat stretch
            of the IV line there may be missing data rather than flat volatility.
          </span>
        </div>
      ) : null}

      <div className={`grid gap-[var(--container-gap)] ${spec.className}`}>
        {visible.map((slot) => (
          <StraddleSlot
            key={slot.id}
            slot={slot}
            date={date}
            height={spec.height}
            dense={spec.dense}
            focused={slot.id === focused.id}
            // A focus ring on the only chart on screen is noise: there is
            // nothing it could be distinguishing it from.
            showFocus={multi}
            onFocus={() => setFocusedId(slot.id)}
            onChange={(next) => updateSlot(slot.id, next)}
          />
        ))}
      </div>
    </>
  );
}
