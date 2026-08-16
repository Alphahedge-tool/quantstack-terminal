/**
 * Checks for the trading normalisation layer.
 *
 * The risk here is not crashes, it is quiet wrongness: a status that maps to
 * OPEN when the order actually filled, a cost basis computed from only the day
 * bucket, a timestamp parsed in the server's timezone instead of IST. None of
 * those throw. All of them are visible on screen as a number that looks fine.
 *
 *   npx tsx scripts/verifyTrading.ts
 */

import {
  toSide, toStatus, toKind, toProduct, toTimestamp, toNumber,
} from '../trading/types.js';
import { resolveContract } from '../trading/contract.js';
import { normalizeKotakPosition } from '../trading/adapters/kotak.js';
import { normalizeZerodhaPosition } from '../trading/adapters/zerodha.js';
import { normalizeAngelPosition } from '../trading/adapters/angel.js';
import { normalizeOrderFrame } from '../trading/orderStream/angel.js';

let failures = 0;

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures += 1;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── Enum normalisation ───────────────────────────────────────────────────────

console.log('\n── status / kind / product ──');
{
  // Each broker's own vocabulary must land on the same enum.
  check('Angel "complete" → COMPLETE',   toStatus('complete') === 'COMPLETE');
  check('Kite "COMPLETE" → COMPLETE',    toStatus('COMPLETE') === 'COMPLETE');
  check('Kotak "filled" → COMPLETE',     toStatus('filled') === 'COMPLETE');
  check('"rejected" → REJECTED',         toStatus('rejected') === 'REJECTED');
  check('"trigger pending" → TRIGGER_PENDING', toStatus('trigger pending') === 'TRIGGER_PENDING');

  // The important negative: an unrecognised status must NOT become OPEN, which
  // would show a filled order as still working.
  check('unknown status → UNKNOWN, not OPEN', toStatus('some new state') === 'UNKNOWN');
  check('empty status → UNKNOWN',             toStatus('') === 'UNKNOWN');

  check('MIS → INTRADAY',        toProduct('MIS') === 'INTRADAY');
  check('NRML → CARRYFORWARD',   toProduct('NRML') === 'CARRYFORWARD');
  check('CNC → DELIVERY',        toProduct('CNC') === 'DELIVERY');
  check('unknown product → UNKNOWN', toProduct('XYZ') === 'UNKNOWN');

  check('STOPLOSS_LIMIT → SL',   toKind('STOPLOSS_LIMIT') === 'SL');
  check('SL-M → SL-M',           toKind('SL-M') === 'SL-M');
  check('LIMIT → LIMIT',         toKind('LIMIT') === 'LIMIT');

  check('"SELL" → SELL',  toSide('SELL') === 'SELL');
  check('"S" → SELL',     toSide('S') === 'SELL');
  check('"BUY" → BUY',    toSide('BUY') === 'BUY');
  check('"B" → BUY',      toSide('B') === 'BUY');
}

// ── Timestamps ───────────────────────────────────────────────────────────────

console.log('\n── timestamps ──');
{
  // Angel and Kotak both send IST with no zone marker. Parsed as local time on
  // a UTC server this would be 5½ hours out — a whole trading session's worth.
  const ist = toTimestamp('2026-08-12 09:15:00');
  const expected = Date.UTC(2026, 7, 12, 3, 45, 0);   // 09:15 IST = 03:45 UTC
  check('IST-without-zone parsed as IST', ist === expected,
    `${ist} vs ${expected}`);

  // ISO with an explicit zone must be respected, not re-shifted.
  const iso = toTimestamp('2026-08-12T09:15:00+05:30');
  check('ISO with zone is respected', iso === expected, `${iso} vs ${expected}`);

  // A bad timestamp must be null, never Date.now(): a fabricated one sorts an
  // order book plausibly and wrongly.
  check('unparseable → null', toTimestamp('not a date') === null);
  check('empty → null',       toTimestamp('') === null);
  check('null → null',        toTimestamp(null) === null);
}

