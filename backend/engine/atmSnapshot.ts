/**
 * One ATM reading for one expiry — the cheap answer to "what is this contract
 * priced at right now".
 *
 * The rolling engine answers a different question: it walks a whole session bar
 * by bar to produce a chart. Reading a single current value off the end of that
 * costs a full session compute (~22k points, every strike the spot visited),
 * which is fine once per charted contract and ruinous when a term-structure
 * view asks for six expiries at once.
 *
 * This does the same selection — ATM from spot, candidates at ATM ± 2, cheapest
 * mid wins — over a short window at the end of the session instead of all of
 * it. Ten contracts, one interval, no walk. The number it returns is the same
 * number the last point of a full run would carry.
 */

import type { MarketDataFeed } from '../feeds/types.js';
import { keyOf } from '../feeds/identity.js';
import {
  inferStep, nearestStrike, candidateStrikes, ivMidOf,
} from '../analytics/syntheticFuture.js';
import { sessionRange } from './rollingStraddle.js';

const BAND = 2;

/**
 * Look-back ladder, in minutes before the reference instant.
 *
 * Thin contracts do not print every minute — an MCX far-month can go an hour
 * between quotes — so a single window would report "no data" for a contract
 * that is merely quiet. Each step is tried in turn and the first that carries
 * quotes wins; the last is effectively the whole session.
 */
const LOOKBACK_LADDER_MIN = [30, 120, 900];

export interface AtmSnapshot {
  expiry:           string;
  atmStrike:        number | null;
  straddleMid:      number | null;
  straddleBid:      number | null;
  straddleAsk:      number | null;
  iv:               number | null;
  syntheticFuture:  number | null;
  spot:             number | null;
  /** Timestamp of the quote this reading came from, epoch ms. */
  ts:               number | null;
  error?:           string;
}

function empty(expiry: string, error: string): AtmSnapshot {
  return {
    expiry, atmStrike: null, straddleMid: null, straddleBid: null,
    straddleAsk: null, iv: null, syntheticFuture: null, spot: null, ts: null, error,
  };
}

/** Last point of a series, or null when it never printed. */
function lastOf(points: Array<{ ts: number; v: number }> | undefined): { ts: number; v: number } | null {
  if (!points?.length) return null;
  const p = points[points.length - 1];
  return Number.isFinite(p.v) && p.v > 0 ? p : null;
}

/**
 * Feed IV → percent.
 *
 * Nubra's timeseries returns IV as a plain decimal — 0.1048 means 10.48% (see
 * the unit conventions in feeds/types.ts). The rolling engine scales it by 100
 * when it builds a point, so this must too: the compare panel reads a cached
 * SESSION for an expiry it has charted and this snapshot for one it has not,
 * and the two rows sit next to each other. A scale that differed between them
 * would put 10.48 above 0.10 for contracts a few days apart and read as a
 * collapse in vol.
 *
 * Deliberately a hard ×100 rather than the "looks small, must be a fraction"
 * guess the live websocket path makes. That guess is right for the socket,
 * whose streams disagree with each other about units, and wrong here: it would
 * leave a genuine 150% IV (a commodity on expiry day) as 1.5%.
 */
function toPercent(iv: number | null): number | null {
  return iv != null && Number.isFinite(iv) && iv > 0 ? iv * 100 : null;
}

