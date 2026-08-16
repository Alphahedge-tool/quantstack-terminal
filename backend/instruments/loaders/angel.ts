/**
 * Angel One (SmartAPI) instrument master → canonical rows.
 *
 * Angel publishes one unauthenticated ~30 MB JSON file containing every listed
 * instrument on every segment. No session is needed, which makes Angel the
 * cheapest master to warm and a good default for the canonical table even when
 * the live feed is pointed at another broker.
 *
 * Two quirks this file exists to absorb:
 *
 *   strike     is scaled. MCX is consistently ×100; NSE/BSE index options are
 *              ×100 only on some rows. Getting this wrong puts a 24500 strike in
 *              the table as 2450000, and nothing matches it ever again.
 *   expiry     is `DDMMMYYYY` (`28AUG2026`), not ISO.
 */

import type { InstrumentRow } from '../types.js';
import type { ContractType } from '../symbol.js';
import { canonicalSymbol, expiryKey, expiryKeyToISO } from '../symbol.js';

const MASTER_URL = process.env.ANGEL_MASTER_URL
  || 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';

/** Angel's raw row. Every field arrives as a string. */
interface AngelRaw {
  token?:    string;
  symbol?:   string;
  name?:     string;
  expiry?:   string;
  strike?:   string;
  lotsize?:  string;
  instrumenttype?: string;
  exch_seg?: string;
  tick_size?: string;
}

/**
 * Segments worth keeping.
 *
 * The full file is ~120k rows, the overwhelming majority of them cash equities
 * this terminal never prices. Filtering at load keeps the in-memory table and
 * its disk cache an order of magnitude smaller.
 */
const DERIVATIVE_SEGMENTS = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
const CASH_SEGMENTS       = new Set(['NSE', 'BSE']);

/**
 * Angel's scaled strike → rupees.
 *
 * MCX is always ×100. On NSE/BSE only the over-scaled rows are (>200000 rupees
 * is not a strike anyone lists), so the threshold test is the reliable one.
 */
function normalizeStrike(raw: string | undefined, segment: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (segment === 'MCX' || n > 200_000) return n / 100;
  return n;
}

/** Contract type from the trading symbol's suffix — the one field always present. */
function typeOf(brsymbol: string, instrumentType: string): ContractType {
  const sym  = brsymbol.toUpperCase();
  const inst = instrumentType.toUpperCase();
  if (sym.endsWith('CE')) return 'CE';
  if (sym.endsWith('PE')) return 'PE';
  if (sym.endsWith('FUT') || inst.startsWith('FUT')) return 'FUT';
  return 'EQ';
}

/**
 * The whole cash segment is kept, not just the indices.
 *
 * An earlier version kept only the index names, on the reasoning that the
 * straddle engine never asks for anything else and NSE/BSE cash is ~22,000 rows
 * of otherwise-dead weight.
 *
 * That was wrong the moment holdings arrived. A demat holding of `CDSL-EQ` has
 * to resolve against this table or it is reported as an unidentified contract —
 * and every equity holding in a real account then carries a warning marker
 * saying the instrument could not be confirmed. Verified against a live account:
 * eight holdings, all of them flagged, all of them perfectly ordinary stock.
 *
 * The filter cannot be narrowed to "equities" either. Sovereign gold bonds
 * (`-SG`), government securities (`-GS`) and mutual-fund units (`-MF`) are all
 * holdable, and guessing which of them this account will never own is exactly
 * the assumption that just failed.
 */

/**
 * Index spot names → the root their derivatives use.
 *
 * Angel lists the cash index as `Nifty 50` and its options under `NIFTY`. Left
 * alone, the two land under different canonical symbols and `underlyings()`
 * finds no spot leg for any index — the ATM engine then falls through to the
 * futures path on an instrument that has a perfectly good cash quote.
 *
 * Keyed on Angel's own cash symbol, upper-cased.
 */
const INDEX_SPOT_ALIASES: Record<string, string> = {
  'NIFTY 50':          'NIFTY',
  'NIFTY BANK':        'BANKNIFTY',
  'NIFTY FIN SERVICE': 'FINNIFTY',
  'NIFTY MID SELECT':  'MIDCPNIFTY',
  'NIFTY NEXT 50':     'NIFTYNXT50',
  SENSEX:              'SENSEX',
  BANKEX:              'BANKEX',
};

function indexAlias(brsymbol: string): string | undefined {
  return INDEX_SPOT_ALIASES[brsymbol.toUpperCase().trim()];
}

/** Normalise Angel's raw master. Rows that cannot be identified are dropped. */
export function normalizeAngelRows(raw: AngelRaw[]): InstrumentRow[] {
  const out: InstrumentRow[] = [];

  for (const r of raw) {
    const segment  = String(r.exch_seg ?? '').toUpperCase();
    const brsymbol = String(r.symbol ?? '').trim();
    const token    = String(r.token ?? '').trim();
    const name     = String(r.name ?? '').toUpperCase().trim();
    if (!brsymbol || !token || !name) continue;

    const derivative = DERIVATIVE_SEGMENTS.has(segment);
    const spot       = CASH_SEGMENTS.has(segment);
    if (!derivative && !spot) continue;

    const type   = derivative ? typeOf(brsymbol, String(r.instrumenttype ?? '')) : 'EQ';
    const strike = type === 'CE' || type === 'PE'
      ? normalizeStrike(r.strike, segment)
      : null;

    // Angel ships `28AUG2026`; the canonical expiry is ISO so it matches keys
    // built anywhere else in the terminal.
    const expiry = type === 'EQ' ? '' : (expiryKeyToISO(expiryKey(r.expiry)) ?? '');

    const symbol = type === 'EQ'
      // Cash symbols carry a series suffix Angel alone uses (`RELIANCE-EQ`), and
      // indices are named differently in cash than in derivatives — see
      // INDEX_SPOT_ALIASES.
      ? indexAlias(brsymbol) ?? brsymbol.toUpperCase().replace(/-(EQ|BE|MF|SG|GS|ST|SM)$/, '')
      : canonicalSymbol({ name, type, expiry, strike });
    if (!symbol) continue;

    const lot = Math.trunc(Number(r.lotsize) || 0);

    out.push({
      symbol,
      exchange:   segment,
      name,
      expiry,
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize:    lot > 0 ? lot : 1,
      ticksize:   Number(r.tick_size) || undefined,
      instrumentType: type,
      brsymbol,
      brexchange: segment,
      token,
    });
  }

  return out;
}

/** Download and normalise. Unauthenticated — no session required. */
export async function loadAngelMaster(): Promise<InstrumentRow[]> {
  const res = await fetch(MASTER_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Angel master download failed: HTTP ${res.status}`);

  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Angel master returned a non-array body');

  const rows = normalizeAngelRows(raw as AngelRaw[]);
  if (!rows.length) throw new Error('Angel master parsed no instruments');
  return rows;
}
