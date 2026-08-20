/**
 * The instrument master as Parquet, partitioned by expiry.
 *
 * ── What this replaces ──
 *
 * One JSON file per exchange per date, kept forever: 270 files and 5.9 GB, each
 * one read whole and parsed into ~81,000 JavaScript objects costing 23 MB of
 * resident heap. Measured, not estimated — `scripts/probeMemory.ts`.
 *
 * The same data as Parquet is 1 MB a master, 31x smaller, and DuckDB reads only
 * the columns a query touches without any of it entering V8's heap. A question
 * like "which expiries did NIFTY have listed on this date" stops being a 33 MB
 * parse and becomes a 10 ms scan of one column.
 *
 * ── Why partitioned by expiry ──
 *
 * Because that is the unit that expires. A contract set is meaningful until its
 * expiry passes and then it is history — so making the expiry the directory
 * makes "drop what is finished" a directory removal rather than a rewrite, and
 * makes "everything for this expiry" a path rather than a filter.
 *
 * Written on every warm, overwriting the partition for each expiry the master
 * still had LIVE — that qualifier is load-bearing, and the reasoning is at the
 * WHERE clause in `writeMasterParquet`. Re-running is idempotent.
 *
 * ── The prune, and the thing it can break ──
 *
 * Deleting an expiry the moment it passes is the obvious rule and it would
 * quietly disable the historical replay: `/api/expiry/replay` resolves a past
 * session's contracts from the master for that expiry, so removing it means
 * last Tuesday can no longer be rebuilt. The default retention therefore keeps
 * expired partitions for `QT_PARQUET_RETAIN_DAYS` days (90) rather than zero.
 *
 * The number is a trade of disk against history, and the disk side is now
 * trivial: a single expiry's slice is tens of kilobytes. Set the variable to 0
 * for delete-on-expiry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

import { logger } from './logger.js';

const log = logger('parquet');

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dir, '..', 'cache');
const ROOT = path.join(CACHE, 'parquet', 'instruments');

/** Days an expiry's partition survives past its expiry date. 0 = delete as
 *  soon as it expires, which also disables replaying those sessions. */
const RETAIN_DAYS = Math.max(0, Number(process.env.QT_PARQUET_RETAIN_DAYS ?? 90));

/** A path is a SQL string literal; a Windows backslash is an escape inside one. */
const sqlPath = (p: string) => p.replace(/\\/g, '/');

/** `YYYYMMDD` in IST — the exchange's day, not the server's. */
export function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date()).replace(/-/g, '');
}

/**
 * One connection for the process.
 *
 * DuckDB is in-process and a connection is cheap, but not free — and the writes
 * here happen on a background warm where a per-call instance would spawn and
 * tear down a database engine per exchange. Lazily created so a backend that
 * never warms never pays for it at all.
 */
let connection: Promise<DuckDBConnection> | null = null;

function connect(): Promise<DuckDBConnection> {
  connection ??= (async () => {
    fs.mkdirSync(ROOT, { recursive: true });
    /*
     * `:memory:`, deliberately — the server opens no database FILE.
     *
     * DuckDB permits one writing process or several reading ones, so a backend
     * holding `quantstack.duckdb` open read-write locks every other reader out:
     * `npm run duck` failed with "already open in node.exe (PID 15920)" for as
     * long as the server was up, which defeats the point of having a SQL shell
     * over your own data.
     *
     * Nothing is lost. The parquet files are the data; that file only ever held
     * view definitions for the shell's convenience. An in-memory instance is a
     * query engine over the same files and takes no lock.
     */
    const db = await DuckDBInstance.create(':memory:');
    return db.connect();
  })();
  return connection;
}

export interface WriteResult {
  exchange: string;
  expiries: number;
  rows: number;
  bytes: number;
  tookMs: number;
}

