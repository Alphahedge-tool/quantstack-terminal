/**
 * Synthetic Future + Rolling ATM Straddle analytics.
 *
 * Synthetic Future (put-call parity):
 *   F = K + CE_ltp − PE_ltp
 *
 * This is the market's own implied forward price for expiry. It factors in
 * carry, dividends, and funding costs — everything spot does not show you.
 *
 * Straddle Price:
 *   S = CE_ltp + PE_ltp   (at the ATM strike)
 *
 * ATM Strike selection:
 *   nearestStrike(spotOrSynthetic, strikes, step)
 *
 * Roll event:
 *   A roll happens when the ATM strike changes from one bar to the next.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OptionChainSlice {
  strikes: number[];
  callLtp: number[];     // aligned to strikes
  putLtp:  number[];     // aligned to strikes
  spot:    number;
  atm?:    number;       // optional override
}

export interface SyntheticFutureResult {
  status:       true;
  spot:         number;
  atmStrike:    number;
  atmCall:      number;
  atmPut:       number;
  atmForward:   number;   // K + CE - PE at ATM only
  forward:      number;   // median across ATM±depth strikes (more robust)
  basis:        number;   // forward - spot
  basisPct:     number;   // basis / spot * 100
  strikesUsed:  number;
  samples:      Array<{ strike: number; forward: number }>;
}

export interface SyntheticFutureError {
  status:  false;
  message: string;
}

export type SyntheticFutureOutput = SyntheticFutureResult | SyntheticFutureError;

export interface StraddlePoint {
  time:            number;   // epoch ms
  spot:            number;
  atmStrike:       number;
  syntheticFuture: number;   // K + CE - PE (median across ATM±depth)
  callLtp:         number;
  putLtp:          number;
  straddlePrice:   number;   // CE + PE
  straddleBid?:    number;
  straddleAsk?:    number;
  iv?:             number;   // IV mid (%) if available
  /**
   * Where `iv` came from. The feed only carries IV for recent contracts, so a
   * long backtest legitimately mixes both — and a spliced series that does not
   * say which is which is impossible to audit when the two disagree.
   */
  ivSource?:       'feed' | 'black76';

  /**
   * Greeks of the straddle actually held at this bar — CE + PE at the SELECTED
   * strike, so they roll with it. Vega per vol point, theta per calendar day,
   * both per 1 unit of the underlying (not per lot), matching the points
   * convention every other price on this object uses.
   *
   * A long straddle has vega > 0 and theta < 0. Undefined when neither leg
   * published a greek and no vol was recoverable to derive one — the same
   * "absent, not zero" discipline `iv` follows.
   */
  vega?:           number;
  theta?:          number;
  /** Straddle delta (CE + PE) — near zero at the money, the residual after a roll. */
  delta?:          number;
  gamma?:          number;
  /** Where the greeks came from, for the same audit reason as `ivSource`. */
  greekSource?:    'feed' | 'black76';

  isRollEvent:     boolean;

  /**
   * Microstructure around the straddle at the same instant the point was
   * computed — depth, open interest and volume for the strike actually held.
   *
   * Only the Go engine (`backend-go/straddle`) fills this in, so it is absent
   * on every historical point and on any live point produced by the TypeScript
   * engine. Nested rather than flattened so a consumer that has never heard of
   * it drops one key instead of nine, and so the fields above stay exactly the
   * shape the chart has always bound to.
   *
   * One instant is the reason it lives on the point at all: open interest read
   * a second later is a different number from the one that priced this
   * straddle, and "OI jumped while the straddle was at X" is only a statement
   * if the two were observed together.
   */
  micro?: StraddleMicro;
}

/** See StraddlePoint.micro. Every field is absent rather than zero when the
 *  feed did not publish what it is derived from. */
export interface StraddleMicro {
  /** CE spread + PE spread: what it costs to get out of the whole position. */
  spreadRs?:    number;
  spreadBps?:   number;
  /** Mean of the two legs' book imbalance, in [-1, +1]. Summing a ratio would
   *  produce a number in [-2, 2] that means nothing. */
  imbalance?:   number;
  microprice?:  number;

