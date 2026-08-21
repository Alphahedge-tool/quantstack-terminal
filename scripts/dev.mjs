/**
 * One command, both halves of the stack.
 *
 * `npm run dev` used to start Vite alone, which then proxied `/api` and `/ws`
 * to a port with nothing behind it — and the only symptom was an
 * `AggregateError [ECONNREFUSED]` from the proxy, which says nothing about the
 * backend being the thing that is missing. Starting them together removes the
 * failure mode rather than documenting it.
 *
 * ── Why no `concurrently` ──
 *
 * It is the obvious dependency and it would work. It is not worth it here: the
 * whole job is two spawns and a teardown, and this file is shorter than the
 * lockfile churn. It also keeps the repo installable behind a proxy that has
 * never heard of npm.
 *
 * ── Why the binaries are spawned directly, not through npm ──
 *
 * On Windows `npm run dev` in the backend would be cmd.exe → npm.cmd → node →
 * tsx. Ctrl+C reaches the top of that chain and nothing below it: npm.cmd does
 * not forward the signal, so the watcher survives and keeps port 3101 held,
 * and the NEXT start fails to bind. Resolving each package's own entry point
 * and running it under `process.execPath` makes each child a plain node process
 * this script owns directly.
 *
 * Teardown is still tree-based on Windows — `tsx watch` spawns the actual
 * server as a grandchild, and killing the parent orphans it. See `stop()`.
 *
 * ── The third process ──
 *
 * `--go` adds the Go compute sidecar and points the backend at it. It is a flag
 * rather than the default because the sidecar is an optimisation the backend is
 * built to run without — see `lib/computeClient.ts` — and because it needs a Go
 * toolchain that a frontend-only contributor has no reason to have installed.
 *
 * It is also the one child whose death is NOT fatal to the run. If it exits,
 * the backend simply computes locally, which is what it does by default; taking
 * the whole stack down over a helper process would turn an optional speed-up
 * into a hard dependency.
 *
 * ── The preflight ──
 *
 * Every port is checked and cleared BEFORE anything is spawned. On Windows a
 * previous run routinely leaves a listener behind — `tsx watch` runs the server
 * as a grandchild and a closed terminal takes only the parent — and the symptom
 * is an EADDRINUSE stack trace from a backend that then sits dead while Vite
 * and the sidecar carry on around it, because `tsx watch` itself never exits
 * and so this script never sees a child die. See `clearPort`.
 */

import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend = path.join(root, 'backend');
const goRoot = path.join(root, 'backend-go');
const require = createRequire(import.meta.url);

/*
 * Which sidecars to bring up.
 *
 * `--all` is the "run everything" switch: both Go services plus the stack.
 * The individual flags stay because the two sidecars fail independently and are
 * useful independently — `computed` is a pricing helper, `marketd` is a market
 * engine, and wanting one is not wanting the other.
 *
 * `--go` keeps its original meaning (the compute sidecar), so `npm run dev:go`
 * behaves exactly as it did.
 */
const withAll     = process.argv.includes('--all');
const withGo      = withAll || process.argv.includes('--go');
const withMarketd = withAll || process.argv.includes('--marketd');

/**
 * The sidecar's port, passed to BOTH children.
 *
 * The Go service binds it and the backend's client dials it, and this script is
 * the one place that knows they are the same number. Set it once in the
 * environment and the pair moves together.
 */
const goPort = process.env.QT_GO_COMPUTE_PORT || '3151';

/**
 * The market engine's port. Same contract as `goPort`: this script is the one
 * place that knows marketd's bind port and the backend's dial port are the same
 * number, so setting it here moves the pair together.
 */
const marketdPort = process.env.QT_MARKETD_PORT || '3152';

/** A package's executable entry, resolved from wherever it is installed. */
function binOf(pkg, from, fallback) {
  const manifest = require.resolve(`${pkg}/package.json`, { paths: [from] });
  const { bin } = require(manifest);
  const rel = typeof bin === 'string' ? bin : bin?.[pkg] ?? fallback;
  return path.join(path.dirname(manifest), rel);
}

