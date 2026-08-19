/**
 * What does historical OI actually look like, and how much of it is there?
 *
 * `probeFields.ts` answers "does the endpoint serve this field name". This one
 * answers the three questions that decide whether the expiry research can be
 * backtested at all:
 *
 *   1. Are `cumulative_oi` values real per-contract OI, at the magnitude the
 *      live chain publishes? A field that is served but always zero is worse
 *      than one that is absent, because it looks like data.
 *   2. Do the aggregate names — `cumulative_call_oi`, `cumulative_put_oi` —
 *      work against an INDEX or CHAIN query, where an option query returns
 *      nothing for them? That would give chain-wide OI and a PCR without
 *      walking every strike.
 *   3. How far back does intraday OI go? The docs say three months for
 *      sub-daily intervals; the ladder needs to know where the corpus ends.
 *
 *   npx tsx scripts/probeOi.ts [SYMBOL]
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
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const eq = trimmed.indexOf('=');
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq).trim();
  if (key && !(key in process.env)) {
    process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
}

const SYMBOL = (process.argv[2] || 'NIFTY').toUpperCase();

interface Point { ts: number; v: number }

async function timeseries(
  session: NubraSession,
  body: Record<string, unknown>,
): Promise<Record<string, Record<string, Point[]>>> {
  const res = await nubraFetch<{ result?: Array<{ values?: Array<Record<string, Record<string, Point[]>>> }> }>(
    'charts/timeseries', session, { method: 'POST', body: { query: [body] }, timeoutMs: 60_000 },
  );
  const merged: Record<string, Record<string, Point[]>> = {};
  for (const entry of res.result?.[0]?.values ?? []) {
    for (const [name, fields] of Object.entries(entry)) {
      merged[name] = fields as unknown as Record<string, Point[]>;
    }
  }
  return merged;
}

const istDate = (offsetDays: number) => {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
};

async function main() {
  if (!getSession()) await autoLoginFromEnv();
  const session = getSession();
  if (!session) { console.error('\n  No Nubra session.\n'); process.exit(2); }

  const rows = await getCachedRefdata('NSE', todayIST(), session);
  const options = rows.filter((r) => r.asset === SYMBOL && r.type === 'OPT' && r.expiry);
  const expiry = options.map((o) => o.expiry!).sort()[0];
  const front = options.filter((o) => o.expiry === expiry);
  const strikes = [...new Set(front.map((o) => o.strike ?? 0))].sort((a, b) => a - b);
  const atm = strikes[Math.floor(strikes.length / 2)];
  const legs = front.filter((o) => o.strike === atm);
  const ce = legs.find((l) => l.optionType === 'CE')?.name ?? legs[0].name;

  console.log(`\n  Historical OI probe — ${SYMBOL} ${expiry} ${atm}\n`);

  /* ── 1. Per-contract OI, today ──────────────────────────────────────── */
  const today = todayIST();
  const one = await timeseries(session, {
    exchange: 'NSE', type: 'OPT', values: [ce],
    fields: ['close', 'cumulative_oi', 'cumulative_volume'],
    startDate: `${today}T03:45:00Z`, endDate: `${today}T10:00:00Z`,
    interval: '1m', intraDay: false, realTime: false,
  });
  const oi = one[ce]?.cumulative_oi ?? [];
  const close = one[ce]?.close ?? [];
  console.log(`  ${ce}`);
  console.log(`    cumulative_oi   ${oi.length} points`);
  if (oi.length) {
    const first = oi[0];
    const last = oi[oi.length - 1];
    console.log(`      first ${new Date(first.ts / 1e6).toISOString().slice(11, 16)} = ${first.v.toLocaleString('en-IN')}`);
    console.log(`      last  ${new Date(last.ts / 1e6).toISOString().slice(11, 16)} = ${last.v.toLocaleString('en-IN')}`);
    console.log(`      change over the session: ${(last.v - first.v).toLocaleString('en-IN')}`);
    const distinct = new Set(oi.map((p) => p.v)).size;
    console.log(`      ${distinct} distinct values — ${distinct > 3 ? 'it MOVES intraday' : 'looks static'}`);
  }
  console.log(`    close           ${close.length} points`);

  /* ── 2. Chain-wide aggregates, on an INDEX query ────────────────────── */
  for (const type of ['INDEX', 'CHAIN'] as const) {
    try {
      const agg = await timeseries(session, {
        exchange: 'NSE', type, values: [SYMBOL],
        fields: ['close', 'cumulative_call_oi', 'cumulative_put_oi', 'cumulative_oi'],
        startDate: `${today}T03:45:00Z`, endDate: `${today}T10:00:00Z`,
        interval: '5m', intraDay: false, realTime: false,
      });
      const data = agg[SYMBOL] ?? {};
      const summary = Object.entries(data)
        .map(([field, points]) => `${field}:${points.length}`)
        .join('  ') || 'nothing';
      console.log(`\n  type=${type}  ${summary}`);
      const call = data.cumulative_call_oi?.at(-1)?.v;
      const put = data.cumulative_put_oi?.at(-1)?.v;
      if (call && put) {
        console.log(`    last call OI ${call.toLocaleString('en-IN')} · put OI ${put.toLocaleString('en-IN')} · PCR ${(put / call).toFixed(3)}`);
      }
    } catch (e) {
      console.log(`\n  type=${type}  REJECTED — ${(e as Error).message.slice(0, 100)}`);
    }
  }

  /* ── 3. How far back does 1m OI go? ─────────────────────────────────── */
  /*
   * Probed with a contract that was ALIVE on the date being asked about.
   *
   * The obvious version — take today's front-month option and ask for it sixty
   * days ago — measures the wrong thing entirely and looks like a data limit: a
   * weekly listed last month has no history before it was listed, so an empty
   * answer says the contract did not exist, not that the archive stops. Each
   * date below therefore resolves its own front contract from that date's own
   * instrument master.
   */
  console.log('\n  Reach at 1m resolution, using a contract live on each date:');
  for (const days of [7, 30, 60, 90, 120, 180]) {
    const day = istDate(days);
    try {
      const master = await getCachedRefdata('NSE', day, session);
      const live = master.filter((r) => r.asset === SYMBOL && r.type === 'OPT'
        && r.expiry && r.expiry >= day.replace(/-/g, ''));
      if (!live.length) {
        console.log(`    ${days.toString().padStart(3)}d ago (${day})  no master for that date`);
        continue;
      }
      const nearest = live.map((o) => o.expiry!).sort()[0];
      const ladder = [...new Set(live.filter((o) => o.expiry === nearest).map((o) => o.strike ?? 0))]
        .sort((a, b) => a - b);
      const middle = ladder[Math.floor(ladder.length / 2)];
      const leg = live.find((o) => o.expiry === nearest && o.strike === middle && o.optionType === 'CE');
      if (!leg) {
        console.log(`    ${days.toString().padStart(3)}d ago (${day})  no CE at the middle strike`);
        continue;
      }

      const back = await timeseries(session, {
        exchange: 'NSE', type: 'OPT', values: [leg.name],
        fields: ['cumulative_oi', 'gamma'],
        startDate: `${day}T03:45:00Z`, endDate: `${day}T10:00:00Z`,
        interval: '1m', intraDay: false, realTime: false,
      });
      const points = back[leg.name]?.cumulative_oi?.length ?? 0;
      const gammas = back[leg.name]?.gamma?.length ?? 0;
      console.log(
        `    ${days.toString().padStart(3)}d ago (${day})  ${leg.name.padEnd(22)}`
        + ` oi ${String(points).padStart(4)}  gamma ${String(gammas).padStart(4)}`
        + `${points ? '' : '   <- nothing'}`,
      );
    } catch (e) {
      console.log(`    ${days.toString().padStart(3)}d ago (${day})  error - ${(e as Error).message.slice(0, 70)}`);
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\n  probe failed — ${(e as Error).message}\n`);
  process.exit(1);
});
