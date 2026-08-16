/**
 * Relative-value volatility — comparing implied vol between two underlyings.
 *
 * ── Provenance ──
 *
 * Copied VERBATIM from the trading terminal's `lib/options/ivArbitrage.ts`,
 * modulo the import quote style. It is pure arithmetic over a surface — no
 * React, no fetching — so there is nothing to adapt, and adapting it anyway
 * would be the surest way to make two copies of the same maths disagree.
 * Diff the two files before changing either.
 *
 * The UI that consumes this is called ANALYSIS SHEETS. The names differ on
 * purpose: this module is one sheet's arithmetic, not the page.
 *
 * ── The problem this solves ──
 *
 * "Is NIFTY vol rich against BANKNIFTY?" is not answerable by putting two IV
 * numbers side by side, because the two are rarely measured at the same place
 * on their distributions. Three things differ:
 *
 *   strike ladder   NIFTY steps 50, BANKNIFTY and SENSEX step 100. "Three
 *                   strikes out" is 150 points on one and 300 on the other.
 *   spot level      24,400 against 79,200. A fixed rupee offset is a different
 *                   moneyness on each.
 *   vol level       the same step count sits at a different delta once the two
 *                   assets' vols differ, which is precisely when you are asking.
 *
 * So a pair has to be MATCHED before it can be compared, and how you match
 * changes the answer. Both available modes are honest about what they measure:
 *
 *   moneyness   match by signed strike-steps from ATM. Simple, and what most
 *               desks mean by "compare the 3rd OTM". Does not correct for a
 *               vol difference between the assets.
 *   delta       match by |delta|, interpolating between listed strikes. The
 *               fairer comparison — 25-delta on both is the same probability
 *               of finishing in the money — and the standard way skew is
 *               quoted between markets.
 *
 * ── What the spread means ──
 *
 * `spread = ivA − ivB` in vol points. `ratio = ivA / ivB`. The ratio travels
 * better across regimes: a 2-point spread is large when both are at 9 and
 * unremarkable when both are at 40, and a pair trade sized on the raw spread
 * will be sized wrong in one of those.
 *
 * ── On the name ──
 *
 * This is a RELATIVE VALUE screen, not an arbitrage. Two different underlyings
 * have no arbitrage relationship — nothing forces their vols to converge, and a
 * wide spread can stay wide or widen. Treating the readings here as a
 * risk-free edge is the mistake the label invites.
 */

import type { OptionSide } from './black76';

export interface SurfaceRow {
  strike: number;
  side: OptionSide;
  iv: number | null;
  delta: number | null;
  ltp: number | null;
  steps: number;
  /** Canonical symbol, for joining a live tick to this row. */
  symbol: string;
}

/** The instrument a surface's spot was read from, as the live socket wants it. */
export interface UnderlyingRef {
  key: {
    exchange: string;
    asset: string;
    kind: "SPOT" | "FUT" | "OPT";
    expiry?: string;
    strike?: number;
    side?: OptionSide;
  };
  symbol: string;
}

export interface Surface {
  symbol: string;
  exchange: string;
  expiry: string;
  spot: number;
  /**
   * The market's implied forward, from put-call parity (F = K + CE − PE).
   *
   * This — never `spot` — is what a vol is struck against. Black-76 prices off
   * the forward, so inverting a premium against spot pushes the entire basis
   * into the vol, and it does so with opposite sign for calls and puts: the two
   * legs of one strike come out several vol points apart when parity says they
   * must nearly agree. Optional only because an older cached response may
   * predate the field; callers fall back to `spot` and are wrong in that way.
   */
  forward?: number;
  atmStrike: number;
  step: number;
  years: number;
  rows: SurfaceRow[];
  underlying?: UnderlyingRef | null;
  /**
   * True once live ticks have been folded in — see `useLiveSurface`.
   *
   * Worth carrying on the surface itself because it changes what the numbers
   * MEAN: a live row's IV is solved from its last traded price, where the
   * fetched one is the feed's own bid/ask mid vol.
   */
  live?: boolean;
}

export type MatchMode = "moneyness" | "delta" | "points";

/** Which number is being compared. */
export type Metric = "iv" | "ltp";

