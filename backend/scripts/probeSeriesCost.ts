/**
 * What makes `charts/timeseries` slow — interval, fields, or symbol count?
 *
 * The straddle walk spends 88% of its wall time in one call: 9,260ms of a
 * 10,555ms request, for twelve contracts. That is not a concurrency problem —
 * twelve contracts is two batches and they run in parallel — so the cost is
 * inside a single upstream response, and the only three things that change its
 * size are the interval, the field list and the number of symbols.
 *
 * This measures each independently against the live feed so the trade-offs are
 * numbers rather than opinions.
 *
 *   npx tsx scripts/probeSeriesCost.ts [SYMBOL] [YYYY-MM-DD]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoLoginFromEnv, getSession } from '../lib/sessionStore.js';
import { nubraFetch } from '../lib/nubraData.js';
import { getCachedRefdata, todayIST } from '../lib/instrumentCache.js';
import type { NubraSession } from '../brokers/nubra.js';

for (const line of readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8',
).split(String.fromCharCode(10))) {
  const t = line.trim();
  const eq = t.indexOf('=');
  if (!t || t.startsWith('#') || eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (k && !(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}

const SYMBOL = (process.argv[2] || 'NIFTY').toUpperCase();
const DATE = process.argv[3] || todayIST();

const QUOTE = ['l1bid', 'l1ask', 'iv_bid', 'iv_ask', 'close'];

async function timed(
  session: NubraSession, values: string[], fields: string[], interval: string,
): Promise<{ ms: number; bytes: number; points: number }> {
  const started = Date.now();
  const res = await nubraFetch<unknown>('charts/timeseries', session, {
    method: 'POST',
    timeoutMs: 120_000,
    body: {
      query: [{
        exchange: 'NSE', type: 'OPT', values, fields,
        startDate: `${DATE}T03:45:00Z`, endDate: `${DATE}T10:00:00Z`,
        interval, intraDay: false, realTime: false,
      }],
    },
  });
  const text = JSON.stringify(res);
  return {
    ms: Date.now() - started,
    bytes: text.length,
    points: (text.match(/"ts"/g) || []).length,
  };
}

const mb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

async function main() {
  if (!getSession()) await autoLoginFromEnv();
  const session = getSession();
  if (!session) { console.error('\n  No session.\n'); process.exit(2); }

  const rows = await getCachedRefdata('NSE', DATE, session);
  const options = rows.filter((r) => r.asset === SYMBOL && r.type === 'OPT' && r.expiry);
  const expiry = options.map((o) => o.expiry!).sort()[0];
  const front = options.filter((o) => o.expiry === expiry);
  const strikes = [...new Set(front.map((o) => o.strike ?? 0))].sort((a, b) => a - b);
  const atm = strikes[Math.floor(strikes.length / 2)];

  // Eight symbols: one full batch, which is the unit the engine actually sends.
  const batch = front
    .filter((o) => Math.abs((o.strike ?? 0) - atm) <= 2 * 50)
    .slice(0, 8)
    .map((o) => o.name);

  console.log(`\n  ${SYMBOL} ${expiry} on ${DATE} — ${batch.length} contracts (one batch)\n`);
  console.log('  case                              time     payload   points');
  console.log('  --------------------------------  -------  --------  ------');

  const show = async (label: string, fields: string[], interval: string) => {
    const r = await timed(session, batch, fields, interval);
    console.log(
      `  ${label.padEnd(32)} ${`${r.ms}ms`.padStart(7)}  `
      + `${mb(r.bytes).padStart(8)}  ${String(r.points).padStart(6)}`,
    );
    return r;
  };

  const base = await show('1s · 5 fields (what runs today)', QUOTE, '1s');
  await show('1s · 3 fields (no iv_bid/iv_ask)', ['l1bid', 'l1ask', 'close'], '1s');
  await show('1s · 2 fields (bid/ask only)', ['l1bid', 'l1ask'], '1s');
  const minute = await show('1m · 5 fields', QUOTE, '1m');
  await show('1m · 5 fields + gamma + oi', [...QUOTE, 'gamma', 'cumulative_oi'], '1m');

  console.log(`\n  A 1m walk is ${(base.ms / Math.max(1, minute.ms)).toFixed(1)}x faster`
    + ` and ${(base.bytes / Math.max(1, minute.bytes)).toFixed(0)}x smaller than the 1s one.\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