/**
 * Convert one master's JSON into per-expiry Parquet.
 *
 * The JSON is read BY DUCKDB, not by Node. That is the whole performance story:
 * the 33 MB file never becomes a V8 string and its rows never become JavaScript
 * objects, so this runs at a flat ~10 MB of heap regardless of the file's size.
 *
 * `OVERWRITE_OR_IGNORE` because a warm re-runs this for expiries already on
 * disk every single day, and the newer master is the one to keep.
 */
export async function writeMasterParquet(
  exchange: string, jsonPath: string, masterDate?: string,
): Promise<WriteResult | null> {
  if (!fs.existsSync(jsonPath)) return null;

  const started = Date.now();
  const c = await connect();
  const target = path.join(ROOT, exchange.toUpperCase());

  /*
   * The master's own date, as YYYYMMDD — from the filename when not given.
   *
   * This is what decides which rows a master is ALLOWED to write, which turns
   * out to be the whole correctness of the store. See the filter below.
   */
  const asOf = (masterDate
    ?? path.basename(jsonPath).replace(/^[A-Z]+_/, '').replace(/\.json$/, '')
  ).replace(/-/g, '');

  /*
   * `expiry` is normalised to a string here rather than trusted from the feed.
   *
   * Nubra sends it as an integer (20260825) for derivatives and omits it for
   * cash rows. A partition key that is sometimes a number and sometimes null
   * produces both `expiry=20260825` and DuckDB's `__HIVE_DEFAULT_PARTITION__`
   * directory, and the two would then compare differently on read. Cast once,
   * and put the cash rows somewhere with a name.
   *
   * ── sample_size = -1 ──
   *
   * The schema is inferred from the WHOLE file, not from DuckDB's default
   * 20,480-record sample. This feed does not keep its rows uniform: a master
   * with 81,000 contracts carried a `CasEligibility` key on one row at index
   * 76,215 and nowhere earlier, and the conversion failed outright with
   * "unknown key". Every master before August failed the same way on the same
   * field. A full scan costs about a second per file and turns a schema guess
   * into a schema fact.
   */
  await c.run(`
    COPY (
      SELECT * FROM (
      SELECT * REPLACE (
        CASE WHEN expiry IS NULL OR CAST(expiry AS VARCHAR) = ''
             THEN 'CASH' ELSE CAST(expiry AS VARCHAR) END AS expiry
      )
      FROM read_json('${sqlPath(jsonPath)}', auto_detect = true, sample_size = -1)
      /*
       * A master may only write expiries it still had LIVE.
       *
       * As it happens this excludes nothing: the NSE master for 2026-08-20 was
       * checked and carries zero rows for 20260804, 20260811 or 20260818 — the
       * exchange drops a contract from the master once it settles. So this is a
       * guard, not a filter, and it is worth the line because the write is
       * DESTRUCTIVE per partition: one stale row for a dead expiry in some
       * future master would replace that expiry's complete contract set with a
       * fragment, and nothing downstream would look wrong enough to notice.
       *
       * CASH sorts above every digit string, so cash rows pass unconditionally
       * — stated because it reads like an accident.
       */
      ) WHERE expiry = 'CASH' OR expiry >= '${asOf}'
    )
    TO '${sqlPath(target)}'
    (FORMAT PARQUET, PARTITION_BY (expiry), OVERWRITE_OR_IGNORE, COMPRESSION ZSTD)
  `);

  const counted = await c.runAndReadAll(`
    SELECT count(*) AS rows, count(DISTINCT expiry) AS expiries
    FROM read_parquet('${sqlPath(path.join(target, '**', '*.parquet'))}', ${HIVE})
  `);
  const [rows, expiries] = counted.getRows()[0] as [bigint, bigint];

  return {
    exchange: exchange.toUpperCase(),
    rows: Number(rows),
    expiries: Number(expiries),
    bytes: directorySize(target),
    tookMs: Date.now() - started,
  };
}

