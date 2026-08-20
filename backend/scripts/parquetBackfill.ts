/**
 * Convert the JSON masters already on disk into per-expiry Parquet.
 *
 * The warm handles every master from now on. This is for the 270 that were
 * downloaded before the store existed — 5.9 GB of JSON that becomes a couple of
 * hundred megabytes and answers questions in milliseconds.
 *
 *   npx tsx scripts/parquetBackfill.ts            newest 30 masters per exchange
 *   npx tsx scripts/parquetBackfill.ts --all      everything
 *   npx tsx scripts/parquetBackfill.ts --prune    convert, then drop expired
 *
 * Newest-first and capped by default: the recent masters are the ones a live
 * session and a recent replay actually read, and converting 270 files takes
 * minutes that nobody asked for on a first run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeMasterParquet, pruneExpiredParquet, parquetStats } from '../lib/parquetStore.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REFDATA = path.resolve(__dir, '..', 'cache', 'refdata');

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

async function main() {
  const all = process.argv.includes('--all');
  const prune = process.argv.includes('--prune');
  const limit = all ? Infinity : 30;

  if (!fs.existsSync(REFDATA)) {
    console.log(`\n  Nothing at ${REFDATA}\n`);
    return;
  }

  // Grouped per exchange so a cap of 30 means 30 NSE and 30 MCX, not 30 of
  // whichever sorted first.
  const byExchange = new Map<string, string[]>();
  for (const file of fs.readdirSync(REFDATA)) {
    const match = /^([A-Z]+)_(\d{4}-\d{2}-\d{2})\.json$/.exec(file);
    if (!match) continue;
    const list = byExchange.get(match[1]) ?? [];
    list.push(file);
    byExchange.set(match[1], list);
  }

  let converted = 0;
  let sourceBytes = 0;
  const started = Date.now();

  for (const [exchange, files] of byExchange) {
    /*
     * Select the newest, then write them OLDEST FIRST.
     *
     * Both halves matter and they pull opposite ways. The cap keeps the recent
     * masters, which are the ones a live session and a recent replay read. The
     * write order decides which master wins a partition that several of them
     * name — and the last write wins, so writing newest-first hands the
     * partition to the OLDEST master that mentioned that expiry.
     *
     * Measured, before this was fixed: the August monthly expiry came out with
     * 17,541 rows across 213 assets, because the winner was a master from
     * months earlier when only part of that chain had been listed. Written
     * oldest-first the same partition is 30,053 rows — the newest master has
     * every strike that got listed as spot moved through the range.
     *
     * (The weekly partitions look small at 462 rows, and that is not this bug:
     * NSE lists weeklies for NIFTY alone, so 231 strikes x 2 sides is the whole
     * contract set.)
     */
    const selected = files.sort().reverse().slice(0, limit).reverse();
    console.log(`\n  ${exchange}: ${selected.length} of ${files.length} master(s)`);

    for (const file of selected) {
      const full = path.join(REFDATA, file);
      const bytes = fs.statSync(full).size;
      // An empty master is the artefact of a transient upstream blank, and
      // feeding one to the converter would replace a good partition with
      // nothing.
      if (bytes < 1024) {
        console.log(`    ${file}  skipped — ${bytes}B, not a real master`);
        continue;
      }
      try {
        await writeMasterParquet(exchange, full);
        converted += 1;
        sourceBytes += bytes;
      } catch (e) {
        console.log(`    ${file}  FAILED — ${(e as Error).message.split('\n')[0]}`);
      }
    }
    // One line per exchange, not a carriage-return counter: this frequently
    // runs into a log file rather than a terminal, where \r is a smear.
    console.log(`    ${converted} converted, ${mb(sourceBytes)} of JSON read`);
  }

  if (prune) pruneExpiredParquet();

  const stats = await parquetStats();
  const total = stats.exchanges.reduce((sum, e) => sum + e.bytes, 0);

  console.log(`\n  ${converted} master(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  console.log(`  ${mb(sourceBytes)} of JSON  ->  ${mb(total)} of parquet`
    + (total ? `   (${(sourceBytes / total).toFixed(1)}x)` : ''));
  for (const e of stats.exchanges) {
    console.log(`    ${e.exchange.padEnd(5)} ${String(e.expiries).padStart(4)} expiries`
      + ` (${e.live} still live)  ${mb(e.bytes)}`);
  }
  console.log(`  retention: ${stats.retainDays} days past expiry\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
