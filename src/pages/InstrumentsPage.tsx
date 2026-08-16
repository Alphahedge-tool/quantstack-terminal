/**
 * Instrument search — the lookup against the canonical master.
 *
 * The master is a broker file that fills in the background after login, so the
 * first search in a fresh session can legitimately return nothing for a symbol
 * that does exist. That is worth saying in the empty state rather than letting
 * the user conclude the symbol is not tradable.
 */

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { PageHeader } from '@/components/layout/AppShell';
import { Panel, PanelBody, PanelHeader } from '@/components/ui/Panel';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { SearchInput, Select } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Badge';
import { EmptyState, ErrorState, Spinner, TableSkeleton } from '@/components/ui/States';
import { useInstrumentSearch } from '@/hooks/queries';
import { decimal, expiryLabel, integer } from '@/lib/format';
import type { Instrument } from '@/schemas/market';

const EXCHANGES = [
  { value: '', label: 'All exchanges' },
  { value: 'NSE', label: 'NSE' },
  { value: 'NFO', label: 'NFO' },
  { value: 'BSE', label: 'BSE' },
  { value: 'MCX', label: 'MCX' },
  { value: 'CDS', label: 'CDS' },
];

/** Debounce, so typing "BANKNIFTY" issues one request rather than nine. */
function useDebounced<T>(value: T, delay = 250): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return settled;
}

export function InstrumentsPage() {
  const [term, setTerm] = useState('');
  const [exchange, setExchange] = useState('');
  const debounced = useDebounced(term);
  const query = useInstrumentSearch(debounced, exchange);

  const rows = useMemo(() => query.data?.instruments ?? [], [query.data]);

  const columns: Column<Instrument>[] = [
    {
      id: 'symbol',
      header: 'Symbol',
      cell: (row) => (
        <div className="min-w-0 leading-tight">
          <div className="truncate font-medium text-[var(--text-primary)]">{row.symbol}</div>
          {row.name && row.name !== row.symbol ? (
            <div className="mt-0.5 truncate text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
              {row.name}
            </div>
          ) : null}
        </div>
      ),
      sortValue: (row) => row.symbol,
      width: '28%',
    },
    {
      id: 'exchange',
      header: 'Exchange',
      cell: (row) => <Badge tone="neutral">{row.exchange}</Badge>,
      sortValue: (row) => row.exchange,
    },
    {
      id: 'underlying',
      header: 'Underlying',
      cell: (row) => (
        <span className="text-[var(--text-secondary)]">{row.underlying || '—'}</span>
      ),
      sortValue: (row) => row.underlying,
      secondary: true,
    },
    {
      id: 'expiry',
      header: 'Expiry',
      cell: (row) =>
        row.expiry ? (
          <span className="qs-num text-[var(--text-secondary)]">{expiryLabel(row.expiry)}</span>
        ) : (
          <span className="text-[var(--text-disabled)]">—</span>
        ),
      sortValue: (row) => row.expiry,
    },
    {
      id: 'strike',
      header: 'Strike',
      kind: 'num',
      cell: (row) => (row.strike ? decimal(row.strike, 0) : '—'),
      sortValue: (row) => row.strike ?? 0,
    },
    {
      id: 'type',
      header: 'Type',
      cell: (row) =>
        row.optionType ? (
          // CE and PE are the fastest thing to scan in an option list, so they
          // get the accent/warning pairing rather than plain text.
          <Badge tone={row.optionType === 'CE' ? 'accent' : 'warning'}>{row.optionType}</Badge>
        ) : (
          <span className="text-[var(--text-disabled)]">—</span>
        ),
      sortValue: (row) => row.optionType,
    },
    {
      id: 'lot',
      header: 'Lot',
      kind: 'num',
      cell: (row) => (row.lot ? integer(row.lot) : '—'),
      sortValue: (row) => row.lot,
      secondary: true,
    },
  ];

  const tooShort = debounced.trim().length < 2;

  return (
    <>
      <PageHeader title="Instruments" subtitle="Search the canonical instrument master" />

      <Panel flush>
        <PanelHeader
          title="Search"
          icon={<Search size={14} />}
          subtitle={
            tooShort
              ? 'Type at least two characters'
              : `${query.data?.count ?? rows.length} match${(query.data?.count ?? rows.length) === 1 ? '' : 'es'}`
          }
          actions={
            <div className="flex items-center gap-2">
              {query.isFetching ? <Spinner /> : null}
              <Select
                aria-label="Exchange"
                value={exchange}
                options={EXCHANGES}
                onChange={(e) => setExchange(e.target.value)}
                className="w-36"
              />
              <div className="w-64">
                <SearchInput
                  autoFocus
                  placeholder="NIFTY, CRUDEOIL, RELIANCE…"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
              </div>
            </div>
          }
        />

        <PanelBody>
          {tooShort ? (
            <EmptyState
              icon={<Search size={22} strokeWidth={1.5} />}
              title="Search the instrument master"
              hint="Enter a symbol, an underlying or part of a name. Results come from the canonical table the feeds share."
            />
          ) : query.isLoading ? (
            <TableSkeleton columns={6} />
          ) : query.error ? (
            <ErrorState error={query.error} onRetry={() => query.refetch()} />
          ) : (
            <DataTable
              rows={rows}
              columns={columns}
              rowKey={(row, i) => `${row.exchange}:${row.symbol}:${i}`}
              empty={
                <EmptyState
                  title={`Nothing matches "${debounced}"`}
                  // The master loads in the background after login — an empty
                  // result seconds into a session is often "not loaded yet"
                  // rather than "does not exist", and the two need different
                  // reactions from the user.
                  hint="If you have only just signed in, the instrument master may still be loading. Try again in a moment."
                />
              }
            />
          )}
        </PanelBody>
      </Panel>
    </>
  );
}