const TAGS = {
  // Cyan, amber and magenta — matched to nothing in particular beyond being the
  // three easiest colours to tell apart at a glance in a scrolling log.
  api: '\x1b[36m',
  web: '\x1b[33m',
  go: '\x1b[35m',
  // Green, so the two Go services are never mistaken for each other in a
  // scrolling log — they fail in different ways and for different reasons.
  mkt: '\x1b[32m',
};
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const children = new Map();
let stopping = false;

/**
 * Prefix every line with its source.
 *
 * Interleaved output from two servers is unreadable without it — a stack trace
 * appears with no indication of which half threw. Buffered to a newline rather
 * than tagging each chunk, because a chunk boundary is not a line boundary and
 * tagging chunks puts `[api]` in the middle of sentences.
 */
function pipe(name, stream) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      process.stdout.write(`${TAGS[name]}[${name}]${RESET} ${line}\n`);
    }
  });
  // Whatever was still buffered when the pipe closed is real output that would
  // otherwise be silently dropped — often the most interesting line, since a
  // crash message frequently arrives without its trailing newline.
  stream.on('end', () => {
    if (buffer) process.stdout.write(`${TAGS[name]}[${name}]${RESET} ${buffer}\n`);
  });
}

/**
 * Spawn one tagged child.
 *
 * `optional` inverts what an exit means. The api and the web server are halves
 * of one stack and neither is useful alone, so either exiting takes everything
 * down. The sidecar is not: the backend runs without it by design, so its death
 * is a line of log and nothing more.
 */
function run(name, command, args, cwd, { env = {}, optional = false } = {}) {
  const child = spawn(command, args, {
    cwd,
    // Piped rather than inherited so output can be tagged. The cost is that
    // Vite's own colours would drop, so FORCE_COLOR keeps them.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1', ...env },
  });

  children.set(name, child);
  pipe(name, child.stdout);
  pipe(name, child.stderr);

  child.on('exit', (code, signal) => {
    children.delete(name);
    if (stopping) return;
    process.stdout.write(
      `${TAGS[name]}[${name}]${RESET} ${DIM}exited (${signal ?? `code ${code}`})${RESET}\n`,
    );
    if (optional) {
      process.stdout.write(
        `${TAGS[name]}[${name}]${RESET} ${DIM}the backend will compute locally${RESET}\n`,
      );
      return;
    }
    // One half without the other is not a working stack — the frontend would
    // sit there proxying to nothing, which is the exact confusion this script
    // exists to prevent. Take the whole thing down and surface the code.
    stop(code ?? 1);
  });

  child.on('error', (err) => {
    process.stdout.write(`${TAGS[name]}[${name}]${RESET} failed to start: ${err.message}\n`);
    if (optional) {
      process.stdout.write(
        `${TAGS[name]}[${name}]${RESET} ${DIM}is Go installed and on PATH? ` +
        `continuing without the sidecar${RESET}\n`,
      );
      return;
    }
    stop(1);
  });

  return child;
}

/** A node child — the common case, and the reason `binOf` exists. */
function start(name, file, args, cwd, opts) {
  return run(name, process.execPath, [file, ...args], cwd, opts);
}

/**
 * Kill both, then exit.
 *
 * On Windows a plain `child.kill()` signals only the process spawned here.
 * `tsx watch` runs the server as a GRANDCHILD, so that leaves the real listener
 * alive holding port 3101 — and the next `npm run dev` fails to bind with an
 * error that points at the port rather than at the orphan. `taskkill /T` walks
 * the tree; POSIX gets the ordinary signal.
 */
function stop(code) {
  if (stopping) return;
  stopping = true;

  for (const [, child] of children) {
    if (child.pid == null || child.exitCode != null) continue;
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }

  // A moment for the kills to land before the parent's exit closes the pipes
  // and truncates whatever the children were printing on the way out.
  setTimeout(() => process.exit(code), 300).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    process.stdout.write(`\n${DIM}stopping…${RESET}\n`);
    stop(0);
  });
}

