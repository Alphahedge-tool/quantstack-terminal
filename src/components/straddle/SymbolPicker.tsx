/**
 * The contract's underlying, searched rather than chosen from a list.
 *
 * ── Why this replaced a `<Select>` ──
 *
 * The slot used to offer seven hardcoded underlyings — four NSE indices and
 * three MCX commodities. Everything else the engine can walk was unreachable
 * from the page: SENSEX and BANKEX on BSE, GOLD, SILVER, and every F&O stock.
 * The straddle engine never needed that list; it takes a symbol and an exchange
 * and walks whatever the instrument master carries. The list was purely a UI
 * limit, and a hardcoded one has to be edited every time an exchange lists
 * something new.
 *
 * So the picker asks the backend instead. `/api/instruments/search` answers
 * from the same instrument cache the engine resolves contracts against, which
 * means anything offered here is by construction something the engine can walk
 * — a symbol that appears in this list cannot be a dead end.
 *
 * ── The exchange travels with the symbol ──
 *
 * Picked together, always, and never re-derived downstream. SENSEX on NSE
 * returns zero expiries and on BSE returns nineteen; the old `exchangeFor`
 * lookup knew only the NSE and MCX names, so any BSE symbol quietly resolved to
 * NSE and drew an empty chart with no error anywhere. The search result already
 * states which exchange the asset was found on, so it is carried through rather
 * than guessed.
 *
 * ── Why the list is a portal ──
 *
 * `Panel` is `overflow-hidden`, and it has to be — it is what keeps a chart
 * inside its own rounded corners. A dropdown absolutely positioned inside the
 * panel header is clipped by that same rule, and in the 2×2 layout the panel is
 * barely taller than the list, so most of the results would simply be invisible.
 * So the list renders into `document.body` at coordinates measured from the
 * trigger, and flips above it when the space below is not enough.
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Spinner } from '@/components/ui/States';
import { useEligibleSearch } from '@/hooks/queries';
import type { EligibleAsset } from '@/schemas/market';
import { cn } from '@/lib/cn';

/** Scopes the search. Blank searches every exchange the feed carries. */
const EXCHANGES = [
  { value: '', label: 'All' },
  { value: 'NSE', label: 'NSE' },
  { value: 'BSE', label: 'BSE' },
  { value: 'MCX', label: 'MCX' },
];

/** Debounce, so typing "BANKNIFTY" issues one request rather than nine. */
function useDebounced<T>(value: T, delay = 200): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return settled;
}

const KIND_TONE: Record<string, 'accent' | 'neutral' | 'warning'> = {
  INDEX: 'accent',
  STOCK: 'neutral',
  COMMODITY: 'warning',
};

export interface SymbolChoice {
  symbol: string;
  exchange: string;
}

interface Props {
  symbol: string;
  exchange: string;
  onChange: (choice: SymbolChoice) => void;
  /** Matches the slot's other controls in the dense layouts. */
  dense?: boolean;
}

