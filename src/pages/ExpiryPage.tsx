/**
 * The expiry cockpit.
 *
 * ── What this page is for ──
 *
 * Not "will it go up". Expiry day is a regime problem, and the question worth
 * answering is the two-stage one:
 *
 *   1. Is this session about to go from COMPRESSION to EXPANSION?
 *   2. Once it does, which side?
 *
 * Almost everything here serves stage one. Stage two is barely represented, on
 * purpose — direction on expiry day is a much weaker read than regime, and a
 * dashboard that gave both the same visual weight would be making a claim the
 * data does not support.
 *
 * ── Layout ──
 *
 * Three columns at width: the tape (what premium and spot are doing), the
 * ladder (where the market has written its options, and whether that is
 * changing), and the read (regime, pressure, levels, migration). The tape and
 * the ladder are the evidence; the right column is the interpretation, and it
 * is narrowest because it is the part most likely to be wrong.
 *
 * ── One endpoint ──
 *
 * Everything comes from `/api/expiry/state`, polled. The regime, the pressure
 * score, the ladder and the series are all derived from one chain snapshot at
 * one instant; splitting them across calls would let the panels disagree about
 * which minute they describe.
 */

import { useMemo, useState } from 'react';
import { AlertTriangle, Circle, History, Radio, RotateCcw } from 'lucide-react';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { SymbolPicker } from '@/components/straddle/SymbolPicker';
import { ExpiryLadder } from '@/components/expiry/ExpiryLadder';
import { ExpiryTape } from '@/components/expiry/ExpiryTape';
import { PressureGauge } from '@/components/expiry/PressureGauge';
import { useExpiryReplay, useExpiryState } from '@/hooks/queries';
import { decimal, expiryLabel, integer, signed, timeToExpiry } from '@/lib/format';
import type { ExpiryReplay, ExpiryState, Regime } from '@/schemas/expiry';

/**
 * What each regime means, in one line, next to the word.
 *
 * The words are jargon and the panel would be unreadable to anyone who has not
 * spent a year on an expiry desk without them — and the tone is what makes the
 * classification scannable from across a room.
 */
const REGIME: Record<Regime, { label: string; tone: 'accent' | 'warning' | 'danger' | 'neutral'; note: string }> = {
  compression: { label: 'Compression', tone: 'accent', note: 'premium bleeding, tape quiet' },
  expansion: { label: 'Expansion', tone: 'danger', note: 'premium rising against theta' },
  trend: { label: 'Trend', tone: 'warning', note: 'spot moving, ATM migrating' },
  pin: { label: 'Pinned', tone: 'accent', note: 'spot sitting on the ATM' },
  whipsaw: { label: 'Whipsaw', tone: 'warning', note: 'premium transferring between sides' },
  unknown: { label: 'Reading…', tone: 'neutral', note: 'not enough of the session yet' },
};

