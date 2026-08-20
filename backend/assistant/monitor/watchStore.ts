/**
 * Watch persistence.
 *
 * ── Why watches survive a restart ──
 *
 * A watch is a promise: the user said "tell me if the OI on this strike moves"
 * and then stopped looking at the screen. If a backend restart silently drops
 * that, the terminal is worse than useless — it is quietly not doing the one
 * job it was asked to do, and the user has no way to notice. So watches are
 * written to disk on every mutation and reloaded at boot.
 *
 * ── What does NOT survive ──
 *
 * The metric history behind a watch is in-memory only. After a restart a watch
 * is live but has no idea what "normal" looks like for its contract yet, so
 * adaptive alerts stay quiet until MIN_SAMPLES of history rebuilds. That is the
 * correct behaviour — firing off a cold distribution is how you get a burst of
 * garbage alerts every deploy — but it means a restart costs a few minutes of
 * adaptive coverage, and that is worth knowing.
 *
 * Watches also carry `sessionId`, and a session does not survive a browser
 * reload. Expired-session watches are kept, not dropped: the alert center reads
 * them back by symbol, and a user who reloads should still find what they set.
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Watch } from '../types.js';

import { logger } from '../../lib/logger.js';

const log = logger('iris/watches');

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * `backend/cache/assistant/watches.json`, found by walking up to the package
 * root rather than counting `..` segments.
 *
 * Counting breaks silently: `tsx` runs this from backend/assistant/monitor/ and
 * `node dist/main.js` runs it from backend/dist/assistant/monitor/, one level
 * deeper, so a fixed depth writes outside the project in one of the two modes —
 * and the failure looks like "my watches vanished after deploying", not like a
 * path bug. Anchoring on the directory that holds package.json is true in both.
 */
let cachedPath: string | null = null;

function storePath(): string {
  if (cachedPath) return cachedPath;

  let dir = __dir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'package.json'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  cachedPath = resolve(dir, 'cache', 'assistant', 'watches.json');
  return cachedPath;
}

interface Persisted {
  version: 1;
  watches: Watch[];
}

let watches = new Map<string, Watch>();
let loaded = false;

/** Coalesces bursts of mutations into one write. */
let writeTimer: NodeJS.Timeout | null = null;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as Persisted;
    if (parsed?.version === 1 && Array.isArray(parsed.watches)) {
      for (const w of parsed.watches) watches.set(w.id, w);
      log.info(`restored ${watches.size} watch(es)`);
    }
  } catch {
    // No file yet, or a corrupt one. Starting empty is the only safe recovery:
    // a half-parsed watch list would silently monitor the wrong contracts.
  }
}

function flush(): void {
  writeTimer = null;
  const path = storePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const payload: Persisted = { version: 1, watches: [...watches.values()] };
    // Write-then-rename: a crash mid-write leaves the previous good file in
    // place rather than a truncated one that fails to parse on next boot.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, path);
  } catch (err) {
    log.warn(`could not persist: ${(err as Error).message}`);
  }
}

function schedulePersist(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(flush, 500);
  writeTimer.unref?.();
}

// ── API ──────────────────────────────────────────────────────────────────────

export function allWatches(): Watch[] {
  load();
  return [...watches.values()];
}

export function watchesFor(sessionId: string): Watch[] {
  load();
  return [...watches.values()].filter((w) => w.sessionId === sessionId);
}

export function getWatch(id: string): Watch | undefined {
  load();
  return watches.get(id);
}

export function addWatch(watch: Watch): Watch {
  load();
  watches.set(watch.id, watch);
  schedulePersist();
  return watch;
}

export function removeWatch(id: string): boolean {
  load();
  const had = watches.delete(id);
  if (had) schedulePersist();
  return had;
}

/**
 * Remove every watch matching a predicate, returning what went.
 *
 * Used by "cancel all my alerts" and by "stop watching nifty" — the caller
 * builds the predicate so this file never has to know how a user refers to a
 * watch.
 */
export function removeWhere(pred: (w: Watch) => boolean): Watch[] {
  load();
  const gone: Watch[] = [];
  for (const w of [...watches.values()]) {
    if (!pred(w)) continue;
    watches.delete(w.id);
    gone.push(w);
  }
  if (gone.length) schedulePersist();
  return gone;
}

/** Record a fire — bumps the counter and stamps the cooldown. */
export function markFired(id: string, at = Date.now()): void {
  load();
  const w = watches.get(id);
  if (!w) return;
  w.lastFiredAt = at;
  w.firedCount += 1;
  schedulePersist();
}

export function setPaused(id: string, paused: boolean): boolean {
  load();
  const w = watches.get(id);
  if (!w) return false;
  w.paused = paused;
  schedulePersist();
  return true;
}

/** Distinct chains the current watch set needs subscribed. */
export function requiredChains(): Array<{ exchange: string; symbol: string; expiry: string }> {
  load();
  const seen = new Map<string, { exchange: string; symbol: string; expiry: string }>();
  for (const w of watches.values()) {
    if (w.paused) continue;
    const key = `${w.exchange}:${w.symbol}:${w.expiry}`;
    if (!seen.has(key)) seen.set(key, { exchange: w.exchange, symbol: w.symbol, expiry: w.expiry });
  }
  return [...seen.values()];
}

/** Short, stable, human-quotable. Long enough not to collide in a session. */
export function newWatchId(): string {
  return `w_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
