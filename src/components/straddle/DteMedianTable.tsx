/**
 * The DTE-median cohort as a table — every minute, every session, and the
 * low/median/high the chart draws from them.
 *
 * ── Why a table at all, next to a chart of the same numbers ──
 *
 * The overlay answers "is today rich or cheap against a typical session at this
 * DTE" at a glance and nothing else. It cannot answer the question that follows,
 * which is always the same one: WHICH session is pulling the band. A median of
 * five drawn as a line is five contributions collapsed into one pixel column,
 * and a band edge 27 points wide is the work of one session the reader cannot
 * name. Here the five are columns, so an outlier has a date on it.
 *
 * It is also the only view that survives being checked. Reconciling a straddle
 * engine against another terminal means comparing numbers at a stated minute,
 * and reading those off a chart by hovering is how a 2% discrepancy goes unseen.
 *
 * ── Two units, and why both are needed ──
 *
 * REBASED is what the chart draws. The cohort is pooled as an index — five
 * contracts at five spot levels cannot be averaged in rupees — and multiplied
 * back by today's open, exactly as `projectToPoints` does, so the table and the
 * overlay are the same numbers.
 *
 * RAW is what each session actually printed, and leaving it out was a real
 * defect. A column headed `08-07` showing `192.93` reads as a statement about
 * the 7 Aug straddle; the 7 Aug straddle was 256.15. Both numbers are correct —
 * 256.15 × (190.05 / 252.25) = 192.99 — but only one of them can be checked
 * against a chart of that session, and a table nobody can reconcile against the
 * source is a table nobody should trust. So the switch exists, and the anchors
 * that relate the two are printed above it rather than left to be inferred.
 */

import { useMemo } from 'react';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/States';
import { clockOf, type MedianProfile, type RebasedSession } from '@/lib/straddle/dteMedian';
import type { StraddlePoint } from '@/schemas/market';

const IST_OFFSET_MIN = 330;

type Units = 'rebased' | 'raw';

interface Row {
  minute: number;
  /** Per cohort session, aligned to the columns, in the CURRENT units. `null`
   *  where that session did not report this minute. */
  values: Array<number | null>;
  lo: number;
  median: number;
  hi: number;
  n: number;
  /** Today's own straddle at this minute, when today has reached it. Always
   *  raw — today needs no rebasing, it IS the base. */
  today: number | null;
}

interface Props {
  /** Already pooled in `units` — the same object the chart plots. */
  profile: MedianProfile;
  sessions: RebasedSession[];
  /** Per-session multiplier from index to `units`, from `unitScales`. */
  scales: number[];
  units: Units;
  /** Today's opening anchor, in points. Shown so the two units reconcile. */
  todayOpen: number;
  /** Today's session, for the comparison column. */
  todayPoints: StraddlePoint[];
}

/**
 * Note what this component does NOT do: choose a unit, or scale anything into
 * one. Both arrive from the slot, which hands the identical `profile` to the
 * chart. When the table computed its own, the two views could disagree about
 * the same minute of the same session, and each was independently correct.
 */
