/**
 * Offline verification for the feed layer.
 *
 *   npm --prefix backend run verify:feeds
 *
 * Runs against the REAL instrument masters already in backend/cache/refdata,
 * with no network and no Nubra session: getSlot() reads the disk cache before
 * it ever reaches out, so the stub session below is only there to satisfy the
 * not-connected guard.
 *
 * What this is for: phase 1's contract is "no behaviour change", and the way
 * that claim goes wrong is silently — a strike still in paise, an expiry that
 * did not normalise, a symbol that maps one way but not back. Those are exactly
 * the failures that would not surface until a failover, when it is too late.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where instrumentCache writes its disk cache — the source of truth for
 *  what this install has actually seen Nubra serve. */
const REFDATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'refdata',
);

import { keyOf, parseKey, normalizeExpiry, optionKey } from './identity.js';
import { classify, FeedError } from './errors.js';
import { supports, bestInterval } from './types.js';
import {
  feeds, feedById, primaryFeed, splitFeedId, resetRegistry,
  installTestFeeds, restoreFeeds,
} from './registry.js';
import { router, withProvenance } from './router.js';
import { stateOf as breakerState, resetAll as resetBreakers } from './breaker.js';
import { probeNow } from './health.js';
import { nubraFeed } from './adapters/nubra/index.js';
import { MockFeed } from './testing/mockFeed.js';
import { ensureConnected, authStatus, resetAuth } from './authManager.js';
import { computeRollingStraddle } from '../engine/rollingStraddle.js';
import { setSession } from '../lib/sessionStore.js';