// ── Numbers ──────────────────────────────────────────────────────────────────

console.log('\n── numbers ──');
{
  check('numeric string', toNumber('123.45') === 123.45);
  check('number passthrough', toNumber(7) === 7);
  check('empty → 0',  toNumber('') === 0);
  check('null → 0',   toNumber(null) === 0);
  check('NaN → 0',    toNumber('abc') === 0);
  check('Infinity → 0', toNumber(Infinity) === 0);
}

// ── Contract resolution, master-free fallback ────────────────────────────────

console.log('\n── contract resolution (no master loaded) ──');
{
  // Nothing is loaded for `faux`, so this exercises the reconstruction path —
  // the one that has to work on the day a contract is listed and the cached
  // master predates it.
  const opt = resolveContract('faux', {
    brsymbol:   'NIFTY28AUG2624500CE',
    brexchange: 'NFO',
    expiry:     '2026-08-28',
    strike:     24500,
    optionType: 'CE',
    lot:        65,
  });

  check('canonical symbol rebuilt', opt.symbol === 'NIFTY28AUG2624500CE', opt.symbol);
  check('underlying recovered',     opt.underlying === 'NIFTY', opt.underlying);
  check('exchange canonical',       opt.exchange === 'NFO', opt.exchange);
  check('key is usable',            opt.key?.kind === 'OPT' && opt.key?.strike === 24500);
  check('key exchange is NSE, not NFO', opt.key?.exchange === 'NSE', opt.key?.exchange);
  check('lot carried',              opt.lot === 65, String(opt.lot));

  // Underlying recovery when the broker states no name — Kite's case.
  const noName = resolveContract('faux', {
    brsymbol: 'BANKNIFTY28AUG2652000PE', brexchange: 'NFO',
    expiry: '2026-08-28', strike: 52000, optionType: 'PE',
  });
  check('root stripped from symbol', noName.underlying === 'BANKNIFTY', noName.underlying);
  check('PE side preserved',         noName.key?.side === 'PE');

  // Reconstructed contracts must be FLAGGED as such. The resolver cannot tell a
  // garbled row from a legitimately unlisted cash symbol, so it does not try —
  // it reports that no master confirmed this, and the UI decides.
  check('reconstructed contract is flagged unresolved', opt.resolved === false);

  const junk = resolveContract('faux', { brsymbol: '???', brexchange: 'XXX' });
  check('unidentifiable row still renders', junk.label === '???', junk.label);
  check('unidentifiable row is not marked resolved', junk.resolved === false);

  // Kotak's segment spelling must normalise like everyone else's.
  const kotakSeg = resolveContract('faux', {
    brsymbol: 'NIFTY28AUG2624500CE', brexchange: 'nse_fo',
    expiry: '2026-08-28', strike: 24500, optionType: 'CE',
  });
  check('nse_fo → NFO', kotakSeg.exchange === 'NFO', kotakSeg.exchange);
}

// ── Kotak position arithmetic ────────────────────────────────────────────────

