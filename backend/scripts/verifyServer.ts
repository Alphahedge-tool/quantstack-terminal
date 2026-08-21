/**
 * Server-layer checks — the Fastify migration's safety net.
 *
 * These assert the CONTRACT that server.ts offers its route modules, not any
 * particular route's behaviour. Everything here passed on the hand-rolled
 * node:http dispatcher too; that is the point. If a future change to the
 * framework layer breaks one of these, it broke something fifty-three
 * registrations across twelve files depend on.
 *
 * No broker session and no network: routes are registered by this file, the
 * server binds a loopback port, and the assertions are plain fetches. So it can
 * run in CI, and it runs in a second.
 *
 * The body check is the one that matters most. Fastify parses request bodies by
 * default, which consumes the stream `readJSON` reads from — a backend where
 * every POST silently sees `{}` typechecks perfectly and fails only in
 * production.
 */

import { route, readJSON, ApiError, startServer, getPort } from '../server.js';

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (ok) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

// ── Routes used only by this file ────────────────────────────────────────────

route('GET', '/__verify/json', () => ({ status: true, hello: 'world' }));

route('POST', '/__verify/echo', async (req) => {
  const body = await readJSON<{ value?: unknown }>(req);
  return { status: true, echoed: body.value ?? null, keys: Object.keys(body).length };
});

route('GET', '/__verify/boom', () => {
  throw new ApiError('deliberate failure', 418);
});

route('GET', '/__verify/big', () => ({
  status: true,
  // Comfortably over the 8 KB compression threshold, and repetitive enough that
  // gzip on it is unambiguous.
  rows: Array.from({ length: 2_000 }, (_, i) => ({ i, label: 'straddle-point-row' })),
}));

route('GET', '/__verify/stream', (_req, res) => {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection:      'keep-alive',
  });
  res.write('data: one\n\n');
  res.write('data: two\n\n');
  res.end();
  // Returns undefined having written the response itself — the SSE contract.
});

// ── Run ──────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.QT_VERIFY_PORT || 3187);

