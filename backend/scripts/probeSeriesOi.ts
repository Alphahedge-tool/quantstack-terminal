/** Does `optionSeries({ extras: ['oi'] })` actually deliver OI? */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoLoginFromEnv, getSession } from '../lib/sessionStore.js';
import { activeFeed } from '../feeds/access.js';
import { keyOf } from '../feeds/identity.js';
import { sessionRange } from '../engine/rollingStraddle.js';

for (const line of readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), 'utf8',
).split(String.fromCharCode(10))) {
  const t = line.trim();
  const eq = t.indexOf('=');
  if (!t || t.startsWith('#') || eq < 0) continue;
  const k = t.slice(0, eq).trim();
  if (k && !(k in process.env)) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
}

const DATE = process.argv[2] || '2026-08-12';

async function main() {
  if (!getSession()) await autoLoginFromEnv();
  const feed = await activeFeed();
  const { start, end } = sessionRange(DATE, 'NSE');
  const expiries = await feed.expiries('NIFTY', 'NSE', DATE);
  const rows = await feed.chain('NIFTY', 'NSE', DATE, expiries[0]);
  const strikes = [...new Set(rows.map((r) => r.key.strike ?? 0))].sort((a, b) => a - b);
  const mid = strikes[Math.floor(strikes.length / 2)];
  const pick = rows.filter((r) => r.key.strike === mid).slice(0, 2);

  console.log(`\n  ${DATE} ${expiries[0]} strike ${mid} — ${pick.map((p) => p.label).join(', ')}\n`);

  const { series } = await feed.optionSeries({
    keys: pick.map((p) => p.key),
    interval: '1m',
    from: start,
    to: end,
    greeks: ['gamma'],
    extras: ['oi', 'volume'],
  });

  for (const [key, s] of series) {
    console.log(`  ${key}`);
    for (const field of ['bid', 'ask', 'ltp', 'ivBid', 'ivAsk', 'ivMid', 'gamma', 'oi', 'volume'] as const) {
      const arr = s[field];
      const last = arr?.length ? arr[arr.length - 1].v : null;
      console.log(`    ${field.padEnd(7)} ${String(arr?.length ?? 0).padStart(4)} points  last=${last}`);
    }
  }
  console.log('');
}

main().catch((e) => { console.error(e); process.exit(1); });