console.log('\n── Kotak position arithmetic ──');
{
  // Bought 100 today at 50 (amount 5000) and held 50 from yesterday at 40
  // (amount 2000); sold 75 today at 60 (amount 4500).
  //   buy qty  = 150,  buy amount  = 7000  → average 46.666…
  //   sell qty =  75,  sell amount = 4500  → average 60
  //   closed   =  75   → realised = (60 − 46.666…) × 75 = 1000
  const p = normalizeKotakPosition({
    trdSym: 'NIFTY28AUG2624500CE', exSeg: 'nse_fo', prod: 'NRML',
    flBuyQty: 100, buyAmt: 5000,
    cfBuyQty: 50,  cfBuyAmt: 2000,
    flSellQty: 75, sellAmt: 4500,
    cfSellQty: 0,  cfSellAmt: 0,
  });

  check('buy quantity spans day + carry',   p.buyQuantity === 150, String(p.buyQuantity));
  check('sell quantity',                    p.sellQuantity === 75, String(p.sellQuantity));
  check('buy average from BOTH buckets',    Math.abs(p.buyAverage - 7000 / 150) < 1e-9,
    p.buyAverage.toFixed(4));
  check('sell average',                     p.sellAverage === 60, String(p.sellAverage));
  check('net quantity derived',             p.quantity === 75, String(p.quantity));
  check('overnight quantity',               p.overnight === 50, String(p.overnight));
  check('realised on closed qty only',      Math.abs(p.realised - 1000) < 1e-9,
    p.realised.toFixed(4));
  check('no invented last price',           p.lastPrice === 0);
  check('product normalised',               p.product === 'CARRYFORWARD', p.product);

  // The failure this guards: using only the day bucket would give a buy average
  // of 50 and a realised of 750, which looks entirely plausible on screen.
  check('day-only average would differ (guard is meaningful)',
    Math.abs(p.buyAverage - 50) > 1);

  // An explicit qty from the broker wins over the derivation.
  const explicit = normalizeKotakPosition({
    trdSym: 'X', exSeg: 'nse_fo', qty: -25, flBuyQty: 0, flSellQty: 25,
  });
  check('explicit qty respected (short)', explicit.quantity === -25, String(explicit.quantity));

  // A flat position must not divide by zero.
  const flat = normalizeKotakPosition({ trdSym: 'Y', exSeg: 'nse_fo' });
  check('flat position has no NaN',
    Number.isFinite(flat.buyAverage) && Number.isFinite(flat.sellAverage)
    && Number.isFinite(flat.pnl) && flat.quantity === 0);
}

// ── Order-stream frames ──────────────────────────────────────────────────────

console.log('\n── order socket frames ──');
{
  /** One Angel socket frame, with `orderData` overridden per case. */
  const frame = (code: string, data: Record<string, unknown> = {}) => JSON.stringify({
    'order-status': code,
    orderData: {
      orderid: '2508130001', tradingsymbol: 'NIFTY28AUG2524600CE', exchange: 'NFO',
      transactiontype: 'BUY', producttype: 'CARRYFORWARD', ordertype: 'LIMIT',
      quantity: 75, filledshares: 0, unfilledshares: 75, price: 120.5,
      ...data,
    },
  });

  // The ack carries no order. Treating it as one would put a phantom row in the
  // book every time the socket reconnected.
  check('connection ack without an order is ignored',
    normalizeOrderFrame(JSON.stringify({ 'order-status': 'AB00', orderData: {} })) === null);

  // …but Angel's own sample shows AB00 carrying a real order, so a populated
  // ack must NOT be dropped: that would silently lose genuine updates.
  const ackOrder = normalizeOrderFrame(frame('AB00', { orderstatus: 'rejected' }));
  check('populated ack is still an order', ackOrder?.status === 'REJECTED', ackOrder?.status);

  check('non-JSON frame (pong) is ignored', normalizeOrderFrame('pong') === null);

  const complete = normalizeOrderFrame(frame('AB05', { filledshares: 75, unfilledshares: 0 }));
  check('AB05 → COMPLETE', complete?.status === 'COMPLETE', complete?.status);
  check('filled quantity carried', complete?.filled === 75, String(complete?.filled));
  check('pending derived, not trusted', complete?.pending === 0, String(complete?.pending));

  check('AB03 → REJECTED', normalizeOrderFrame(frame('AB03'))?.status === 'REJECTED');
  check('AB02 → CANCELLED', normalizeOrderFrame(frame('AB02'))?.status === 'CANCELLED');
  check('AB10 → TRIGGER_PENDING',
    normalizeOrderFrame(frame('AB10'))?.status === 'TRIGGER_PENDING');

  // Every modify/AMO/pending variant is still working. The damaging direction is
  // one of them landing on COMPLETE — a working order shown as filled.
  for (const code of ['AB01', 'AB04', 'AB06', 'AB08', 'AB09', 'AB11']) {
    check(`${code} → OPEN`, normalizeOrderFrame(frame(code))?.status === 'OPEN');
  }

  // An unrecognised code must fall back to the payload text, not to OPEN.
  const unknown = normalizeOrderFrame(frame('AB99', { orderstatus: 'complete' }));
  check('unknown code falls back to the payload status',
    unknown?.status === 'COMPLETE', unknown?.status);

  // Angel omits `quantity` on some frames; filled + unfilled reconstructs it.
  const partial = normalizeOrderFrame(
    frame('AB01', { quantity: undefined, filledshares: 25, unfilledshares: 50 }),
  );
  check('missing quantity reconstructed from filled + unfilled',
    partial?.quantity === 75, String(partial?.quantity));
  check('partial fill leaves 50 pending', partial?.pending === 50, String(partial?.pending));

  check('side normalised', normalizeOrderFrame(frame('AB01'))?.side === 'BUY');
  check('order id carried', normalizeOrderFrame(frame('AB01'))?.id === '2508130001');
}

