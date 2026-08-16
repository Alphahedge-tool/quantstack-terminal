/**
 * Position book → strategy legs.
 *
 * The adapter that turns "what I hold" into something that can be valued
 * forward. Three things have to come together, and they come from three
 * different places:
 *
 *   contract   from the broker's position report, resolved to a canonical key
 *              by `backend/trading/contract.ts`
 *   quantity   from the same report, already signed and in units
 *   IV         from Nubra via `/api/options/marks`, joined by canonical key —
 *              no broker reports one
 *
 * That last line is the whole reason this file is not trivial.
 */

import { keyOf, type InstrumentKey } from '@/lib/symbol';
import { impliedVol } from './black76';
import type { Leg } from './payoff';
import type { ContractKey, Position } from '@/schemas/trading';
import type { OptionMark } from '@/schemas/options';

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

/** A parsed contract key in the wire shape the rest of the app passes around. */
export function toInstrumentKey(key: ContractKey): InstrumentKey {
  return {
    exchange: key.exchange,
    asset: key.asset,
    kind: key.kind,
    expiry: key.expiry ?? undefined,
    strike: key.strike ?? undefined,
    side: key.side ?? undefined,
  };
}

/** Stable id for a leg. Must match the backend's `keyOf` exactly — it is the
 *  join key between a position and its mark. */
export function idOf(key: ContractKey): string {
  return keyOf(toInstrumentKey(key));
}

/**
 * Positions worth putting on a payoff.
 *
 * Flat rows are excluded: a squared-off position has realised P&L but no
 * exposure, and including it would flatten the curve by exactly nothing while
 * adding a leg to every calculation. Unresolved contracts are excluded too —
 * without a strike and expiry there is no contract to price.
 */
export function payoffEligible(positions: Position[]): Position[] {
  return positions.filter(
    (p) =>
      p.quantity !== 0 &&
      p.contract.key != null &&
      (p.contract.key.kind === 'OPT' || p.contract.key.kind === 'FUT'),
  );
}

/**
 * Convert positions to legs, attaching IV where a mark supplied one.
 *
 * `entryPrice` is the side-appropriate average: a long's cost basis is its buy
 * average, a short's is its sell average. Using one blended figure would be
 * wrong for every short in the book — the same distinction the position book
 * itself makes.
 */
export function toLegs(positions: Position[], marks: Map<string, OptionMark>): Leg[] {
  return payoffEligible(positions).map((position): Leg => {
    const key = position.contract.key!;
    const id = idOf(key);

    const entryPrice =
      position.quantity > 0
        ? position.buyAverage || position.sellAverage
        : position.sellAverage || position.buyAverage;

    return {
      id,
      kind: key.kind === 'FUT' ? 'FUT' : 'OPT',
      quantity: position.quantity,
      entryPrice,
      expiry: position.contract.expiry,
      strike: position.contract.strike ?? undefined,
      side: position.contract.optionType || undefined,
      // Null, not zero. A leg with no vol cannot be valued before expiry, and
      // the payoff engine reports that rather than inventing a number.
      iv: marks.get(id)?.iv ?? null,
      label: position.contract.label,
    };
  });
}

export interface AssetGroup {
  asset: string;
  /** The exchange the underlying trades on — for the spot subscription. */
  exchange: string;
  positions: Position[];
  /** P&L already booked on legs of this underlying that are now closed. */
  realised: number;
}

/**
 * Split a book by underlying.
 *
 * A payoff has ONE x-axis, and that axis is a price. Legs on NIFTY (~24,400)
 * and SENSEX (~79,200) do not share one: plotting them together produces a
 * curve where each strategy is a vertical spike at the far end of the other's
 * range, and the combined "max loss" is the sum of two unrelated risks.
 *
 * Ordered by leg count, so the biggest position is the default view.
 */
export function groupByUnderlying(positions: Position[]): AssetGroup[] {
  const groups = new Map<string, Position[]>();
  for (const position of payoffEligible(positions)) {
    const asset = position.contract.underlying || position.contract.key!.asset;
    const list = groups.get(asset);
    if (list) list.push(position);
    else groups.set(asset, [position]);
  }

  /**
   * Booked P&L on CLOSED legs of this underlying.
   *
   * Collected from the full position list, not from the grouped legs, because
   * `payoffEligible` has deliberately dropped every squared-off row — they have
   * no exposure and so no place in the curve's shape. Their money is still
   * real: closing two legs at a loss leaves the strategy that much worse off at
   * every price, and omitting it makes the panel's P&L disagree with the book.
   */
  const realisedFor = (asset: string): number =>
    positions
      .filter(
        (p) => p.quantity === 0 && (p.contract.underlying || p.contract.key?.asset) === asset,
      )
      .reduce((sum, p) => sum + (p.realised || p.pnl), 0);

  return [...groups]
    .map(([asset, list]) => ({
      asset,
      // Every position in a group shares an underlying and therefore its
      // exchange, so the first row is a safe source.
      exchange: list[0].contract.key?.exchange ?? 'NSE',
      positions: list,
      realised: realisedFor(asset),
    }))
    .sort((a, b) => b.positions.length - a.positions.length || a.asset.localeCompare(b.asset));
}

