/**
 * Bridge between the token ladder and lightweight-charts.
 *
 * The charting library paints to a canvas and takes literal colour strings — it
 * cannot resolve `var(--series-iv)`. Hardcoding the hexes into the chart
 * component would fork the palette: `tokens.css` would move and the canvas
 * would not, which is exactly the drift the token system exists to prevent.
 *
 * So the values are read out of the live computed style ONCE per chart mount
 * and handed over as literals. One place knows the token names; everything else
 * keeps consuming roles.
 */

/**
 * Resolve one design token to a literal colour, for the canvas.
 *
 * Exported because `ChartTheme` can only name the roles it knows about, and a
 * CATEGORICAL palette — one hue per symbol on the straddle wall, say — is chosen
 * by the component, not by this file. Without an escape hatch the caller reaches
 * for `var(--series-iv)`, which a canvas cannot resolve and paints BLACK. That
 * has now happened twice in this project: once on the DTE-median overlay and
 * once on the wall.
 *
 * Call it during render or in an effect, never at module scope: at module-eval
 * time the stylesheet may not have applied and every token would come back as
 * its fallback.
 */
export function cssToken(name: string, fallback: string): string {
  return token(name, fallback);
}

/** Reads a custom property off the document root. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/**
 * `rgba()` from a `#rrggbb` token.
 *
 * Grid and border lines want the surface colour at low alpha rather than a
 * solid mid-grey: a solid line at that luminance competes with the marks, and
 * an alpha line composites correctly over whichever pane it lands on.
 *
 * Exported as `alphaOf` for the same reason `cssToken` is: a FILL is not a
 * line. The vs-median pane washes a whole region in the direction colour, and
 * at full opacity that region would out-shout every stroke on the chart —
 * including the candles it is describing. Callers reaching for their own
 * hand-written `rgba(...)` literal is how the palette forks.
 */
function alpha(hex: string, a: number): string {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!match) return hex;
  const [r, g, b] = match.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const alphaOf = alpha;

export interface ChartTheme {
  surface: string;
  text: string;
  textStrong: string;
  grid: string;
  border: string;
  crosshair: string;
  crosshairLabel: string;
  paneLabel: string;
  up: string;
  down: string;
  sf: string;
  iv: string;
  bid: string;
  ask: string;
  spot: string;
  thetaCall: string;
  thetaPut: string;
  roll: string;
  /** The DTE-median overlay and its cohort band. */
  compare: string;
  compareBand: string;
  fontFamily: string;
  fontMono: string;
}

export function readChartTheme(): ChartTheme {
  const strong = token('--border-strong', '#55534f');
  return {
    surface: token('--surface-chart', '#1c1b19'),
    text: token('--text-secondary', '#a4a29d'),
    textStrong: token('--text-primary', '#e0dfdc'),
    // Recessive by construction. The grid locates a mark; it must never read as
    // one, so it is the strong border at 22% rather than a solid line.
    grid: alpha(strong, 0.22),
    border: alpha(strong, 0.4),
    crosshair: token('--text-tertiary', '#706e69'),
    crosshairLabel: token('--surface-hover', '#302f2c'),
    /**
     * The caption naming what a pane plots.
     *
     * Its own role, deliberately, even though it currently resolves to the same
     * step the axis text does. It used to borrow `crosshair` — a colour chosen
     * for a dashed LINE, reused for TYPE. Those two have opposite requirements:
     * a crosshair line should be as quiet as it can be and still be followed,
     * while a pane caption is the one thing that says what you are looking at,
     * and at tertiary on the chart surface it was the dimmest text on screen
     * doing the most important job. Separate names so dimming the crosshair
     * never again dims the label.
     */
    paneLabel: token('--text-secondary', '#96948f'),
    up: token('--market-up', '#7fc45a'),
    down: token('--market-down', '#dd6974'),
    sf: token('--series-sf', '#38bdf8'),
    iv: token('--series-iv', '#fdab43'),
    bid: token('--series-bid', '#7fc45a'),
    ask: token('--series-ask', '#dd6974'),
    spot: token('--series-vega', '#b78af0'),
    thetaCall: token('--series-theta-call', '#38bdf8'),
    thetaPut: token('--series-theta-put', '#ffd43b'),
    roll: token('--accent-info', '#4f98a3'),
    /**
     * The comparison overlay — NEUTRAL, deliberately.
     *
     * Every other series on this chart owns a hue that means something: green
     * up, red down, green bid, red ask, violet spot, blue synthetic future,
     * amber IV. The comparison is not another market quantity, it is a
     * reference the others are read against — so it takes the one range left
     * that carries no meaning of its own, and stops competing for the reader's
     * colour vocabulary.
     *
     * White for the median, grey for the band. Same family, so they read as one
     * object, with the median unambiguously the primary line.
     *
     * Both are full-opacity tokens rather than alpha over the surface. Measured
     * on `--surface-chart` #1c1b19:
     *
     *   compare      #e0dfdc   14.8:1
     *   compareBand  #a4a29d    6.8:1
     *
     * `--border-strong` #55534f was the intuitive pick for the band and is
     * wrong: it measures 2.26:1, under the 3:1 a graphical object needs to be
     * perceivable at all. Separation from the median comes from the band being
     * DASHED and 1px against 2px solid — a difference that survives at full
     * brightness, unlike dimming, which trades legibility for hierarchy.
     */
    compare: token('--text-primary', '#e0dfdc'),
    compareBand: token('--text-secondary', '#a4a29d'),
    fontFamily: token('--font-sans', 'Inter, sans-serif'),
    fontMono: token('--font-mono', 'monospace'),
  };
}

/**
 * IST clock for an axis tick or a crosshair label.
 *
 * lightweight-charts stamps every `UTCTimestamp` in UTC and offers no timezone
 * option. Left alone, an Indian session would label its 09:15 open as 03:45 —
 * so both the tick formatter and the localization formatter are overridden and
 * both must use this, or the axis and the crosshair disagree by 5h30m.
 */
const IST_HM = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const IST_HMS = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function istClock(seconds: number): string {
  return IST_HM.format(new Date(seconds * 1000));
}

export function istClockSeconds(seconds: number): string {
  return IST_HMS.format(new Date(seconds * 1000));
}
