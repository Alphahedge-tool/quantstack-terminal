/**
 * The expiry cockpit, rebuilt for a session that has already happened.
 *
 * ── Why this can exist ──
 *
 * It was written off. The live store's own header said open interest had no
 * history and that walls, migration and every gamma figure could therefore
 * never be backtested — a conclusion reached by probing `oi`, `open_interest`
 * and `openInterest`, all of which `charts/timeseries` accepts and answers with
 * nothing. The documented field is `cumulative_oi`, and it is served: measured
 * at 376 one-minute points for a single contract in one session, moving through
 * 363 distinct values, and reaching back at least 180 days.
 *
 * So the whole cockpit is backtestable, and this module is the proof: same
 * metrics, same shapes, same panels — over a date rather than over a socket.
 *
 * ── Where it differs from the live path, and why ──
 *
 * SPOT is the synthetic forward, not the index. The live chain publishes an
 * underlying price; history would need a separate spot series per session and a
 * second failure mode when a thin underlying goes unquoted. The forward is
 * already in the option prices — `K + CE − PE` at the ATM — so the replay reads
 * the market's own number instead of fetching a second one. It is also the more
 * honest input for gamma and for the flip, both of which are properties of the
 * forward rather than of spot.
 *
 * GAMMA falls back to Black-76. The feed serves gamma for roughly the last
 * month and OI for at least six, so any older session has the OI needed for GEX
 * and no gamma to multiply it by. Rather than silently produce a flat profile,
 * the replay inverts the vol from the straddle and prices the gamma itself —
 * the same `analytics/black76` the straddle engine already trusts for IV.
 */

import { activeFeed } from '../feeds/access.js';
import { keyOf } from '../feeds/identity.js';
import { sessionRange } from '../engine/rollingStraddle.js';
import { impliedVolStraddle, black76Greeks, yearsToExpiry } from '../analytics/black76.js';
import {
  atmView, buildLadder, classifyFlow, classifyRegime, expectedMovePct, gammaFlip,
  minutesToExpiry, oiMigration, pressureOf, realizedVolPct, wallsOf,
  type ExpiryBar, type Leg, type Rung,
} from '../analytics/expiryMetrics.js';
import type { OptionSeries, Point } from '../feeds/types.js';

/** Strikes either side of the day's opening ATM. 21 strikes both sides is
 *  ~42 contracts — six batches of eight, which the pool runs in two rounds. */
const SPAN = 20;

export interface ReplayResult {
  symbol: string;
  exchange: string;
  expiry: string;
  date: string;
  /** Where each figure came from, because a replay that looks live and is not
   *  is the most dangerous thing this file could produce. */
  source: 'replay';
  gammaSource: 'feed' | 'black76' | 'mixed' | 'none';
  contracts: number;
  bars: ExpiryBar[];
  ladder: Rung[];
  regime: ReturnType<typeof classifyRegime>['regime'];
  regimeNote: string;
  pressure: ReturnType<typeof pressureOf>;
  migration: ReturnType<typeof oiMigration>;
  callWall: number | null;
  putWall: number | null;
  maxPain: number | null;
  minutesToExpiry: number | null;
  tookMs: number;
}

/** A cursor that carries a series' last value forward to a timestamp. */
class Cursor {
  private i = 0;
  private last: number | null = null;
  constructor(private readonly points: Point[] | undefined) {}
  at(ts: number): number | null {
    const points = this.points;
    if (!points) return this.last;
    while (this.i < points.length && points[this.i].ts <= ts) {
      this.last = points[this.i].v;
      this.i += 1;
    }
    return this.last;
  }
}

interface LegCursors {
  strike: number;
  side: 'CE' | 'PE';
  bid: Cursor; ask: Cursor; ltp: Cursor;
  /**
   * IV comes as a BID/ASK PAIR, not as a mid.
   *
   * `QUOTE_FIELDS` asks for `iv_bid` and `iv_ask`; `iv_mid` exists on the
   * endpoint but is not in the set the engine has always requested, so
   * `series.ivMid` is empty on every historical fetch. Reading it directly gave
   * a replay with no IV at all — and a null IV silently disables the modelled
   * gamma below, which is what a session older than the greek window depends on.
   */
  ivBid: Cursor; ivAsk: Cursor; ivMid: Cursor;
  gamma: Cursor; oi: Cursor; volume: Cursor;
}

/** The mid of whatever the feed published, in VOL POINTS. */
function ivAt(c: LegCursors, ts: number): number | undefined {
  const mid = c.ivMid.at(ts);
  if (mid != null && mid > 0) return mid * 100;
  const bid = c.ivBid.at(ts);
  const ask = c.ivAsk.at(ts);
  if (bid != null && ask != null && bid > 0 && ask > 0) return ((bid + ask) / 2) * 100;
  const one = bid ?? ask;
  return one != null && one > 0 ? one * 100 : undefined;
}