  callOi?:      number;
  putOi?:       number;
  totalOi?:     number;
  oiChange?:    number;
  oiChangePct?: number;
  /** Put OI over call OI at the held strike. */
  pcr?:         number;

  callVolume?:  number;
  putVolume?:   number;

  /** Both legs were quoted two-sided at selection time. False means the mid
   *  came off an LTP fallback for at least one leg. */
  firm:         boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nearestIndex(strikes: number[], target: number): number {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const gap = Math.abs(strikes[i] - target);
    if (gap < bestGap) { bestGap = gap; best = i; }
  }
  return best;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ─── Nearest-strike lookup ────────────────────────────────────────────────────

export function inferStep(strikes: number[]): number {
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) {
    const diff = strikes[i] - strikes[i - 1];
    if (diff > 0) step = Math.min(step, diff);
  }
  return Number.isFinite(step) ? step : 50;
}

export function nearestStrike(price: number, strikes: number[], step: number): number {
  const target = step > 0 ? Math.round(price / step) * step : price;
  return strikes.reduce(
    (best, s) => Math.abs(s - target) < Math.abs(best - target) ? s : best,
    strikes[0],
  );
}

/** ATM ± BAND strikes, de-duplicated. */
export function candidateStrikes(atm: number, strikes: number[], step: number, band = 2): number[] {
  const out: number[] = [];
  for (let offset = -band; offset <= band; offset++) {
    out.push(nearestStrike(atm + offset * step, strikes, step));
  }
  return [...new Set(out)];
}

// ─── Synthetic Future ─────────────────────────────────────────────────────────

/**
 * Derive the synthetic future from a chain snapshot.
 *
 * @param chain  { strikes, callLtp, putLtp, spot, atm? }
 * @param depth  Number of strikes either side of ATM to corroborate with (default 2)
 */
export function syntheticFuture(
  chain: OptionChainSlice,
  depth = 2,
): SyntheticFutureOutput {
  const strikes = (chain.strikes || []).map(Number);
  const callLtp = chain.callLtp || [];
  const putLtp  = chain.putLtp  || [];
  const spot    = Number(chain.spot) || 0;

  if (!strikes.length || !(spot > 0)) {
    return { status: false, message: 'Chain has no strikes or spot' };
  }

  const atm      = Number(chain.atm) > 0 ? Number(chain.atm) : spot;
  const atmIndex = nearestIndex(strikes, atm);
  if (atmIndex < 0) return { status: false, message: 'Could not locate ATM strike' };

  const samples: Array<{ strike: number; forward: number; call: number; put: number }> = [];
  const lo = Math.max(0, atmIndex - depth);
  const hi = Math.min(strikes.length - 1, atmIndex + depth);

  for (let i = lo; i <= hi; i++) {
    const call = Number(callLtp[i]);
    const put  = Number(putLtp[i]);
    if (!(call > 0) || !(put > 0)) continue;   // zero = unquoted, skip
    samples.push({ strike: strikes[i], forward: strikes[i] + call - put, call, put });
  }

  if (!samples.length) {
    return { status: false, message: 'No strike near ATM has both a call and a put quote' };
  }

  const atmSample = samples.find((s) => s.strike === strikes[atmIndex]) || samples[0];
  const forward   = median(samples.map((s) => s.forward));
  const basis     = forward - spot;

  return {
    status:       true,
    spot,
    atmStrike:    strikes[atmIndex],
    atmCall:      atmSample.call,
    atmPut:       atmSample.put,
    atmForward:   atmSample.forward,
    forward,
    basis,
    basisPct:     spot > 0 ? (basis / spot) * 100 : 0,
    strikesUsed:  samples.length,
    samples:      samples.map((s) => ({ strike: s.strike, forward: s.forward })),
  };
}

// ─── Advancing quote cursor (for timeseries walk) ────────────────────────────

