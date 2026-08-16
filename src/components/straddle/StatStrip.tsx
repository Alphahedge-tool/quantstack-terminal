/**
 * The one-line stat strip.
 *
 * ── Why this is not `StatTile` ──
 *
 * `StatTile` is right where the numbers ARE the page: a display-size value in a
 * card you can read from across a desk. Here they are the chart's caption. Four
 * of those cards cost ~110px, and a first pass at a `dense` card still cost
 * ~52px plus a 10px gap — for four figures that between them hold about sixty
 * characters.
 *
 * So the card is dropped rather than shrunk. Label, value and detail run
 * HORIZONTALLY in one 34px row: the whole strip now costs less than one tile
 * did, and the charts start that much higher up the page. Trying to reach this
 * height by shrinking a vertical tile would have meant a 9px value — smaller
 * than the label above it, which is the point where a component stops being a
 * smaller version of itself and starts being a different one.
 *
 * The mono column survives, which is the part that actually mattered: values
 * are still tabular, so a ticking number does not make the row jitter.
 */

import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { cn } from '@/lib/cn';
import { direction } from '@/lib/format';

/**
 * A direction arrow for a figure that carries its own identity colour.
 *
 * ── Why an arrow and not just colouring the number ──
 *
 * The synthetic future, spot and ATM IV are tinted to their series so the eye
 * can link them to their lines. That spends their colour on identity, which
 * leaves nothing to say which way they are going — so direction moves to a
 * separate mark. The number says WHAT, the arrow says WHICH WAY, and neither
 * has to give up its channel to the other.
 *
 * Shape carries the meaning as well as colour: up and down arrows are
 * distinguishable without seeing red and green at all, which matters because
 * red/green is the one pair that collapses under deuteranopia.
 *
 * Exactly zero is drawn as a dash rather than as an up arrow. On a session
 * comparison a genuine no-change happens — a contract that has not printed
 * since the open — and calling that a rise would be a small lie told often.
 */
export function Trend({
  value,
  label,
}: {
  /** The signed change. `null` renders nothing rather than a neutral mark —
   *  "no baseline to compare against" is not "unchanged". */
  value: number | null | undefined;
  /** What is moving, for the accessible name: "Spot", "ATM IV". */
  label: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const flat = value === 0;
  const Icon = flat ? Minus : value > 0 ? ArrowUp : ArrowDown;
  const word = flat ? 'unchanged since the open' : value > 0 ? 'up' : 'down';
  const magnitude = flat ? '' : ` ${Math.abs(value).toFixed(2)} since the open`;

  return (
    <span
      role="img"
      aria-label={`${label} ${word}${magnitude}`}
      title={`${label} ${word}${magnitude}`}
      className="inline-flex shrink-0 items-center self-center"
      style={{
        color: flat
          ? 'var(--text-tertiary)'
          : value > 0
            ? 'var(--market-up)'
            : 'var(--market-down)',
      }}
    >
      {/* Heavier stroke than the default: at 11px a 2px-stroke arrow loses its
          head and reads as a bare tick. */}
      <Icon size={11} strokeWidth={3} aria-hidden />
    </span>
  );
}

export interface Stat {
  label: string;
  value: ReactNode;
  /** Trails the value in tertiary ink — the comparison, the count, the source. */
  detail?: ReactNode;
  /** When present, colours the value by sign. */
  signedBy?: number | null;
  /**
   * An IDENTITY colour for the value — normally the `--series-*` token of the
   * line that plots it on the chart below.
   *
   * White is the "no information" default: it says a number is a number. Giving
   * a figure the colour of its own line means the eye links the two without a
   * legend, which is the whole reason a terminal colours its tickers.
   *
   * Distinct from `signedBy`, which colours by DIRECTION, and the two must not
   * be set together — a value cannot mean "this is the synthetic future" and
   * "this went up" in one colour. They stay unambiguous in practice because the
   * identity tokens are blue and violet while direction is only ever the
   * green/red pair, so no reader has to guess which sense is in play.
   */
  tone?: string;
  /** Signed change since the session open. Draws a `Trend` arrow after the
   *  value — used alongside `tone`, where colour is already spent on identity. */
  trend?: number | null;
}

export function StatStrip({
  stats,
  className,
  embedded = false,
}: {
  stats: Stat[];
  className?: string;
  /** Removes the outer card treatment when the strip is part of a larger
   *  workspace header. The parent then owns the edge and elevation. */
  embedded?: boolean;
}) {
  return (
    <div
      className={cn(
        embedded
          ? 'flex h-7 min-w-0 items-center divide-x divide-[var(--container-rule)] ' +
            'overflow-x-auto border-t border-[var(--container-rule)] ' +
            '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
          : 'qs-container flex flex-wrap items-center gap-x-5 gap-y-1 px-3 py-1.5',
        className,
      )}
    >
      {stats.map((stat, index) => {
        const dir = stat.signedBy === undefined ? 'flat' : direction(stat.signedBy);
        return (
          <div
            key={stat.label}
            className={cn(
              'flex items-baseline gap-1.5',
              embedded ? 'min-w-[10rem] flex-1 px-3' : 'min-w-0',
            )}
          >
            {/* A rule between items rather than a gap alone: at this density the
                eye needs a boundary to stop reading one item's detail as the
                next item's label. It is drawn on the item, not between them, so
                a wrapped row never starts with a dangling divider. */}
            {!embedded && index > 0 ? (
              <span
                aria-hidden
                className="mr-3.5 hidden h-3.5 w-px self-center bg-[var(--border-default)] sm:block"
              />
            ) : null}

            <span className="qs-label shrink-0">{stat.label}</span>

            <span
              className={cn(
                'shrink-0 font-mono text-[length:var(--type-control)] font-semibold tabular-nums',
                'leading-tight tracking-[var(--tracking-tight)]',
                // Sign wins where it is set, since direction is the reading;
                // otherwise identity; otherwise the plain default.
                stat.signedBy !== undefined
                  ? dir === 'up'
                    ? 'text-[var(--market-up)]'
                    : dir === 'down'
                      ? 'text-[var(--market-down)]'
                      : 'text-[var(--text-primary)]'
                  : stat.tone
                    ? undefined
                    : 'text-[var(--text-primary)]',
              )}
              style={stat.signedBy === undefined && stat.tone ? { color: stat.tone } : undefined}
            >
              {stat.value}
            </span>

            {stat.trend !== undefined ? <Trend value={stat.trend} label={stat.label} /> : null}

            {stat.detail ? (
              <span className="truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                {stat.detail}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * A detail whose figure carries a series colour while its word stays quiet.
 *
 * The same two-level split the chart readout uses: the word is scaffolding a
 * reader stops seeing, the number is the payload. Colouring the whole detail
 * would tint the label too and make a secondary line shout as loudly as the
 * value above it.
 */
export function DetailValue({
  k,
  v,
  tone,
  trend,
}: {
  k: string;
  v: string;
  tone?: string;
  trend?: number | null;
}) {
  return (
    <>
      {k}{' '}
      <span className="qs-num font-semibold" style={tone ? { color: tone } : undefined}>
        {v}
      </span>
      {trend !== undefined ? (
        <>
          {' '}
          <Trend value={trend} label={k} />
        </>
      ) : null}
    </>
  );
}
