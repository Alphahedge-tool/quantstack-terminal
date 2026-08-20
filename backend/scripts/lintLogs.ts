/**
 * Guard: no `console.*` in the backend's runtime code.
 *
 * Not style policing. A `console.log` in a request path is invisible to the
 * level filter, carries no module and no timestamp, and in production writes a
 * bare line into a stream where everything else is JSON — which is enough to
 * break a log shipper's parser for that line and lose it entirely.
 *
 * `scripts/` is exempt, deliberately and permanently: those are CLI tools whose
 * output is read by a person at a terminal, and structured logging is the wrong
 * shape for a table of ✓ and ✗. See the note in lib/logger.ts.
 *
 * Run: npm run lint:logs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const SKIP_DIRS = new Set(['node_modules', 'dist', 'cache', 'bin', 'scripts']);
/** Files where console output IS the deliverable. */
const ALLOW = new Set([join('feeds', 'verify.ts')]);

const CONSOLE = /\bconsole\.(log|info|warn|error|debug|trace)\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const offences: string[] = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (ALLOW.has(rel)) continue;
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    CONSOLE.lastIndex = 0;
    if (CONSOLE.test(line)) offences.push(`${rel.split(sep).join('/')}:${i + 1}  ${line.trim()}`);
  });
}

if (offences.length) {
  console.error(`\n${offences.length} console call(s) in runtime code:\n`);
  for (const o of offences) console.error(`  ${o}`);
  console.error(`
Use a module logger instead:

  import { logger } from './lib/logger.js';
  const log = logger('feeds');
  log.info({ feed: id }, 'feed connected');
`);
  process.exit(1);
}

console.log('No console calls in runtime code.');