/* ── Preflight ──────────────────────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** PIDs listening on a port. netstat/lsof rather than a dependency — this file
 *  is deliberately free of them. */
function ownersOf(port) {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split('\n')) {
        if (!line.includes('LISTENING')) continue;
        // Match the LOCAL address column only. A bare `includes(':3101')` also
        // matches a foreign address, which is how a preflight ends up trying to
        // kill the browser that is merely connected to the port.
        if (!new RegExp(`[:\\.]${port}\\s`).test(line)) continue;
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
      return [...pids];
    }
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    // No listener at all is an exit code, not an error worth reporting.
    return [];
  }
}

/** Ask whoever is on the port what they are. */
async function identify(port, path) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_500) });
    const body = await res.json();
    return typeof body?.service === 'string' ? body.service : null;
  } catch {
    return null;
  }
}

/**
 * Make a port available, or explain who has it and stop.
 *
 * The identity check is the whole safety of this. A stale instance of OUR OWN
 * service is an orphan from the last run and killing it is the only thing the
 * user could want — they just asked for a fresh one on that port. Anything else
 * is somebody else's process, and a dev script that kills unknown listeners
 * because it wanted their port is a far worse bug than the one it is fixing.
 */
async function clearPort(name, port, path, expect) {
  const owners = ownersOf(port);
  if (!owners.length) return true;

  const service = await identify(port, path);
  if (service !== expect) {
    process.stdout.write(
      `${TAGS[name]}[${name}]${RESET} port ${port} is held by ` +
      `${service ? `"${service}"` : `pid ${owners.join(', ')}`}, which is not ${expect}.\n` +
      `${DIM}  Nothing was killed. Free it yourself, or start elsewhere:\n` +
      `    QT_BACKEND_PORT=3102 npm run dev:go${RESET}\n`,
    );
    return false;
  }

  process.stdout.write(
    `${TAGS[name]}[${name}]${RESET} ${DIM}port ${port} still held by a previous ` +
    `${expect} (pid ${owners.join(', ')}) — stopping it${RESET}\n`,
  );

  for (const pid of owners) {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/pid', pid, '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(Number(pid), 'SIGTERM');
      }
    } catch { /* already gone between the listing and the kill */ }
  }

  // The socket outlives the process by a moment. Polling rather than a fixed
  // sleep, because the wait is usually one tick and occasionally a second.
  for (let i = 0; i < 20; i += 1) {
    await sleep(100);
    if (!ownersOf(port).length) return true;
  }

  process.stdout.write(
    `${TAGS[name]}[${name}]${RESET} port ${port} did not free up after 2s.\n`,
  );
  return false;
}

const apiPort = process.env.QT_BACKEND_PORT || '3101';

// The backend's port is fatal — it is the stack. The sidecar's is not: a port
// it cannot have simply means no sidecar, which is the default anyway.
if (!await clearPort('api', apiPort, '/api/health', 'qt-backend')) process.exit(1);
if (withGo && !await clearPort('go', goPort, '/health', 'quantstack-compute')) {
  process.stdout.write(`${TAGS.go}[go]${RESET} ${DIM}starting without the sidecar${RESET}\n`);
}
if (withMarketd && !await clearPort('mkt', marketdPort, '/health', 'marketd')) {
  process.stdout.write(`${TAGS.mkt}[mkt]${RESET} ${DIM}starting without the market engine${RESET}\n`);
}

/* ── Launch ─────────────────────────────────────────────────────────────── */

/*
 * The sidecar goes first when it is wanted.
 *
 * `go run` compiles before it listens — a second or two — and the backend
 * probes the sidecar lazily on its first batch rather than at boot, so there is
 * no race to lose. Starting it first simply means a compile error appears above
 * the backend's banner instead of somewhere inside it.
 *
 * The binary is named explicitly on Windows: `spawn` there resolves an exact
 * filename through PATH and does not apply PATHEXT, so a bare 'go' would be
 * ENOENT on a machine that has Go installed and working.
 */
