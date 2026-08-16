/**
 * Smoke test for the canonical instrument layer.
 *
 * Downloads Angel's public master (no credentials needed), loads it into the
 * store, and checks that a structural InstrumentKey resolves back to a broker
 * token — the round-trip every adapter and the live router depend on.
 *
 *   npx tsx scripts/verifyInstruments.ts
 */

import { ensureMaster } from '../instruments/manager.js';
import { instruments } from '../instruments/store.js';
import { symbolOf, segmentOf, canonicalSymbol, expiryKey } from '../instruments/symbol.js';
import type { InstrumentKey } from '../feeds/identity.js';

function ok(label: string, pass: boolean, detail = ''): boolean {
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  return pass;
}

async function main(): Promise<void> {
  let failures = 0;

  console.log('\n── canonical symbol formatting ──');
  failures += ok('expiry ISO → DDMMMYY', expiryKey('2026-08-28') === '28AUG26', expiryKey('2026-08-28')) ? 0 : 1;
  failures += ok('expiry Angel → DDMMMYY', expiryKey('28AUG2026') === '28AUG26', expiryKey('28AUG2026')) ? 0 : 1;
  const built = canonicalSymbol({ name: 'NIFTY', type: 'CE', expiry: '2026-08-28', strike: 24500 });
  failures += ok('option symbol', built === 'NIFTY28AUG2624500CE', built) ? 0 : 1;
  const fut = canonicalSymbol({ name: 'CRUDEOIL', type: 'FUT', expiry: '2026-08-19' });
  failures += ok('future symbol', fut === 'CRUDEOIL19AUG26FUT', fut) ? 0 : 1;

  console.log('\n── Angel master ──');
  const t0 = Date.now();
  const status = await ensureMaster('angel');
  console.log(`  loaded (${status}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const stats = instruments.status().angel;
  failures += ok('rows present', (stats?.rows ?? 0) > 10_000, `${stats?.rows ?? 0} rows`) ? 0 : 1;

  for (const segment of ['NFO', 'BFO', 'MCX']) {
    const n = instruments.segmentRows('angel', segment).length;
    failures += ok(`${segment} populated`, n > 0, `${n} rows`) ? 0 : 1;
  }

  console.log('\n── structural key → Angel token ──');

  // Pick a real, live contract out of the master rather than hard-coding an
  // expiry: any fixed date in a test file is wrong the week after it is written.
  const sample = instruments.segmentRows('angel', 'NFO')
    .find((r) => r.name === 'NIFTY' && r.optionType === 'CE' && r.strike);

  if (!sample) {
    failures += ok('found a NIFTY CE row', false) ? 0 : 1;
  } else {
    const key: InstrumentKey = {
      exchange: 'NSE', asset: 'NIFTY', kind: 'OPT',
      expiry: sample.expiry, strike: sample.strike!, side: 'CE',
    };
    console.log(`  sample: ${sample.symbol} (Angel: ${sample.brsymbol}, token ${sample.token})`);
    failures += ok('symbolOf matches master row', symbolOf(key) === sample.symbol, symbolOf(key)) ? 0 : 1;
    failures += ok('segmentOf(NSE, OPT) = NFO', segmentOf('NSE', 'OPT') === 'NFO') ? 0 : 1;

    const resolved = instruments.resolveKey('angel', key);
    failures += ok('key resolves to a token', resolved?.token === sample.token,
      resolved ? `token ${resolved.token}, lot ${resolved.lotsize}` : 'not found') ? 0 : 1;

    const back = instruments.resolveBroker('angel', sample.brsymbol, sample.brexchange);
    failures += ok('broker symbol resolves back', back?.symbol === sample.symbol) ? 0 : 1;

    const brokers = instruments.brokersFor(key);
    failures += ok('brokersFor lists angel', brokers.includes('angel'), brokers.join(', ')) ? 0 : 1;
  }

  console.log('\n── strike scaling ──');
  const strikes = instruments.segmentRows('angel', 'NFO')
    .filter((r) => r.name === 'NIFTY' && r.optionType === 'CE' && r.strike)
    .map((r) => r.strike!);
  const max = Math.max(...strikes);
  // A NIFTY strike is a five-digit rupee figure. Seven digits means the ×100
  // scaling was not undone, which is the single most consequential bug this
  // loader can have: nothing would ever match again.
  failures += ok('NIFTY strikes in rupees', max > 1_000 && max < 200_000, `max ${max}`) ? 0 : 1;

  // MCX needs a much wider bound than NSE: silver is quoted per KILO and lists
  // strikes past ₹350,000, gold past ₹200,000. The test is still meaningful —
  // a missed ÷100 would put silver at ₹36,900,000.
  const mcx = instruments.segmentRows('angel', 'MCX').filter((r) => r.strike);
  if (mcx.length) {
    const mcxMax = Math.max(...mcx.map((r) => r.strike!));
    failures += ok('MCX strikes in rupees', mcxMax < 1_000_000, `max ${mcxMax}`) ? 0 : 1;

    // Per-underlying sanity: natural gas is a two-to-three-digit strike and
    // silver a six-digit one, so a single global bound cannot catch a scaling
    // error that hits only one commodity.
    const gas = mcx.filter((r) => r.name === 'NATURALGAS').map((r) => r.strike!);
    if (gas.length) {
      failures += ok('NATURALGAS strikes plausible',
        Math.max(...gas) < 5_000, `max ${Math.max(...gas)}`) ? 0 : 1;
    }
  }

  console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nverify failed: ${(err as Error).message}\n`);
  process.exit(1);
});