const DATE = process.env.QT_VERIFY_DATE || '2026-08-07';

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n         ${(e as Error).message}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`);
}

async function main(): Promise<void> {
  section('identity');

  await check('keyOf / parseKey round-trip', () => {
    const k = optionKey('NSE', 'nifty', '20260811', 24500, 'CE');
    assert.equal(keyOf(k), 'NSE:NIFTY:OPT:2026-08-11:24500:CE');
    assert.deepEqual(parseKey(keyOf(k)), {
      exchange: 'NSE', asset: 'NIFTY', kind: 'OPT',
      expiry: '2026-08-11', strike: 24500, side: 'CE',
    });
  });

  await check('normalizeExpiry accepts both refdata forms', () => {
    assert.equal(normalizeExpiry('20260811'),   '2026-08-11');
    assert.equal(normalizeExpiry('2026-08-11'), '2026-08-11');
    assert.equal(normalizeExpiry(''),           undefined);
    assert.equal(normalizeExpiry(null),         undefined);
  });

  section('error classification');

  await check('403 is RATE_LIMIT, not AUTH (Nubra burst rejection)', () => {
    const e = classify(Object.assign(new Error('403: forbidden'), { status: 403 }), 'nubra');
    assert.equal(e.code, 'RATE_LIMIT');
    assert.equal(e.shouldFailover, true);
    assert.equal(e.countsAsFailure, true);
  });

  await check('401 and 440 are AUTH', () => {
    assert.equal(classify(Object.assign(new Error('x'), { status: 401 }), 'nubra').code, 'AUTH');
    assert.equal(classify(Object.assign(new Error('x'), { status: 440 }), 'nubra').code, 'AUTH');
  });

  await check('NubraDataError "<status>: msg" prefix is parsed', () => {
    assert.equal(classify(new Error('502: Bad Gateway'), 'nubra').code, 'TRANSIENT');
    assert.equal(classify(new Error('429: slow down'), 'nubra').code, 'RATE_LIMIT');
  });

  await check('404 is returned, never failed over', () => {
    const e = classify(Object.assign(new Error('x'), { status: 404 }), 'nubra');
    assert.equal(e.code, 'NOT_FOUND');
    assert.equal(e.shouldFailover, false);
    assert.equal(e.countsAsFailure, false);
  });

  await check('timeout and abort are TRANSIENT', () => {
    assert.equal(classify(Object.assign(new Error('t'), { name: 'TimeoutError' }), 'n').code, 'TRANSIENT');
    assert.equal(classify(Object.assign(new Error('a'), { name: 'AbortError' }),   'n').code, 'TRANSIENT');
  });

  await check('UNSUPPORTED fails over but never trips the breaker', () => {
    const e = new FeedError('UNSUPPORTED', 'no MCX here', { feedId: 'feed2' });
    assert.equal(e.shouldFailover,  true);
    assert.equal(e.countsAsFailure, false);
  });

  await check('classify is idempotent', () => {
    const once  = classify(new Error('500: boom'), 'nubra');
    assert.equal(classify(once, 'nubra'), once);
  });

  section('capabilities');

  const cap = nubraFeed.capabilities;

  await check('nubra carries NSE and MCX', () => {
    assert.equal(supports(cap, { exchange: 'NSE', interval: '1s' }).ok, true);
    assert.equal(supports(cap, { exchange: 'MCX', interval: '1m' }).ok, true);
  });

  await check('an unsupported exchange is refused with a reason', () => {
    const r = supports(cap, { exchange: 'NASDAQ' });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /does not carry NASDAQ/);
  });

  await check('history depth is enforced', () => {
    const old = Date.now() - (cap.historyDays + 30) * 86_400_000;
    assert.equal(supports(cap, { exchange: 'NSE', from: old }).ok, false);
  });

  await check('capabilities cover every exchange with refdata on disk', () => {
    // Under-declaring is the dangerous direction: the router SKIPS a feed that
    // says it cannot help, so a missing exchange turns working requests into
    // "no feed could serve this". Anything we have already downloaded is proof
    // Nubra serves it.
    const onDisk = new Set(
      fs.existsSync(REFDATA_DIR)
        ? fs.readdirSync(REFDATA_DIR)
            .map((f) => f.split('_')[0])
            .filter((x) => /^[A-Z]+$/.test(x))
        : [],
    );
    for (const ex of onDisk) {
      assert.ok(cap.exchanges.includes(ex),
        `${ex} refdata is cached but nubra declares only [${cap.exchanges}] — `
        + 'the router would refuse it');
    }
  });

  await check('history window covers the oldest refdata on disk', () => {
    const dates = fs.existsSync(REFDATA_DIR)
      ? fs.readdirSync(REFDATA_DIR)
          .map((f) => f.replace(/^[A-Z]+_/, '').replace(/\.json$/, ''))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
          .sort()
      : [];
    if (!dates.length) return;
    const ageDays = (Date.now() - Date.parse(`${dates[0]}T00:00:00Z`)) / 86_400_000;
    assert.ok(ageDays <= cap.historyDays,
      `oldest cached refdata is ${dates[0]} (${Math.round(ageDays)}d ago) but `
      + `historyDays is ${cap.historyDays} — a backtest of that date would be refused`);
    console.log(`         oldest ${dates[0]} (${Math.round(ageDays)}d) within ${cap.historyDays}d`);
  });

  await check('bestInterval degrades rather than refusing', () => {
    assert.equal(bestInterval({ ...cap, intervals: ['1m'] }, '5s'), '1m');
    assert.equal(bestInterval(cap, '1s'), '1s');
    assert.equal(bestInterval({ ...cap, intervals: ['1s'] }, '1d'), null);
  });

  await check('batch cap matches the documented Nubra limit', () => {
    assert.equal(cap.maxSymbolsPerRequest, 8);
  });

  section('registry');

  await check('default spec registers nubra at priority 1', () => {
    const r = feeds();
    assert.equal(r[0].feed.id, 'nubra');
    assert.equal(primaryFeed().id, 'nubra');
    assert.equal(feedById('nope'), null);
  });

  await check('splitFeedId separates broker from instance', () => {
    assert.deepEqual(splitFeedId('nubra'),    { broker: 'nubra', instance: undefined });
    assert.deepEqual(splitFeedId('nubra#2'),  { broker: 'nubra', instance: '2' });
    assert.deepEqual(splitFeedId('NUBRA#b'),  { broker: 'nubra', instance: 'b' });
  });

  await check('two accounts on one broker register independently', () => {
    process.env.QT_FEEDS = 'nubra#1:1,nubra#2:2';
    resetRegistry();
    try {
      const r = feeds();
      assert.equal(r.length, 2);
      assert.deepEqual(r.map((x) => x.feed.id), ['nubra#1', 'nubra#2']);
      // Distinct objects — a shared instance would mean a shared session.
      assert.notEqual(r[0].feed, r[1].feed);
      assert.equal(r[0].broker, 'nubra');
      assert.equal(r[1].instance, '2');
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('priority parses despite the # in the id', () => {
    process.env.QT_FEEDS = 'nubra#2:5,nubra#1:1';
    resetRegistry();
    try {
      // Sorted by priority, so the #1 account (priority 1) comes first.
      assert.deepEqual(feeds().map((x) => x.feed.id), ['nubra#1', 'nubra#2']);
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('an unknown broker is a startup error, not a silent skip', () => {
    // Deliberately a name no adapter will ever have. This used to say `zerodha`,
    // which stopped being unknown the moment that adapter shipped — an assertion
    // that quietly inverts as the codebase grows is worse than no assertion.
    process.env.QT_FEEDS = 'nubra:1,notabroker:2';
    resetRegistry();
    try {
      assert.throws(() => feeds(), /no adapter: notabroker/);
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('every shipped adapter is registrable', () => {
    process.env.QT_FEEDS = 'nubra:1,angel:2,zerodha:3,kotak:4';
    resetRegistry();
    try {
      assert.deepEqual(feeds().map((r) => r.feed.id), ['nubra', 'angel', 'zerodha', 'kotak']);
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('broker aliases resolve to their adapter', () => {
    // The UI's broker cards and the Supabase rows both say `angelone`.
    process.env.QT_FEEDS = 'angelone:1';
    resetRegistry();
    try {
      assert.equal(feeds()[0].feed.id, 'angel');
      assert.equal(feedById('angelone')?.id, 'angel');
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('a duplicated feed id is rejected', () => {
    process.env.QT_FEEDS = 'nubra:1,nubra:2';
    resetRegistry();
    try {
      assert.throws(() => feeds(), /more than once/);
    } finally {
      delete process.env.QT_FEEDS;
      resetRegistry();
    }
  });

  await check('a second instance names its own credential vars', async () => {
    const second = nubraFeed.withInstance('2');
    assert.equal(second.id, 'nubra#2');
    await assert.rejects(
      () => second.connect(),
      (e: FeedError) => e.code === 'AUTH' && /NUBRA_2_PHONE/.test(e.message),
    );
  });

  section('adapter · real cached refdata');

  await check('not connected surfaces AUTH, not a crash', async () => {
    await assert.rejects(
      () => nubraFeed.expiries('NIFTY', 'NSE', DATE),
      (e: FeedError) => e.code === 'AUTH',
    );
  });

  setSession({
    sessionToken: 'offline-verify',
    deviceId:     'offline-verify',
    phone:        '0000000000',
    loginAt:      new Date().toISOString(),
  });

  await check('isConnected() reflects the session', () => {
    assert.equal(nubraFeed.isConnected(), true);
  });

  await check('a suffixed instance does NOT inherit the default session', () => {
    // This is the property that makes two accounts safe: if `nubra#2` read the
    // shared store it would silently trade on account 1's session.
    assert.equal(nubraFeed.withInstance('2').isConnected(), false);
  });

  let expiries: string[] = [];
  await check('expiries() returns ISO dates, ascending', async () => {
    expiries = await nubraFeed.expiries('NIFTY', 'NSE', DATE);
    assert.ok(expiries.length > 0, `no NIFTY expiries cached for ${DATE}`);
    for (const e of expiries) assert.match(e, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(expiries, [...expiries].sort());
    console.log(`         ${expiries.length} expiries, first ${expiries[0]}`);
  });

  let chain: Awaited<ReturnType<typeof nubraFeed.chain>> = [];
  await check('chain() returns canonical keys with rupee strikes', async () => {
    chain = await nubraFeed.chain('NIFTY', 'NSE', DATE, expiries[0]);
    assert.ok(chain.length > 0, 'empty chain');
    for (const c of chain) {
      assert.equal(c.key.kind,   'OPT');
      assert.equal(c.key.asset,  'NIFTY');
      assert.equal(c.key.expiry, expiries[0]);
      assert.ok(c.key.side === 'CE' || c.key.side === 'PE');
      // Paise would put a NIFTY strike in the millions.
      assert.ok(c.key.strike! > 100 && c.key.strike! < 200_000,
        `strike ${c.key.strike} does not look like rupees`);
    }
    const ce = chain.filter((c) => c.key.side === 'CE').length;
    console.log(`         ${chain.length} contracts (${ce} CE / ${chain.length - ce} PE)`);
  });

  await check('chain keys are unique — no contract collisions', () => {
    const seen = new Set(chain.map((c) => keyOf(c.key)));
    assert.equal(seen.size, chain.length, `${chain.length - seen.size} duplicate keys`);
  });

  await check('Instrument leaks no broker symbol field', () => {
    assert.equal('symbol' in chain[0], false);
    assert.ok(chain[0].label.length > 0);
  });

  await check('key → nubra symbol → key round-trips for the whole chain', async () => {
    const idx = await (nubraFeed as unknown as {
      index(e: string, d: string): Promise<{
        toNative: Map<string, string>; toKey: Map<string, string>;
      }>;
    }).index('NSE', DATE);

    for (const c of chain) {
      const ks     = keyOf(c.key);
      const native = idx.toNative.get(ks);
      assert.ok(native, `no nubra symbol for ${ks}`);
      assert.equal(idx.toKey.get(native.toUpperCase()), ks,
        `${native} did not map back to ${ks}`);
    }
    console.log(`         ${chain.length} contracts round-tripped`);
  });

  await check('MCX commodity chain resolves', async () => {
    const ex = await nubraFeed.expiries('CRUDEOIL', 'MCX', DATE);
    assert.ok(ex.length > 0, 'no MCX expiries');
    const c = await nubraFeed.chain('CRUDEOIL', 'MCX', DATE, ex[0]);
    assert.ok(c.length > 0, 'empty MCX chain');
    assert.equal(c[0].kind, 'COMMODITY');
    console.log(`         CRUDEOIL ${c.length} contracts, kind=${c[0].kind}`);
  });

  await check('spotCandidates() gives MCX a future chain, not the bare asset', async () => {
    const ex   = await nubraFeed.expiries('CRUDEOIL', 'MCX', DATE);
    const cand = await nubraFeed.spotCandidates('CRUDEOIL', 'MCX', DATE, ex[0]);
    assert.ok(cand.length > 1, 'expected a fallback chain, got one candidate');
    assert.equal(cand[0].type, 'FUT');
    console.log(`         ${cand.length} candidates, first ${cand[0].symbol}`);
  });

  await check('optionSeries() with unknown contracts reports NOT_FOUND', async () => {
    await assert.rejects(
      () => nubraFeed.optionSeries({
        keys:     [optionKey('NSE', 'NOTAREALASSET', '2026-08-11', 100, 'CE')],
        interval: '1m',
        from:     Date.parse(`${DATE}T03:45:00Z`),
        to:       Date.parse(`${DATE}T10:00:00Z`),
      }),
      (e: FeedError) => e.code === 'NOT_FOUND',
    );
  });

  await check('empty key list short-circuits without a request', async () => {
    const r = await nubraFeed.optionSeries({ keys: [], interval: '1m', from: 0, to: 1 });
    assert.equal(r.series.size, 0);
  });

  section('engine · driven by a feed with no broker');

  // The point of this whole section: computeRollingStraddle now runs with no
  // Nubra session, no network and no refdata on disk. If anything
  // broker-shaped were still reachable from the engine, none of this could run.
  const mock = new MockFeed();
  await mock.connect();

  const run = await computeRollingStraddle({
    symbol:   mock.asset,
    exchange: mock.exchange,
    date:     mock.date,
    feed:     mock,
  });

  await check('engine produces a result from synthetic data alone', () => {
    assert.equal(run.status, true, (run as { message?: string }).message ?? '');
  });

  if (run.status) {
    await check('one point per spot bar', () => {
      assert.equal(run.points.length, 6);
    });

    await check('step inferred from the strike ladder', () => {
      assert.equal(run.step, 100);
      assert.equal(run.band, 2);
    });

    await check('picks the cheapest straddle inside ATM±2', () => {
      // Premium falls with strike, so the cheapest candidate is the top of the
      // window: ATM 24500 → 24700, ATM 24600 → 24800.
      assert.deepEqual(run.points.map((p) => p.atmStrike),
        [24700, 24700, 24700, 24800, 24800, 24800]);
    });

    await check('straddle price matches the mock premium exactly', () => {
      assert.equal(run.points[0].straddlePrice, mock.expectedMid(24700));
      assert.equal(run.points[5].straddlePrice, mock.expectedMid(24800));
    });

    await check('the window sliding is reported as exactly one roll', () => {
      assert.equal(run.rollEvents.length, 1);
      assert.equal(run.rollEvents[0].fromStrike, 24700);
      assert.equal(run.rollEvents[0].toStrike,   24800);
      assert.equal(run.points.filter((p) => p.isRollEvent).length, 1);
      assert.equal(run.points[3].isRollEvent, true);
    });

    await check('synthetic future = strike + call − put', () => {
      // 24700 + 430 − 500
      assert.equal(run.points[0].syntheticFuture, 24630);
      assert.equal(run.entryPrice,    24630);
      assert.equal(run.entryStraddle, mock.expectedMid(24700));
    });

    await check('IV is carried through as a percentage', () => {
      assert.equal(run.points[0].iv, 13);
    });

    await check('spot is the underlying candle close, untouched', () => {
      assert.deepEqual(run.points.map((p) => p.spot),
        [24500, 24500, 24500, 24600, 24600, 24600]);
    });
  }

  await check('one option fetch for the whole session, not one per bar', () => {
    assert.equal(mock.calls.optionSeries, 1);
    assert.equal(mock.calls.candles, 1);
  });

  await check('a provider outage is a fault, not "no data for this symbol"', async () => {
    // The exact shape of the 2026-08-09 Nubra incident: refdata answered 200
    // while charts/timeseries returned 500 "failed to get market schedule".
    // The spot fetch has a fallback chain, so it is tempting to treat "every
    // candidate failed" as "no spot data" — but that reports a broker outage as
    // a missing symbol, which sends you looking in the wrong place entirely.
    const outage = new MockFeed({ id: 'outage' });
    await outage.connect();
    outage.failOn('candles', 'TRANSIENT', '500: failed to get market schedule');

    await assert.rejects(
      () => computeRollingStraddle({
        symbol: outage.asset, exchange: outage.exchange, date: outage.date, feed: outage,
      }),
      (e: FeedError) => e.code === 'TRANSIENT' && /market schedule/.test(e.message),
    );
  });

  await check('a genuinely empty series is still "no spot data", not a fault', async () => {
    const empty = new MockFeed({ id: 'empty', spotPath: [] });
    await empty.connect();
    const out = await computeRollingStraddle({
      symbol: empty.asset, exchange: empty.exchange, date: empty.date, feed: empty,
    });
    assert.equal(out.status, false);
    assert.match((out as { message: string }).message, /No spot data/);
  });

  await check('a feed that cannot serve the chain fails cleanly', async () => {
    const broken = new MockFeed({ id: 'broken' });
    await broken.connect();
    broken.fail('TRANSIENT', 'upstream gone');
    await assert.rejects(
      () => computeRollingStraddle({
        symbol: broken.asset, exchange: broken.exchange, date: broken.date, feed: broken,
      }),
      (e: FeedError) => e.code === 'TRANSIENT',
    );
  });

  section('auth · single-flight');

  await check('20 concurrent callers produce exactly ONE login', async () => {
    resetAuth();
    const slow = new MockFeed({ id: 'slow' });
    const original = slow.connect.bind(slow);
    slow.connect = async () => {
      await new Promise((r) => setTimeout(r, 25));
      return original();
    };

    await Promise.all(Array.from({ length: 20 }, () => ensureConnected(slow)));
    assert.equal(slow.calls.connect, 1,
      `expected 1 login, got ${slow.calls.connect} — the burst was not deduplicated`);
  });

  await check('a failed login backs off instead of retrying every call', async () => {
    resetAuth();
    const bad = new MockFeed({ id: 'bad' });
    bad.fail('AUTH', 'wrong TOTP secret');

    await assert.rejects(() => ensureConnected(bad), (e: FeedError) => e.code === 'AUTH');
    const afterFirst = bad.calls.connect;

    // Inside the backoff window every further call must fail WITHOUT touching
    // the broker — this is what stops one bad secret becoming a login storm.
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => ensureConnected(bad), (e: FeedError) => e.code === 'AUTH');
    }
    assert.equal(bad.calls.connect, afterFirst,
      `broker was called ${bad.calls.connect - afterFirst} extra times during backoff`);
    assert.match(authStatus('bad').lastError ?? '', /wrong TOTP secret/);
  });

  await check('a recovered feed connects on the next call', async () => {
    resetAuth();
    const flaky = new MockFeed({ id: 'flaky' });
    flaky.fail('AUTH', 'temporarily down');
    await assert.rejects(() => ensureConnected(flaky));

    resetAuth();          // stands in for the backoff window elapsing
    flaky.heal();
    await ensureConnected(flaky);
    assert.equal(flaky.isConnected(), true);
  });

  section('router · failover and hot-switch');

  // Two mock feeds standing in for "nubra" and "feed 2", registered through the
  // real registry so the router's own selection logic is what gets exercised.
  const feedA = new MockFeed({ id: 'mock-a', exchange: 'NSE' });
  const feedB = new MockFeed({ id: 'mock-b', exchange: 'NSE' });
  installTestFeeds([{ feed: feedA, priority: 1 }, { feed: feedB, priority: 2 }]);
  resetAuth();
  resetBreakers();

  const DAY  = feedA.date;
  const askA = () => router.expiries(feedA.asset, 'NSE', DAY);

  await check('router serves from the highest-priority feed', async () => {
    await askA();
    assert.equal(router.lastProvenance?.feed, 'mock-a');
    assert.equal(feedB.calls.expiries, 0, 'feed 2 was called while feed 1 was healthy');
  });

  await check('router logs a feed in on demand — no explicit connect needed', () => {
    assert.equal(feedA.calls.connect, 1);
    assert.equal(feedA.isConnected(), true);
  });

  await check('a TRANSIENT fault fails over to the next feed', async () => {
    feedA.fail('TRANSIENT', 'upstream gone');
    await askA();
    assert.equal(router.lastProvenance?.feed, 'mock-b');
  });

  await check('three faults trip the breaker and feed 1 stops being tried', async () => {
    const before = feedA.calls.expiries;
    await askA();
    await askA();                       // failures 2 and 3 → OPEN
    assert.equal(breakerState('mock-a'), 'OPEN');

    const during = feedA.calls.expiries;
    await askA();                       // must not reach feed 1 at all
    assert.equal(feedA.calls.expiries, during,
      'an OPEN feed was still being called');
    assert.ok(during > before);
    assert.equal(router.lastProvenance?.feed, 'mock-b');
  });

  await check('NOT_FOUND does NOT fail over — it is returned', async () => {
    resetBreakers();
    feedA.fail('NOT_FOUND', 'no such symbol');
    const callsB = feedB.calls.expiries;
    await assert.rejects(askA, (e: FeedError) => e.code === 'NOT_FOUND');
    assert.equal(feedB.calls.expiries, callsB,
      'a missing symbol was re-asked of the second feed');
  });

  await check('NOT_FOUND does not count against the breaker', () => {
    assert.equal(breakerState('mock-a'), 'CLOSED');
  });

  await check('recovery is automatic — next call goes back to feed 1', async () => {
    feedA.heal();
    await askA();
    assert.equal(router.lastProvenance?.feed, 'mock-a',
      'a recovered feed was not returned to rotation');
  });

  await check('health probe recovers a feed with no traffic at all', async () => {
    resetBreakers();
    feedA.fail('TRANSIENT', 'down');
    for (let i = 0; i < 3; i++) await askA();
    assert.equal(breakerState('mock-a'), 'OPEN');

    // Cooldown elapses, but nothing is requested — only the prober can notice.
    feedA.heal();
    resetBreakers();
    await probeNow();
    assert.equal(breakerState('mock-a'), 'CLOSED');
  });

  await check('a capability gap is skipped, not counted as a fault', async () => {
    resetBreakers();
    const mcxOnly = new MockFeed({ id: 'mcx-only', exchange: 'MCX' });
    installTestFeeds([{ feed: mcxOnly, priority: 1 }, { feed: feedB, priority: 2 }]);
    await router.expiries(feedB.asset, 'NSE', DAY);
    assert.equal(router.lastProvenance?.feed, 'mock-b');
    assert.equal(breakerState('mcx-only'), 'CLOSED',
      'a feed was penalised for not carrying an exchange');
    assert.equal(mcxOnly.calls.expiries, 0);
  });

  await check('a coarser feed degrades rather than refusing', async () => {
    resetBreakers();
    const minuteOnly = new MockFeed({
      id: 'minute-only', exchange: 'NSE', capabilities: { intervals: ['1m'] },
    });
    installTestFeeds([{ feed: minuteOnly, priority: 1 }]);

    const r = await router.optionSeries({
      keys:     [minuteOnly.keysFor(24500).ce],
      interval: '1s',
      from:     Date.parse(`${DAY}T03:45:00Z`),
      to:       Date.parse(`${DAY}T10:00:00Z`),
    });
    assert.equal(r.interval, '1m');
    assert.equal(router.lastProvenance?.degraded?.interval, '1m');
  });

  await check('when no feed can serve, the error names every reason', async () => {
    resetBreakers();
    installTestFeeds([{ feed: new MockFeed({ id: 'only-mcx', exchange: 'MCX' }), priority: 1 }]);
    await assert.rejects(
      () => router.expiries('NIFTY', 'NSE', DAY),
      (e: FeedError) => e.code === 'UNSUPPORTED' && /does not carry NSE/.test(e.message),
    );
  });

  await check('the engine runs through the router, unaware of any of it', async () => {
    resetBreakers();
    resetAuth();
    const primary = new MockFeed({ id: 'primary', exchange: 'NSE' });
    const backup  = new MockFeed({ id: 'backup',  exchange: 'NSE' });
    installTestFeeds([{ feed: primary, priority: 1 }, { feed: backup, priority: 2 }]);
    primary.fail('TRANSIENT', 'dead');

    const out = await computeRollingStraddle({
      symbol: backup.asset, exchange: 'NSE', date: backup.date, feed: router,
    });
    assert.equal(out.status, true, (out as { message?: string }).message ?? '');
    if (out.status) assert.equal(out.points.length, 6);
    assert.equal(router.lastProvenance?.feed, 'backup');
  });

  await check('provenance is per-request, not a shared global', async () => {
    resetBreakers();
    resetAuth();
    const good = new MockFeed({ id: 'prov-good', exchange: 'NSE' });
    const dead = new MockFeed({ id: 'prov-dead', exchange: 'MCX' });
    dead.fail('TRANSIENT', 'down');
    installTestFeeds([{ feed: dead, priority: 1 }, { feed: good, priority: 2 }]);

    // Two overlapping requests: one hits MCX (fails over), one hits NSE (does
    // not). A process-wide "last feed" would let them contaminate each other.
    const [nse, mcx] = await Promise.all([
      withProvenance(() => router.expiries(good.asset, 'NSE', DAY)),
      withProvenance(() => router.expiries(dead.asset, 'MCX', DAY).catch(() => [])),
    ]);

    assert.deepEqual(nse.provenance.feeds, ['prov-good']);
    assert.equal(nse.provenance.mixed, false);
    assert.deepEqual(mcx.provenance.feeds, [],
      'a failed MCX request borrowed the NSE request\'s provenance');
  });

  await check('a failover inside one request is reported as mixed', async () => {
    resetBreakers();
    resetAuth();
    const p = new MockFeed({ id: 'mix-a', exchange: 'NSE' });
    const b = new MockFeed({ id: 'mix-b', exchange: 'NSE' });
    installTestFeeds([{ feed: p, priority: 1 }, { feed: b, priority: 2 }]);

    const { provenance: prov } = await withProvenance(async () => {
      await router.expiries(p.asset, 'NSE', DAY);   // served by mix-a
      p.fail('TRANSIENT', 'died mid-request');
      await router.chain(p.asset, 'NSE', DAY);      // falls over to mix-b
    });

    assert.deepEqual(prov.feeds, ['mix-a', 'mix-b']);
    assert.equal(prov.mixed, true);
  });

  restoreFeeds();

  console.log(
    `\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nverify crashed:', e);
  process.exit(1);
});
