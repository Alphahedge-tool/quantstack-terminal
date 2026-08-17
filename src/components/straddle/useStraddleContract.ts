/**
 * One contract's worth of straddle state: its exchange, its expiry list, the
 * expiry actually in force, and the session walk.
 *
 * Extracted because two callers need the SAME answer for the same contract —
 * each chart slot draws it, and the page's stat strip describes whichever slot
 * has focus. Both call this hook; TanStack Query dedupes them onto one request
 * because the keys match, so the strip costs nothing. Duplicating the
 * expiry-resolution rule in two places instead would let the strip and the
 * chart under it disagree about which expiry they are showing.
 */

import { useMemo } from 'react';
import { useStraddleExpiries, useStraddleHistory } from '@/hooks/queries';
import type { StraddlePoint } from '@/schemas/market';

/**
 * Each underlying carries its own exchange. Defaulting everything to NSE — as
 * the backend does when the param is absent — silently asks for a CRUDEOIL
 * contract on the wrong exchange and gets nothing back.
 */
export const UNDERLYINGS = [
  { value: 'NIFTY', exchange: 'NSE' },
  { value: 'BANKNIFTY', exchange: 'NSE' },
  { value: 'FINNIFTY', exchange: 'NSE' },
  { value: 'MIDCPNIFTY', exchange: 'NSE' },
  { value: 'CRUDEOIL', exchange: 'MCX' },
  { value: 'CRUDEOILM', exchange: 'MCX' },
  { value: 'NATURALGAS', exchange: 'MCX' },
] as const;

/**
 * Today's session date in IST, as `YYYY-MM-DD`.
 *
 * Shifted by the offset and then formatted as UTC, which is what makes it the
 * IST WALL-CLOCK date rather than the browser's. A trader in London looking at
 * an Indian session at 20:00 their time is on tomorrow's date by their own
 * clock; the exchange is not, and the exchange is what the backend resolved its
 * walk against.
 *
 * Shared by the page and the slot: both decide whether to open a live feed from
 * it, and two definitions that could drift would let the strip go live while the
 * chart stayed historical.
 */
export function todayIST(): string {
  return new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
}

export function exchangeFor(symbol: string): string {
  return UNDERLYINGS.find((u) => u.value === symbol)?.exchange ?? 'NSE';
}

/**
 * Keep the roll events that actually settled, and drop the boundary chatter.
 *
 * The engine emits a roll every time the ATM strike changes, which is correct
 * as a record. But when the synthetic future sits on a strike boundary it
 * crosses back and forth once a second: a measured NIFTY session produced 408
 * roll events across THREE distinct strikes. Marking all of them papers the
 * chart in arrows and hides the two or three moves that actually mattered.
 *
 * A roll is kept when the new strike HELD for `dwellMs` before the next change,
 * and when it is a different level from the last one kept. What survives is the
 * regime changes — which is what a marker on a price chart is claiming to be.
 * Nothing is thrown away silently: the raw count is returned alongside.
 */
export function settledRolls<T extends { time: number; toStrike?: number | null }>(
  events: readonly T[],
  dwellMs = 60_000,
): T[] {
  const kept: T[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    const next = events[i + 1];
    if ((next ? next.time : Infinity) - event.time < dwellMs) continue;
    const previous = kept[kept.length - 1];
    if (previous && previous.toStrike === event.toStrike) continue;
    kept.push(event);
  }
  return kept;
}

/**
 * Where the real session starts, and what it opened at.
 *
 * ── The problem this exists to solve ──
 *
 * The engine emits a bar for the first second of the session whether or not the
 * market has printed yet, and when it has not, that bar carries the PREVIOUS
 * session's marks. Measured on CRUDEOILM 2026-08-14:
 *
 *   09:00:00   call  96.30 + put  86.00 = 182.30   ← stale carry-over
 *   09:00:01   call 154.90 + put 147.80 = 302.70   ← the market actually opens
 *
 * The backend's `entryStraddle` is that first bar, so every "since the open"
 * figure derived from it was measured against a price that did not exist in
 * this session. On that contract it did not merely skew the numbers, it
 * INVERTED them: the straddle read +64.08 (+35%) on a day it decayed 48 points,
 * and ATM IV showed a rising arrow while the plotted line fell from 50% to 43%.
 * A header that disagrees with the chart under it is worse than no header.
 *
 * ── How the stale bars are found ──
 *
 * The median of the opening minute is the yardstick, because a median cannot be
 * moved by the handful of bad bars it is being used to detect — no threshold
 * tuning, and a mid-roll bar in the window does not shift it either. Leading
 * bars further than 25% from that median are treated as carry-over and skipped.
 *
 * The reported open is then the first bar that PASSED, not the median itself.
 * The median is a synthetic number no one could have traded; "the open" should
 * be a real print, and using the median would trade one kind of fiction for
 * another.
 *
 * Everything session-relative comes from here — the change, the direction
 * arrows, and the high/low band — so they cannot disagree with each other.
 */