export async function atmSnapshot(opts: {
  symbol:   string;
  exchange: string;
  date:     string;
  /** Canonical ISO expiry. */
  expiry:   string;
  feed:     MarketDataFeed;
}): Promise<AtmSnapshot> {
  const { symbol, exchange, date, expiry, feed } = opts;

  try {
    const rows = await feed.chain(symbol, exchange, date, expiry);
    if (!rows.length) return empty(expiry, 'No option rows for this expiry');

    const strikes = [...new Set(rows.map((r) => r.key.strike!))]
      .filter((s) => Number.isFinite(s))
      .sort((a, b) => a - b);
    if (!strikes.length) return empty(expiry, 'No strikes listed');
    const step = inferStep(strikes);

    const underlyings = await feed.underlyings(symbol, exchange, date, expiry);
    if (!underlyings.length) return empty(expiry, 'No underlying instrument');

    // The reference instant: now for a live session, the close for a past one.
    // Clamped to the session so an out-of-hours request reads the day's last
    // quotes rather than an empty window after the bell.
    const { start, end } = sessionRange(date, exchange);
    const to = Math.min(Date.now(), end);
    if (to < start) return empty(expiry, 'Session has not opened yet');

    // ── Spot, over the narrowest window that carries a print ─────────────────
    let spot: number | null = null;
    let spotTs = to;
    let from = start;

    for (const minutes of LOOKBACK_LADDER_MIN) {
      from = Math.max(start, to - minutes * 60_000);
      let found = false;
      for (const ref of underlyings) {
        try {
          const { candles } = await feed.candles({ key: ref.key, interval: '1m', from, to });
          const last = candles.filter((c) => Number.isFinite(c.c) && c.c > 0).pop();
          if (last) { spot = last.c; spotTs = last.ts; found = true; break; }
        } catch {
          // A candidate the feed does not carry is the reason `underlyings`
          // returns a chain rather than one name — try the next.
        }
      }
      if (found) break;
    }
    if (spot == null) return empty(expiry, 'No underlying quotes in session');

    // ── Quotes for the band around ATM ───────────────────────────────────────
    const atm  = nearestStrike(spot, strikes, step);
    const band = candidateStrikes(atm, strikes, step, BAND);

    const rowByLeg = new Map(rows.map((r) => [`${r.key.strike}|${r.key.side}`, r]));
    const keys = band
      .flatMap((strike) => [rowByLeg.get(`${strike}|CE`), rowByLeg.get(`${strike}|PE`)])
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => r.key);

    if (!keys.length) return empty(expiry, 'No CE/PE contracts around ATM');

    const { series } = await feed.optionSeries({ keys, interval: '1m', from, to });
    if (!series.size) return empty(expiry, 'No quotes around ATM in session');

    // ── Cheapest two-sided straddle in the band ──────────────────────────────
    let best: AtmSnapshot | null = null;

    for (const strike of band) {
      const ce = rowByLeg.get(`${strike}|CE`);
      const pe = rowByLeg.get(`${strike}|PE`);
      if (!ce || !pe) continue;
      const cs = series.get(keyOf(ce.key));
      const ps = series.get(keyOf(pe.key));
      if (!cs || !ps) continue;

      const cBid = lastOf(cs.bid), cAsk = lastOf(cs.ask);
      const pBid = lastOf(ps.bid), pAsk = lastOf(ps.ask);
      if (!cBid || !cAsk || !pBid || !pAsk) continue;

      const bid = cBid.v + pBid.v;
      const ask = cAsk.v + pAsk.v;
      const mid = (bid + ask) / 2;
      if (best?.straddleMid != null && mid >= best.straddleMid) continue;

      const cMid = (cBid.v + cAsk.v) / 2;
      const pMid = (pBid.v + pAsk.v) / 2;
      // Scaled to percent before the filter and the average, so both operate on
      // the units the caller will display.
      const ivs  = [cs, ps]
        .map((s) => toPercent(ivMidOf({
          ivMid: lastOf(s.ivMid)?.v ?? null,
          ivBid: lastOf(s.ivBid)?.v ?? null,
          ivAsk: lastOf(s.ivAsk)?.v ?? null,
        })))
        .filter((v): v is number => v != null && v > 0);

      best = {
        expiry,
        atmStrike:       strike,
        straddleMid:     mid,
        straddleBid:     bid,
        straddleAsk:     ask,
        iv:              ivs.length ? ivs.reduce((s, v) => s + v, 0) / ivs.length : null,
        // Put-call parity on the selected strike, same identity the chart plots.
        syntheticFuture: strike + cMid - pMid,
        spot,
        ts:              Math.max(cBid.ts, pBid.ts, spotTs),
      };
    }

    return best ?? empty(expiry, 'No two-sided quote around ATM');
  } catch (err) {
    return empty(expiry, (err as Error)?.message || 'Snapshot failed');
  }
}
