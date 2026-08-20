/**
 * Smoke test for `marketd`, the Go market engine.
 *
 * ── What this can and cannot check ──
 *
 * It cannot check the numbers. Verifying that the Go straddle rule agrees with
 * the TypeScript one needs a live chain, a broker token and an open market —
 * and a script that quietly passes because the market was shut would be worse
 * than no script. That comparison belongs in `backend-go`'s own tests, where
 * the engine is driven off a scripted feed with no broker at all
 * (`straddle/engine_test.go`), and those run on `npm run go:test`.
 *
 * What it DOES check is everything that goes wrong in deployment rather than in
 * the maths:
 *
 *   1. the engine is up, and says which build it is
 *   2. it still serves the batch compute endpoints, so one process can replace
 *      `computed` without a second URL
 *   3. its market clock agrees with the TypeScript one — a disagreement here
 *      means live and history would use different session bounds
 *   4. the WebSocket accepts a subscribe and REFUSES a malformed one, rather
 *      than accepting it and going silent
 *   5. the fallback engages when the engine is not reachable
 *
 * Run: npm run verify:engine
 */

import { WebSocket } from 'ws';
import { isMarketOpen, msUntilClose } from '../engine/liveStraddle.js';

const PORT = process.env.QT_MARKETD_PORT || '3152';
const HTTP = (process.env.QT_MARKETD_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const WS = HTTP.replace(/^http/, 'ws');

let failures = 0;

function pass(what: string, detail = ''): void {
  console.log(`  ✓ ${what}${detail ? ` — ${detail}` : ''}`);
}

function fail(what: string, why: string): void {
  failures++;
  console.error(`  ✗ ${what} — ${why}`);
}

async function getJson(path: string, timeoutMs = 3_000): Promise<any> {
  const res = await fetch(`${HTTP}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ── 1. Health ────────────────────────────────────────────────────────────────

async function checkHealth(): Promise<boolean> {
  try {
    const info = await getJson('/health');
    if (info.service !== 'quantstack-marketd') {
      fail('health', `service is "${info.service}", not quantstack-marketd — is this the compute sidecar on the same port?`);
      return false;
    }
    pass('engine is up', `v${info.version} on ${info.go}, ${info.cores} cores, ${info.sessions?.length ?? 0} sessions`);
    return true;
  } catch (e) {
    fail('engine is up', `${HTTP} unreachable (${(e as Error).message}). Start it with: npm run go:marketd`);
    return false;
  }
}

// ── 2. The batch endpoints still answer ──────────────────────────────────────

async function checkCompute(): Promise<void> {
  try {
    const res = await fetch(`${HTTP}/v1/straddle/vol`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // One bar, a month out, deliberately deep in time value so a solution
      // exists and a returned null would mean the solver is broken rather than
      // the quote being unsolvable.
      body: JSON.stringify({
        expiry: compactMonthAhead(),
        greeks: true,
        bars: [{ t: Date.now(), s: 600, f: 24500, k: 24500, g: true }],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) { fail('compute endpoints', `/v1/straddle/vol → ${res.status}`); return; }
    const out = await res.json() as { iv: Array<number | null>; vega?: Array<number | null> };
    if (!Array.isArray(out.iv) || out.iv.length !== 1) {
      fail('compute endpoints', 'response was not one column of one value');
      return;
    }
    if (out.iv[0] == null) {
      fail('compute endpoints', 'no implied vol solved for a straddle that has one');
      return;
    }
    const vega = out.vega?.[0];
    if (vega == null || vega <= 0) {
      fail('compute endpoints', `vega = ${vega}, want positive for a long straddle`);
      return;
    }
    pass('compute endpoints served by the same process', `iv ${out.iv[0].toFixed(2)}, vega ${vega.toFixed(2)}`);
  } catch (e) {
    fail('compute endpoints', (e as Error).message);
  }
}

function compactMonthAhead(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// ── 3. The two market clocks agree ───────────────────────────────────────────

async function checkMarketClock(): Promise<void> {
  for (const exchange of ['NSE', 'MCX']) {
    try {
      const out = await getJson(`/v1/market/state?exchange=${exchange}`);
      const goOpen = Boolean(out.state?.open);
      const tsOpen = isMarketOpen(exchange);
      if (goOpen !== tsOpen) {
        fail(`${exchange} clock`, `Go says ${goOpen ? 'open' : 'closed'}, TypeScript says ${tsOpen ? 'open' : 'closed'} — live and history would use different session bounds`);
        continue;
      }
      // The close time is the one that actually clips the historical walk, so
      // it is worth checking directly rather than inferring from open/closed.
      const goUntilClose = Number(out.state?.endMs) - Number(out.state?.nowMs);
      const drift = Math.abs(goUntilClose - msUntilClose(exchange));
      if (drift > 2_000) {
        fail(`${exchange} clock`, `session close differs by ${Math.round(drift / 1000)}s`);
        continue;
      }
      pass(`${exchange} clock agrees`, `${out.state?.state}${out.forced ? ' (forced open)' : ''}`);
    } catch (e) {
      fail(`${exchange} clock`, (e as Error).message);
    }
  }
}

// ── 3b. Metrics ──────────────────────────────────────────────────────────────

/**
 * A scrape endpoint that returns 200 and nothing useful is the failure worth
 * catching: it is indistinguishable from a healthy one until an alert fails to
 * fire. So this checks that the series the dashboards are built on are actually
 * present, not merely that the endpoint answers.
 */
async function checkMetrics(): Promise<void> {
  try {
    const res = await fetch(`${HTTP}/metrics`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) { fail('metrics', `/metrics → ${res.status}`); return; }
    const body = await res.text();

    /**
     * Only series that exist on an IDLE process.
     *
     * A labelled metric family is absent from the exposition until one of its
     * children is written, and `qt_feed_frames_total` is labelled by feed —
     * which is not seeded, on purpose, because inventing a series for a broker
     * nobody enabled would be a lie. Requiring it here would make this check
     * fail on a healthy engine that simply has no session open, so the ones
     * listed are the unlabelled and the seeded.
     */
    const required = [
      'qt_engine_points_total',
      'qt_engine_compute_duration_seconds',
      'qt_engine_iv_source_total',
      'qt_solve_bars_total',
      'qt_hub_sessions',
      'qt_hub_subscribers',
      'qt_market_open',
      // The Go runtime collector. Its absence means the process metrics were
      // never registered, which is easy to break and impossible to notice.
      'go_goroutines',
    ];
    const missing = required.filter((m) => !body.includes(m));
    if (missing.length) {
      fail('metrics', `missing series: ${missing.join(', ')}`);
      return;
    }

    // Every metric must declare a type. A series exposed without one is parsed
    // as untyped, and `rate()` over an untyped counter silently returns
    // nonsense rather than an error.
    const names = new Set(
      [...body.matchAll(/^# TYPE (\S+) /gm)].map((m) => m[1]),
    );
    const untyped = required.filter((m) => !names.has(m) && !names.has(`${m}_bucket`));
    if (untyped.length) {
      fail('metrics', `series exposed without a TYPE: ${untyped.join(', ')}`);
      return;
    }

    const count = names.size;
    pass('metrics endpoint exposes the expected series', `${count} metric families`);
  } catch (e) {
    fail('metrics', (e as Error).message);
  }
}

// ── 4. The socket accepts and refuses the right things ───────────────────────

/** Open the live socket, send one frame, and collect what comes back. */
function probeSocket(frame: unknown, waitMs: number): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS}/ws/live/straddle`, { handshakeTimeout: 3_000 });
    const seen: any[] = [];
    const finish = () => { try { ws.close(); } catch { /* closing */ } resolve(seen); };
    const timer = setTimeout(finish, waitMs);

    ws.once('open', () => ws.send(JSON.stringify(frame)));
    ws.on('message', (raw: Buffer) => {
      try { seen.push(JSON.parse(raw.toString('utf8'))); } catch { /* not ours */ }
    });
    ws.once('error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

async function checkSocket(): Promise<void> {
  // A ping proves the socket is alive without opening a broker subscription —
  // which matters because this script is meant to be safe to run in the middle
  // of a trading session.
  try {
    const seen = await probeSocket({ type: 'ping' }, 1_500);
    if (!seen.some((m) => m.event === 'pong')) {
      fail('socket', 'no pong; the engine accepted the connection and went quiet');
    } else {
      pass('socket answers a ping');
    }
  } catch (e) {
    fail('socket', (e as Error).message);
  }

  // A subscribe with no contract table cannot be served, and the engine must
  // SAY so. Accepting it and going silent is the failure mode that looks
  // identical to a broken feed from the client's side.
  try {
    const seen = await probeSocket(
      { type: 'subscribe', symbol: 'NIFTY', exchange: 'NSE', expiry: '20991231', contracts: [] },
      1_500,
    );
    const err = seen.find((m) => m.event === 'error');
    if (!err) {
      fail('socket rejects an unservable subscribe', 'no error frame came back');
    } else {
      pass('socket rejects an unservable subscribe', String(err.message).slice(0, 70));
    }
  } catch (e) {
    fail('socket rejects an unservable subscribe', (e as Error).message);
  }

  // An unknown verb must be answered, not ignored: a client that mistypes gets
  // told, rather than waiting forever for data it will never receive.
  try {
    const seen = await probeSocket({ type: 'nonsense' }, 1_000);
    if (!seen.some((m) => m.event === 'error')) {
      fail('socket answers an unknown verb', 'silence');
    } else {
      pass('socket answers an unknown verb');
    }
  } catch (e) {
    fail('socket answers an unknown verb', (e as Error).message);
  }
}

// ── 5. The fallback engages ──────────────────────────────────────────────────

/**
 * Point the client at a port nothing is listening on and confirm it declines
 * rather than throwing.
 *
 * This is the property the whole design rests on: the Go engine is an
 * optimisation, and a backend that 500s because a helper process is not running
 * would be a worse product than the one we started with.
 */
async function checkFallback(): Promise<void> {
  const saved = { url: process.env.QT_MARKETD_URL, on: process.env.QT_GO_ENGINE };
  process.env.QT_GO_ENGINE = '1';
  // Port 1 is reserved and never listening.
  process.env.QT_MARKETD_URL = 'http://127.0.0.1:1';
  try {
    // Imported fresh so it reads the overridden env, and with a cache-buster so
    // a previous import in this process does not satisfy it.
    const mod = await import(`../lib/engineClient.js?probe=${Date.now()}`);
    const ready = await mod.goEngineReady();
    if (ready) {
      fail('fallback', 'client reported an unreachable engine as ready');
      return;
    }
    const status = mod.goEngineStatus();
    if (!(status.cooldownMs > 0)) {
      fail('fallback', 'a failed probe did not start a cooldown; every subscribe would retry the dead engine');
      return;
    }
    pass('fallback engages when the engine is down', `cooldown ${Math.round(status.cooldownMs / 1000)}s`);
  } catch (e) {
    fail('fallback', `client threw instead of declining: ${(e as Error).message}`);
  } finally {
    if (saved.url == null) delete process.env.QT_MARKETD_URL; else process.env.QT_MARKETD_URL = saved.url;
    if (saved.on == null) delete process.env.QT_GO_ENGINE; else process.env.QT_GO_ENGINE = saved.on;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nmarketd verification — ${HTTP}\n`);

  const up = await checkHealth();
  if (up) {
    await checkCompute();
    await checkMarketClock();
    await checkMetrics();
    await checkSocket();
  } else {
    console.log('  · skipping the endpoint checks — nothing is listening');
  }
  await checkFallback();

  console.log('');
  if (failures) {
    console.error(`${failures} check${failures === 1 ? '' : 's'} failed\n`);
    process.exit(1);
  }
  console.log('All checks passed\n');
}

void main();