export interface QuoteCursor {
  bi: number; ai: number; ibi: number; iai: number; imi: number;
  bid: number; ask: number; ivBid: number | null; ivAsk: number | null; ivMid: number | null;
  /** Greek walk indices and last-good values. Null until the feed publishes one. */
  di: number; gi: number; vi: number; ti: number;
  delta: number | null; gamma: number | null; vega: number | null; theta: number | null;
}

/** What advanceQuote hands back — a read-only view of the cursor's state. */
export type Quote = Omit<QuoteCursor, 'bi' | 'ai' | 'ibi' | 'iai' | 'imi' | 'di' | 'gi' | 'vi' | 'ti'>;

import type { OptionSeries } from '../feeds/types.js';

/**
 * Advance the quote cursor for one option up to `ts` (carry-forward semantics).
 * Returns the latest {bid, ask, ivMid} at or before ts.
 *
 * `name` is whatever the caller keys its series map by. The engine now passes
 * canonical instrument keys (`NSE:NIFTY:OPT:2026-08-11:24500:CE`) rather than a
 * broker's symbol — the uppercasing below is a no-op on those, since a key
 * carries no lowercase letters.
 */
export function advanceQuote(
  name: string,
  seriesByName: Map<string, OptionSeries>,
  cursorByName: Map<string, QuoteCursor>,
  ts: number,
): Quote {
  const keyName = String(name || '').toUpperCase();
  const series  = seriesByName.get(keyName);
  if (!series) {
    return {
      bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null,
      delta: null, gamma: null, vega: null, theta: null,
    };
  }

  const cursor: QuoteCursor = cursorByName.get(keyName) || {
    bi: 0, ai: 0, ibi: 0, iai: 0, imi: 0,
    bid: 0, ask: 0, ivBid: null, ivAsk: null, ivMid: null,
    di: 0, gi: 0, vi: 0, ti: 0,
    delta: null, gamma: null, vega: null, theta: null,
  };

  while (cursor.bi < series.bid.length   && series.bid[cursor.bi].ts   <= ts) { cursor.bid   = series.bid[cursor.bi].v;   cursor.bi++;  }
  while (cursor.ai < series.ask.length   && series.ask[cursor.ai].ts   <= ts) { cursor.ask   = series.ask[cursor.ai].v;   cursor.ai++;  }
  while (cursor.ibi < (series.ivBid?.length || 0) && series.ivBid[cursor.ibi].ts <= ts) { cursor.ivBid = series.ivBid[cursor.ibi].v; cursor.ibi++; }
  while (cursor.iai < (series.ivAsk?.length || 0) && series.ivAsk[cursor.iai].ts <= ts) { cursor.ivAsk = series.ivAsk[cursor.iai].v; cursor.iai++; }
  while (cursor.imi < (series.ivMid?.length || 0) && series.ivMid[cursor.imi].ts <= ts) { cursor.ivMid = series.ivMid[cursor.imi].v; cursor.imi++; }

  // Greeks walk with the same carry-forward semantics as the quote. A contract
  // whose greek series is missing entirely keeps its null, which is what makes
  // "feed did not publish this" distinguishable from "the greek is zero".
  const greeks = [
    ['delta', 'di'], ['gamma', 'gi'], ['vega', 'vi'], ['theta', 'ti'],
  ] as const;
  for (const [field, idx] of greeks) {
    const arr = series[field];
    if (!arr?.length) continue;
    while (cursor[idx] < arr.length && arr[cursor[idx]].ts <= ts) {
      cursor[field] = arr[cursor[idx]].v;
      cursor[idx]++;
    }
  }

  cursorByName.set(keyName, cursor);
  return cursor;
}

export function ivMidOf(quote: { ivMid: number | null; ivBid: number | null; ivAsk: number | null }): number | null {
  if (quote.ivMid != null) return quote.ivMid;
  if (quote.ivBid != null && quote.ivAsk != null) return (quote.ivBid + quote.ivAsk) / 2;
  return null;
}
