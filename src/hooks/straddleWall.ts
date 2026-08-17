/**
 * Four straddles at once, each on its own exchange and its own front expiry.
 *
 * ── Why this is not four `useStraddleContract` calls in a loop ──
 *
 * It very nearly is, and deliberately so: each leg goes through the same query
 * keys, so a leg already open on the straddle page costs nothing to include
 * here. What it adds is the ONE thing a wall needs and a single chart does not —
 * a common baseline, so four contracts an order of magnitude apart in premium
 * can share a y-axis.
 *
 * Hooks cannot be called in a loop over a runtime-length array, so the legs are
 * a fixed tuple and each is unrolled. Four is the number that fits a screen; a
 * dynamic list would need a component per leg, which is the design this replaces.
 */

import { useMemo, useRef } from 'react';
import {
  sessionOpenOf, todayIST, useStraddleContract,
} from '@/components/straddle/useStraddleContract';
import { useLiveStraddle, type LiveStraddleState } from '@/hooks/useLiveStraddle';
import type { StraddlePoint } from '@/schemas/market';

/**
 * The wall's symbols.
 *
 * SENSEX is on BSE — verified against the live backend, where `SENSEX` on NSE
 * returns zero expiries and on BSE returns nineteen. `exchangeFor` only knows
 * the NSE and MCX names, so the exchange is declared here rather than looked up,
 * and getting it wrong is a silent empty chart rather than an error.
 */
export const WALL_SYMBOLS = [
  { symbol: 'NIFTY', exchange: 'NSE' },
  { symbol: 'BANKNIFTY', exchange: 'NSE' },
  { symbol: 'SENSEX', exchange: 'BSE' },
  { symbol: 'CRUDEOIL', exchange: 'MCX' },
] as const;

export interface WallLeg {
  symbol: string;
  exchange: string;
  expiry: string;
  /** History plus live ticks, one ascending series. */
  points: StraddlePoint[];
  last: StraddlePoint | null;
  /**
   * The session's opening premium, from `sessionOpenOf` — NOT `points[0]`.
   *
   * This is load-bearing for a normalised wall. A contract that has not printed
   * yet carries the previous session's marks in its first bar: on 2026-08-17
   * BANKNIFTY's first print was 308.90 against a session range of 309–890, which
   * as a baseline reads as +172% in a day. Every percent line on the chart hangs
   * off this number, so one stale bar would not perturb a leg, it would invent
   * the whole comparison.
   */
  open: number | null;
  low: number | null;
  high: number | null;
  live: LiveStraddleState;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
}

/** One leg: contract resolution, history, live merge, session baseline. */
function useWallLeg(symbol: string, exchange: string, date: string): WallLeg {
  const { expiry, history, points: walked } = useStraddleContract(symbol, '', date);

  const walkedDate = history.data?.date ?? '';
  const isToday = Boolean(walkedDate) && walkedDate === todayIST();
  const lastWalked = walked.length ? walked[walked.length - 1] : null;

  const gapRef = useRef(0);
  const live = useLiveStraddle({
    symbol,
    exchange,
    expiry,
    atmHint: lastWalked?.atmStrike ?? null,
    since: lastWalked?.time ?? null,
    enabled: isToday && Boolean(expiry),
    onGap: () => {
      const now = Date.now();
      if (now - gapRef.current < 30_000) return;
      gapRef.current = now;
      void history.refetch();
    },
  });

  const points = useMemo(() => {
    if (!live.points.length) return walked;
    const cutoff = lastWalked?.time ?? -Infinity;
    // A reload can overlap ticks already held, and lightweight-charts throws on
    // a non-ascending series.
    const fresh = live.points.filter((p) => p.time > cutoff);
    return fresh.length ? [...walked, ...fresh] : walked;
  }, [walked, live.points, lastWalked]);

  /*
   * The baseline is recomputed over history+live rather than reused from the
   * contract hook, whose `open` was measured on history alone. On a session that
   * began while the page was open, the trusted opening bar arrives as a LIVE
   * tick — and a baseline of null there would drop the leg off a percent chart
   * entirely.
   */
  const session = useMemo(() => sessionOpenOf(points), [points]);

  return {
    symbol,
    exchange,
    expiry,
    points,
    last: live.last ?? lastWalked ?? null,
    open: session.straddle,
    low: session.low,
    high: session.high,
    live: live.state,
    isLoading: history.isLoading,
    isFetching: history.isFetching,
    error: history.error,
  };
}

export function useStraddleWall(date: string): WallLeg[] {
  // Unrolled, because hooks cannot be called in a loop. The indices are pinned
  // to WALL_SYMBOLS so the two cannot drift.
  const a = useWallLeg(WALL_SYMBOLS[0].symbol, WALL_SYMBOLS[0].exchange, date);
  const b = useWallLeg(WALL_SYMBOLS[1].symbol, WALL_SYMBOLS[1].exchange, date);
  const c = useWallLeg(WALL_SYMBOLS[2].symbol, WALL_SYMBOLS[2].exchange, date);
  const d = useWallLeg(WALL_SYMBOLS[3].symbol, WALL_SYMBOLS[3].exchange, date);
  return useMemo(() => [a, b, c, d], [a, b, c, d]);
}

export interface WallSeriesPoint {
  time: number;
  value: number;
  /** The same instant in the other unit, for the tooltip. */
  note?: string;
}

/**
 * Percent change from the session baseline — the wall's shared unit.
 *
 * The rupee premium rides along as `note`, so the tooltip can show the level a
 * percent axis has thrown away. Building it here rather than in the chart is the
 * only place both numbers exist together.
 */
export function percentSeries(leg: WallLeg, step: number): WallSeriesPoint[] {
  const base = leg.open;
  if (!base || !(base > 0)) return [];

  const out: WallSeriesPoint[] = [];
  let bucket = -1;
  for (const point of leg.points) {
    const value = point.straddlePrice;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const at = Math.floor(point.time / 1000 / step) * step;
    const pct = (value / base - 1) * 100;
    const note = value.toFixed(2);
    // Last print in the bucket wins, matching `lineData`'s close-of-bucket
    // convention so the wall and the single-contract chart agree at every bar.
    if (at === bucket) {
      out[out.length - 1].value = pct;
      out[out.length - 1].note = note;
    } else {
      out.push({ time: at, value: pct, note });
      bucket = at;
    }
  }
  return out;
}

/**
 * Premium in rupees, with the percent as the note — the inverse of the above.
 *
 * Bucketed identically, so a reader switching modes sees the same bars at the
 * same instants rather than two slightly different samplings of one session.
 */
export function absoluteSeries(leg: WallLeg, step: number): WallSeriesPoint[] {
  const base = leg.open;
  const out: WallSeriesPoint[] = [];
  let bucket = -1;
  for (const point of leg.points) {
    const value = point.straddlePrice;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    const at = Math.floor(point.time / 1000 / step) * step;
    const pct = base && base > 0 ? (value / base - 1) * 100 : null;
    const note = pct == null ? undefined : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    if (at === bucket) {
      out[out.length - 1].value = value;
      out[out.length - 1].note = note;
    } else {
      out.push({ time: at, value, note });
      bucket = at;
    }
  }
  return out;
}