/** One comparable point on one surface. */
export interface Anchor {
  /** `ATM`, `OTM3`, `25Δ` — how this point was selected. */
  label: string;
  strike: number | null;
  side: OptionSide;
  iv: number | null;
  /**
   * Last traded price.
   *
   * Offered alongside IV because the two answer different questions. IV is
   * comparable across assets by construction; PREMIUM is not — a BANKNIFTY
   * option costs more than a NIFTY one at the same vol simply because the index
   * is larger. A premium gap is still worth seeing when sizing a spread in
   * rupees, but it is not a statement about relative value.
   */
  ltp: number | null;
  delta: number | null;
  /** True when the reading was interpolated between two listed strikes. */
  interpolated: boolean;
}

export interface Comparison {
  label: string;
  side: OptionSide;
  a: Anchor;
  b: Anchor;
  /** ivA − ivB, in vol POINTS (percentage points), or null. */
  spread: number | null;
  /** ivA / ivB, or null. */
  ratio: number | null;
  /** ltpA − ltpB, in rupees. Not a relative-value signal — see Anchor.ltp. */
  ltpGap: number | null;
}

// ── Moneyness ────────────────────────────────────────────────────────────────

/**
 * Signed steps for a moneyness label, given the side.
 *
 * OTM is above the money for a call and below it for a put; ITM is the reverse.
 * Getting this backwards silently compares a call's wing against a put's body,
 * which produces a spread that looks like a huge skew dislocation and is
 * actually a sign error.
 */
export function stepsFor(label: string, side: OptionSide): number | null {
  const m = label.toUpperCase().match(/^(ATM|ITM|OTM)(\d*)$/);
  if (!m) return null;
  if (m[1] === "ATM") return 0;

  const n = Number(m[2] || 1);
  const outward = side === "CE" ? 1 : -1;
  return m[1] === "OTM" ? n * outward : -n * outward;
}

/** The listed row at a given step count, or null when the chain does not reach. */
export function rowAtSteps(surface: Surface, steps: number, side: OptionSide): SurfaceRow | null {
  return surface.rows.find((r) => r.side === side && r.steps === steps) ?? null;
}

// ── Delta ────────────────────────────────────────────────────────────────────

/**
 * IV at a target |delta|, interpolated between the two straddling strikes.
 *
 * A chain almost never lists a contract at exactly 25 delta, so picking the
 * NEAREST one instead would compare, say, 22Δ on one asset against 29Δ on the
 * other — and since IV varies with delta, that difference alone shows up as a
 * spread. Interpolating removes it.
 *
 * Linear in delta rather than in strike: IV is far closer to linear against
 * delta across the region that matters, which is the reason delta is the axis
 * skew is quoted on in the first place.
 *
 * Returns null rather than extrapolating past the listed range. A 10-delta
 * reading invented from a chain that stops at 18 is not an observation.
 */
export function ivAtDelta(surface: Surface, targetAbsDelta: number, side: OptionSide): Anchor {
  const label = `${Math.round(targetAbsDelta * 100)}Δ`;
  const empty: Anchor = { label, strike: null, side, iv: null, ltp: null, delta: null, interpolated: false };

  const usable = surface.rows
    .filter((r) => r.side === side && r.iv != null && r.delta != null)
    .map((r) => ({ ...r, abs: Math.abs(r.delta!) }))
    .sort((x, y) => x.abs - y.abs);

  if (usable.length < 2) return empty;

  // Exact-enough hit: no interpolation needed, and saying so matters because an
  // interpolated reading is weaker evidence than a quoted one.
  const exact = usable.find((r) => Math.abs(r.abs - targetAbsDelta) < 0.005);
  if (exact) {
    return { label, strike: exact.strike, side, iv: exact.iv, ltp: exact.ltp, delta: exact.delta, interpolated: false };
  }

  const below = [...usable].reverse().find((r) => r.abs <= targetAbsDelta);
  const above = usable.find((r) => r.abs >= targetAbsDelta);
  if (!below || !above || below.abs === above.abs) return empty;

  const t = (targetAbsDelta - below.abs) / (above.abs - below.abs);
  const lerp = (x: number | null, y: number | null): number | null =>
    x != null && y != null ? x + t * (y - x) : null;

  return {
    label,
    strike: Math.round(below.strike + t * (above.strike - below.strike)),
    side,
    iv: below.iv! + t * (above.iv! - below.iv!),
    ltp: lerp(below.ltp, above.ltp),
    delta: side === "CE" ? targetAbsDelta : -targetAbsDelta,
    interpolated: true,
  };
}


