/**
 * Zerodha (Kite Connect) instrument master → canonical rows.
 *
 * Unlike Angel's, this download is authenticated — it needs a live access token,
 * so it cannot be warmed at boot and loads on the first authenticated call.
 *
 * Two fields matter and are easy to confuse:
 *
 *   instrument_token   the WebSocket subscribes by THIS. Globally unique, and it
 *                      encodes the segment in its low byte (see stream.ts).
 *   exchange_token     the order API's identifier. Not interchangeable.
 *
 * Kite's strikes are already in rupees — no ×100 scaling to undo, unlike Angel.
 */

import type { InstrumentRow } from '../types.js';
import type { ContractType } from '../symbol.js';
import { canonicalSymbol, expiryKey, expiryKeyToISO } from '../symbol.js';
import { parseCSV } from '../csv.js';

const INSTRUMENTS_URL = 'https://api.kite.trade/instruments';

/** Segments worth keeping — see the note in loaders/angel.ts. */
const KEPT_SEGMENTS = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);

const KEPT_SPOT = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX', 'NIFTYNXT50',
  'NIFTY 50', 'NIFTY BANK', 'NIFTY FIN SERVICE', 'NIFTY MID SELECT',
]);

/**
 * Recover the underlying root when Kite leaves `name` blank.
 *
 * It does this for some index derivatives, and without a root the canonical
 * symbol collapses to an empty string — the row is then unmatchable against
 * every other broker. Stripping the trailing `<DD><MMM><YY>…` off the trading
 * symbol reconstructs it.
 */
function rootOf(name: string, brsymbol: string, type: ContractType): string {
  const direct = name.toUpperCase().trim();
  if (direct) return direct;
  if (type === 'EQ') return brsymbol.toUpperCase().replace(/-(EQ|BE)$/, '');
  return brsymbol.toUpperCase().replace(/\d{1,2}[A-Z]{3}\d{2}.*$/, '')
    .replace(/\d{5,}.*$/, '');
}

export function normalizeZerodhaRows(raw: Array<Record<string, string>>): InstrumentRow[] {
  const out: InstrumentRow[] = [];

  for (const r of raw) {
    const exchange = String(r.exchange ?? '').toUpperCase();
    const type     = String(r.instrument_type ?? '').toUpperCase() as ContractType;
    const brsymbol = String(r.tradingsymbol ?? '').trim();
    const token    = String(r.instrument_token ?? '').trim();
    if (!exchange || !brsymbol || !token) continue;
    if (!['EQ', 'FUT', 'CE', 'PE'].includes(type)) continue;

    const derivative = KEPT_SEGMENTS.has(exchange);
    const name = rootOf(String(r.name ?? ''), brsymbol, type);
    if (!derivative && !KEPT_SPOT.has(name)) continue;
    if (!name) continue;

    const strikeRaw = Number(r.strike);
    const strike = (type === 'CE' || type === 'PE') && Number.isFinite(strikeRaw) && strikeRaw > 0
      ? strikeRaw
      : null;

    const expiry = type === 'EQ' ? '' : (expiryKeyToISO(expiryKey(r.expiry)) ?? '');

    const symbol = type === 'EQ'
      ? brsymbol.toUpperCase().replace(/-(EQ|BE)$/, '')
      : canonicalSymbol({ name, type, expiry, strike });
    if (!symbol) continue;

    out.push({
      symbol,
      exchange,
      name,
      expiry,
      strike,
      optionType: type === 'CE' || type === 'PE' ? type : '',
      lotsize:    Number(r.lot_size)  || 1,
      ticksize:   Number(r.tick_size) || undefined,
      instrumentType: type,
      brsymbol,
      brexchange:    exchange,
      token,
      exchangeToken: String(r.exchange_token ?? ''),
    });
  }

  return out;
}

export async function loadZerodhaMaster(
  { apiKey, accessToken }: { apiKey?: string; accessToken?: string },
): Promise<InstrumentRow[]> {
  if (!apiKey || !accessToken) {
    throw new Error('Zerodha instrument master needs an apiKey and a live accessToken');
  }

  const res = await fetch(INSTRUMENTS_URL, {
    headers: {
      Accept:          'text/csv',
      'X-Kite-Version': '3',
      Authorization:   `token ${apiKey}:${accessToken}`,
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Zerodha instruments download failed: HTTP ${res.status}`);

  const rows = normalizeZerodhaRows(parseCSV(await res.text()));
  if (!rows.length) throw new Error('Zerodha instruments file parsed no instruments');
  return rows;
}
