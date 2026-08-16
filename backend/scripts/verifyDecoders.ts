/**
 * Unit checks for the three brokers' binary tick decoders.
 *
 * These parsers are the highest-risk code in the feed layer and the hardest to
 * observe: a wrong offset or divisor produces plausible-looking numbers, not an
 * error, and the mistake only shows up as a chart that is subtly wrong. Synthetic
 * packets are built to a known layout here so the decoders can be checked
 * exactly, with no broker session involved.
 *
 *   npx tsx scripts/verifyDecoders.ts
 */

import { parsePacket as parseAngel }   from '../feeds/adapters/angel/stream.js';
import { parsePacket as parseZerodha } from '../feeds/adapters/zerodha/stream.js';
import { normalizeKotakFiles }         from '../instruments/loaders/kotak.js';
import { normalizeZerodhaRows }        from '../instruments/loaders/zerodha.js';
import { isComplete }                  from '../lib/credentialStore.js';

let failures = 0;

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function near(a: number | undefined, b: number, tol = 1e-6): boolean {
  return a != null && Math.abs(a - b) < tol;
}

// ── Angel SmartStream V2 ─────────────────────────────────────────────────────

/** Build a 379-byte SNAP_QUOTE packet with known values. */
function angelPacket(opts: {
  exType: number; token: string; ts: number; ltpPaise: bigint;
  bidPaise?: bigint; askPaise?: bigint;
}): Buffer {
  const buf = Buffer.alloc(379);
  buf.writeUInt8(3, 0);                       // mode = SNAP_QUOTE
  buf.writeUInt8(opts.exType, 1);
  buf.write(opts.token.padEnd(25, ' '), 2, 25, 'ascii');
  buf.writeBigInt64LE(BigInt(opts.ts), 35);
  buf.writeBigInt64LE(opts.ltpPaise, 43);

  // Depth: entry 0 is a buy at bidPaise, entry 5 a sell at askPaise.
  if (opts.bidPaise != null) {
    buf.writeInt16LE(1, 147);
    buf.writeBigInt64LE(opts.bidPaise, 147 + 10);
  }
  if (opts.askPaise != null) {
    buf.writeInt16LE(0, 147 + 5 * 20);
    buf.writeBigInt64LE(opts.askPaise, 147 + 5 * 20 + 10);
  }
  return buf;
}

console.log('\n── Angel SmartStream V2 ──');
{
  const ts = 1_760_000_000_000;
  const t = parseAngel(angelPacket({
    exType: 2, token: '43215', ts,
    ltpPaise: 12_345n, bidPaise: 12_300n, askPaise: 12_400n,
  }));

  check('token parsed', t?.token === '43215', t?.token);
  check('exchange timestamp used', t?.ts === ts, String(t?.ts));
  check('LTP paise → rupees', near(t?.ltp, 123.45), String(t?.ltp));
  check('best bid', near(t?.bid, 123.0), String(t?.bid));
  check('best ask', near(t?.ask, 124.0), String(t?.ask));

  // CDS is scaled by 10^7, not 100 — the divisor that, if wrong, makes it look
  // like the rupee collapsed rather than like a bug.
  const cds = parseAngel(angelPacket({
    exType: 13, token: '1234', ts, ltpPaise: 882_500_000n,
  }));
  check('CDS divisor 10^7', near(cds?.ltp, 88.25), String(cds?.ltp));

  // LTP-only packets are normal, not errors.
  // Copied into a fresh 51-byte buffer rather than sliced: `subarray` returns a
  // view whose backing type the decoder's signature does not accept, and the
  // point here is the packet length, not how it was produced.
  const short = Buffer.alloc(51);
  angelPacket({ exType: 2, token: '99', ts, ltpPaise: 5_000n }).copy(short, 0, 0, 51);
  const shortTick = parseAngel(short);
  check('LTP-only packet decodes', near(shortTick?.ltp, 50) && shortTick?.bid == null,
    String(shortTick?.ltp));

  check('runt packet rejected', parseAngel(Buffer.alloc(20)) === null);

  // A zero exchange timestamp must fall back to arrival time, not 1970.
  const noTs = parseAngel(angelPacket({ exType: 2, token: '7', ts: 0, ltpPaise: 100n }));
  check('zero timestamp falls back to now', (noTs?.ts ?? 0) > 1_700_000_000_000);
}