/**
 * Drop partitions whose expiry passed more than `RETAIN_DAYS` ago.
 *
 * Directory removal, not a query: the partition IS the unit, which is the
 * reason for partitioning this way. `CASH` is never pruned — cash instruments
 * do not expire, and the name is what keeps them out of a date comparison that
 * would otherwise treat them as infinitely old.
 */
export function pruneExpiredParquet(): { removed: string[]; keptDays: number } {
  const removed: string[] = [];
  if (!fs.existsSync(ROOT)) return { removed, keptDays: RETAIN_DAYS };

  const cutoff = Number(todayKey()) - 0;
  const cutoffDate = new Date(
    `${todayKey().slice(0, 4)}-${todayKey().slice(4, 6)}-${todayKey().slice(6, 8)}T00:00:00Z`,
  );
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - RETAIN_DAYS);
  const oldest = Number(cutoffDate.toISOString().slice(0, 10).replace(/-/g, ''));
  void cutoff;

  for (const exchange of fs.readdirSync(ROOT)) {
    const exchangeDir = path.join(ROOT, exchange);
    if (!fs.statSync(exchangeDir).isDirectory()) continue;

    for (const partition of fs.readdirSync(exchangeDir)) {
      const match = /^expiry=(\d{8})$/.exec(partition);
      if (!match) continue;                       // CASH, or something unexpected
      if (Number(match[1]) >= oldest) continue;   // still inside the window

      fs.rmSync(path.join(exchangeDir, partition), { recursive: true, force: true });
      removed.push(`${exchange}/${partition}`);
    }
  }

  if (removed.length) {
    log.info(
      `pruned ${removed.length} expired partition(s) older than `
      + `${RETAIN_DAYS}d: ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ' …' : ''}`,
    );
  }
  return { removed, keptDays: RETAIN_DAYS };
}

function directorySize(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

/** What is stored, for the status route. */
export async function parquetStats(): Promise<{
  root: string;
  retainDays: number;
  exchanges: Array<{ exchange: string; expiries: number; bytes: number; live: number }>;
}> {
  const today = todayKey();
  const exchanges: Array<{ exchange: string; expiries: number; bytes: number; live: number }> = [];

  if (fs.existsSync(ROOT)) {
    for (const exchange of fs.readdirSync(ROOT)) {
      const dir = path.join(ROOT, exchange);
      if (!fs.statSync(dir).isDirectory()) continue;
      const partitions = fs.readdirSync(dir).filter((p) => p.startsWith('expiry='));
      exchanges.push({
        exchange,
        expiries: partitions.length,
        bytes: directorySize(dir),
        // Partitions that have not expired yet — the ones a live session reads.
        live: partitions.filter((p) => {
          const key = p.slice('expiry='.length);
          return key === 'CASH' || key >= today;
        }).length,
      });
    }
  }

  return { root: ROOT, retainDays: RETAIN_DAYS, exchanges };
}

/* ── Reads ────────────────────────────────────────────────────────────────
 *
 * Everything below answers a question the backend used to answer by parsing a
 * 33 MB JSON file into 81,000 JavaScript objects and keeping them resident.
 * Here the same questions are one scan of one column across the partitions that
 * can possibly contain an answer, and nothing crosses into V8 except the rows
 * that come back.
 *
 * Each returns null — not an empty array — when the store cannot answer at all,
 * so a caller can tell "no parquet for this exchange yet" apart from "this
 * asset genuinely has no contracts" and fall back to the JSON path for the
 * first while reporting the second honestly.
 */

/** Does this exchange have anything written? */
export function hasParquet(exchange: string): boolean {
  const dir = path.join(ROOT, exchange.toUpperCase());
  return fs.existsSync(dir) && fs.readdirSync(dir).some((p) => p.startsWith('expiry='));
}

/**
 * The glob for one exchange, restricted to expiries that were still live on
 * `asOf`.
 *
 * Restricting by DIRECTORY rather than by a WHERE clause is the reason the
 * partitioning exists: DuckDB never opens the file for an expiry outside the
 * window, so asking about today costs the 19 live NSE partitions and not the
 * 57 on disk.
 */
function livePartitions(exchange: string, asOf: string): string[] {
  const dir = path.join(ROOT, exchange.toUpperCase());
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((p) => {
      if (!p.startsWith('expiry=')) return false;
      const key = p.slice('expiry='.length);
      // CASH never expires; a dated partition is live while its expiry is on or
      // after the date being asked about.
      return key === 'CASH' || key >= asOf;
    })
    .map((p) => sqlPath(path.join(dir, p, '*.parquet')));
}

const quote = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * Read options for every parquet scan in this file.
 *
 * `hive_types` pins the partition column to VARCHAR, and it is not optional.
 * DuckDB infers a hive column's type from the directory NAMES in the glob, so
 * `expiry` came back INT64 for MCX — which has no cash instruments and
 * therefore no `expiry=CASH` partition — while NSE and BSE, which do, inferred
 * VARCHAR. The same query then worked on two exchanges and failed on the third
 * with "Could not convert string 'CASH' to INT64", from a comparison that never
 * changed. Declaring the type makes the schema a property of the store rather
 * than of whichever partitions a caller happened to select.
 */
const HIVE = `hive_partitioning = true, hive_types = {'expiry': 'VARCHAR'}`;

/** Elements of a DuckDB LIST value, which is not a JS array. */
function listItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = (value as { items?: unknown })?.items;
  return Array.isArray(items) ? items : [];
}

