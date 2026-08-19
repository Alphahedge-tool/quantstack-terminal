/**
 * Which fields does `charts/timeseries` actually serve?
 *
 * ── Why this exists ──
 *
 * The expiry-day work turns on one fact nobody has written down: whether the
 * HISTORY endpoint carries open interest and volume, or only the quote fields
 * the straddle engine has always asked for. The answer decides the shape of the
 * whole feature — OI migration, the OI wall and GEX are either backtestable
 * across every expiry Nubra retains, or they are live-only signals that have to
 * be recorded from today forward and cannot be studied until enough sessions
 * accumulate.
 *
 * The endpoint 400s the WHOLE batch on an unrecognised field name rather than
 * ignoring it (see `fetchRollingBatch`), which is what makes this probe cheap
 * and unambiguous: ask for one field at a time and the error IS the answer.
 *
 *   npx tsx scripts/probeFields.ts [SYMBOL] [YYYY-MM-DD]
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoLoginFromEnv, getSession } from '../lib/sessionStore.js';
import { nubraFetch } from '../lib/nubraData.js';
import { getCachedRefdata, todayIST } from '../lib/instrumentCache.js';
import type { NubraSession } from '../brokers/nubra.js';

/*
 * The same .env the server reads, loaded the same way.
 *
 * `main.ts` does this inline and a script that skips it fails with "no
 * credentials" while a working .env sits one directory up — which reads as a
 * broken login rather than as a script that never looked.
 */
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
const DATE = process.argv[3] || todayIST();

/**
 * Every field worth knowing about, probed one at a time.
 *
 * The names come from the REST v3 documentation's own `fields` list for
 * `charts/timeseries`, which is the part this probe originally missed: the
 * first pass guessed `oi`, `open_interest` and `openInterest`, all of which the
 * endpoint accepts and answers with nothing. The documented name is
 * `cumulative_oi`, and guessing a field name is indistinguishable from the
 * field not existing.
 */
const CANDIDATES = [
  // The set the engine already relies on — a control group. If these fail the
  // probe itself is broken, not the endpoint.
  'l1bid', 'l1ask', 'close', 'iv_bid', 'iv_ask',
  'open', 'high', 'low',
  // Greeks.
  'delta', 'gamma', 'vega', 'theta', 'iv_mid',
  // The documented OI family — the whole reason for this re-probe.
  'cumulative_oi', 'cumulative_call_oi', 'cumulative_put_oi', 'cumulative_fut_oi',
  // Volume family.
  'tick_volume', 'cumulative_volume', 'cumulative_volume_premium',
  'cumulative_volume_delta',
  // The names the first pass guessed, kept as a control: they should still come
  // back absent, which is what proves the difference is the NAME and not the
  // endpoint.
  'oi', 'open_interest', 'volume',
];

async function pickContracts(session: NubraSession): Promise<string[]> {
  const rows = await getCachedRefdata('NSE', DATE, session);
  const options = rows.filter((r) => r.asset === SYMBOL && r.type === 'OPT' && r.expiry);
  if (!options.length) throw new Error(`no ${SYMBOL} options in the ${DATE} master`);

  const expiry = options.map((o) => o.expiry!).sort()[0];
  const front = options.filter((o) => o.expiry === expiry);
  // The middle of the strike ladder is the liquid part; a random wing may have
  // no prints at all, and "no data" would be indistinguishable from "no field".
  const sorted = [...new Set(front.map((o) => o.strike ?? 0))].sort((a, b) => a - b);
  const atm = sorted[Math.floor(sorted.length / 2)];
  const legs = front.filter((o) => o.strike === atm).map((o) => o.name);
  console.log(`  contract(s): ${legs.join(', ')}  (expiry ${expiry}, strike ${atm})\n`);
  return legs.slice(0, 2);
}

async function probe(field: string, values: string[], session: NubraSession) {
  // The envelope matters: `charts/timeseries` takes `{ query: [ ... ] }`, and
  // a bare query object comes back 200 with an empty body — which reads as
  // "field not served" for every field, including the ones the engine uses
  // every day. That false negative is exactly what this probe must not produce.
  const body = {
    query: [{
      exchange: 'NSE',
      type: 'OPT',
      values,
      fields: ['close', field],
      // RFC3339, in UTC. The endpoint parses with Go's reference layout and
      // 500s on "YYYY-MM-DD HH:MM:SS" — 09:15 IST is 03:45Z.
      startDate: `${DATE}T03:45:00Z`,
      endDate: `${DATE}T10:00:00Z`,
      interval: '1m',
      intraDay: false,
      realTime: false,
    }],
  };
  try {
    const res = await nubraFetch<Record<string, unknown>>(
      'charts/timeseries', session, { method: 'POST', body, timeoutMs: 30_000 },
    );
    // A 200 with the field missing from the payload is a THIRD outcome, and the
    // one most likely to be misread as success: the endpoint accepted the name
    // and silently returned nothing for it.
    const values = (res as { result?: Array<{ values?: unknown[] }> })
      ?.result?.[0]?.values ?? [];
    const text = JSON.stringify(values);
    const present = text.includes(`"${field}"`);
    // Count the actual points, not the series: a field can be present as an
    // empty array, which is the endpoint saying "known name, no data".
    const points = (text.match(/"ts"/g) || []).length;
    return {
      field,
      status: present ? (points ? 'SERVED' : 'EMPTY') : 'ACCEPTED-BUT-ABSENT',
      detail: `${values.length} series · ${text.length}B`,
    };
  } catch (e) {
    return { field, status: 'REJECTED', detail: (e as Error).message.slice(0, 90) };
  }
}

async function main() {
  console.log(`\n  charts/timeseries field probe — ${SYMBOL} ${DATE}\n`);

  if (!getSession()) await autoLoginFromEnv();
  const session = getSession();
  if (!session) {
    console.error('  No Nubra session. Set the .env credentials the backend uses.\n');
    process.exit(2);
  }

  const values = await pickContracts(session);

  for (const field of CANDIDATES) {
    const r = await probe(field, values, session);
    const mark = r.status === 'SERVED' ? '✓' : r.status === 'REJECTED' ? '✗' : '·';
    console.log(`  ${mark} ${r.field.padEnd(22)} ${r.status.padEnd(20)} ${r.detail}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\n  probe failed — ${(e as Error).message}\n`);
  process.exit(1);
});