export function SymbolPicker({ symbol, exchange, onChange, dense }: Props) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [scope, setScope] = useState('');
  const [active, setActive] = useState(0);
  const [box, setBox] = useState({ top: 0, left: 0 });
  const debounced = useDebounced(term);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Only queried while the popover is open: four slots on the page would
  // otherwise each hold a search subscription for a list nobody is looking at.
  const query = useEligibleSearch(debounced, scope, open);
  const results: EligibleAsset[] = useMemo(
    () => query.data?.instruments ?? [],
    [query.data],
  );

  // A new result set invalidates the old highlight — leaving it at index 7
  // after a search that returned two rows means Enter selects nothing.
  useEffect(() => setActive(0), [debounced, scope]);

  /**
   * Close on an outside press.
   *
   * Both containers are tested, because the list is no longer a descendant of
   * the trigger in the DOM — testing only `rootRef` would treat every click on
   * a result as an outside press and close the list before the row's own
   * handler ran. Pointerdown rather than click, so a press that starts outside
   * cannot land on a row that moved under the cursor.
   */
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Node;
      if (rootRef.current?.contains(target) || popRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);

  /**
   * Where the list sits, in viewport coordinates.
   *
   * Measured on open and re-measured on scroll or resize — a fixed element does
   * not follow the trigger on its own, and a list left behind over the chart
   * while the page scrolls is worse than one that closes. `PANEL` is the list's
   * own height budget; below that much room it flips above the trigger.
   */
  useEffect(() => {
    if (!open) return;
    const PANEL = 360;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 288; // w-72
      const below = window.innerHeight - rect.bottom;
      setBox({
        top: below < PANEL && rect.top > below ? rect.top - PANEL - 4 : rect.bottom + 4,
        // Right-aligned to the trigger, then pulled back inside the viewport —
        // the slot's controls sit at the right edge of a panel that can itself
        // be at the right edge of the window.
        left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  // Keep the highlighted row in view when the arrows walk past the fold.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, results]);

  const choose = (asset: EligibleAsset) => {
    onChange({ symbol: asset.asset, exchange: asset.exchange });
    setOpen(false);
    setTerm('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const hit = results[active];
      if (hit) choose(hit);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Underlying"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${symbol} · ${exchange} — click to search any underlying`}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex h-[var(--control-compact)] items-center justify-between gap-1.5',
          'rounded-[var(--control-radius)] border border-[var(--control-border)]',
          'bg-[var(--control-bg)] px-2 text-[length:var(--type-control)]',
          'text-[var(--text-primary)] outline-none transition-colors duration-100',
          'hover:border-[var(--border-strong)] focus:border-[var(--border-focus)]',
          dense ? 'w-32' : 'w-40',
        )}
      >
        <span className="min-w-0 truncate font-medium">{symbol || 'Pick symbol'}</span>
        <span className="shrink-0 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
          {exchange}
        </span>
        <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
      </button>

      {open ? createPortal(
        <div
          ref={popRef}
          role="listbox"
          aria-label="Underlying search"
          style={{ top: box.top, left: box.left }}
          className={cn(
            'fixed z-50 w-72 overflow-hidden rounded-[var(--control-radius)]',
            'border border-[var(--border-strong)] bg-[var(--container-blue)] shadow-lg',
          )}
        >
          <div className="flex items-center gap-2 border-b border-[var(--container-rule)] px-2 py-1.5">
            <Search size={13} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              autoFocus
              value={term}
              placeholder="SENSEX, CRUDEOIL, RELIANCE…"
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={onKeyDown}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-[length:var(--type-control)]',
                'text-[var(--text-primary)] outline-none',
                'placeholder:text-[var(--text-tertiary)]',
              )}
            />
            {query.isFetching ? <Spinner /> : null}
          </div>

          {/* Scoping is a filter on the same search, not a different one — and
              the blank scope is the default because a user who knows the symbol
              should not have to know which exchange lists it. */}
          <div className="flex items-center gap-1 border-b border-[var(--container-rule)] px-2 py-1.5">
            {EXCHANGES.map((ex) => (
              <button
                key={ex.value}
                type="button"
                onClick={() => setScope(ex.value)}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[length:var(--type-micro)] transition-colors',
                  scope === ex.value
                    ? 'bg-[var(--accent-info)] text-[var(--container-blue)]'
                    : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                )}
              >
                {ex.label}
              </button>
            ))}
          </div>

          <div ref={listRef} className="max-h-72 overflow-y-auto py-1">
            {query.isLoading ? (
              <p className="px-3 py-3 text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
                Searching…
              </p>
            ) : query.error ? (
              <p className="px-3 py-3 text-center text-[length:var(--type-caption)] text-[var(--market-down)]">
                Search failed. The instrument master may still be loading.
              </p>
            ) : results.length === 0 ? (
              <p className="px-3 py-3 text-center text-[length:var(--type-caption)] text-[var(--text-tertiary)]">
                {/* The master fills in the background after sign-in, so an empty
                    result seconds into a session is often "not loaded yet"
                    rather than "does not exist", and the two need different
                    reactions from the user. */}
                Nothing matches{term ? ` "${term}"` : ''}. If you have only just
                signed in, the instrument master may still be loading.
              </p>
            ) : (
              results.map((asset, i) => {
                const selected = asset.asset === symbol && asset.exchange === exchange;
                return (
                  <button
                    key={`${asset.exchange}:${asset.asset}`}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-active={i === active}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => choose(asset)}
                    className={cn(
                      'flex w-full items-center gap-2 px-2 py-1.5 text-left',
                      'text-[length:var(--type-control)] text-[var(--text-primary)]',
                      i === active && 'bg-[var(--control-bg-hover)]',
                    )}
                  >
                    <Check
                      size={12}
                      className={cn(
                        'shrink-0 text-[var(--accent-info)]',
                        !selected && 'invisible',
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{asset.asset}</span>
                    {/* The expiry count is the honest signal of whether this
                        symbol will draw anything: an F&O name with one listed
                        expiry is a thin contract, and knowing that before the
                        20-second session walk saves the walk. */}
                    <span className="qs-num shrink-0 text-[length:var(--type-micro)] text-[var(--text-tertiary)]">
                      {asset.expiries.length}e
                    </span>
                    <Badge tone={KIND_TONE[asset.kind] ?? 'neutral'}>{asset.exchange}</Badge>
                  </button>
                );
              })
            )}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
