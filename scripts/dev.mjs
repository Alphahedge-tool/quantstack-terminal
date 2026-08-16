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
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const backend = path.join(root, 'backend');
const require = createRequire(import.meta.url);

/** A package's executable entry, resolved from wherever it is installed. */
function binOf(pkg, from, fallback) {
  const manifest = require.resolve(`${pkg}/package.json`, { paths: [from] });
  const { bin } = require(manifest);
  const rel = typeof bin === 'string' ? bin : bin?.[pkg] ?? fallback;
  return path.join(path.dirname(manifest), rel);
}

const TAGS = {
  // Cyan and amber, matched to nothing in particular beyond being the two
  // easiest colours to tell apart at a glance in a scrolling log.
  api: '\x1b[36m',
  web: '\x1b[33m',
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

function start(name, file, args, cwd) {
  const child = spawn(process.execPath, [file, ...args], {
    cwd,
    // Piped rather than inherited so output can be tagged. The cost is that
    // Vite's own colours would drop, so FORCE_COLOR keeps them.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? '1' },
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
    // One half without the other is not a working stack — the frontend would
    // sit there proxying to nothing, which is the exact confusion this script
    // exists to prevent. Take the whole thing down and surface the code.
    stop(code ?? 1);
  });

  child.on('error', (err) => {
    process.stdout.write(`${TAGS[name]}[${name}]${RESET} failed to start: ${err.message}\n`);
    stop(1);
  });

  return child;
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

/*
 * Backend first.
 *
 * Not a race that needs solving — Vite's proxy retries per request, so a
 * frontend that comes up first is merely unable to answer for a second. Started
 * first only so its startup log, which is where a bad broker login or a held
 * port shows up, is at the top rather than buried under Vite's banner.
 */
start('api', binOf('tsx', backend, './dist/cli.mjs'), ['watch', 'main.ts'], backend);
start('web', binOf('vite', root, 'bin/vite.js'), [], root);