// ── Zerodha Kite ticker ──────────────────────────────────────────────────────

/** Build a 184-byte full packet. */
function kitePacket(opts: {
  token: number; ts: number; ltp: number; bid?: number; ask?: number;
}): Buffer {
  const p = Buffer.alloc(184);
  p.writeInt32BE(opts.token, 0);
  p.writeInt32BE(opts.ltp, 4);
  p.writeInt32BE(opts.ts, 60);
  if (opts.bid != null) p.writeInt32BE(opts.bid, 64 + 4);
  if (opts.ask != null) p.writeInt32BE(opts.ask, 64 + 5 * 12 + 4);
  return p;
}

/** Wrap packets in a Kite frame: int16 count, then int16 length + payload each. */
function kiteFrame(packets: Buffer[]): Buffer {
  const head = Buffer.alloc(2);
  head.writeInt16BE(packets.length);
  const parts: Buffer[] = [head];
  for (const p of packets) {
    const len = Buffer.alloc(2);
    len.writeInt16BE(p.length);
    parts.push(len, p);
  }
  return Buffer.concat(parts);
}

console.log('\n── Zerodha Kite ticker ──');
{
  const tsSec = 1_760_000_000;
  // Low byte 2 = NFO → divisor 100.
  const nfoToken = (12345 << 8) | 2;
  const t = parseZerodha(kitePacket({
    token: nfoToken, ts: tsSec, ltp: 12_345, bid: 12_300, ask: 12_400,
  }));

  check('token parsed', t?.token === nfoToken, String(t?.token));
  check('timestamp seconds → ms', t?.ts === tsSec * 1000, String(t?.ts));
  check('LTP paise → rupees', near(t?.ltp, 123.45), String(t?.ltp));
  check('best bid', near(t?.bid, 123.0), String(t?.bid));
  check('best ask', near(t?.ask, 124.0), String(t?.ask));

  // Low byte 3 = CDS → divisor 10^7.
  const cdsToken = (999 << 8) | 3;
  const cds = parseZerodha(kitePacket({ token: cdsToken, ts: tsSec, ltp: 882_500_000 }));
  check('CDS divisor 10^7', near(cds?.ltp, 88.25), String(cds?.ltp));

  // Multi-packet frames are the normal case for Kite, unlike Angel.
  const frame = kiteFrame([
    kitePacket({ token: nfoToken, ts: tsSec, ltp: 100 }),
    kitePacket({ token: (777 << 8) | 2, ts: tsSec, ltp: 200 }),
  ]);
  const count = frame.readInt16BE(0);
  check('frame declares 2 packets', count === 2, String(count));

  check('runt packet rejected', parseZerodha(Buffer.alloc(4)) === null);
}

// ── Kotak master normalisation ───────────────────────────────────────────────

console.log('\n── Kotak master ──');
{
  // NSE F&O expiries carry a 315,511,200s offset the other segments do not.
  // 2026-08-28 UTC = 1787875200; stored as that minus the offset.
  const target  = Date.UTC(2026, 7, 28) / 1000;
  const stored  = target - 315_511_200;

  const csv = 'pSymbol,pTrdSymbol,pSymbolName,pInstType,pOptionType,pExpiryDate,dStrikePrice,lLotSize,dTickSize\n'
    + `12345,NIFTY26AUG24500CE,NIFTY,OPTIDX,CE,${stored},2450000,65,5\n`;

  const rows = normalizeKotakFiles([{ url: 'https://x/nse_fo.csv', text: csv }]);
  check('one row parsed', rows.length === 1, `${rows.length} rows`);

  const row = rows[0];
  check('NSE F&O epoch offset applied', row?.expiry === '2026-08-28', row?.expiry);
  check('strike ÷100', row?.strike === 24500, String(row?.strike));
  check('canonical symbol', row?.symbol === 'NIFTY28AUG2624500CE', row?.symbol);
  check('canonical exchange NFO', row?.exchange === 'NFO', row?.exchange);
  check('broker segment kept', row?.brexchange === 'nse_fo', row?.brexchange);
  check('lot size', row?.lotsize === 65, String(row?.lotsize));

  // MCX has no offset — applying one here would shift every commodity expiry
  // ten years early. Same stored value, different segment, different answer.
  const mcxCsv = 'pSymbol,pTrdSymbol,pSymbolName,pInstType,pOptionType,pExpiryDate,dStrikePrice,lLotSize,dTickSize\n'
    + `777,CRUDEOIL28AUG265000CE,CRUDEOIL,OPTFUT,CE,${target},500000,100,1\n`;
  const mcx = normalizeKotakFiles([{ url: 'https://x/mcx_fo.csv', text: mcxCsv }]);
  check('MCX expiry without offset', mcx[0]?.expiry === '2026-08-28', mcx[0]?.expiry);
  check('MCX strike ÷100', mcx[0]?.strike === 5000, String(mcx[0]?.strike));
  check('MCX canonical symbol', mcx[0]?.symbol === 'CRUDEOIL28AUG265000CE', mcx[0]?.symbol);

  // The offset is the whole point: the same stored integer must yield a
  // different date on nse_fo than on mcx_fo.
  check('offset actually differentiates segments',
    normalizeKotakFiles([{ url: 'https://x/nse_fo.csv', text: mcxCsv }])[0]?.expiry !== mcx[0]?.expiry);
}