// ── Points from ATM ──────────────────────────────────────────────────────────

/**
 * The listed row nearest a given DISTANCE in points from ATM.
 *
 * A third way to anchor, and the most direct one: "the call 300 points out"
 * means a strike, not a step count and not a delta. It is also the only mode
 * that compares a CALL against a PUT rather than one asset against another —
 * 300 points OTM is ATM+300 for a call and ATM−300 for a put, equidistant on
 * either side of the money.
 *
 * That equidistant pair is what SKEW is: if the 300-point put trades richer
 * than the 300-point call, the market is paying more to insure a fall than a
 * rise. The ratio below puts a number on it.
 *
 * Snaps to the nearest LISTED strike rather than demanding an exact one — a
 * 300-point offset lands on a real strike for NIFTY (step 50) and between two
 * for an asset stepping 250. Returns null when the nearest listed strike is
 * more than half a step away, which means the chain simply does not reach.
 */
export function rowAtPoints(surface: Surface, points: number, side: OptionSide): SurfaceRow | null {
  const target = surface.atmStrike + (side === "CE" ? points : -points);

  const candidates = surface.rows.filter((r) => r.side === side);
  if (!candidates.length) return null;

  const nearest = candidates.reduce((best, r) =>
    Math.abs(r.strike - target) < Math.abs(best.strike - target) ? r : best);

  // Half a step is the furthest a "nearest" match can be before it is really a
  // different strike. Beyond that the chain does not reach and saying so is the
  // honest answer.
  return Math.abs(nearest.strike - target) <= surface.step / 2 ? nearest : null;
}

/** A call and its equidistant put, on one surface. */
export interface SkewPoint {
  /** Distance from ATM, in points. */
  points: number;
  label: string;
  call: Anchor;
  put: Anchor;
  /** call − put, in vol POINTS. Positive means calls are bid over puts. */
  diff: number | null;
  /**
   * call / put.
   *
   * "How many times" one side is richer. 1.00 is symmetric; 0.90 means the put
   * carries about 11% more vol than the call. Reported alongside `diff` because
   * the two disagree about what "large" means: a 1-point gap is a 10% skew at a
   * vol of 10 and a 2.5% skew at 40.
   */
  ratio: number | null;
}

/** The call/put pair at one distance from ATM. */
export function skewAt(surface: Surface, points: number, metric: Metric = "iv"): SkewPoint {
  const label = `${points}pt`;
  const call = anchorFromRow(label, rowAtPoints(surface, points, "CE"), "CE");
  const put  = anchorFromRow(label, rowAtPoints(surface, points, "PE"), "PE");

  const c = anchorValue(call, metric);
  const p = anchorValue(put, metric);
  const both = c != null && p != null && p !== 0;

  return {
    points,
    label,
    call,
    put,
    // Vol points for iv; rupees for ltp. The ×100 belongs only to the decimal.
    diff: both ? (metric === "iv" ? (c - p) * 100 : c - p) : null,
    ratio: both ? c / p : null,
  };
}

/** Both legs' skew at every requested distance. */
export interface SkewComparison {
  points: number;
  label: string;
  a: SkewPoint;
  b: SkewPoint;
}

export function compareSkew(
  a: Surface, b: Surface, distances: number[], metric: Metric = "iv",
): SkewComparison[] {
  return distances.map((points) => ({
    points,
    label: `${points}pt`,
    a: skewAt(a, points, metric),
    b: skewAt(b, points, metric),
  }));
}

/**
 * Distances that make sense for an asset, derived from its own strike ladder.
 *
 * A fixed list of 100/200/300 is right for NIFTY and useless for BANKNIFTY,
 * whose ladder steps 100 — three of those distances land within one strike of
 * each other in percentage terms. Multiples of the step keep every suggestion
 * on a real strike and scale with the asset.
 */
export function suggestedDistances(surface: Surface | null): number[] {
  const step = surface?.step && surface.step > 0 ? surface.step : 50;
  return [1, 2, 3, 4, 6, 8, 10].map((n) => n * step);
}

// ── Comparison ───────────────────────────────────────────────────────────────

function anchorFromRow(label: string, row: SurfaceRow | null, side: OptionSide): Anchor {
  if (!row) return { label, strike: null, side, iv: null, ltp: null, delta: null, interpolated: false };
  return { label, strike: row.strike, side, iv: row.iv, ltp: row.ltp, delta: row.delta, interpolated: false };
}