async function main(): Promise<void> {
  process.env.QT_BACKEND_PORT = String(PORT);
  const server = startServer(PORT, '127.0.0.1');

  // `startServer` returns before the bind completes, by design.
  await new Promise<void>((resolve, reject) => {
    if (server.listening) { resolve(); return; }
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const base = `http://127.0.0.1:${PORT}`;
  console.log(`\nverifying server contract on ${base}\n`);

  // 1. Plain JSON return value becomes the body.
  {
    const r = await fetch(`${base}/__verify/json`);
    const j = await r.json() as { hello?: string };
    check('GET returns JSON from the handler value', r.status === 200 && j.hello === 'world',
      `status=${r.status} body=${JSON.stringify(j)}`);
    check('JSON content-type is set',
      (r.headers.get('content-type') || '').includes('application/json'));
  }

  // 2. THE ONE THAT FAILS SILENTLY: a POST body must reach readJSON intact.
  {
    const r = await fetch(`${base}/__verify/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'round-trip' }),
    });
    const j = await r.json() as { echoed?: unknown; keys?: number };
    check('POST body reaches readJSON', j.echoed === 'round-trip',
      `got ${JSON.stringify(j)} — Fastify probably consumed the stream`);
    check('POST body is fully parsed', j.keys === 1, `keys=${j.keys}`);
  }

  // 3. An empty POST body is {} rather than a crash.
  {
    const r = await fetch(`${base}/__verify/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    const j = await r.json() as { echoed?: unknown };
    check('empty POST body yields {}', r.status === 200 && j.echoed === null,
      `status=${r.status} body=${JSON.stringify(j)}`);
  }

  // 4. Malformed JSON is a 400 from readJSON, not a 500 from the framework.
  {
    const r = await fetch(`${base}/__verify/echo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const j = await r.json() as { message?: string };
    check('malformed JSON body is 400', r.status === 400, `status=${r.status}`);
    check('malformed JSON keeps its message', (j.message || '').includes('Invalid JSON'),
      `message=${j.message}`);
  }

  // 5. ApiError maps to its status and message.
  {
    const r = await fetch(`${base}/__verify/boom`);
    const j = await r.json() as { status?: boolean; message?: string };
    check('ApiError status is honoured', r.status === 418, `status=${r.status}`);
    check('ApiError body shape is { status:false, message }',
      j.status === false && j.message === 'deliberate failure', JSON.stringify(j));
  }

  // 6. 404 shape.
  {
    const r = await fetch(`${base}/__verify/nope`);
    const j = await r.json() as { status?: boolean; message?: string };
    check('unknown route is 404 JSON', r.status === 404 && j.status === false,
      `status=${r.status} body=${JSON.stringify(j)}`);
  }

  // 7. Compression above the threshold, and only when asked for.
  {
    const on = await fetch(`${base}/__verify/big`, { headers: { 'accept-encoding': 'gzip' } });
    check('large response is gzipped when accepted',
      (on.headers.get('content-encoding') || '') === 'gzip',
      `content-encoding=${on.headers.get('content-encoding')}`);
    const body = await on.json() as { rows?: unknown[] };
    check('gzipped response still decodes to the same JSON', (body.rows?.length ?? 0) === 2_000);

    const off = await fetch(`${base}/__verify/json`, { headers: { 'accept-encoding': 'gzip' } });
    check('small response is not gzipped',
      !(off.headers.get('content-encoding') || '').includes('gzip'),
      `content-encoding=${off.headers.get('content-encoding')}`);
  }

  // 8. A handler that writes the response itself is left alone.
  {
    const r = await fetch(`${base}/__verify/stream`);
    const text = await r.text();
    check('SSE handler keeps its own content-type',
      (r.headers.get('content-type') || '').includes('text/event-stream'),
      `content-type=${r.headers.get('content-type')}`);
    check('SSE body is the handler\'s writes, untouched',
      text === 'data: one\n\ndata: two\n\n', JSON.stringify(text));
  }

  // 9. CORS preflight still answers.
  {
    const r = await fetch(`${base}/__verify/json`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5273',
        'access-control-request-method': 'GET',
      },
    });
    check('CORS preflight is answered', r.status === 204 || r.status === 200, `status=${r.status}`);
    check('CORS allows the requesting origin',
      (r.headers.get('access-control-allow-origin') || '') !== '',
      `allow-origin=${r.headers.get('access-control-allow-origin')}`);
  }

  // 10. Health and metrics, the two built-ins.
  {
    const h = await fetch(`${base}/api/health`);
    const j = await h.json() as { service?: string; port?: number };
    check('/api/health responds', h.status === 200 && j.service === 'qt-backend');
    check('/api/health reports the bound port', j.port === getPort(), `port=${j.port}`);

    const m = await fetch(`${base}/metrics`);
    const text = await m.text();
    check('/metrics serves the Prometheus text format',
      m.status === 200 && (m.headers.get('content-type') || '').includes('text/plain'),
      `status=${m.status} type=${m.headers.get('content-type')}`);
    check('/metrics counted the requests above', text.includes('http_requests_total'),
      'counter missing from exposition');
  }

  console.log(`\n${checks - failures} passed, ${failures} failed\n`);

  /*
   * Close and let the loop drain, rather than `process.exit()`.
   *
   * Calling exit straight after `server.close()` tears the process down while
   * libuv is still closing the pino transport's handle, and Windows aborts with
   *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
   * printed AFTER a clean pass — a green run that looks like a crash, which in
   * CI is indistinguishable from one. Setting the code and letting the last
   * handle close on its own exits quietly with the same status.
   */
  process.exitCode = failures ? 1 : 0;
  server.close();
}

main().catch((err) => {
  console.error('verify:server crashed:', err);
  process.exit(1);
});