// ── Realised / unrealised split ──────────────────────────────────────────────

console.log('\n── realised vs unrealised ──');
{
  // Kite reports a squared-off leg as realised:0 with the whole figure in
  // unrealised — exactly backwards. A position with no quantity has no exposure
  // left to be unrealised about.
  const closed = normalizeZerodhaPosition({
    tradingsymbol: 'SENSEX13AUG2678100CE', exchange: 'BFO',
    quantity: 0, buy_quantity: 120, sell_quantity: 120,
    buy_price: 44.20, sell_price: 29.45,
    pnl: -1770, realised: 0, unrealised: -1770,
  });
  check('a fully closed leg is REALISED, not unrealised',
    closed.realised === -1770, String(closed.realised));
  check('and carries no unrealised', closed.unrealised === 0, String(closed.unrealised));

  // An open leg's P&L is unrealised, whatever Kite splits it as.
  const open = normalizeZerodhaPosition({
    tradingsymbol: 'SENSEX13AUG2677300PE', exchange: 'BFO',
    quantity: -120, buy_quantity: 0, sell_quantity: 120,
    buy_price: 0, sell_price: 29.35,
    pnl: 3114, realised: 0, unrealised: 3114,
  });
  check('an open leg stays unrealised', open.unrealised === 3114, String(open.unrealised));
  check('and books nothing', open.realised === 0, String(open.realised));

  // Partially closed: realised on the matched quantity only.
  const partial = normalizeZerodhaPosition({
    tradingsymbol: 'X', exchange: 'BFO',
    quantity: 50, buy_quantity: 150, sell_quantity: 100,
    buy_price: 10, sell_price: 14, pnl: 600,
  });
  check('partial close books the matched quantity',
    Math.abs(partial.realised - 400) < 1e-9, String(partial.realised));
  check('parts always reconcile to the total',
    Math.abs((partial.realised + partial.unrealised) - partial.pnl) < 1e-9);

  // Angel's rows are the same shape and no more trustworthy, so the same rule
  // applies — checked here so the two adapters cannot drift apart.
  const angelClosed = normalizeAngelPosition({
    tradingsymbol: 'NIFTY18AUG2624300CE', exchange: 'NFO',
    netqty: 0, totalbuyqty: 65, totalsellqty: 65,
    totalbuyavgprice: 208.50, totalsellavgprice: 202.50,
    pnl: -390, realised: 0, unrealised: -390,
  });
  check('angel: a closed leg is REALISED too',
    angelClosed.realised === -390, String(angelClosed.realised));

  const angelOpen = normalizeAngelPosition({
    tradingsymbol: 'NIFTY18AUG2624650CE', exchange: 'NFO',
    netqty: -325, totalbuyqty: 0, totalsellqty: 325,
    totalbuyavgprice: 0, totalsellavgprice: 45.54,
    pnl: 3848, realised: 0, unrealised: 3848,
  });
  check('angel: an open leg stays unrealised',
    angelOpen.unrealised === 3848 && angelOpen.realised === 0,
    `${angelOpen.realised}/${angelOpen.unrealised}`);
}

console.log(failures === 0 ? '\nAll trading checks passed.\n' : `\n${failures} check(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