export interface CompareOptions {
  mode: MatchMode;
  /** Moneyness labels: ATM, OTM1…OTM5, ITM1…ITM5. */
  moneyness: string[];
  /** Absolute deltas, 0–1. 0.25 is 25-delta. */
  deltas: number[];
  /** Distances from ATM, in points. */
  distances?: number[];
  sides: OptionSide[];
}

/**
 * Compare two surfaces at every requested anchor.
 *
 * A pair where either side is missing is still returned, with nulls. Dropping
 * it would silently shorten the table and hide that the chain does not reach
 * that far on one of the two — which is itself the answer to "why can I not
 * see the 5th OTM".
 */
export function compareSurfaces(a: Surface, b: Surface, opts: CompareOptions): Comparison[] {
  const out: Comparison[] = [];

  for (const side of opts.sides) {
    if (opts.mode === "moneyness") {
      for (const label of opts.moneyness) {
        const steps = stepsFor(label, side);
        if (steps == null) continue;
        const rowA = rowAtSteps(a, steps, side);
        const rowB = rowAtSteps(b, steps, side);
        out.push(build(label, side, anchorFromRow(label, rowA, side), anchorFromRow(label, rowB, side)));
      }
    } else if (opts.mode === "points") {
      for (const points of opts.distances ?? []) {
        const label = `${points}pt`;
        const row = rowAtPoints(a, points, side);
        const rowB = rowAtPoints(b, points, side);
        out.push(build(label, side, anchorFromRow(label, row, side), anchorFromRow(label, rowB, side)));
      }
    } else {
      for (const d of opts.deltas) {
        const anchorA = ivAtDelta(a, d, side);
        const anchorB = ivAtDelta(b, d, side);
        out.push(build(anchorA.label, side, anchorA, anchorB));
      }
    }
  }

  return out;
}

function build(label: string, side: OptionSide, a: Anchor, b: Anchor): Comparison {
  const both = a.iv != null && b.iv != null && b.iv !== 0;
  const bothLtp = a.ltp != null && b.ltp != null;
  return {
    label,
    side,
    a,
    b,
    ltpGap: bothLtp ? a.ltp! - b.ltp! : null,
    // Vol POINTS: the surfaces carry decimals, and a spread quoted as 0.021 is
    // read as two basis points by eyes expecting 2.1.
    spread: both ? (a.iv! - b.iv!) * 100 : null,
    ratio: both ? a.iv! / b.iv! : null,
  };
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface ArbSummary {
  /** Mean spread across every comparable anchor, in vol points. */
  meanSpread: number | null;
  /** Mean of ivA/ivB. */
  meanRatio: number | null;
  /** The widest anchor, by absolute spread. */
  widest: Comparison | null;
  /** How many anchors had both sides. */
  matched: number;
  total: number;
}

export function summarise(rows: Comparison[]): ArbSummary {
  const usable = rows.filter((r) => r.spread != null);
  if (!usable.length) {
    return { meanSpread: null, meanRatio: null, widest: null, matched: 0, total: rows.length };
  }

  const meanSpread = usable.reduce((s, r) => s + r.spread!, 0) / usable.length;
  const meanRatio = usable.reduce((s, r) => s + r.ratio!, 0) / usable.length;
  const widest = usable.reduce((w, r) => (Math.abs(r.spread!) > Math.abs(w.spread!) ? r : w));

  return { meanSpread, meanRatio, widest, matched: usable.length, total: rows.length };
}

/** The compared value for one side, in its own units. */
export function anchorValue(anchor: Anchor, metric: Metric): number | null {
  return metric === "iv" ? anchor.iv : anchor.ltp;
}

/** The gap for the selected metric: vol POINTS for iv, rupees for ltp. */
export function gapFor(row: Comparison, metric: Metric): number | null {
  return metric === "iv" ? row.spread : row.ltpGap;
}

/** Vol points → a readable string. Always signed: the direction is the point. */
export function volPoints(v: number | null, digits = 2): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(digits)}`;
}

/** Decimal IV → percent string. */
export function ivPercent(iv: number | null, digits = 2): string {
  if (iv == null || !Number.isFinite(iv)) return "—";
  return `${(iv * 100).toFixed(digits)}%`;
}