const goExe = process.platform === 'win32' ? 'go.exe' : 'go';

const goReady = withGo && !ownersOf(goPort).length;
if (goReady) {
  run('go', goExe, ['run', './cmd/computed'], goRoot,
    { optional: true, env: { QT_GO_COMPUTE_PORT: goPort } });
}

/*
 * The market engine, on the same terms as the compute sidecar.
 *
 * Also `optional`: marketd owns the live feed and its own straddle engine, but
 * the Node backend does the same work itself whenever `QT_GO_ENGINE` is unset —
 * see backend/lib/engineClient.ts. Taking the whole stack down because a helper
 * failed to compile would turn an optimisation into a hard dependency.
 */
const marketdReady = withMarketd && !ownersOf(marketdPort).length;
if (marketdReady) {
  run('mkt', goExe, ['run', './cmd/marketd'], goRoot,
    { optional: true, env: { QT_MARKETD_PORT: marketdPort } });
}

/*
 * Backend second, and the web server waits for it.
 *
 * The HTTP proxy genuinely does not need this — it retries per request, so a
 * frontend that came up first was merely unable to answer for a second. The
 * WEBSOCKET proxy is not so forgiving: an already-open browser tab reconnects
 * its socket the instant Vite is listening, and if the backend has not bound
 * yet that surfaces as
 *
 *   [vite] ws proxy error: AggregateError [ECONNREFUSED]
 *
 * which is a red stack trace in the startup log of a run that is going fine.
 * Waiting costs the two seconds the backend takes to bind and puts the Local
 * URL last, where it is the first thing you see rather than the thing you
 * scroll back for.
 *
 * QT_GO_COMPUTE is set HERE rather than left to the shell, so the one flag both
 * starts the sidecar and points the backend at it. Two steps would eventually
 * be done in one order or the other and the sidecar would sit idle while
 * everything looked correct.
 */
/*
 * The enable flags are set HERE, not left to the shell.
 *
 * One switch both starts a sidecar and points the backend at it. Two steps
 * would eventually be done in one order or the other, and the sidecar would sit
 * idle while everything looked correct — the failure mode being a stack that is
 * simply slower than it should be, with nothing in the log saying so.
 */
const apiEnv = {
  ...(goReady      ? { QT_GO_COMPUTE: '1', QT_GO_COMPUTE_PORT: goPort } : {}),
  ...(marketdReady ? { QT_GO_ENGINE: '1', QT_MARKETD_PORT: marketdPort } : {}),
};

start('api', binOf('tsx', backend, './dist/cli.mjs'), ['watch', 'main.ts'], backend,
  Object.keys(apiEnv).length ? { env: apiEnv } : undefined);

/** Resolves when something accepts a TCP connection on the port. */
function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: Number(port) });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/*
 * Bounded, and it starts Vite either way.
 *
 * A backend that fails to boot must not leave the developer with no frontend
 * and no explanation — the log already carries whatever went wrong, and Vite
 * coming up anyway keeps this script's behaviour the same as it was before the
 * wait existed.
 */
for (let i = 0; i < 40 && !stopping; i += 1) {
  if (await listening(apiPort)) break;
  await sleep(250);
}
/*
 * LAN exposure.
 *
 * `--host` makes Vite listen on every interface, so the terminal is reachable
 * from other machines at http://<this-machine>:5273. Only the FRONTEND is
 * exposed: the backend stays bound to 127.0.0.1 and is reached through Vite's
 * `/api` and `/ws` proxy, which keeps the one open port on the LAN a port that
 * serves the app rather than the raw API.
 *
 * `QT_EXPOSE=0 npm run dev` goes back to a localhost-only terminal.
 */
const EXPOSE = process.env.QT_EXPOSE !== '0';

if (!stopping) start('web', binOf('vite', root, 'bin/vite.js'), EXPOSE ? ['--host'] : [], root);