/**
 * SPOT keys for every underlying in the book.
 *
 * ── Why these are subscribed by the PAGE, not by the payoff panel ──
 *
 * The quote socket holds ONE subscription set per connection and `subscribe`
 * REPLACES it (see `backend/live/wsQuotes.ts`). If the payoff panel called
 * `useQuoteSubscription` itself, its set would overwrite the position book's on
 * every mount and the P&L column would go dead — two components on one page
 * fighting over a single server-side set. The page therefore subscribes to the
 * union once, and the panel reads what it needs out of the store.
 */
export function spotKeys(positions: Position[]): Array<{ key: ContractKey }> {
  const seen = new Map<string, ContractKey>();
  for (const group of groupByUnderlying(positions)) {
    const key: ContractKey = { exchange: group.exchange, asset: group.asset, kind: 'SPOT' };
    seen.set(idOf(key), key);
  }
  return [...seen.values()].map((key) => ({ key }));
}

/**
 * The canonical symbol a SPOT tick arrives under.
 *
 * Frames are keyed by canonical symbol, and a SPOT key's canonical form is the
 * bare asset root — `NIFTY`, `SENSEX`. See `canonicalSymbol` in lib/symbol.ts.
 */
export function spotSymbol(asset: string): string {
  return asset.toUpperCase();
}

/**
 * Solve IV from each position's own mark, for legs the feed could not price.
 *
 * The feed is the better source and is tried first. This covers what it does
 * not carry — Nubra declares BSE in its capabilities but returns nothing for
 * SENSEX options, so a book holding them would otherwise have no greeks at all.
 *
 * The mark is the BROKER's last traded price for that exact contract, which is
 * a genuinely weaker input: an illiquid strike with a stale print yields a stale
 * vol. The solved legs are named so the panel can say so rather than presenting
 * both sources as equally good.
 */
export function solveMissingIv(
  legs: Leg[],
  positions: Position[],
  spot: number,
): { legs: Leg[]; solved: string[] } {
  const markFor = new Map(
    payoffEligible(positions)
      .filter((p) => p.lastPrice > 0)
      .map((p) => [idOf(p.contract.key!), p.lastPrice]),
  );

  const solved: string[] = [];
  const out = legs.map((leg) => {
    if (leg.iv != null || leg.kind !== 'OPT' || leg.strike == null || !leg.side) return leg;

    const mark = markFor.get(leg.id);
    if (!(mark && mark > 0)) return leg;

    const t = (Date.parse(`${leg.expiry}T10:00:00Z`) - Date.now()) / YEAR_MS;
    if (!(t > 0) || !(spot > 0)) return leg;

    const iv = impliedVol(mark, spot, leg.strike, t, leg.side);
    if (!Number.isFinite(iv)) return leg;

    solved.push(leg.label);
    return { ...leg, iv };
  });

  return { legs: out, solved };
}

/**
 * Best available underlying price for a set of positions.
 *
 * `live` — the underlying's own tick, when the feed is carrying one — wins over
 * everything. The fallbacks are estimates, and the last is a poor one: the mean
 * of the strikes held. For an options-only book that value is not merely
 * approximate, it is CONSTANT — it cannot move until the position itself
 * changes. Anchoring a payoff to it means the current-P&L marker sits still all
 * session while the market moves underneath it, which is exactly the thing a
 * payoff chart exists to show.
 */
export function inferSpot(positions: Position[], legs: Leg[], live?: number): number {
  if (live != null && Number.isFinite(live) && live > 0) return live;

  // A future's mark IS the underlying for its own expiry, and is the cleanest
  // reference when one is held.
  const future = payoffEligible(positions).find((p) => p.contract.key?.kind === 'FUT');
  if (future?.lastPrice) return future.lastPrice;

  const strikes = legs.map((l) => l.strike).filter((s): s is number => s != null);
  if (!strikes.length) return 0;
  return strikes.reduce((a, b) => a + b, 0) / strikes.length;
}

/** Days until the nearest leg expires, or null when nothing is dated. */
export function daysToNearestExpiry(legs: Leg[]): number | null {
  const days = legs
    .map((l) => (Date.parse(`${l.expiry}T10:00:00Z`) - Date.now()) / DAY_MS)
    .filter((d) => Number.isFinite(d));
  return days.length ? Math.max(0, Math.min(...days)) : null;
}
