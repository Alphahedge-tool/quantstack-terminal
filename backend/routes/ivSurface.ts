/**
 * Implied-vol surface for one asset and expiry.
 *
 *   GET /api/options/surface?symbol=&exchange=&expiry=&date=&width=
 *     → { spot, atmStrike, step, rows: [{ strike, side, iv, delta, ltp, steps }] }
 *
 * Built for the IV-arbitrage panel, which compares vol between two underlyings
 * at MATCHED moneyness — ATM against ATM, OTM3 against OTM3, or 25-delta against
 * 25-delta. That comparison only means anything if both sides are measured the
 * same way, so everything the matcher needs comes from here rather than being
 * reconstructed per-instrument on the client:
 *
 *   steps   how many strike-steps from ATM this strike is, signed. The strike
 *           LADDER differs between assets — NIFTY steps 50, SENSEX 100,
 *           BANKNIFTY 100 — so "three strikes out" is a different distance in
 *           rupees on each, and only a per-asset step makes OTM3 comparable.
 *   delta   solved from this contract's own IV. Delta-matching is the more
 *           honest comparison of the two: it normalises for the fact that the
 *           same step count sits at a different place on each asset's
 *           distribution once their vols differ.
 *
 * ── Units ──
 *
 * `iv` is a DECIMAL here (0.1048 = 10.48%), matching analytics/black76.ts and
 * feeds/types.ts. The straddle path scales to percent at its edge; this one does
 * not, because every consumer of this route does arithmetic on it.
 */

import { route, ApiError } from '../server.js';
import { activeFeed } from '../feeds/access.js';
import { keyOf, type InstrumentKey } from '../feeds/identity.js';
import { symbolOf } from '../instruments/symbol.js';
import { latestTradingDate, sessionRange } from '../engine/rollingStraddle.js';
import { black76Greeks, yearsToExpiry } from '../analytics/black76.js';
import { syntheticFuture } from '../analytics/syntheticFuture.js';
import type { OptionSeries } from '../feeds/types.js';

export interface SurfaceRow {
  strike: number;
  side: 'CE' | 'PE';
  /** Decimal. Null when the feed carried no vol for this contract. */
  iv: number | null;
  /** Signed, from Black-76 on this contract's own IV. Null without an IV. */
  delta: number | null;
  ltp: number | null;
  /** Signed strike-steps from ATM: −2 is two steps below, +3 three above. */
  steps: number;
  /**
   * Canonical symbol, e.g. `NIFTY18AUG2624300CE`.
   *
   * Carried so the browser can join a `/ws/live/quotes` tick to a row with a
   * map lookup. That socket indexes frames by canonical symbol, and the
   * alternative — rebuilding the symbol on the client — would put a second copy
   * of instruments/symbol.ts in the bundle and one more place for the two sides
   * to disagree about what identifies a contract.
   */
  symbol: string;
}

function lastOf(points: Array<{ ts: number; v: number }> | undefined): number | null {
  if (!points?.length) return null;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(points[i].v) && points[i].v > 0) return points[i].v;
  }
  return null;
}

/**
 * Mid IV from the two sides.
 *
 * `OptionSeries.ivMid` is always empty — QUOTE_FIELDS in lib/nubraData.ts asks
 * the feed for `iv_bid` and `iv_ask` and never `iv_mid`. Same trap as
 * routes/optionMarks.ts; both derive it rather than reading the field.
 */
function midIv(series: OptionSeries): number | null {
  const bid = lastOf(series.ivBid);
  const ask = lastOf(series.ivAsk);
  if (bid != null && ask != null) return (bid + ask) / 2;
  return bid ?? ask;
}

/**
 * The gap between adjacent strikes.
 *
 * The MODE of the differences, not the minimum or the mean. A chain routinely
 * carries a few half-step strikes near the money and widens in the far wings,
 * so the minimum reports 25 where the ladder is 50, and the mean reports
 * something that is not a real step at all. Both would put "OTM3" at a strike
 * that does not exist.
 */
function inferStep(strikes: number[]): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < strikes.length; i += 1) {
    const d = Math.round(strikes[i] - strikes[i - 1]);
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let step = 0;
  let best = 0;
  for (const [d, n] of counts) if (n > best) { best = n; step = d; }
  return step || 1;
}

