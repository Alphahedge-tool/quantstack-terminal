/**
 * Kotak Neo instrument master → canonical rows.
 *
 * The most awkward of the four. Kotak publishes not one file but a LIST of
 * per-segment CSVs, behind an endpoint whose host and path have both moved
 * between API versions — hence the host/path fallback ladder below.
 *
 * Three normalisation traps:
 *
 *   segment    is carried in the FILENAME, not in the rows. `nse_fo.csv` is NFO.
 *   expiry     is epoch SECONDS, and NSE F&O rows carry a 315,511,200-second
 *              offset (the gap from 1970 to 1980) that the others do not.
 *   strike     is ×100, like Angel's.
 */

import type { InstrumentRow } from '../types.js';
import type { ContractType } from '../symbol.js';
import { canonicalSymbol } from '../symbol.js';
import { parseCSV } from '../csv.js';

/** API hosts, in the order they are worth trying. */
const HOSTS = [
  'https://gw-napi.kotaksecurities.com',
  'https://cis.kotaksecurities.com',
  'https://neo-gw.kotaksecurities.com',
];

const PATHS = [
  '/Files/1.0/masterscrip/v2/file-paths',
  '/Files/1.0/masterscrip/v1/file-paths',
  '/script-details/1.0/masterscrip/file-paths',
];

/** Filename fragment → canonical exchange + Kotak's own segment string. */
function segmentFor(url: string): { exchange: string; segment: string } {
  const name = url.toLowerCase();
  if (name.includes('nse_fo')) return { exchange: 'NFO', segment: 'nse_fo' };
  if (name.includes('bse_fo')) return { exchange: 'BFO', segment: 'bse_fo' };
  if (name.includes('cde_fo') || name.includes('cds')) return { exchange: 'CDS', segment: 'cde_fo' };
  if (name.includes('bcs-fo') || name.includes('bcd')) return { exchange: 'BCD', segment: 'bcs-fo' };
  if (name.includes('mcx'))    return { exchange: 'MCX', segment: 'mcx_fo' };
  if (name.includes('bse'))    return { exchange: 'BSE', segment: 'bse_cm' };
  return { exchange: 'NSE', segment: 'nse_cm' };
}

/**
 * Kotak's epoch-seconds expiry → ISO.
 *
 * The NSE F&O offset is not a bug to be fixed upstream — it is how the segment
 * has always encoded dates, and dropping it puts every NFO expiry ten years
 * early, which silently produces canonical symbols that match nothing.
 */
const NSE_FO_EPOCH_OFFSET = 315_511_200;

function expiryOf(raw: string, segment: string): string {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return '';
  const seconds = value + (segment === 'nse_fo' ? NSE_FO_EPOCH_OFFSET : 0);
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

function typeOf(brsymbol: string, instType: string, optType: string): ContractType {
  const sym  = brsymbol.toUpperCase();
  const inst = instType.toUpperCase();
  const opt  = optType.toUpperCase();
  if (opt === 'CE' || opt === 'PE') return opt;
  if (inst.startsWith('OPT')) return sym.endsWith('PE') ? 'PE' : 'CE';
  if (opt === 'XX' || inst.includes('FUT') || sym.endsWith('FUT')) return 'FUT';
  return 'EQ';
}

const KEPT_SPOT = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX',
]);

export function normalizeKotakFiles(files: Array<{ url: string; text: string }>): InstrumentRow[] {
  const out: InstrumentRow[] = [];

  for (const file of files) {
    const { exchange, segment } = segmentFor(file.url);
    const cash = segment === 'nse_cm' || segment === 'bse_cm';

    for (const raw of parseCSV(file.text)) {
      const name     = String(raw.pSymbolName ?? '').toUpperCase().trim();
      const brsymbol = String(raw.pTrdSymbol ?? '').trim();
      const token    = String(raw.pSymbol ?? '').trim();
      if (!name || !brsymbol || !token) continue;

      const type = typeOf(brsymbol, raw.pInstType ?? '', raw.pOptionType ?? '');
      if (cash && !KEPT_SPOT.has(name)) continue;

      const strikeRaw = Number(raw.dStrikePrice);
      const strike = (type === 'CE' || type === 'PE') && Number.isFinite(strikeRaw) && strikeRaw > 0
        ? strikeRaw / 100
        : null;

      const expiry = type === 'EQ' ? '' : expiryOf(raw.pExpiryDate ?? '', segment);
      const symbol = type === 'EQ' ? name : canonicalSymbol({ name, type, expiry, strike });
      if (!symbol) continue;

      out.push({
        symbol,
        exchange,
        name,
        expiry,
        strike,
        optionType: type === 'CE' || type === 'PE' ? type : '',
        lotsize:    Number(raw.lLotSize)  || 1,
        ticksize:   Number(raw.dTickSize) || undefined,
        instrumentType: type,
        brsymbol,
        // Kotak's own segment string, which is what the HSM socket subscribes by.
        brexchange: segment,
        token,
      });
    }
  }

  return out;
}

/** Kotak's fixed API key. Not a secret and not per-account. */
const NEO_FIN_KEY = 'neotradeapi';

export async function loadKotakMaster(
  { accessToken, baseUrl }: { accessToken?: string; baseUrl?: string },
): Promise<InstrumentRow[]> {
  if (!accessToken) throw new Error('Kotak instrument master needs the Neo access token');

  let fileUrls: string[] = [];

  // Host and path have both moved across API versions and the account's data
  // centre decides which one answers, so this walks the ladder rather than
  // hard-coding the current one and breaking on the next migration.
  outer:
  for (const host of [baseUrl, ...HOSTS].filter(Boolean) as string[]) {
    for (const endpoint of PATHS) {
      try {
        const res = await fetch(host.replace(/\/+$/, '') + endpoint, {
          headers: {
            Authorization:  accessToken,
            'neo-fin-key':  NEO_FIN_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) continue;
        const body = await res.json() as { data?: { filesPaths?: string[] }; filesPaths?: string[] };
        fileUrls = body?.data?.filesPaths ?? body?.filesPaths ?? [];
        if (fileUrls.length) break outer;
      } catch {
        /* try the next host/path pair */
      }
    }
  }

  if (!fileUrls.length) throw new Error('Kotak master returned no CSV file paths');

  // Partial success is better than none: one unavailable segment file should
  // cost that segment, not the whole master.
  const files: Array<{ url: string; text: string }> = [];
  for (const url of fileUrls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) files.push({ url, text: await res.text() });
    } catch {
      console.warn(`[instruments] kotak segment unavailable: ${url}`);
    }
  }

  const rows = normalizeKotakFiles(files);
  if (!rows.length) throw new Error('Kotak master parsed no instruments');
  return rows;
}