/** One asset that has listed options — the search result shape. */
export interface EligibleAsset {
  asset: string;
  exchange: string;
  kind: 'INDEX' | 'STOCK' | 'COMMODITY';
  lot: number;
  expiries: string[];
}

/**
 * Assets with live options, ranked, for the symbol picker.
 *
 * Ranking is done in SQL rather than in Node for the same reason the filtering
 * is: the alternative is dragging every matching row across the boundary to
 * sort three thousand of them and keep fifty.
 */
export async function searchAssetsParquet(
  query: string, exchange: string, limit = 50, asOf = todayKey(),
): Promise<EligibleAsset[] | null> {
  const exchanges = exchange
    ? [exchange.toUpperCase()]
    : fs.existsSync(ROOT) ? fs.readdirSync(ROOT) : [];

  const globs = exchanges.flatMap((ex) => livePartitions(ex, asOf));
  if (!globs.length) return null;

  const q = query.trim().toUpperCase();
  const c = await connect();

  /*
   * `kind` is classified from the feed's own asset_type, exactly as the JSON
   * path does — a hardcoded symbol list needs editing every time an index is
   * listed, and it already missed NIFTYNXT50 once.
   */
  const rows = await c.runAndReadAll(`
    SELECT
      asset,
      any_value(exchange)                                     AS exchange,
      CASE
        WHEN starts_with(any_value(asset_type), 'COM')   THEN 'COMMODITY'
        WHEN starts_with(any_value(asset_type), 'INDEX') THEN 'INDEX'
        WHEN starts_with(any_value(asset_type), 'STOCK') THEN 'STOCK'
        WHEN any_value(exchange) = 'MCX'                 THEN 'COMMODITY'
        ELSE 'STOCK'
      END                                                     AS kind,
      max(lot_size)                                           AS lot,
      list_sort(array_agg(DISTINCT expiry))                   AS expiries,
      ${q ? `CASE WHEN asset = ${quote(q)} THEN 0
                  WHEN starts_with(asset, ${quote(q)}) THEN 1
                  ELSE 2 END` : '0'}                          AS rank
    FROM read_parquet([${globs.map(quote).join(', ')}], ${HIVE})
    WHERE derivative_type = 'OPT'
      ${q ? `AND contains(asset, ${quote(q)})` : ''}
    GROUP BY asset
    ORDER BY rank,
             CASE kind WHEN 'INDEX' THEN 0 WHEN 'STOCK' THEN 1 ELSE 2 END,
             asset
    LIMIT ${Math.max(1, Math.min(500, limit))}
  `);

  return rows.getRows().map((row) => ({
    asset: String(row[0]),
    exchange: String(row[1]),
    kind: String(row[2]) as EligibleAsset['kind'],
    lot: Number(row[3] ?? 0),
    // The aggregate comes back as a DuckDB list value, which is array-LIKE but
    // not an Array — casting straight to unknown[] is a lie TypeScript is right
    // to reject. `items` is the accessor for its elements.
    expiries: listItems(row[4]).map(String),
  }));
}

