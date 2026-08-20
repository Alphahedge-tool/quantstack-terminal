/**
 * A SQL shell over the market data — like `psql`, over Parquet.
 *
 *   npm run duck                      interactive prompt
 *   npm run duck -- "SELECT ..."      run one query and exit
 *
 * ── What the "database" actually is ──
 *
 * `backend/cache/quantstack.duckdb` is a real DuckDB database file and can be
 * opened by anything that speaks DuckDB — the CLI, DBeaver, a Python notebook.
 * But it holds almost no data: what it stores is VIEWS pointing at the Parquet
 * files beside it.
 *
 * That is the arrangement worth understanding. A table would mean the same rows
 * existing twice, in the file and in the database, with an import step between
 * them and a way to be out of date. A view means the Parquet IS the table:
 * convert a new date, and every query sees it with nothing to reload. The .duckdb
 * file is a few kilobytes of definitions, and deleting it loses nothing.
 *
 * ── Why the views are created every start ──
 *
 * `CREATE OR REPLACE` on each run, rather than once at setup: the definitions
 * are cheap, and a stale view left over from a renamed directory is a confusing
 * failure — "table exists but returns nothing" — where a redefinition is free
 * and always right.
 */

import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CACHE = resolve(__dir, '..', 'cache');
const PARQUET = join(CACHE, 'parquet');
const EXPIRY = join(CACHE, 'expiry');
const DB = join(CACHE, 'quantstack.duckdb');

/** Forward slashes: a path is a SQL string literal, and a Windows backslash is
 *  an escape inside one. */
const sqlPath = (p: string) => p.replace(/\\/g, '/');
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

/**
 * Print rows as an aligned table.
 *
 * Widths come from the data, because the point of a prompt is reading numbers
 * next to each other — a strike ladder in a ragged column is a list you parse
 * by eye instead of scan. Capped at 48 so one long JSON blob cannot push every
 * other column off the screen.
 */
function table(columns: string[], rows: unknown[][]): void {
  if (!rows.length) { console.log(`${DIM}  (no rows)${RESET}\n`); return; }

  const cells = rows.map((row) => row.map((v) => (v === null ? 'NULL' : String(v))));
  const widths = columns.map((name, i) =>
    Math.min(48, Math.max(name.length, ...cells.map((r) => (r[i] ?? '').length))));

  const line = (parts: string[], pad = ' ') =>
    '  ' + parts.map((p, i) => p.slice(0, widths[i]).padEnd(widths[i], pad)).join('  ');

  console.log(`${BOLD}${line(columns)}${RESET}`);
  console.log(`${DIM}${line(widths.map(() => ''), '-')}${RESET}`);
  for (const row of cells) console.log(line(row));
}

async function run(c: DuckDBConnection, sql: string): Promise<void> {
  const started = Date.now();
  try {
    const result = await c.runAndReadAll(sql);
    const rows = result.getRows() as unknown[][];
    table(result.columnNames(), rows);
    console.log(`${DIM}  ${rows.length} row(s) · ${Date.now() - started}ms${RESET}\n`);
  } catch (e) {
    // The error is the answer to a typo, so it is printed and the prompt
    // continues — an exiting shell would lose the session over a missing comma.
    console.log(`${CYAN}  ${(e as Error).message.split('\n')[0]}${RESET}\n`);
  }
}

/** Point views at whatever is on disk right now. */
async function defineViews(c: DuckDBConnection): Promise<string[]> {
  const defined: string[] = [];

  if (existsSync(PARQUET) && readdirSync(PARQUET).some((f) => f.endsWith('.parquet'))) {
    await c.run(`
      CREATE OR REPLACE VIEW refdata AS
      SELECT * FROM read_parquet('${sqlPath(join(PARQUET, '*.parquet'))}', filename = true)
    `);
    defined.push('refdata');
  }

  /*
   * The expiry recorder's output, read as a table without conversion.
   *
   * DuckDB reads JSONL natively, so the cockpit's recordings are queryable the
   * moment they are written — no build step between recording a session and
   * asking questions of it. `union_by_name` because the ladder column gained
   * fields as the recorder evolved and a file written last week has fewer keys
   * than one written today; without it a schema mismatch fails the whole glob.
   */
  if (existsSync(EXPIRY) && readdirSync(EXPIRY).some((f) => f.endsWith('.jsonl'))) {
    await c.run(`
      CREATE OR REPLACE VIEW expiry_bars AS
      SELECT * FROM read_json_auto('${sqlPath(join(EXPIRY, '*.jsonl'))}',
                                   format = 'newline_delimited',
                                   union_by_name = true,
                                   filename = true)
    `);
    defined.push('expiry_bars');
  }

  return defined;
}

async function main(): Promise<void> {
  mkdirSync(CACHE, { recursive: true });

  const db = await DuckDBInstance.create(DB);
  const c = await db.connect();
  const views = await defineViews(c);

  const sql = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (sql) { await run(c, sql); return; }

  const parquetFiles = existsSync(PARQUET)
    ? readdirSync(PARQUET).filter((f) => f.endsWith('.parquet')) : [];
  const bytes = parquetFiles.reduce((sum, f) => sum + statSync(join(PARQUET, f)).size, 0);

  console.log(`\n${BOLD}  QuantStack · DuckDB${RESET}`);
  console.log(`${DIM}  ${DB}${RESET}`);
  console.log(`${DIM}  ${parquetFiles.length} parquet file(s), ${mb(bytes)}${RESET}\n`);

  if (!views.length) {
    console.log(`  Nothing to query yet. Build some parquet:  npm run duck:build\n`);
  } else {
    console.log(`  Tables: ${views.map((v) => `${CYAN}${v}${RESET}`).join(', ')}`);
    console.log(`${DIM}  .tables   .schema <table>   .quit${RESET}\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = () => rl.setPrompt(`${CYAN}duck>${RESET} `);
  prompt();
  rl.prompt();

  /*
   * Statements accumulate until a semicolon.
   *
   * A one-line-one-query shell is unusable for the queries worth writing here —
   * a join across the ladder and the bars runs to five lines — so the buffer
   * holds until `;`, exactly as psql does, and a bare newline just continues.
   */
  let buffer = '';

  rl.on('line', async (raw) => {
    const line = raw.trim();

    if (!buffer && (line === '.quit' || line === '.exit' || line === 'exit')) { rl.close(); return; }
    if (!buffer && line === '.tables') {
      await run(c, `SELECT table_name, table_type FROM information_schema.tables ORDER BY 1`);
      rl.prompt(); return;
    }
    if (!buffer && line.startsWith('.schema')) {
      const name = line.split(/\s+/)[1] ?? views[0];
      await run(c, `DESCRIBE ${name}`);
      rl.prompt(); return;
    }
    if (!buffer && !line) { rl.prompt(); return; }

    buffer = buffer ? `${buffer}\n${line}` : line;
    if (!buffer.endsWith(';')) {
      // The continuation prompt says the shell is waiting rather than hung.
      rl.setPrompt(`${DIM}   ...>${RESET} `);
      rl.prompt();
      return;
    }

    const statement = buffer.slice(0, -1);
    buffer = '';
    await run(c, statement);
    prompt();
    rl.prompt();
  });

  rl.on('close', () => { console.log(`${DIM}  bye${RESET}\n`); process.exit(0); });
}

main().catch((e) => { console.error(`\n  ${(e as Error).message}\n`); process.exit(1); });
