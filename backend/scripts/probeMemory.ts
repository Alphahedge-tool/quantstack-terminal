/**
 * How much heap does one cached instrument master actually cost?
 *
 * `memCache` in `lib/instrumentCache.ts` has no eviction: every exchange/date
 * slot ever asked for stays resident for the process lifetime. That is fine for
 * the two or three dates a normal session touches and is the suspected cause of
 * the backend dying during a DTE-median compare, which walks back through
 * dozens of past dates and loads a master for each.
 *
 * This measures the per-slot cost so the cap can be a number rather than a
 * guess.
 *
 *   npx tsx scripts/probeMemory.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(__dir, '..', 'cache', 'refdata');

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(0)} MB`;

function heap(): number {
  global.gc?.();
  return process.memoryUsage().heapUsed;
}

/** The same parse `instrumentCache.parseRows` performs, in shape and cost. */
function parseLike(raw: Record<string, unknown>[]) {
  const rows = [];
  for (const r of raw) {
    const asset = String(r.asset || r.underlying || '').trim().toUpperCase();
    if (!asset) continue;
    const aliases = [...new Set(
      [r.stock_name, r.symbol, r.trading_symbol, r.display_name, r.zanskar_name]
        .map((v) => String(v || '').trim().toUpperCase()).filter(Boolean),
    )];
    if (!aliases.length) continue;
    rows.push({
      asset, name: aliases[0], aliases,
      exchange: 'NSE',
      type: String(r.derivative_type || '').toUpperCase(),
      assetType: String(r.asset_type || '').toUpperCase(),
      strike: Number(r.strike_price ?? 0) / 100,
      expiry: String(r.expiry || '').replace(/-/g, ''),
      lot: Number(r.lot_size || 0),
      refId: String(r.refId ?? ''),
    });
  }
  return rows;
}

const files = readdirSync(CACHE)
  .filter((f) => f.startsWith('NSE_') && f.endsWith('.json'))
  .sort()
  .slice(-6);

console.log(`\n  Heap cost per cached instrument master\n`);
console.log(`  baseline ${mb(heap())}\n`);

const held: unknown[] = [];
let previous = heap();

for (const file of files) {
  const bytes = readFileSync(join(CACHE, file), 'utf8');
  const raw = JSON.parse(bytes) as Record<string, unknown>[];
  const rows = parseLike(raw);
  // Held, exactly as memCache holds them — the whole point is the resident cost.
  held.push(rows);

  const now = heap();
  console.log(
    `  ${file.padEnd(22)} ${String(raw.length).padStart(7)} raw rows`
    + ` -> ${String(rows.length).padStart(7)} parsed`
    + `   +${mb(now - previous).padStart(7)}   total ${mb(now)}`,
  );
  previous = now;
}

console.log(`\n  ${held.length} slots resident: ${mb(heap())}`);
console.log(`  extrapolated to 25 slots (one DTE-median compare): ${mb(heap() / held.length * 25)}\n`);