/** Expiries listed for one asset, ascending, as of a date. */
export async function expiriesParquet(
  asset: string, exchange: string, asOf = todayKey(),
): Promise<string[] | null> {
  const globs = livePartitions(exchange, asOf.replace(/-/g, ''));
  if (!globs.length) return null;

  const c = await connect();
  const rows = await c.runAndReadAll(`
    SELECT DISTINCT expiry
    FROM read_parquet([${globs.map(quote).join(', ')}], ${HIVE})
    WHERE asset = ${quote(asset.trim().toUpperCase())}
      AND derivative_type = 'OPT'
    ORDER BY expiry
  `);
  return rows.getRows().map((r) => String(r[0]));
}

/** One contract row, in the shape `instrumentCache` produces. */
export interface ContractRow {
  asset: string;
  name: string;
  exchange: string;
  type: string;
  assetType: string;
  optionType?: 'CE' | 'PE';
  strike?: number;
  expiry?: string;
  lot?: number;
  refId: string;
}

/**
 * Every contract for one asset, optionally one expiry.
 *
 * `strike_price` is divided by 100 here for the same reason `toRupees` exists
 * on the JSON path: this feed quotes every price in paise INCLUDING strikes,
 * and a magnitude heuristic would misread a sub-ten-rupee strike.
 */
export async function contractsParquet(
  asset: string, exchange: string, expiry?: string, asOf = todayKey(),
): Promise<ContractRow[] | null> {
  const wanted = expiry?.replace(/-/g, '');
  const dir = path.join(ROOT, exchange.toUpperCase());
  if (!fs.existsSync(dir)) return null;

  /*
   * A named expiry reads ONE directory, whether or not it has already expired.
   *
   * That is what lets a replay of last Tuesday work: the partition is addressed
   * directly rather than filtered out of a live window, so history stays
   * reachable while the default stays restricted to what is tradable now.
   */
  const globs = wanted
    ? [sqlPath(path.join(dir, `expiry=${wanted}`, '*.parquet'))]
    : livePartitions(exchange, asOf);
  if (!globs.length) return null;
  if (wanted && !fs.existsSync(path.join(dir, `expiry=${wanted}`))) return null;

  const c = await connect();
  const rows = await c.runAndReadAll(`
    SELECT asset, stock_name, exchange, derivative_type, asset_type,
           option_type, strike_price / 100.0 AS strike, expiry, lot_size, ref_id
    FROM read_parquet([${globs.map(quote).join(', ')}], ${HIVE})
    WHERE asset = ${quote(asset.trim().toUpperCase())}
    ORDER BY expiry, strike, option_type
  `);

  return rows.getRows().map((r) => ({
    asset: String(r[0]),
    name: String(r[1] ?? '').toUpperCase(),
    exchange: String(r[2] ?? exchange).toUpperCase(),
    type: String(r[3] ?? '').toUpperCase(),
    assetType: String(r[4] ?? '').toUpperCase(),
    optionType: r[5] === 'CE' ? 'CE' : r[5] === 'PE' ? 'PE' : undefined,
    strike: Number(r[6]) > 0 ? Number(r[6]) : undefined,
    expiry: String(r[7]) === 'CASH' ? undefined : String(r[7]),
    lot: Number(r[8]) > 0 ? Number(r[8]) : undefined,
    refId: String(r[9] ?? ''),
  }));
}
