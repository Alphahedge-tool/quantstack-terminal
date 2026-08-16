/**
 * Analysis Sheets — implied volatility compared between two contracts.
 *
 * Pick two legs, choose how their strikes are matched, and every anchor shows
 * both readings and the gap between them.
 *
 * ── Three ways to match, and why the choice changes the answer ──
 *
 * Two option chains are almost never measured at the same place on their
 * distributions. NIFTY steps 50 and BANKNIFTY steps 100, so "three strikes out"
 * is 150 points on one and 300 on the other; spot is 24,400 against 79,200, so
 * a fixed rupee offset is a different moneyness on each. Matching is therefore
 * a decision, not a detail:
 *
 *   STRIKES   signed strike-STEPS from ATM. What most desks mean by "the 3rd
 *             OTM". Does not correct for a vol difference between the assets.
 *   POINTS    a fixed distance from ATM. The only mode where a call and its
 *             equidistant put are comparable, which is what SKEW is.
 *   DELTA     matched on |delta|, interpolated between listed strikes. The
 *             fairest of the three — 25-delta on both is the same probability
 *             of finishing in the money — and how skew is quoted between
 *             markets.
 *
 * ── On the name ──
 *
 * The reference implementation calls this IV Arbitrage. It is not arbitrage.
 * Two different underlyings have no arbitrage relationship: nothing forces
 * their vols to converge, and a wide spread can stay wide or widen further.
 * "Analysis Sheets" is the better name because it claims only what the screen
 * does, and the panel says the rest out loud rather than letting a title imply
 * a risk-free edge.
 *
 * ── Colour ──
 *
 * The two legs carry NO colour of their own. Every hue on this screen is spent
 * on the gap — up green, down red, tinted by magnitude — because the gap is the
 * only thing here that is a judgement. Colouring the legs as well would put
 * three competing signals in a row of six numbers and leave the reader deciding
 * which one to trust. Leg identity is carried by position and by a neutral A/B
 * chip, which never competes with a reading.
 */

import { useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, RefreshCw, Scale, TriangleAlert } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Panel, PanelHeader } from '@/components/ui/Panel';
import { Button } from '@/components/ui/Button';
import { Select, SegmentedControl } from '@/components/ui/Field';
import { EmptyState, ErrorState, Spinner } from '@/components/ui/States';
import { useAssetOptions, useExpiries, useSurfacePair } from '@/hooks/surface';
import {
  anchorValue, compareSkew, compareSurfaces, gapFor, ivPercent, summarise,
  suggestedDistances, volPoints,
  type Anchor, type Comparison, type MatchMode, type Metric, type SkewComparison,
} from '@/lib/options/ivArbitrage';
import type { OptionSide } from '@/lib/options/black76';
import { cn } from '@/lib/cn';

const MONEYNESS = ['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3', 'OTM4', 'OTM5'];
const DELTAS = [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];
const EXCHANGES = ['NSE', 'BSE', 'MCX'];