export async function replayExpiry(opts: {
  symbol: string;
  exchange: string;
  expiry: string;
  date: string;
  interval?: string;
}): Promise<ReplayResult> {
  const started = Date.now();
  const symbol = opts.symbol.toUpperCase();
  const exchange = opts.exchange.toUpperCase();
  const expiry = opts.expiry.replace(/-/g, '');
  const date = opts.date;
  // One bar a minute, matching the live store. A replay at 1s would be 22k
  // ladders of 42 contracts for no extra signal — every rate in `expiryMetrics`
  // is defined per minute.
  const interval = opts.interval || '1m';

  const feed = await activeFeed();
  const { start, end } = sessionRange(date, exchange);

  const isoExpiry = `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
  const rows = await feed.chain(symbol, exchange, date, isoExpiry);
  if (!rows.length) {
    throw new Error(`No ${symbol} ${isoExpiry} contracts listed on ${date}`);
  }

  /*
   * The strike window, centred without a spot fetch.
   *
   * The median listed strike is a good enough centre: exchanges list strikes
   * symmetrically around the underlying, so the middle of the ladder tracks it
   * within a few strikes — which the ±20 span absorbs. A wrong centre would
   * show up immediately as an ATM pinned to the edge of the window.
   */
  const strikes = [...new Set(rows.map((r) => r.key.strike ?? 0))]
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  const centre = strikes[Math.floor(strikes.length / 2)];
  const lo = strikes[Math.max(0, strikes.indexOf(centre) - SPAN)];
  const hi = strikes[Math.min(strikes.length - 1, strikes.indexOf(centre) + SPAN)];
  const wanted = rows.filter((r) => (r.key.strike ?? 0) >= lo && (r.key.strike ?? 0) <= hi);

  const { series } = await feed.optionSeries({
    keys: wanted.map((r) => r.key),
    interval,
    from: start,
    to: end,
    // Gamma only. delta/vega/theta are not read by anything on this page, and
    // each one is another full series per contract.
    greeks: ['gamma'],
    extras: ['oi', 'volume'],
  });
  if (!series.size) {
    throw new Error(`No option series for ${symbol} ${isoExpiry} on ${date}`);
  }

  const cursors: LegCursors[] = [];
  let fedGamma = 0;
  for (const row of wanted) {
    const s: OptionSeries | undefined = series.get(keyOf(row.key));
    if (!s) continue;
    const side = row.key.side === 'PE' ? 'PE' : 'CE';
    if (s.gamma?.length) fedGamma += 1;
    cursors.push({
      strike: row.key.strike ?? 0,
      side,
      bid: new Cursor(s.bid), ask: new Cursor(s.ask), ltp: new Cursor(s.ltp),
      ivBid: new Cursor(s.ivBid), ivAsk: new Cursor(s.ivAsk), ivMid: new Cursor(s.ivMid),
      gamma: new Cursor(s.gamma),
      oi: new Cursor(s.oi), volume: new Cursor(s.volume),
    });
  }

  /* ── The walk ──────────────────────────────────────────────────────────── */

  const bars: ExpiryBar[] = [];
  const spots: number[] = [];
  const lastLtp = new Map<string, number>();
  const lastOi = new Map<string, number>();
  let ladder: Rung[] = [];
  let modelledGamma = 0;

  for (let ts = start; ts <= end; ts += 60_000) {
    const legs: Leg[] = [];
    for (const c of cursors) {
      const bid = c.bid.at(ts);
      const ask = c.ask.at(ts);
      const ltp = c.ltp.at(ts) ?? (bid != null && ask != null ? (bid + ask) / 2 : null);
      legs.push({
        strike: c.strike,
        side: c.side,
        ltp: ltp ?? undefined,
        // Decimal on the wire, vol points on the page — the same convention
        // `rollingStraddle` applies at its own splice.
        iv: ivAt(c, ts),
        oi: c.oi.at(ts) ?? undefined,
        volume: c.volume.at(ts) ?? undefined,
        gamma: c.gamma.at(ts) ?? undefined,
      });
    }

    // The ATM by PARITY: the strike where the call and the put are closest is
    // the one the forward sits on, and it needs no spot to find.
    let atmStrike: number | null = null;
    let atmGap = Infinity;
    const byStrike = new Map<number, { call?: Leg; put?: Leg }>();
    for (const leg of legs) {
      const slot = byStrike.get(leg.strike) ?? {};
      if (leg.side === 'CE') slot.call = leg; else slot.put = leg;
      byStrike.set(leg.strike, slot);
    }
    for (const [strike, { call, put }] of byStrike) {
      if (call?.ltp == null || put?.ltp == null) continue;
      const gap = Math.abs(call.ltp - put.ltp);
      if (gap < atmGap) { atmGap = gap; atmStrike = strike; }
    }
    if (atmStrike == null) continue;

    const atmSlot = byStrike.get(atmStrike)!;
    const forward = atmStrike + (atmSlot.call!.ltp as number) - (atmSlot.put!.ltp as number);
    if (!(forward > 0)) continue;

    /*
     * Gamma, modelled where the feed has none.
     *
     * The vol is inverted from the ATM straddle once per bar and applied across
     * the window rather than re-solved per strike: a per-strike inversion would
     * take the smile from the quotes, which is more faithful and forty times the
     * work, and the flip level — the only thing this profile is read for — moves
     * by a fraction of a strike between the two.
     */
    const T = yearsToExpiry(ts, expiry);
    const atmStraddle = (atmSlot.call!.ltp as number) + (atmSlot.put!.ltp as number);
    let sigma = atmSlot.call?.iv != null ? atmSlot.call.iv / 100 : NaN;
    if (!(sigma > 0)) sigma = impliedVolStraddle(atmStraddle, forward, atmStrike, T);

    for (const leg of legs) {
      if (leg.gamma != null || !(sigma > 0) || !(T > 0)) continue;
      const g = black76Greeks(forward, leg.strike, T, sigma, leg.side);
      if (g.gamma > 0) { leg.gamma = g.gamma; modelledGamma += 1; }
    }

    ladder = buildLadder(legs, forward);

    for (const rung of ladder) {
      for (const side of ['call', 'put'] as const) {
        const leg = rung[side];
        if (!leg?.ltp || leg.oi == null) continue;
        const k = `${rung.strike}|${side}`;
        const prevLtp = lastLtp.get(k);
        const prevOi = lastOi.get(k);
        if (prevLtp != null && prevOi != null) {
          const flow = classifyFlow(leg.ltp - prevLtp, leg.oi - prevOi);
          if (side === 'call') rung.callFlow = flow; else rung.putFlow = flow;
        }
        lastLtp.set(k, leg.ltp);
        lastOi.set(k, leg.oi);
      }
    }

    const atm = atmView(ladder, forward);
    /*
     * The IV line, where the feed has no IV to give.
     *
     * `iv_bid`/`iv_ask` stop about three months back, and the vol was already
     * solved above to price the gamma — so an old session had a working gamma
     * profile and an empty IV series, which is the one signal the whole
     * compression-to-expansion read is built on. Same number, same bar, no
     * second inversion.
     *
     * It stays a MODELLED figure: it is the vol implied by the ATM straddle,
     * not a quote, and it will differ from a fed vol by the smile the model
     * does not carry.
     */
    if (atm.iv == null && sigma > 0) atm.iv = sigma * 100;
    const walls = wallsOf(ladder);
    spots.push(forward);
    if (spots.length > 60) spots.shift();

    bars.push({
      time: ts,
      spot: forward,
      atmStrike: atm.strike,
      straddle: atm.straddle,
      iv: atm.iv,
      skew: atm.skew,
      syntheticFuture: atm.syntheticFuture,
      netGex: ladder.reduce((sum, r) => sum + r.netGex, 0),
      gammaFlip: gammaFlip(ladder),
      callWall: walls.callWall,
      putWall: walls.putWall,
      callOi: ladder.reduce((sum, r) => sum + r.callOi, 0),
      putOi: ladder.reduce((sum, r) => sum + r.putOi, 0),
      volume: ladder.reduce(
        (sum, r) => sum + (r.call?.volume ?? 0) + (r.put?.volume ?? 0), 0,
      ),
      expectedMovePct: expectedMovePct(atm.straddle, forward),
      realizedVolPct: realizedVolPct(spots),
    });
  }

  const walls = wallsOf(ladder);
  const { regime, note } = classifyRegime(bars);

  return {
    symbol, exchange, expiry, date,
    source: 'replay',
    gammaSource:
      fedGamma && modelledGamma ? 'mixed'
        : fedGamma ? 'feed'
          : modelledGamma ? 'black76' : 'none',
    contracts: cursors.length,
    bars,
    ladder,
    regime,
    regimeNote: note,
    pressure: pressureOf(bars),
    migration: oiMigration(bars),
    callWall: walls.callWall,
    putWall: walls.putWall,
    maxPain: walls.maxPain,
    // Measured at the CLOSE of the replayed session, which is what makes a
    // signal comparable across sessions — the same minute-to-expiry on two days
    // is the same point in the decay, and an absolute clock time is not.
    minutesToExpiry: minutesToExpiry(end, expiry),
    tookMs: Date.now() - started,
  };
}