export function DteMedianTable({
  profile, sessions, scales, units, todayOpen, todayPoints,
}: Props) {
  /*
   * Today, collapsed to one value per minute.
   *
   * Today arrives at 1-second and the cohort at 1-minute, so this has to be
   * bucketed before the two can share a row. LAST print in the minute wins,
   * which makes the column a close-of-minute series — the same convention
   * `rebaseSession` uses, so "vs median" is not comparing a close against an
   * open.
   */
  const todayByMinute = useMemo(() => {
    const map = new Map<number, number>();
    for (const point of todayPoints) {
      const value = point.straddlePrice;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
      map.set(Math.floor((point.time / 60_000 + IST_OFFSET_MIN) % 1440), value);
    }
    return map;
  }, [todayPoints]);

  const rows = useMemo<Row[]>(
    () =>
      profile.points.map((point) => ({
        minute: point.minute,
        // Per-session cells use the same `scales` the profile was pooled with,
        // so a row's Low/Median/High are always drawn from the very numbers
        // printed beside them.
        values: sessions.map((s, i) => {
          const index = s.byMinute.get(point.minute);
          return index === undefined ? null : index * (scales[i] ?? 1);
        }),
        lo: point.lo,
        median: point.median,
        hi: point.hi,
        n: point.n,
        today: todayByMinute.get(point.minute) ?? null,
      })),
    [profile.points, sessions, scales, todayByMinute],
  );

  const columns = useMemo<Column<Row>[]>(() => {
    const num = (v: number | null) => (v == null ? '—' : v.toFixed(2));

    const sessionColumns: Column<Row>[] = sessions.map((session, index) => ({
      id: `s${index}`,
      // Day and month only. The year is the same across a five-week cohort and
      // five full ISO dates in a header row is most of the table's width.
      header: session.date.slice(5),
      cell: (row) => num(row.values[index]),
      sortValue: (row) => row.values[index] ?? Number.NEGATIVE_INFINITY,
      kind: 'num',
      // Secondary, so a narrow pane keeps the summary and drops the detail
      // rather than truncating everything equally.
      secondary: true,
    }));

    return [
      {
        id: 'minute',
        header: 'Time',
        cell: (row) => clockOf(row.minute),
        sortValue: (row) => row.minute,
        width: '4.5rem',
      },
      ...sessionColumns,
      {
        id: 'lo',
        header: 'Low',
        cell: (row) => num(row.lo),
        sortValue: (row) => row.lo,
        kind: 'num',
      },
      {
        id: 'median',
        header: 'Median',
        // Matches the overlay's own colour, so the column and the line on the
        // chart are recognisably the same quantity.
        cell: (row) => (
          <span style={{ color: 'var(--text-primary)' }}>{num(row.median)}</span>
        ),
        sortValue: (row) => row.median,
        kind: 'num',
      },
      {
        id: 'hi',
        header: 'High',
        cell: (row) => num(row.hi),
        sortValue: (row) => row.hi,
        kind: 'num',
      },
      {
        id: 'width',
        header: 'Width',
        cell: (row) => num(row.hi - row.lo),
        sortValue: (row) => row.hi - row.lo,
        kind: 'num',
        secondary: true,
      },
      {
        id: 'today',
        header: 'Today',
        cell: (row) => num(row.today),
        sortValue: (row) => row.today ?? Number.NEGATIVE_INFINITY,
        kind: 'num',
      },
      /*
       * Only in rebased units.
       *
       * Today's premium minus a median of five sessions that each traded at
       * their own spot level is a subtraction between different things — on
       * 2026-08-14 it would read −56, which is not richness, it is the fact that
       * NIFTY was lower. Rebasing is the entire reason the difference means
       * anything, so the column goes away when the rebasing does rather than
       * printing a number that invites the wrong read.
       */
      ...(units === 'rebased'
        ? ([{
            id: 'vs',
            header: 'vs median',
            cell: (row) => {
              if (row.today == null) return '—';
              const diff = row.today - row.median;
              return (
                <span style={{ color: toneFor(diff) }}>
                  {diff > 0 ? '+' : ''}{diff.toFixed(2)}
                </span>
              );
            },
            sortValue: (row) => (row.today == null ? 0 : row.today - row.median),
            kind: 'num',
          }] as Column<Row>[])
        : []),
      {
        id: 'n',
        header: 'N',
        // Not decoration. A row backed by three sessions and one backed by five
        // print an identical median, and only one of them is worth acting on.
        cell: (row) => String(row.n),
        sortValue: (row) => row.n,
        kind: 'num',
        width: '3rem',
        secondary: true,
      },
    ];
  }, [sessions, units]);

  if (!rows.length) {
    return (
      <EmptyState
        title="No cohort"
        hint="No previous session at this DTE returned data the engine could walk."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[var(--border-subtle)] px-3 py-2">
        {/* The switch itself lives in the pane header, because it drives the
            chart too. This line only says which way it is set. */}
        <p className="text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
          {units === 'rebased'
            ? 'Rebased — each session scaled to today’s open.'
            : 'Raw — each session’s own traded premium, checkable against that day’s chart.'}
        </p>

        {/* The anchors, printed rather than implied.
            These are the only numbers that relate the two units, and without
            them "why does 08-07 say 192.93 when that day traded 256" has no
            answer visible anywhere on screen. With them it is one division. */}
        <p className="qs-num w-full text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
          <span className="text-[var(--text-secondary)]">anchors</span>{' '}
          {sessions.map((s) => `${s.date.slice(5)} ${s.open.toFixed(2)}`).join(' · ')}
          {' · '}
          <span className="text-[var(--text-secondary)]">today</span> {todayOpen.toFixed(2)}
        </p>
      </div>

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => String(row.minute)}
        // Chronological, not sorted by magnitude. The point of the table is to
        // read a session's shape down the page; the columns stay sortable for
        // hunting an extreme.
        initialSort={{ id: 'minute', direction: 'asc' }}
      />
    </div>
  );
}

function toneFor(value: number): string {
  if (value > 0) return 'var(--market-up)';
  if (value < 0) return 'var(--market-down)';
  return 'var(--text-secondary)';
}
