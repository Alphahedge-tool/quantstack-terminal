/**
 * Can DuckDB + Parquet replace the JSON instrument cache?
 *
 * The cache today is 270 files of raw broker JSON, 5.9 GB on disk, and every
 * date the backend touches is read whole, parsed by V8 and kept resident at
 * ~23 MB a slot. That is what killed the process during a DTE-median compare.
 *
 * This measures the alternative on the same data: convert one master to
 * Parquet, then answer the questions the backend actually asks — the expiry
 * list for one asset, the strike ladder, the eligible-asset search — and see
 * what it costs in bytes, milliseconds, and heap.
 *
 *   npx tsx --expose-gc scripts/probeParquet.ts
 */

import { DuckDBInstance } from '@duckdb/node-api';
import { readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const REFDATA = resolve(__dir, '..', 'cache', 'refdata');
const OUT = resolve(__dir, '..', 'cache', 'parquet');

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed; };

async function main() {
  mkdirSync(OUT, { recursive: true });

  const file = readdirSync(REFDATA)
    .filter((f) => f.startsWith('NSE_') && f.endsWith('.json'))
    .sort()
    .pop();
  if (!file) throw new Error('no NSE master cached to convert');

  const source = join(REFDATA, file);
  const date = file.replace('NSE_', '').replace('.json', '');
  const target = join(OUT, `NSE_${date}.parquet`);
  const sourceBytes = statSync(source).size;

  console.log(`\n  ${file} — ${mb(sourceBytes)} of broker JSON\n`);
  const baseline = heap();

  const db = await DuckDBInstance.create(':memory:');
  const c = await db.connect();

  /*
   * The conversion, in one statement.
   *
   * DuckDB reads the JSON itself — the 43 MB never becomes a V8 string and
   * never becomes 81,000 JavaScript objects, which is the entire point. Node's
   * heap does not move.
   *
   * ZSTD over the default SNAPPY: this data is one enormous run of repeated
   * asset names, expiries and option types, and it compresses accordingly. The
   * cost is decompression CPU on a file that is read far more often than
   * written.
   */
  const t0 = Date.now();
  await c.run(`
    COPY (SELECT * FROM read_json_auto('${source.replace(/\\/g, '/')}'))
    TO '${target.replace(/\\/g, '/')}'
    (FORMAT PARQUET, COMPRESSION ZSTD)
  `);
  const convertMs = Date.now() - t0;
  const targetBytes = statSync(target).size;

  console.log(`  -> ${mb(targetBytes)} parquet in ${convertMs}ms`
    + `   (${(sourceBytes / targetBytes).toFixed(1)}x smaller)`);
  console.log(`     heap after conversion: +${mb(heap() - baseline)}\n`);

  const parquet = target.replace(/\\/g, '/');
  const ask = async (label: string, sql: string) => {
    const started = Date.now();
    const r = await c.runAndReadAll(sql);
    const rows = r.getRows();
    const took = Date.now() - started;
    const shown = rows.slice(0, 3).map((row) => row.join(' ')).join(' | ');
    console.log(`  ${label.padEnd(34)} ${String(took).padStart(4)}ms  ${String(rows.length).padStart(6)} rows   ${shown}`);
  };

  console.log('  Queries the backend actually makes:\n');

  await ask('expiries for NIFTY', `
    SELECT DISTINCT expiry FROM '${parquet}'
    WHERE asset = 'NIFTY' AND derivative_type = 'OPT'
    ORDER BY expiry LIMIT 5`);

  await ask('strike ladder, one expiry', `
    SELECT DISTINCT strike_price / 100 AS strike FROM '${parquet}'
    WHERE asset = 'NIFTY' AND derivative_type = 'OPT'
      AND expiry = (SELECT min(expiry) FROM '${parquet}' WHERE asset='NIFTY' AND derivative_type='OPT')
    ORDER BY strike LIMIT 5`);

  await ask('option-bearing assets (search)', `
    SELECT asset, count(*) AS contracts FROM '${parquet}'
    WHERE derivative_type = 'OPT'
    GROUP BY asset ORDER BY contracts DESC LIMIT 5`);

  await ask('one contract by name', `
    SELECT stock_name, ref_id, lot_size FROM '${parquet}'
    WHERE asset = 'NIFTY' AND derivative_type = 'OPT' LIMIT 3`);

  console.log(`\n  heap at the end: ${mb(heap())}  (baseline was ${mb(baseline)})`);
  console.log(`  the whole master stayed in DuckDB — V8 never held a row.\n`);

  // What 270 of these would cost, which is the number that matters.
  const all = readdirSync(REFDATA).filter((f) => f.endsWith('.json'));
  const totalJson = all.reduce((sum, f) => sum + statSync(join(REFDATA, f)).size, 0);
  console.log(`  ${all.length} cached masters today: ${mb(totalJson)} of JSON`);
  console.log(`  same data as parquet, at this ratio: ~${mb(totalJson / (sourceBytes / targetBytes))}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