function Stat({
  label, value, detail, tone,
}: {
  label: string; value: string; detail?: string; tone?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2">
      <span className="qs-label">{label}</span>
      <strong
        className="qs-num truncate text-[length:var(--type-control)]"
        style={{ color: tone ?? 'var(--text-primary)' }}
      >
        {value}
      </strong>
      {detail ? (
        <span className="truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {detail}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What the panels actually read — live and replay flattened to one shape.
 *
 * The two payloads are deliberately different types (see `expiryReplayResponse`)
 * so nothing can mistake one for the other by accident, and this is the single
 * place that decides how they map onto the same panels. A replay's top line
 * comes from its LAST BAR rather than from a live snapshot, which is the honest
 * reading: it is the state at the close of that session, not now.
 */
interface CockpitView {
  symbol: string;
  expiry: string;
  minutesToExpiry: number | null;
  spot: number | null;
  atmStrike: number | null;
  straddle: number | null;
  iv: number | null;
  syntheticFuture: number | null;
  expectedMovePct: number | null;
  realizedVolPct: number | null;
  netGex: number | null;
  gammaFlip: number | null;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  regime: Regime;
  regimeNote: string;
  pressure: ExpiryState['pressure'];
  migration: ExpiryState['migration'];
  ladder: ExpiryState['ladder'];
  bars: ExpiryState['bars'];
  /** The provenance line — never inferred from the shape of the data. */
  live: boolean;
  note: string;
}

function viewOfLive(state: ExpiryState): CockpitView {
  return {
    ...state,
    live: state.live,
    note: state.recorded ? `${state.recorded} bars recorded` : 'recording',
  };
}

function viewOfReplay(replay: ExpiryReplay): CockpitView {
  const last = replay.bars[replay.bars.length - 1] ?? null;
  return {
    symbol: replay.symbol,
    expiry: replay.expiry,
    minutesToExpiry: replay.minutesToExpiry,
    spot: last?.spot ?? null,
    atmStrike: last?.atmStrike ?? null,
    straddle: last?.straddle ?? null,
    iv: last?.iv ?? null,
    syntheticFuture: last?.syntheticFuture ?? null,
    expectedMovePct: last?.expectedMovePct ?? null,
    realizedVolPct: last?.realizedVolPct ?? null,
    netGex: last?.netGex ?? null,
    gammaFlip: last?.gammaFlip ?? null,
    callWall: replay.callWall,
    putWall: replay.putWall,
    maxPain: replay.maxPain,
    regime: replay.regime,
    regimeNote: replay.regimeNote,
    pressure: replay.pressure,
    migration: replay.migration,
    ladder: replay.ladder,
    bars: replay.bars,
    live: false,
    // Gamma provenance is stated because it changes what the GEX figures ARE:
    // fed gamma carries the smile, modelled gamma is Black-76 off one ATM vol.
    note: `${replay.contracts} contracts · gamma ${replay.gammaSource} · ${replay.tookMs}ms`,
  };
}

export function ExpiryPage() {
  const [contract, setContract] = useState({ symbol: 'NIFTY', exchange: 'NSE' });
  /**
   * Blank means live. Any date means that session, rebuilt.
   *
   * One control, two data paths, and the page says which one it is showing at
   * all times — a historical ladder that looked live would be the single most
   * expensive thing this page could do to a reader.
   */
  const [date, setDate] = useState('');

  const query = useExpiryState(contract.symbol, contract.exchange);
  const replay = useExpiryReplay(contract.symbol, contract.exchange, date);
  const active = date ? replay : query;

  const state = useMemo<CockpitView | undefined>(() => {
    if (date) return replay.data ? viewOfReplay(replay.data) : undefined;
    return query.data ? viewOfLive(query.data) : undefined;
  }, [date, replay.data, query.data]);

  const regime = REGIME[state?.regime ?? 'unknown'];
  const spot = state?.spot ?? null;
  const flip = state?.gammaFlip ?? null;
  /*
   * Which side of the flip spot is on — the single most consequential thing on
   * the page, and the reason the flip is computed at all.
   *
   * Stated as a coordinate, never as a prediction: "below the flip" is where
   * hedging tends to amplify a move rather than damp it, and that tendency is
   * an inference about positioning the exchange never publishes. See `gexOf`
   * for why even the sign convention is a convention.
   */
  const belowFlip = spot != null && flip != null && spot < flip;

  return (
    <div className="flex h-full min-h-0 flex-col gap-[var(--container-gap)]">
      {/* ── Command deck ─────────────────────────────────────────────── */}
      <section className="qs-container flex shrink-0 flex-wrap items-stretch divide-x divide-[var(--container-rule)]">
        <div className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2">
          <SymbolPicker
            symbol={contract.symbol}
            exchange={contract.exchange}
            onChange={setContract}
          />
          <div className="min-w-0">
            <h1 className="truncate text-[length:var(--type-control)] font-semibold text-[var(--text-primary)]">
              {state ? expiryLabel(state.expiry) : '—'}
            </h1>
            <p className="flex items-center gap-1.5 truncate text-[length:var(--type-micro)] text-[var(--text-secondary)]">
              {date ? (
                <History size={11} className="text-[var(--series-vega)]" />
              ) : state?.live ? (
                <Radio size={11} className="text-[var(--market-up)]" />
              ) : (
                <Circle size={9} className="text-[var(--text-disabled)]" />
              )}
              {date ? `${date} · replay` : state?.minutesToExpiry != null
                ? `${timeToExpiry(state.minutesToExpiry)} to expiry`
                : 'waiting for the chain'}
              {state?.note ? ` · ${state.note}` : ''}
            </p>
          </div>

          {/* Blank is live. A date rebuilds that session from history — OI
              included, which is what makes the ladder and the gamma profile
              historical rather than decorative. */}
          <Input
            type="date"
            aria-label="Replay a past session"
            title="Blank for live; pick a date to rebuild that session"
            value={date}
            max={new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())}
            onChange={(e) => setDate(e.target.value)}
            className="w-36"
          />
          {date ? (
            <Button variant="ghost" size="sm" onClick={() => setDate('')} title="Back to live">
              <RotateCcw size={13} /> Live
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-2 px-3 py-2">
          <Badge tone={regime.tone}>{regime.label}</Badge>
          <span className="max-w-[22rem] truncate text-[length:var(--type-micro)] text-[var(--text-secondary)]">
            {state?.regimeNote || regime.note}
          </span>
          {active.isFetching ? <Spinner /> : null}
        </div>

        <div className="grid flex-1 grid-cols-2 divide-x divide-[var(--container-rule)] sm:grid-cols-4">
          <Stat
            label="Spot"
            value={decimal(spot)}
            detail={state?.syntheticFuture != null ? `syn ${decimal(state.syntheticFuture)}` : undefined}
            tone="var(--series-vega)"
          />
          <Stat
            label="ATM straddle"
            value={decimal(state?.straddle ?? null)}
            detail={state?.atmStrike != null ? `at ${integer(state.atmStrike)}` : undefined}
          />
          <Stat
            label="ATM IV"
            value={state?.iv != null ? `${decimal(state.iv)}%` : '—'}
            detail={
              state?.realizedVolPct != null
                ? `RV ${decimal(state.realizedVolPct)}%`
                : undefined
            }
            tone="var(--series-iv)"
          />
          <Stat
            label="Expected move"
            value={state?.expectedMovePct != null ? `${decimal(state.expectedMovePct)}%` : '—'}
            detail={
              state?.straddle != null && spot != null
                ? `± ${decimal(state.straddle)} by close`
                : undefined
            }
          />
        </div>
      </section>

      {active.error ? (
        <div className="qs-container p-4">
          <ErrorState error={active.error} onRetry={() => active.refetch()} />
        </div>
      ) : null}

      {/* ── The three columns ────────────────────────────────────────── */}
      <div className="grid min-h-0 flex-1 gap-[var(--container-gap)] grid-rows-[repeat(3,minmax(320px,1fr))] xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_20rem] xl:grid-rows-[minmax(420px,1fr)]">
        <Panel flush className="min-h-0">
          <PanelHeader dense title="Session tape" subtitle="straddle · IV · spot with the levels" />
          <div className="flex min-h-0 flex-1 flex-col p-2">
            {state?.bars.length ? (
              <ExpiryTape
                className="min-h-0 w-full flex-1"
                bars={state.bars}
                levels={{
                  callWall: state.callWall,
                  putWall: state.putWall,
                  gammaFlip: state.gammaFlip,
                  atmStrike: state.atmStrike,
                }}
              />
            ) : (
              <EmptyState
                title={date ? 'Rebuilding that session' : 'Building the session'}
                hint={date
                  ? 'Walking every strike across the day, one bar a minute. A cold replay takes a second or two.'
                  : 'One bar a minute, from the moment this contract was first opened. The tape fills in as the session runs.'}
              />
            )}
          </div>
        </Panel>

        <Panel flush className="min-h-0">
          <PanelHeader
            dense
            title="Strike ladder"
            subtitle="open interest · flow · gamma"
            actions={
              state?.maxPain != null ? (
                <span className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                  max OI {integer(state.maxPain)}
                </span>
              ) : null
            }
          />
          <ExpiryLadder
            className="flex-1"
            ladder={state?.ladder ?? []}
            atmStrike={state?.atmStrike ?? null}
            spot={spot}
            callWall={state?.callWall ?? null}
            putWall={state?.putWall ?? null}
            gammaFlip={state?.gammaFlip ?? null}
          />
        </Panel>

        <Panel flush className="min-h-0 overflow-auto">
          <PanelHeader dense title="The read" subtitle="regime · pressure · levels" />

          <PressureGauge
            score={state?.pressure.score ?? 0}
            components={state?.pressure.components ?? []}
          />

          <div className="border-t border-[var(--container-rule)]">
            <div className="grid grid-cols-2 divide-x divide-[var(--container-rule)] border-b border-[var(--container-rule)]">
              <Stat
                label="Gamma flip"
                value={flip != null ? integer(flip) : '—'}
                detail={
                  spot != null && flip != null
                    ? `spot ${signed(spot - flip)} away`
                    : undefined
                }
                tone="var(--series-vega)"
              />
              <Stat
                label="Net GEX"
                value={state?.netGex != null ? `${integer(state.netGex / 1e7)} cr` : '—'}
                detail="per 1% move"
                tone={
                  state?.netGex == null
                    ? undefined
                    : state.netGex >= 0 ? 'var(--market-up)' : 'var(--market-down)'
                }
              />
              <Stat label="Call wall" value={state?.callWall != null ? integer(state.callWall) : '—'} tone="var(--series-ask)" />
              <Stat label="Put wall" value={state?.putWall != null ? integer(state.putWall) : '—'} tone="var(--series-bid)" />
            </div>

            {/*
              The hedging note. Phrased as a TENDENCY and attributed, because the
              sign convention behind it is imported from US index options and is
              not obviously right on NIFTY, where much of the option supply is
              retail writing both wings.
            */}
            {flip != null && spot != null ? (
              <div className="flex items-start gap-2 px-3 py-2">
                <AlertTriangle
                  size={13}
                  className="mt-0.5 shrink-0"
                  style={{ color: belowFlip ? 'var(--market-down)' : 'var(--accent-info)' }}
                />
                <p className="text-[length:var(--type-micro)] leading-snug text-[var(--text-secondary)]">
                  Spot is <strong>{belowFlip ? 'below' : 'above'}</strong> the flip.
                  {belowFlip
                    ? ' Hedging tends to reinforce moves here — a push can accelerate rather than fade.'
                    : ' Hedging tends to damp moves here — pushes more often fade back.'}
                  {' '}A tendency inferred from positioning nobody publishes, not a rule.
                </p>
              </div>
            ) : null}
          </div>

          {/* ── OI migration ──────────────────────────────────────────── */}
          <div className="border-t border-[var(--container-rule)] px-3 py-2">
            <span className="qs-label">Wall migration · 30m</span>
            <div className="mt-1 flex flex-col gap-1">
              {(state?.migration ?? []).map((m) => (
                <div key={m.side} className="flex items-center justify-between gap-2 text-[length:var(--type-micro)]">
                  <span className="text-[var(--text-secondary)]">
                    {m.side === 'CE' ? 'Call wall' : 'Put wall'}
                  </span>
                  <span className="qs-num text-[var(--text-primary)]">
                    {m.from != null ? integer(m.from) : '—'}
                    {' → '}
                    {m.to != null ? integer(m.to) : '—'}
                    <span
                      className="ml-1.5"
                      style={{
                        color: m.steps === 0
                          ? 'var(--text-tertiary)'
                          : m.steps > 0 ? 'var(--market-up)' : 'var(--market-down)',
                      }}
                    >
                      {m.steps === 0 ? 'held' : m.steps > 0 ? 'up' : 'down'}
                    </span>
                  </span>
                </div>
              ))}
              {!state?.migration.length ? (
                <span className="text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                  Needs 30 minutes of session before a wall can be said to have moved.
                </span>
              ) : null}
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