interface LegState {
  symbol: string;
  exchange: string;
  expiry: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-08-18` → `18 Aug`.
 *
 * Built from the parts rather than through Intl, and anything not matching the
 * expected shape passes straight through — a feed that changes its expiry
 * format then degrades to the raw string instead of to "Invalid Date".
 */
function shortExpiry(expiry: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  const month = m ? MONTHS[Number(m[2]) - 1] : null;
  return m && month ? `${Number(m[3])} ${month}` : expiry;
}

/**
 * How a leg names itself in a header.
 *
 * Two different underlyings name themselves — the symbol is the whole story.
 * The same underlying on two expiries does not: a calendar spread would put
 * "NIFTY" over both columns with nothing saying which is the near leg. The
 * expiry is exactly what differs, so it is appended only in that case. Carrying
 * it always would push a date into every header to disambiguate something
 * already unambiguous.
 */
function legHead(leg: LegState, other: LegState): { label: string; title: string } {
  const same = leg.symbol === other.symbol;
  const when = shortExpiry(leg.expiry);
  return {
    label: same && when ? `${leg.symbol} ${when}` : leg.symbol || '—',
    title: leg.expiry ? `${leg.symbol} · ${leg.exchange} · expiry ${leg.expiry}` : leg.symbol,
  };
}

/**
 * How many strikes either side of ATM this leg has to fetch.
 *
 * ── Why this is computed and not the constant 8 it replaced ──
 *
 * A fixed width silently caps how far the anchors can reach. On NIFTY, 8
 * strikes at a step of 50 is ±400 points, so selecting 500 produced a row of
 * dashes that looked like an empty chain rather than a request that was never
 * made. The furthest anchor SELECTED is the thing that determines the fetch, so
 * that is what decides it.
 *
 * ── The basis margin, which is the part that is easy to get wrong ──
 *
 * The window is not centred where the anchors are measured from. The route
 * slices the ladder around the strike nearest SPOT, while `atmStrike` — what
 * `rowAtPoints` offsets from — is the strike nearest the FORWARD. Those differ
 * by the basis: on 2026-08-14 NIFTY sat at spot 24366 against forward 24420, so
 * the window centred on 24350 while anchors measured from 24400. Every call
 * anchor lost a strike of reach and every put gained one, which is exactly the
 * asymmetry that made 400pt CE missing while 400pt PE was present.
 *
 * So the margin carries the basis converted into strikes, not a guessed
 * constant — the gap widens with tenor, and a fixed +1 that works on a weekly
 * would fail on a quarterly. Plus 2 for the rounding on both conversions.
 *
 * Delta mode gets a floor instead of a derived number: a target of 0.10 sits
 * far out on a low-vol chain and there is no closed form for how far, so it has
 * to fetch enough to bracket it or `ivAtDelta` correctly refuses to extrapolate.
 */
function widthFor(
  mode: MatchMode,
  selected: { moneyness: string[]; deltas: number[]; distances: number[] },
  step: number,
  basis: number,
): number {
  const ladder = step > 0 ? step : 50;
  const margin = 2 + Math.ceil(Math.abs(basis) / ladder);

  if (mode === 'points') {
    /*
     * The EXPLICIT selection only.
     *
     * When nothing is picked the sheet falls back to `distanceOptions.slice(1,4)`
     * — but those options are themselves derived from the fetched surface, so
     * reading them here would make width depend on the very response it decides.
     * Those defaults are the 2nd through 4th multiples of the step, so their
     * reach is 4 strikes by construction and can be stated without the fetch.
     */
    if (!selected.distances.length) return 4 + margin;
    return Math.ceil(Math.max(...selected.distances) / ladder) + margin;
  }

  if (mode === 'moneyness') {
    // `stepsFor` is signed by side; the reach needed is the magnitude, and ITM3
    // on a call is as far from the money as OTM3 on one.
    const furthest = Math.max(
      1,
      ...selected.moneyness.map((label) => {
        const n = /^(?:ITM|OTM)(\d*)$/.exec(label.toUpperCase());
        return n ? Number(n[1] || 1) : 0;
      }),
    );
    return furthest + margin;
  }

  // Delta. Deeper targets need more chain, but not proportionally.
  const deepest = Math.min(0.5, ...(selected.deltas.length ? selected.deltas : [0.25]));
  return (deepest <= 0.12 ? 14 : deepest <= 0.2 ? 11 : 9) + margin;
}

/** Toggle a value in a list, keeping the canonical order. */
function toggleIn<T>(list: T[], value: T, order: T[]): T[] {
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return order.filter((o) => next.includes(o));
}

function fmtValue(anchor: Anchor, metric: Metric): string {
  const v = anchorValue(anchor, metric);
  if (v == null) return '—';
  return metric === 'iv' ? ivPercent(v) : v.toFixed(2);
}

/* ── Chips ─────────────────────────────────────────────────────────────────── */

/**
 * A multi-select chip.
 *
 * Selected state is carried by a tinted fill AND a ring, not by fill alone.
 * At the sizes these run — a row of nine — a fill-only difference between
 * `--surface-raised` and `--surface-hover` is two steps of grey that a reader
 * scanning for "which four are on" cannot resolve at a glance.
 */
function Chip({
  active, onClick, children, title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'qs-num rounded-[var(--control-radius)] px-2 py-0.5 text-[length:var(--type-caption)]',
        'border transition-colors duration-100',
        active
          ? 'border-[var(--accent-info)] bg-[var(--accent-info-soft)] text-[var(--accent-info-hover)]'
          : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-secondary)]',
      )}
    >
      {children}
    </button>
  );
}

/* ── Leg picker ────────────────────────────────────────────────────────────── */

function LegPicker({
  tag, leg, onChange, spot,
}: {
  tag: 'A' | 'B';
  leg: LegState;
  onChange: (next: LegState) => void;
  spot: number | null;
}) {
  const { expiries, isLoading: expiriesLoading } = useExpiries(leg.symbol, leg.exchange);
  const { results: assets, isLoading: assetsLoading } = useAssetOptions(leg.exchange);

  /*
   * The current symbol is prepended when the list does not contain it.
   *
   * A <select> whose value matches no option renders BLANK — so during the
   * asset list's first load, or on an exchange whose master does not list the
   * saved symbol, the picker would silently appear empty while the surface
   * below it loaded correctly for that very symbol.
   */
  const symbolOptions = useMemo(() => {
    const listed = assets.map((a) => ({ value: a.asset, label: a.asset }));
    if (leg.symbol && !assets.some((a) => a.asset === leg.symbol)) {
      return [{ value: leg.symbol, label: leg.symbol }, ...listed];
    }
    return listed.length ? listed : [{ value: '', label: assetsLoading ? 'Loading…' : 'No assets' }];
  }, [assets, assetsLoading, leg.symbol]);

  return (
    <div className="flex items-center gap-1.5 rounded-[var(--control-radius)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-1.5 py-1">
      <span
        className="qs-label grid h-5 w-5 shrink-0 place-items-center rounded-[3px] bg-[var(--surface-hover)] text-[var(--text-secondary)]"
        aria-hidden="true"
      >
        {tag}
      </span>
      <Select
        aria-label={`Leg ${tag} symbol`}
        value={leg.symbol}
        options={symbolOptions}
        // Clearing the expiry is not optional: the old one belongs to the old
        // underlying and names a contract that does not exist.
        onChange={(e) => onChange({ ...leg, symbol: e.target.value, expiry: '' })}
        className="w-28"
      />
      <Select
        aria-label={`Leg ${tag} exchange`}
        value={leg.exchange}
        options={EXCHANGES.map((x) => ({ value: x, label: x }))}
        onChange={(e) => onChange({ ...leg, exchange: e.target.value, symbol: '', expiry: '' })}
        className="w-20"
      />
      <Select
        aria-label={`Leg ${tag} expiry`}
        value={leg.expiry}
        options={
          expiries.length
            ? expiries.map((x) => ({ value: x, label: shortExpiry(x) }))
            : [{ value: '', label: expiriesLoading ? 'Loading…' : 'No expiries' }]
        }
        onChange={(e) => onChange({ ...leg, expiry: e.target.value })}
        className="w-24"
      />
      <span className="qs-num w-20 shrink-0 text-right text-[length:var(--type-caption)] text-[var(--text-secondary)]">
        {spot != null ? spot.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}
      </span>
    </div>
  );
}

/* ── The gap cell ──────────────────────────────────────────────────────────── */

/**
 * The gap, tinted by SIGN and by MAGNITUDE.
 *
 * The alpha carries size so a column reads as a shape — where the two surfaces
 * pull apart — rather than as a list of numbers to compare by hand. Normalised
 * against the widest gap currently on screen, so the scale adapts to the pair
 * instead of assuming a fixed range that would saturate on one and stay
 * invisible on another.
 *
 * Floored at 0.14 alpha rather than starting at zero: a genuine but small gap
 * with no tint at all reads as missing data, which is a different statement.
 * The number is always printed, so the tint never has to be decoded — it is a
 * second channel for the same fact, not the only one.
 */
function GapCell({ gap, widest, digits }: { gap: number | null; widest: number; digits: number }) {
  if (gap == null) {
    return (
      <span
        className="qs-num text-center text-[var(--text-disabled)]"
        title="One leg has no reading at this anchor"
      >
        —
      </span>
    );
  }

  const share = widest > 0 ? Math.min(1, Math.abs(gap) / widest) : 0;
  const alpha = 0.14 + share * 0.3;
  const up = gap > 0;
  const rgb = up ? '127, 196, 90' : '221, 105, 116';

  return (
    <span
      className="qs-num rounded-[3px] px-1.5 py-0.5 text-center font-medium"
      style={{
        background: gap === 0 ? 'transparent' : `rgba(${rgb}, ${alpha})`,
        color: gap === 0 ? 'var(--text-secondary)' : up ? 'var(--market-up)' : 'var(--market-down)',
      }}
    >
      {volPoints(gap, digits)}
    </span>
  );
}

/* ── One side's comparison ─────────────────────────────────────────────────── */

/**
 * Leg A, the gap, leg B — for calls or for puts.
 *
 * ONE grid holds the header and every row, with each row's cells as direct
 * children. Three sibling grids, or a grid per row, would drift out of
 * alignment by a pixel as content changed; sharing one set of tracks makes
 * misalignment impossible.
 *
 * Leg B is mirrored — its value nearest the centre — so the two legs read
 * outward from the gap rather than both left-to-right. The eye then compares
 * two adjacent numbers instead of two numbers with a column between them.
 */
function SidePair({
  side, rows, metric, headA, headB,
}: {
  side: OptionSide;
  rows: Comparison[];
  metric: Metric;
  headA: { label: string; title: string };
  headB: { label: string; title: string };
}) {
  const widest = useMemo(
    () => rows.reduce((m, r) => {
      const g = gapFor(r, metric);
      return g == null ? m : Math.max(m, Math.abs(g));
    }, 0),
    [rows, metric],
  );

  if (!rows.length) return null;
  const digits = metric === 'iv' ? 2 : 1;

  return (
    <section className="min-w-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
      <header className="flex items-baseline gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span
          className="qs-label"
          style={{ color: side === 'CE' ? 'var(--market-up)' : 'var(--market-down)' }}
        >
          {side === 'CE' ? 'Calls' : 'Puts'}
        </span>
        <span className="truncate text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
          {headA.label} vs {headB.label} · {metric === 'iv' ? 'implied vol' : 'premium'}
        </span>
      </header>

      <div
        className="grid items-center gap-x-2 px-3 py-1.5"
        style={{ gridTemplateColumns: 'auto 1fr auto 1fr auto' }}
      >
        <span className="qs-label pb-1 text-[var(--text-tertiary)]">Anchor</span>
        <span className="qs-label pb-1 text-right text-[var(--text-secondary)]" title={headA.title}>
          {headA.label}
        </span>
        <span className="qs-label pb-1 text-center text-[var(--text-tertiary)]">
          {metric === 'iv' ? 'vol pts' : '₹'}
        </span>
        <span className="qs-label pb-1 text-left text-[var(--text-secondary)]" title={headB.title}>
          {headB.label}
        </span>
        <span className="qs-label pb-1 text-right text-[var(--text-tertiary)]">×</span>

        {rows.map((r) => (
          <Row key={`${side}-${r.label}`} row={r} metric={metric} widest={widest} digits={digits} />
        ))}
      </div>
    </section>
  );
}

/**
 * `display: contents` so the cells join the parent grid directly.
 *
 * A wrapper element with its own layout would break the shared track sizing
 * that keeps every row aligned — which is the entire reason there is one grid
 * rather than one per row.
 */
function Row({
  row, metric, widest, digits,
}: {
  row: Comparison;
  metric: Metric;
  widest: number;
  digits: number;
}) {
  const gap = gapFor(row, metric);

  return (
    <div className="contents">
      <span className="qs-num py-0.5 text-[length:var(--type-caption)] text-[var(--text-secondary)]">
        {row.label}
      </span>

      <span className="flex items-baseline justify-end gap-1.5 py-0.5">
        <Strike anchor={row.a} />
        <Value anchor={row.a} metric={metric} />
      </span>

      <GapCell gap={gap} widest={widest} digits={digits} />

      <span className="flex items-baseline gap-1.5 py-0.5">
        <Value anchor={row.b} metric={metric} />
        <Strike anchor={row.b} />
      </span>

      <span className="qs-num py-0.5 text-right text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
        {row.ratio == null ? '—' : row.ratio.toFixed(3)}
      </span>
    </div>
  );
}

function Strike({ anchor }: { anchor: Anchor }) {
  return (
    <span className="qs-num text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
      {anchor.strike ?? '—'}
      {/* An interpolated reading is weaker evidence than a quoted one, and the
          difference is invisible in the number itself. */}
      {anchor.interpolated ? (
        <span
          className="text-[var(--accent-info)]"
          title="Interpolated between listed strikes"
        >
          ~
        </span>
      ) : null}
    </span>
  );
}

function Value({ anchor, metric }: { anchor: Anchor; metric: Metric }) {
  const missing = anchorValue(anchor, metric) == null;
  return (
    <span
      className={cn(
        'qs-num tabular-nums',
        missing ? 'text-[var(--text-disabled)]' : 'text-[var(--text-primary)]',
      )}
    >
      {fmtValue(anchor, metric)}
    </span>
  );
}

/* ── Skew ──────────────────────────────────────────────────────────────────── */

/**
 * A call against its equidistant put, for one leg.
 *
 * The pair a distance anchor exists to show: at 300 points out the call sits at
 * ATM+300 and the put at ATM−300, the same distance either side of the money.
 * If the put is richer, the market is paying more to insure a fall than a rise.
 *
 * Both DIFF and × are shown because they disagree about what "large" means: a
 * 1-point gap is a 10% skew at a vol of 10 and 2.5% at 40.
 */
function SkewTable({
  head, rows, metric, pick,
}: {
  head: { label: string; title: string };
  rows: SkewComparison[];
  metric: Metric;
  pick: (r: SkewComparison) => SkewComparison['a'];
}) {
  const widest = useMemo(
    () => rows.reduce((m, r) => {
      const d = pick(r).diff;
      return d == null ? m : Math.max(m, Math.abs(d));
    }, 0),
    [rows, pick],
  );

  if (!rows.length) return null;

  return (
    <section className="min-w-0 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-panel)]">
      <header className="flex items-baseline gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <span className="qs-label text-[var(--text-primary)]" title={head.title}>{head.label}</span>
        <span className="text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
          call vs put, equidistant from ATM
        </span>
      </header>

      <div
        className="grid items-center gap-x-2 px-3 py-1.5"
        style={{ gridTemplateColumns: 'auto 1fr auto 1fr auto' }}
      >
        <span className="qs-label pb-1 text-[var(--text-tertiary)]">Dist</span>
        <span className="qs-label pb-1 text-right" style={{ color: 'var(--market-up)' }}>Call</span>
        <span className="qs-label pb-1 text-center text-[var(--text-tertiary)]">Difference</span>
        <span className="qs-label pb-1 text-left" style={{ color: 'var(--market-down)' }}>Put</span>
        <span className="qs-label pb-1 text-right text-[var(--text-tertiary)]">×</span>

        {rows.map((r) => {
          const p = pick(r);
          return (
            <div className="contents" key={r.label}>
              <span className="qs-num py-0.5 text-[length:var(--type-caption)] text-[var(--text-secondary)]">
                {r.points}
              </span>
              <span className="flex items-baseline justify-end gap-1.5 py-0.5">
                <Strike anchor={p.call} />
                <Value anchor={p.call} metric={metric} />
              </span>
              <GapCell gap={p.diff} widest={widest} digits={metric === 'iv' ? 2 : 1} />
              <span className="flex items-baseline gap-1.5 py-0.5">
                <Value anchor={p.put} metric={metric} />
                <Strike anchor={p.put} />
              </span>
              <span className="qs-num py-0.5 text-right text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
                {p.ratio == null ? '—' : p.ratio.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── The sheet ─────────────────────────────────────────────────────────────── */

export function AnalysisSheets() {
  const [legA, setLegA] = useState<LegState>({ symbol: 'NIFTY', exchange: 'NSE', expiry: '' });
  const [legB, setLegB] = useState<LegState>({ symbol: 'BANKNIFTY', exchange: 'NSE', expiry: '' });
  const [mode, setMode] = useState<MatchMode>('moneyness');
  const [metric, setMetric] = useState<Metric>('iv');
  const [sides, setSides] = useState<OptionSide[]>(['CE', 'PE']);
  const [moneyness, setMoneyness] = useState(['ATM', 'OTM1', 'OTM2', 'OTM3']);
  const [deltas, setDeltas] = useState([0.15, 0.25, 0.4]);
  const [distances, setDistances] = useState<number[]>([]);

  const queryClient = useQueryClient();

  const expiriesA = useExpiries(legA.symbol, legA.exchange);
  const expiriesB = useExpiries(legB.symbol, legB.exchange);

  /*
   * Default each leg to its front expiry once the list arrives.
   *
   * Derived during render rather than synced in an effect: an effect would
   * render one frame with no expiry, fire, and render again — and that first
   * frame is a full "pick an expiry" empty state that flashes on every load.
   */
  const effectiveA = { ...legA, expiry: legA.expiry || expiriesA.expiries[0] || '' };
  const effectiveB = { ...legB, expiry: legB.expiry || expiriesB.expiries[0] || '' };

  /*
   * The ladder shape each leg was last seen to have.
   *
   * Width depends on the step and the basis; both arrive WITH the surface that
   * width decides. Held in a ref and read at the top of render, that resolves to
   * one extra round trip when an asset changes — default shape, fetch, real
   * shape, refetch — instead of a loop, and `placeholderData` keeps the previous
   * pair on screen throughout. A state variable here would be the same thing
   * with an extra render; a `useEffect` would add a frame where the old width is
   * used against the new asset.
   */
  const shape = useRef({
    a: { step: 50, basis: 0 },
    b: { step: 50, basis: 0 },
  });

  const selection = { moneyness, deltas, distances };
  const [a, b] = useSurfacePair([
    { ...effectiveA, width: widthFor(mode, selection, shape.current.a.step, shape.current.a.basis) },
    { ...effectiveB, width: widthFor(mode, selection, shape.current.b.step, shape.current.b.basis) },
  ]);

  if (a.surface) {
    shape.current.a = { step: a.surface.step, basis: Math.abs(a.surface.basis ?? 0) };
  }
  if (b.surface) {
    shape.current.b = { step: b.surface.step, basis: Math.abs(b.surface.basis ?? 0) };
  }

  /*
   * Distance options come from leg A's own ladder.
   *
   * A fixed 100/200/300 is right for NIFTY and near-useless for BANKNIFTY,
   * whose ladder steps 100 — those three land within one strike of each other
   * in percentage terms. Multiples of the step stay on real strikes.
   */
  const distanceOptions = useMemo(() => suggestedDistances(a.surface), [a.surface]);
  const activeDistances = distances.length ? distances : distanceOptions.slice(1, 4);

  const rows = useMemo<Comparison[]>(() => {
    if (!a.surface || !b.surface) return [];
    return compareSurfaces(a.surface, b.surface, {
      mode, moneyness, deltas, distances: activeDistances, sides,
    });
  }, [a.surface, b.surface, mode, moneyness, deltas, activeDistances, sides]);

  /*
   * Skew is a CE-vs-PE reading, not A-vs-B, and only points mode can express
   * it: a step count is a different distance on the two assets, and a delta
   * pair is not equidistant from the money at all.
   */
  const skewRows = useMemo<SkewComparison[]>(() => {
    if (mode !== 'points' || !a.surface || !b.surface) return [];
    return compareSkew(a.surface, b.surface, activeDistances, metric);
  }, [mode, a.surface, b.surface, activeDistances, metric]);

  const stats = useMemo(() => summarise(rows), [rows]);

  const headA = legHead(effectiveA, effectiveB);
  const headB = legHead(effectiveB, effectiveA);

  const loading = a.isLoading || b.isLoading;
  const error = a.error ?? b.error;
  const fetching = a.isFetching || b.isFetching;

  /*
   * Comparing different tenors is legitimate but not like-for-like — term
   * structure alone produces a spread. Flagged, not blocked: a weekly against
   * a monthly is a real thing to want to see.
   */
  const tenorMismatch =
    a.surface && b.surface && Math.abs(a.surface.years - b.surface.years) > 3 / 365;

  function swap() {
    setLegA(effectiveB);
    setLegB(effectiveA);
  }

  const anchorControls = (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="qs-label mr-1 text-[var(--text-tertiary)]">
        {mode === 'delta' ? 'Deltas' : mode === 'points' ? 'Points from ATM' : 'Strikes'}
      </span>
      {mode === 'moneyness'
        ? MONEYNESS.map((m) => (
            <Chip
              key={m}
              active={moneyness.includes(m)}
              onClick={() => setMoneyness(toggleIn(moneyness, m, MONEYNESS))}
            >
              {m}
            </Chip>
          ))
        : mode === 'delta'
          ? DELTAS.map((d) => (
              <Chip
                key={d}
                active={deltas.includes(d)}
                onClick={() => setDeltas(toggleIn(deltas, d, DELTAS))}
              >
                {Math.round(d * 100)}Δ
              </Chip>
            ))
          : distanceOptions.map((d) => (
              <Chip
                key={d}
                active={activeDistances.includes(d)}
                onClick={() => setDistances(toggleIn(activeDistances, d, distanceOptions))}
              >
                {d}
              </Chip>
            ))}
    </div>
  );

  return (
    <Panel flush>
      <PanelHeader
        icon={<Scale size={14} />}
        title="Analysis Sheets"
        subtitle="Relative-value volatility between two contracts"
        actions={
          <div className="flex items-center gap-2">
            {fetching ? <Spinner /> : null}
            <span
              className="qs-num text-[length:var(--type-caption)] text-[var(--text-tertiary)]"
              title="Anchors where both legs had a reading"
            >
              <span className="text-[var(--text-primary)]">{stats.matched}</span>
              {' / '}
              {stats.total} matched
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              title="Refresh both surfaces"
              aria-label="Refresh both surfaces"
              onClick={() => queryClient.invalidateQueries({ queryKey: ['surface', 'iv'] })}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
        }
      />

      {/* Legs, then how to match them. Two bands rather than one: the leg row
          answers "what am I comparing" and the control row "how", and running
          them together makes a nine-control strip nobody can scan. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <LegPicker tag="A" leg={effectiveA} onChange={setLegA} spot={a.surface?.spot ?? null} />
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          title="Swap A and B"
          aria-label="Swap legs"
          onClick={swap}
        >
          <ArrowLeftRight size={13} />
        </Button>
        <LegPicker tag="B" leg={effectiveB} onChange={setLegB} spot={b.surface?.spot ?? null} />
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--border-subtle)] px-3 py-2">
        <label className="flex items-center gap-1.5">
          <span className="qs-label text-[var(--text-tertiary)]">Match by</span>
          <SegmentedControl
            value={mode}
            options={[
              { value: 'moneyness', label: 'Strikes' },
              { value: 'points', label: 'Points' },
              { value: 'delta', label: 'Delta' },
            ]}
            onChange={(v) => setMode(v as MatchMode)}
          />
        </label>

        <label className="flex items-center gap-1.5">
          <span className="qs-label text-[var(--text-tertiary)]">Metric</span>
          <SegmentedControl
            value={metric}
            options={[
              { value: 'iv', label: 'IV' },
              { value: 'ltp', label: 'LTP' },
            ]}
            onChange={(v) => setMetric(v as Metric)}
          />
        </label>

        <div className="flex items-center gap-1.5">
          <span className="qs-label text-[var(--text-tertiary)]">Sides</span>
          {(['CE', 'PE'] as const).map((s) => (
            <Chip
              key={s}
              active={sides.includes(s)}
              onClick={() => setSides(toggleIn(sides, s, ['CE', 'PE']))}
            >
              {s}
            </Chip>
          ))}
        </div>

        <span className="h-4 w-px bg-[var(--border-default)]" aria-hidden="true" />
        {anchorControls}
      </div>

      {tenorMismatch ? (
        <p className="flex items-center gap-2 border-b border-[var(--border-subtle)] bg-[var(--accent-info-soft)] px-3 py-1.5 text-[length:var(--type-caption)] text-[var(--text-secondary)]">
          <TriangleAlert size={12} className="shrink-0 text-[var(--accent-info-hover)]" />
          These legs expire more than three days apart — term structure alone will
          produce a spread. Comparable, but not like-for-like.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error ? (
          <ErrorState
            error={error}
            onRetry={() => queryClient.invalidateQueries({ queryKey: ['surface', 'iv'] })}
          />
        ) : loading ? (
          <div className="space-y-3">
            <div className="qs-skeleton h-48" />
            <p className="text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
              Walking both option chains — a cold surface takes a few seconds, then
              it is cached and refreshed every 30s.
            </p>
          </div>
        ) : !effectiveA.expiry || !effectiveB.expiry ? (
          <EmptyState
            title="Pick an expiry on both legs"
            hint="A comparison needs two chains. Choose a contract for each leg above."
          />
        ) : !rows.length ? (
          <EmptyState
            title="Nothing to compare"
            hint={
              sides.length
                ? 'No anchor is selected. Pick at least one from the row above.'
                : 'No side is selected. Turn on CE, PE, or both.'
            }
          />
        ) : (
          <div className="space-y-3">
            <SummaryStrip stats={stats} metric={metric} headA={headA} headB={headB} />

            <div className="grid gap-3 lg:grid-cols-2">
              {sides.map((side) => (
                <SidePair
                  key={side}
                  side={side}
                  rows={rows.filter((r) => r.side === side)}
                  metric={metric}
                  headA={headA}
                  headB={headB}
                />
              ))}
            </div>

            {skewRows.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                <SkewTable head={headA} rows={skewRows} metric={metric} pick={(r) => r.a} />
                <SkewTable head={headB} rows={skewRows} metric={metric} pick={(r) => r.b} />
              </div>
            ) : null}

            <p className="px-1 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
              A relative-value screen, not an arbitrage. Two underlyings have no
              arbitrage relationship — nothing forces their vols to converge, and a
              wide spread can stay wide or widen further.
            </p>
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Mean, widest and coverage.
 *
 * The mean travels with `ratio` alongside it deliberately: a 2-point spread is
 * large when both legs are at 9 and unremarkable when both are at 40, so the
 * ratio is the number that survives a change of regime and the raw spread is
 * the one that sizes a trade today.
 */
function SummaryStrip({
  stats, metric, headA, headB,
}: {
  stats: ReturnType<typeof summarise>;
  metric: Metric;
  headA: { label: string };
  headB: { label: string };
}) {
  const unit = metric === 'iv' ? 'vol pts' : '₹';

  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      <Tile
        label={`Mean gap · ${unit}`}
        value={stats.meanSpread == null ? '—' : volPoints(stats.meanSpread)}
        tone={stats.meanSpread}
        hint={`${headA.label} minus ${headB.label}`}
      />
      <Tile
        label="Mean ratio"
        value={stats.meanRatio == null ? '—' : stats.meanRatio.toFixed(3)}
        hint="Travels across vol regimes"
      />
      <Tile
        label="Widest anchor"
        value={stats.widest ? volPoints(stats.widest.spread) : '—'}
        tone={stats.widest?.spread ?? null}
        hint={stats.widest ? `${stats.widest.label} ${stats.widest.side}` : undefined}
      />
      <Tile
        label="Coverage"
        value={`${stats.matched}/${stats.total}`}
        hint={
          stats.matched < stats.total
            ? 'Unmatched anchors are where a chain does not reach'
            : 'Both legs quoted at every anchor'
        }
      />
    </div>
  );
}

function Tile({
  label, value, hint, tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: number | null;
}) {
  const colour =
    tone == null || tone === 0
      ? 'var(--text-primary)'
      : tone > 0
        ? 'var(--market-up)'
        : 'var(--market-down)';

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--surface-raised)] px-3 py-2">
      <p className="qs-label text-[var(--text-tertiary)]">{label}</p>
      <p className="qs-num text-[length:var(--type-h3)] leading-tight" style={{ color: colour }}>
        {value}
      </p>
      {hint ? (
        <p className="truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">{hint}</p>
      ) : null}
    </div>
  );
}
