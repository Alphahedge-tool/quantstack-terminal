/**
 * Nubra session store — in-memory, persists for the lifetime of the process.
 * A single Nubra session covers all data API calls.
 */

import { login, type NubraSession, type NubraCredentials } from '../brokers/nubra.js';

let _session: NubraSession | null = null;
let _loginAt: number = 0;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;   // 8 hours (Nubra sessions last ~12h)

export function getSession(): NubraSession | null {
  if (!_session) return null;
  if (Date.now() - _loginAt > SESSION_TTL_MS) {
    console.warn('[nubra-session] Session TTL exceeded — will re-login on next request');
    _session = null;
    return null;
  }
  return _session;
}

export function requireSession(): NubraSession {
  const s = getSession();
  if (!s) throw new Error('Not logged in to Nubra — call POST /api/nubra/login first');
  return s;
}

export function setSession(session: NubraSession): void {
  _session = session;
  _loginAt = Date.now();
  console.log(`[nubra-session] Session active — clientCode=${session.clientCode || '?'} phone=${session.phone}`);

  // Warm the instrument master in the background. This is the one choke point
  // every login path goes through (auto-login, POST /login, TOTP setup), so the
  // cache is filling before the first straddle request arrives. Dynamic import
  // keeps sessionStore out of the nubraData ↔ instrumentCache import cycle.
  void import('./instrumentCache.js')
    .then((m) => m.warmInstrumentCache(session))
    .catch((e) => console.warn(`[instrument-cache] Warm skipped: ${(e as Error).message}`));
}

export function clearSession(): void {
  _session = null;
  _loginAt = 0;
}

export function sessionStatus() {
  if (!_session) return { loggedIn: false };
  return {
    loggedIn:   true,
    clientCode: _session.clientCode,
    phone:      _session.phone,
    loginAt:    _session.loginAt,
    expiresIn:  Math.max(0, SESSION_TTL_MS - (Date.now() - _loginAt)),
  };
}

/**
 * Auto-login from stored credentials — Supabase first, then NUBRA_* env vars.
 *
 * Resolution is delegated rather than re-implemented: this used to read the env
 * vars directly, which meant a second credential path that would keep working
 * while quietly ignoring Supabase. Only the feed adapter calls the broker at
 * boot today, so this stays available for scripts and one-off tooling.
 */
export async function autoLoginFromEnv(): Promise<boolean> {
  const { credentialsFor } = await import('./credentialStore.js');
  const resolved = await credentialsFor('nubra');

  if (!resolved) {
    console.warn(
      '[nubra-session] No credentials — add an enabled, auto_login row to Supabase'
      + ' broker_accounts, or set NUBRA_PHONE / NUBRA_MPIN / NUBRA_TOTP_SECRET',
    );
    return false;
  }

  const cr: NubraCredentials = {
    phone:      resolved.phone,
    mpin:       resolved.mpin,
    totpSecret: resolved.totpSecret,
    env:        resolved.env,
  };
  try {
    console.log(`[nubra-session] Auto-login as ${resolved.label} (from ${resolved.source}) …`);
    setSession(await login(cr));
    return true;
  } catch (err) {
    console.error('[nubra-session] Auto-login failed:', (err as Error).message);
    return false;
  }
}
