/**
 * Checks that an EXPIRED broker session recovers by itself.
 *
 *   npm --prefix backend run verify:session
 *
 * The failure this guards against is not a crash — it is a feed that reports
 * itself signed in while every request behind it fails. Angel is the reason it
 * exists: its session object outlives its token, so `isConnected()` keeps
 * answering true long after the broker has stopped honouring the JWT. The old
 * code then had no way back, because:
 *
 *   • `ensureConnected()` returns early when `isConnected()` is true,
 *   • `connect()` returns early when a session object is present, and
 *   • `withAuth()` — the one function that drops a dead session and logs in
 *     again — was never called from anywhere.
 *
 * On screen that reads as an account that is signed in and "logging away": the
 * status says connected, the data never arrives, and only a restart fixes it.
 *
 * The stub below mimics Angel's semantics exactly rather than using MockFeed,
 * whose `isConnected()` is honest about its own state and so cannot express the
 * bug at all.
 */

// Set BEFORE the imports below are evaluated: breaker.ts reads its cooldown at
// module scope, and the health prober only probes a feed whose cooldown has
// elapsed. The 30s default would skip the very path this file checks.
process.env.QT_FEED_BREAKER_COOLDOWN_MS = '10';

import assert from 'node:assert/strict';

// Dynamic, so the env var above is in place before breaker.ts is evaluated.
// Static imports are hoisted and would run first.
const { FeedError }                     = await import('../feeds/errors.js');
const { router }                        = await import('../feeds/router.js');
const { installTestFeeds, restoreFeeds } = await import('../feeds/registry.js');
const { resetAuth }                     = await import('../feeds/authManager.js');
const { resetAll: resetBreakers, recordFailure, stateOf } = await import('../feeds/breaker.js');
const { probeNow }                      = await import('../feeds/health.js');

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

/** Let an OPEN breaker age into HALF_OPEN. */
const elapse = () => new Promise((r) => setTimeout(r, 40));

/** A feed whose session object survives its token, exactly as Angel's does. */
class ExpiringFeed {
  readonly id = 'expiring';
  readonly capabilities = {
    exchanges: ['NSE'], intervals: ['1m'], historyDays: 3650,
    optionChain: true, greeks: false, live: false, maxSymbolsPerRequest: 10,
  };

  /** Non-null whenever "logged in", whether or not the token still works. */
  private session: { alive: boolean } | null = null;
  logins = 0;

  async connect(): Promise<void> {
    if (this.session) return;          // the early return that made this stick
    this.logins += 1;
    this.session = { alive: true };
  }

  async disconnect(): Promise<void> { this.session = null; }

  /** Angel's semantics: object presence, NOT token validity. */
  isConnected(): boolean { return this.session !== null; }

  /** The broker expires the token; our side has no idea yet. */
  expire(): void { if (this.session) this.session.alive = false; }

  private guard(): void {
    if (!this.session)       throw new FeedError('AUTH', 'not connected', { feedId: this.id });
    if (!this.session.alive) throw new FeedError('AUTH', 'Token Expired [AG8002]', { feedId: this.id });
  }

  async ping():         Promise<void>     { this.guard(); }
  async expiries():     Promise<string[]> { this.guard(); return ['2026-08-27']; }
  async assets()       { this.guard(); return []; }
  async chain()        { this.guard(); return []; }
  async underlyings()  { this.guard(); return []; }
  async candles()      { this.guard(); return { candles: [], interval: '1m' }; }
  async optionSeries() { this.guard(); return { series: new Map(), interval: '1m' }; }
}

async function main(): Promise<void> {
  console.log('\n── expired session · request path ──');
  {
    const feed = new ExpiringFeed();
    installTestFeeds([{ feed: feed as never, priority: 1 }]);
    resetAuth();
    resetBreakers();

    await check('serves normally while the token is good', async () => {
      assert.deepEqual(await router.expiries('NIFTY', 'NSE', '2026-08-13'), ['2026-08-27']);
      assert.equal(feed.logins, 1);
    });

    await check('a dead token still reports isConnected() — the trap', () => {
      feed.expire();
      assert.equal(feed.isConnected(), true,
        'the stub must mimic Angel: connected-looking but unusable');
    });

    await check('an expired session re-logs-in and still serves the request', async () => {
      assert.deepEqual(await router.expiries('NIFTY', 'NSE', '2026-08-13'), ['2026-08-27'],
        'the request should have succeeded after a silent re-login');
      assert.equal(feed.logins, 2,
        `expected a second login, saw ${feed.logins} — the dead session was reused`);
    });

    await check('recovering does not trip the breaker', () => {
      assert.equal(stateOf(feed.id), 'CLOSED');
    });

    await check('a healthy session is NOT re-logged-in on every call', async () => {
      await router.expiries('NIFTY', 'NSE', '2026-08-13');
      assert.equal(feed.logins, 2, 'the feed logged in again while already valid');
    });
  }

  console.log('\n── expired session · health prober ──');
  {
    const feed = new ExpiringFeed();
    installTestFeeds([{ feed: feed as never, priority: 1 }]);
    resetAuth();
    resetBreakers();

    await feed.connect();
    feed.expire();
    for (let i = 0; i < 3; i++) recordFailure(feed.id, 'Token Expired [AG8002]');

    await check('breaker is OPEN while the session is dead', () => {
      assert.equal(stateOf(feed.id), 'OPEN');
    });

    await check('a probe drops the dead session instead of failing forever', async () => {
      await elapse();                  // OPEN → HALF_OPEN, so the probe is allowed
      await probeNow();
      assert.equal(feed.isConnected(), false,
        'the prober left the dead session in place — it could never recover');
    });

    await check('the next probe logs in and closes the breaker', async () => {
      await elapse();
      await probeNow();
      assert.equal(feed.logins, 2, `expected a re-login, saw ${feed.logins}`);
      assert.equal(stateOf(feed.id), 'CLOSED', 'breaker never closed');
    });
  }

  restoreFeeds();
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nverify crashed:', e);
  process.exit(1);
});