// ── Zerodha master normalisation ─────────────────────────────────────────────

console.log('\n── Zerodha master ──');
{
  const csv = 'instrument_token,exchange_token,tradingsymbol,name,expiry,strike,tick_size,lot_size,'
    + 'instrument_type,segment,exchange\n'
    + '3160321,12345,NIFTY26AUG24500CE,NIFTY,2026-08-28,24500,0.05,65,CE,NFO-OPT,NFO\n';

  const rows = normalizeZerodhaRows([...csvRows(csv)]);
  check('one row parsed', rows.length === 1, `${rows.length} rows`);
  const row = rows[0];
  // Kite's strikes are already rupees — applying Angel's ÷100 here would be the
  // mirror-image bug.
  check('strike NOT rescaled', row?.strike === 24500, String(row?.strike));
  check('canonical symbol', row?.symbol === 'NIFTY28AUG2624500CE', row?.symbol);
  check('instrument_token kept', row?.token === '3160321', row?.token);
  check('exchange_token kept separately', row?.exchangeToken === '12345', row?.exchangeToken);
}

function* csvRows(text: string): Generator<Record<string, string>> {
  const [head, ...lines] = text.trim().split('\n');
  const headers = head.split(',');
  for (const line of lines) {
    const values = line.split(',');
    yield Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])) as Record<string, string>;
  }
}

// ── Credential completeness ──────────────────────────────────────────────────

console.log('\n── credential requirements ──');
{
  const base = { broker: '', phone: '', mpin: '', totpSecret: '', label: 't', source: 'env' as const };

  check('nubra needs phone+pin+totp',
    isComplete({ ...base, phone: '9', mpin: '1', totpSecret: 's' }, 'nubra')
    && !isComplete({ ...base, phone: '9', mpin: '1' }, 'nubra'));

  check('angel needs clientCode+apiKey+pin+totp',
    isComplete({ ...base, clientCode: 'A1', apiKey: 'k', mpin: '1', totpSecret: 's' }, 'angel')
    && !isComplete({ ...base, clientCode: 'A1', mpin: '1', totpSecret: 's' }, 'angel'));

  check('zerodha needs apiKey+secret+user+totp',
    isComplete({ ...base, apiKey: 'k', apiSecret: 's', clientCode: 'ZX', totpSecret: 't' }, 'zerodha')
    && !isComplete({ ...base, apiKey: 'k', clientCode: 'ZX', totpSecret: 't' }, 'zerodha'));

  check('kotak needs token+UCC+phone+mpin+totp',
    isComplete({
      ...base, apiKey: 'k', clientCode: 'UCC1', phone: '9', mpin: '1', totpSecret: 's',
    }, 'kotak')
    && !isComplete({ ...base, apiKey: 'k', mpin: '1', totpSecret: 's' }, 'kotak'));

  // Angel credentials must NOT satisfy Nubra's requirements — the whole point of
  // per-broker rules is that one broker's row cannot be used to log into another.
  check('angel row does not satisfy nubra',
    !isComplete({ ...base, clientCode: 'A1', apiKey: 'k', mpin: '1', totpSecret: 's' }, 'nubra'));
}

console.log(failures === 0 ? '\nAll decoder checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
