/**
 * Broker sessions that survive a restart.
 *
 * Every login here costs a TOTP code, and some brokers meter them. Zerodha's
 * access token in particular is valid until roughly 6 AM the next morning — so
 * re-running the whole headless web login because a dev server reloaded is pure
 * waste, and on a broker that rate-limits 2FA it is a way to get locked out
 * during market hours.
 *
 * So a session is written to disk with the moment it stops being valid, and the
 * next boot reuses it if it is still alive. Reuse is always REVALIDATED by the
 * caller (a cheap authenticated call) before being trusted: an expiry is the
 * broker's promise, not a fact, and a token can be revoked early by logging in
 * elsewhere.
 *
 * `/backend/cache/` is gitignored, which is what makes this an acceptable place
 * to put a bearer token. It is still a bearer token on disk in plain text —
 * anyone with the file can trade the account until it expires.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { logger } from './logger.js';

const log = logger('session');

const DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'cache', 'sessions',
);

interface Envelope<T> {
  savedAt:   number;
  expiresAt: number;
  data:      T;
}

/** One file per feed id. `angel#2` must not collide with `angel`. */
function fileFor(id: string): string {
  return path.join(DIR, `${id.replace(/[^a-z0-9#_-]/gi, '_')}.json`);
}

/**
 * Persist a session until `expiresAt` (epoch ms).
 *
 * Failures are logged and swallowed: a cache that cannot be written is a missed
 * optimisation, not a reason to fail a login that has already succeeded.
 */
export function saveSession<T>(id: string, data: T, expiresAt: number): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const envelope: Envelope<T> = { savedAt: Date.now(), expiresAt, data };
    // Written 0600 where the platform honours it — this is a bearer token.
    fs.writeFileSync(fileFor(id), JSON.stringify(envelope), { mode: 0o600 });
    log.info(`cached ${id} until ${new Date(expiresAt).toISOString()}`);
  } catch (err) {
    log.warn(`could not cache ${id}: ${(err as Error).message}`);
  }
}

/**
 * A cached session that has not expired, or null.
 *
 * An expired file is deleted rather than left to be re-read and re-rejected on
 * every boot.
 */
export function loadSession<T>(id: string): T | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fileFor(id), 'utf8');
  } catch {
    return null;                       // no cache is the normal first run
  }

  try {
    const envelope = JSON.parse(raw) as Envelope<T>;
    if (!envelope?.data || typeof envelope.expiresAt !== 'number') return null;
    if (Date.now() >= envelope.expiresAt) {
      clearSession(id);
      return null;
    }
    return envelope.data;
  } catch {
    clearSession(id);                  // corrupt file: forget it
    return null;
  }
}

export function clearSession(id: string): void {
  try { fs.unlinkSync(fileFor(id)); } catch { /* already gone */ }
}

/**
 * The next 06:00 IST, as epoch ms.
 *
 * Zerodha invalidates access tokens each morning rather than after a fixed
 * lifetime, so "expires in 24h" would keep a dead token past the cutoff and
 * "expires at midnight" would throw away six good hours.
 */
export function nextSixAmIST(now = Date.now()): number {
  const IST_OFFSET = 5.5 * 3_600_000;
  const ist = new Date(now + IST_OFFSET);
  const six = Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 6, 0, 0,
  ) - IST_OFFSET;
  return six > now ? six : six + 86_400_000;
}