export interface SessionOpen {
  /** Index of the first bar trusted as real trading. */
  from: number;
  /** Leading bars rejected as carry-over. Normally 0 or 1. */
  skipped: number;
  straddle: number | null;
  iv: number | null;
  spot: number | null;
  syntheticFuture: number | null;
  /** Straddle high/low over the trusted region only — a stale opening print is
   *  otherwise the session low, and the current price reads as mid-range when
   *  it is really near the bottom. */
  low: number | null;
  high: number | null;
}

const OPENING_WINDOW_MS = 60_000;
const STALE_TOLERANCE = 0.25;

export function sessionOpenOf(points: readonly StraddlePoint[]): SessionOpen {
  const empty: SessionOpen = {
    from: 0, skipped: 0,
    straddle: null, iv: null, spot: null, syntheticFuture: null,
    low: null, high: null,
  };
  if (!points.length) return empty;

  const until = points[0].time + OPENING_WINDOW_MS;
  const opening: number[] = [];
  for (const point of points) {
    if (point.time > until) break;
    if (Number.isFinite(point.straddlePrice)) opening.push(point.straddlePrice as number);
  }

  let from = 0;
  // Too few prints to judge an outlier against. Detecting staleness off two or
  // three samples would reject real bars on a thin contract, which is a worse
  // failure than the one being fixed.
  if (opening.length >= 5) {
    const sorted = [...opening].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    if (median > 0) {
      for (let i = 0; i < points.length; i += 1) {
        const value = points[i].straddlePrice;
        if (!Number.isFinite(value)) continue;
        if (Math.abs((value as number) - median) / median <= STALE_TOLERANCE) {
          from = i;
          break;
        }
      }
    }
  }

  const open: SessionOpen = { ...empty, from, skipped: from };
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (let i = from; i < points.length; i += 1) {
    const point = points[i];
    if (open.straddle === null && Number.isFinite(point.straddlePrice)) {
      open.straddle = point.straddlePrice as number;
    }
    if (open.iv === null && Number.isFinite(point.iv)) open.iv = point.iv as number;
    if (open.spot === null && Number.isFinite(point.spot)) open.spot = point.spot as number;
    if (open.syntheticFuture === null && Number.isFinite(point.syntheticFuture)) {
      open.syntheticFuture = point.syntheticFuture as number;
    }
    if (Number.isFinite(point.straddlePrice)) {
      const value = point.straddlePrice as number;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }

  open.low = Number.isFinite(low) ? low : null;
  open.high = Number.isFinite(high) ? high : null;
  return open;
}

export function useStraddleContract(symbol: string, expiryPreference: string, date: string) {
  const exchange = exchangeFor(symbol);

  const expiries = useStraddleExpiries(symbol, exchange, date);
  const available = useMemo(() => expiries.data?.expiries ?? [], [expiries.data]);

  /**
   * Honour the user's pick, fall back to the front expiry.
   *
   * The `includes` check is what makes changing the DAY safe: an expiry that
   * had already expired by the session being loaded is silently dropped back to
   * the front month rather than sent to the backend as a contract that never
   * existed on that date.
   */
  const expiry =
    expiryPreference && available.includes(expiryPreference)
      ? expiryPreference
      : available[0] || '';

  const history = useStraddleHistory(symbol, exchange, expiry, date);

  const points = useMemo(() => history.data?.points ?? [], [history.data]);
  const rawRolls = useMemo(() => history.data?.rollEvents ?? [], [history.data]);
  const rolls = useMemo(() => settledRolls(rawRolls), [rawRolls]);
  const open = useMemo(() => sessionOpenOf(points), [points]);

  return {
    exchange,
    expiries,
    available,
    expiry,
    history,
    points,
    rolls,
    rawRollCount: rawRolls.length,
    open,
    last: points[points.length - 1],
  };
}