route('GET', '/api/options/surface', async (_req, _res, { query }) => {
  const symbol   = String(query.get('symbol') || '').trim().toUpperCase();
  const exchange = String(query.get('exchange') || 'NSE').trim().toUpperCase();
  const expiry   = String(query.get('expiry') || '').trim();
  const date     = String(query.get('date') || latestTradingDate()).trim();
  // How many strikes either side of ATM. Bounded because each one costs a
  // series fetch on both sides of the chain.
  const width    = Math.min(20, Math.max(1, Number(query.get('width')) || 8));

  if (!symbol) throw new ApiError('symbol is required', 400);
  if (!expiry) throw new ApiError('expiry is required', 400);

  const feed = await activeFeed();

  const chain = await feed.chain(symbol, exchange, date, expiry);
  if (!chain.length) throw new ApiError(`No option chain for ${symbol} ${expiry}`, 404);

  const strikes = [...new Set(chain.map((r) => r.key.strike).filter((s): s is number => s != null))]
    .sort((a, b) => a - b);
  if (!strikes.length) throw new ApiError('No strikes listed', 404);

  const step = inferStep(strikes);

  // ── Underlying ─────────────────────────────────────────────────────────────
  const { start, end } = sessionRange(date, exchange);
  const to = Math.min(Date.now(), end);

  const underlyings = await feed.underlyings(symbol, exchange, date, expiry);
  let spot: number | null = null;
  const underlyingKey = underlyings[0]?.key ?? null;

  if (underlyings.length) {
    try {
      const candles = await feed.candles({
        key: underlyings[0].key, interval: '1m', from: start, to,
      });
      const last = candles.candles.at(-1);
      spot = last?.c ?? null;
    } catch {
      // Falls through to the ATM-by-parity path below.
    }
  }

  // Without a spot there is no ATM, and without an ATM `steps` is meaningless —
  // which is the one field the whole comparison hangs on. Refuse rather than
  // anchor the ladder to the middle of the listed range, which drifts with
  // whatever strikes happen to be listed.
  if (!(spot != null && spot > 0)) {
    throw new ApiError(`No underlying price for ${symbol} — cannot locate ATM`, 503);
  }

  const atmStrike = strikes.reduce((a, b) => (Math.abs(b - spot!) < Math.abs(a - spot!) ? b : a));
  const atmIndex = strikes.indexOf(atmStrike);

  const window = strikes.slice(
    Math.max(0, atmIndex - width),
    Math.min(strikes.length, atmIndex + width + 1),
  );

  // ── IV per contract ────────────────────────────────────────────────────────
  const keys: InstrumentKey[] = [];
  for (const strike of window) {
    for (const side of ['CE', 'PE'] as const) {
      keys.push({ exchange, asset: symbol, kind: 'OPT', expiry, strike, side });
    }
  }

  const result = await feed.optionSeries({ keys, interval: '1m', from: start, to });
  const years = yearsToExpiry(to, expiry.replace(/-/g, ''));

  const quoteOf = (key: InstrumentKey) => {
    const series = result.series.get(keyOf(key));
    return {
      iv: series ? midIv(series) : null,
      ltp: series ? lastOf(series.ltp) ?? lastOf(series.bid) : null,
    };
  };

  const quotes = new Map(keys.map((key) => [keyOf(key), quoteOf(key)]));
  const quoteAt = (strike: number, side: 'CE' | 'PE') =>
    quotes.get(keyOf({ exchange, asset: symbol, kind: 'OPT', expiry, strike, side }));

  // ── The forward ────────────────────────────────────────────────────────────
  //
  // Black-76 prices off the FORWARD, and spot is not it. Pricing off spot puts
  // the whole error into the vol, and asymmetrically: the call needs more vol
  // to reach its market price and the put needs less, so a call and a put at
  // one strike come out several vol points apart when parity says they must be
  // within a fraction of each other. That is a broken reading of the one number
  // this panel exists to report, not a small inaccuracy.
  //
  // So the forward comes from the market itself, by put-call parity —
  // F = K + CE − PE — which carries funding and dividends without either being
  // modelled. Median across ATM±2 rather than the ATM strike alone, because one
  // stale leg would otherwise move the forward for the entire surface.
  const parity = syntheticFuture(
    {
      strikes: window,
      callLtp: window.map((k) => quoteAt(k, 'CE')?.ltp ?? 0),
      putLtp: window.map((k) => quoteAt(k, 'PE')?.ltp ?? 0),
      spot,
      atm: atmStrike,
    },
    2,
  );

  // Falls back to spot when no strike near the money has both legs quoted. That
  // is the pre-forward behaviour and it is wrong in the way described above, so
  // the response says which one it got rather than leaving the reader to guess.
  const forward = parity.status ? parity.forward : spot;

  // ── ATM, re-anchored ───────────────────────────────────────────────────────
  //
  // At-the-money means at the money FORWARD. The window above was centred on
  // spot because the forward cannot be known until the quotes are in, so this
  // is the second pass: with a basis of half a step or more, the strike nearest
  // spot and the strike nearest the forward are different contracts, and every
  // `steps` label — and therefore every OTM3-against-OTM3 comparison — hangs on
  // getting it right.
  const atm = window.reduce((a, b) => (Math.abs(b - forward) < Math.abs(a - forward) ? b : a), atmStrike);

  const rows: SurfaceRow[] = keys.map((key) => {
    const { iv, ltp } = quotes.get(keyOf(key)) ?? { iv: null, ltp: null };

    // Delta from THIS contract's vol, not the ATM vol. Using one vol across the
    // chain would flatten the skew, and the skew is what a delta-matched
    // comparison is trying to see through.
    const delta = iv != null && years > 0
      ? black76Greeks(forward, key.strike!, years, iv, key.side!).delta
      : null;

    return {
      strike: key.strike!,
      side: key.side!,
      iv,
      delta,
      ltp,
      steps: Math.round((key.strike! - atm) / step),
      symbol: symbolOf(key),
    };
  });

  return {
    status: true,
    symbol, exchange, expiry, date,
    spot,
    /**
     * The market's own implied forward, by put-call parity. Every vol and greek
     * on this surface is struck against THIS, not against spot — see the note
     * above the calculation.
     */
    forward,
    /** False when no strike near the money had both legs quoted and `forward` fell back to spot. */
    forwardFromParity: parity.status,
    /** Basis in points. A surface whose forward is far from spot is worth a second look. */
    basis: forward - spot,
    atmStrike: atm,
    step,
    /** Years to expiry — the client needs it to compare like for like. */
    years,
    /**
     * The underlying this spot was read from.
     *
     * Handed over so the browser can put the same instrument on the live socket
     * rather than guessing at `{ asset, kind: 'SPOT' }`. Solving an IV from a
     * live premium against a spot that is up to a poll old prices the move into
     * the vol, which is the one number this panel exists to report — so the
     * forward has to tick with the premium. Null when the feed listed no
     * underlying, in which case the client keeps the spot quoted here.
     */
    underlying: underlyingKey
      ? { key: underlyingKey, symbol: symbolOf(underlyingKey) }
      : null,
    rows,
  };
});
