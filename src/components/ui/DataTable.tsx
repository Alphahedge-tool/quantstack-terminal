/**
 * DataTable — the workhorse. Every book in the app renders through it.
 *
 * Generic over the row type, with columns declared as data rather than as JSX.
 * That is what lets density, alignment, sticky headers and the empty state be
 * solved once instead of per page — and it makes a numeric column impossible to
 * accidentally left-align, because alignment is derived from the column's kind.
 *
 * Sorting is intentionally client-side: these books arrive whole (the backend
 * aggregates every broker in one response), so paging them back to the server
 * would add a round trip for data already in memory.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useUiStore } from '@/stores/uiStore';

export interface Column<T> {
  /** Stable identity, also the sort key. */
  id: string;
  header: ReactNode;
  /** Cell renderer. Return a string for plain text or a node for anything else. */
  cell: (row: T) => ReactNode;
  /** Value used for sorting. Omit to make the column unsortable. */
  sortValue?: (row: T) => string | number;
  /** `num` right-aligns and applies tabular figures — the default for money. */
  kind?: 'text' | 'num';
  width?: string;
  /** Hidden below `lg`. For columns that are useful but not load-bearing. */
  secondary?: boolean;
}

interface DataTableProps<T> {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, index: number) => string;
  /** Extra classes per row — used for the tick flash. */
  rowClassName?: (row: T) => string | undefined;
  onRowClick?: (row: T) => void;
  empty?: ReactNode;
  initialSort?: { id: string; direction: 'asc' | 'desc' };
  /**
   * A totals row, keyed by column id.
   *
   * Rendered as a real `<tfoot>` rather than as a line under the panel, because
   * a total belongs in the COLUMN it totals. A net P&L printed in a footer strip
   * is a number the reader has to match up to a heading by eye; the same number
   * at the foot of the P&L column needs no matching at all.
   *
   * Sticky to the bottom of the scroll region, so it stays put while a long book
   * scrolls past — a total you have to scroll to find is a total you check less
   * often than you should.
   *
   * Columns with no entry render empty, so a caller only names what it can
   * meaningfully sum. Summing every numeric column is how a table ends up
   * reporting the total of a price.
   */
  totals?: Record<string, ReactNode>;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowClassName,
  onRowClick,
  empty,
  initialSort,
  totals,
}: DataTableProps<T>) {
  const density = useUiStore((s) => s.density);
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((c) => c.id === sort.id);
    if (!column?.sortValue) return rows;
    const factor = sort.direction === 'asc' ? 1 : -1;
    // Copy before sorting: mutating the array from the query cache would make
    // React Query hand the next subscriber a re-ordered "unchanged" result.
    return [...rows].sort((a, b) => {
      const av = column.sortValue!(a);
      const bv = column.sortValue!(b);
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor;
      return String(av).localeCompare(String(bv)) * factor;
    });
  }, [rows, columns, sort]);

  function toggleSort(column: Column<T>): void {
    if (!column.sortValue) return;
    setSort((current) => {
      if (current?.id !== column.id) return { id: column.id, direction: 'desc' };
      if (current.direction === 'desc') return { id: column.id, direction: 'asc' };
      return null; // Third click clears — back to the backend's own order.
    });
  }

  const cellPad = density === 'compact' ? 'px-3 py-1' : 'px-3 py-2';

  if (rows.length === 0 && empty) {
    return <>{empty}</>;
  }

  return (
    <table className="w-full border-collapse text-[length:var(--type-caption)]">
      <thead>
        <tr>
          {columns.map((column) => {
            const active = sort?.id === column.id;
            const sortable = Boolean(column.sortValue);
            return (
              <th
                key={column.id}
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'qs-label sticky top-0 z-[var(--z-sticky)] whitespace-nowrap',
                  'border-b border-[var(--container-rule)] bg-[var(--container-head)]',
                  cellPad,
                  column.kind === 'num' ? 'text-right' : 'text-left',
                  column.secondary && 'hidden lg:table-cell',
                  sortable && 'cursor-pointer select-none hover:text-[var(--text-primary)]',
                )}
                onClick={() => toggleSort(column)}
              >
                <span
                  className={cn(
                    'inline-flex items-center gap-1',
                    column.kind === 'num' && 'flex-row-reverse',
                  )}
                >
                  {column.header}
                  {sortable ? (
                    active ? (
                      sort!.direction === 'asc' ? (
                        <ChevronUp size={11} className="text-[var(--accent-info)]" />
                      ) : (
                        <ChevronDown size={11} className="text-[var(--accent-info)]" />
                      )
                    ) : (
                      // Always reserve the glyph's space, even when inactive:
                      // otherwise the header shifts sideways on first sort.
                      <ChevronsUpDown size={11} className="opacity-25" />
                    )
                  ) : null}
                </span>
              </th>
            );
          })}
        </tr>
      </thead>

      <tbody>
        {sorted.map((row, index) => (
          <tr
            key={rowKey(row, index)}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={cn(
              'border-b border-[var(--container-rule)] transition-colors duration-100',
              'hover:bg-[var(--container-hover)]',
              onRowClick && 'cursor-pointer',
              rowClassName?.(row),
            )}
          >
            {columns.map((column) => (
              <td
                key={column.id}
                className={cn(
                  'whitespace-nowrap text-[var(--text-primary)]',
                  cellPad,
                  column.kind === 'num' && 'qs-num text-right',
                  column.secondary && 'hidden lg:table-cell',
                )}
              >
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>

      {totals ? (
        <tfoot>
          <tr>
            {columns.map((column) => (
              <td
                key={column.id}
                className={cn(
                  'sticky bottom-0 z-[var(--z-sticky)] whitespace-nowrap',
                  'border-t border-[var(--border-default)] bg-[var(--container-head)]',
                  'font-semibold text-[var(--text-primary)]',
                  cellPad,
                  column.kind === 'num' && 'qs-num text-right',
                  column.secondary && 'hidden lg:table-cell',
                )}
              >
                {totals[column.id] ?? null}
              </td>
            ))}
          </tr>
        </tfoot>
      ) : null}
    </table>
  );
}
