/**
 * Nubra broker adapter — TypeScript port of Alphahedge node-backend/brokers/nubra.js.
 *
 * Auth flow (REST API V3):
 *   Headless login:   POST /totp/login → auth_token
 *                     POST /verifypin  → session_token + deviceId
 *
 *   One-time setup:   POST /sendphoneotp   → temp_token
 *                     POST /verifyphoneotp → auth_token
 *                     POST /verifypin      → session_token
 *                     GET  /totp/generate-secret → secret_key
 *                     POST /totp/enable    → enables TOTP forever
 *
 * After login, the session { sessionToken, deviceId } is used to call
 * Nubra's data API (charts/timeseries, refdata/refdata/<date>).
 */

import {
  generateTOTP,
  validateTOTPSecret,
  nearWindowEdge,
  msUntilNextWindow,
} from '../lib/totp.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NubraCredentials {
  phone: string;
  mpin: string;          // 4-digit MPIN
  totpSecret: string;    // Base32 TOTP secret
  env?: 'PROD' | 'UAT';
  deviceId?: string;     // optional override; auto-derived if absent
}

export interface NubraSession {
  sessionToken: string;
  deviceId: string;
  phone: string;
  userId?: string | number;
  clientCode?: string;
  name?: string;
  loginAt: string;        // ISO timestamp
}

export interface SetupHandle {
  tempToken: string;
  deviceId: string;
  baseUrl: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class NubraAuthError extends Error {
  status: number;
  constructor(message: string, status = 440) {
    super(message);
    this.name = 'NubraAuthError';
    this.status = status;
  }
}

// ─── URL + device id ──────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.nubra.io';
const UAT_BASE_URL     = 'https://uatapi.nubra.io';

export function baseUrlFor(env?: string): string {
  if (String(env ?? '').toUpperCase() === 'UAT') return UAT_BASE_URL;
  return process.env.NUBRA_BASE_URL || DEFAULT_BASE_URL;
}

export function deviceIdFor(cr: NubraCredentials): string {
  if (cr.deviceId) return cr.deviceId;
  const base = String(cr.phone || 'device').replace(/[^a-zA-Z0-9]/g, '') || 'device';
  return `quantstack-${base}`;
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function authHeaders(devId: string, token?: string): Record<string, string> {
  const h: Record<string, string> = { 'x-device-id': devId };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function extractError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    for (const key of ['error', 'message', 'detail']) {
      const v = (body as Record<string, unknown>)[key];
      if (typeof v === 'string' && v) return v;
    }
  }
  return `Nubra HTTP ${status}`;
}

async function doJSON<T = Record<string, unknown>>(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const text = await res.text();
  let out: unknown = {};
  if (text) {
    try { out = JSON.parse(text); } catch { out = { raw: text }; }
  }
  if (!res.ok) throw new NubraAuthError(extractError(out, res.status), res.status);
  return out as T;
}

// ─── Server time (avoid clock skew) ──────────────────────────────────────────

async function serverTimeMs(baseUrl: string): Promise<number> {
  try {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/', {
      method: 'HEAD',
      signal: AbortSignal.timeout(5_000),
    });
    const date = res.headers.get('date');
    if (date) {
      const t = Date.parse(date);
      if (!Number.isNaN(t)) return t;
    }
  } catch { /* fall through */ }
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Core auth steps ──────────────────────────────────────────────────────────

async function verifyPin(
  baseUrl: string,
  cr: NubraCredentials,
  devId: string,
  authToken: string,
): Promise<NubraSession> {
  const res = await doJSON<{ session_token?: string; phone?: string; userId?: string | number }>(
    baseUrl, 'POST', '/verifypin', authHeaders(devId, authToken), { pin: cr.mpin },
  );
  const sessionToken = res.session_token;
  if (!sessionToken) throw new NubraAuthError('Nubra MPIN verification returned no session_token');
  return {
    sessionToken,
    phone: res.phone || cr.phone,
    userId: res.userId,
    deviceId: devId,
    loginAt: new Date().toISOString(),
  };
}

async function fetchAccountInfo(
  baseUrl: string,
  session: NubraSession,
): Promise<{ clientCode?: string; userId?: string | number; name?: string; email?: string }> {
  try {
    const res = await doJSON<{ data?: Record<string, unknown> } & Record<string, unknown>>(
      baseUrl, 'GET', '/users/account_info', authHeaders(session.deviceId, session.sessionToken),
    );
    const d = (res?.data && typeof res.data === 'object' ? res.data : res) as Record<string, unknown>;
    return {
      clientCode: String(d.client_code || d.clientCode || d.ucc || ''),
      userId: (d.user_id ?? d.userId ?? session.userId) as string | number | undefined,
      name: String(d.name || d.client_name || d.display_name || ''),
      email: String(d.email || ''),
    };
  } catch { return {}; }
}

function hintTOTPError(err: unknown): NubraAuthError {
  const e = err instanceof NubraAuthError ? err : new NubraAuthError(String((err as Error).message || err));
  const msg = e.message.toLowerCase();
  if (msg.includes('totp') || msg.includes('otp') || msg.includes('invalid')) {
    return new NubraAuthError(
      `${e.message} — verify the TOTP secret matches the one enabled on this Nubra account and that the server clock is accurate`,
      e.status,
    );
  }
  return e;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fully headless login: POST /totp/login → POST /verifypin.
 * Retries once at a TOTP window edge (the only transient failure the code can fix).
 */
export async function login(cr: NubraCredentials): Promise<NubraSession> {
  if (!cr.phone || !cr.mpin || !cr.totpSecret) {
    throw new NubraAuthError('Nubra login needs phone, MPIN and TOTP secret', 400);
  }
  validateTOTPSecret(cr.totpSecret);

  const baseUrl = baseUrlFor(cr.env);
  const devId   = deviceIdFor(cr);

  for (let attempt = 0; ; attempt++) {
    const genMs = await serverTimeMs(baseUrl);
    const code  = generateTOTP(cr.totpSecret, genMs);
    try {
      const totpNum = Number.parseInt(code, 10);
      const loginRes = await doJSON<{ auth_token?: string }>(
        baseUrl, 'POST', '/totp/login',
        authHeaders(devId, ''),
        { phone: cr.phone, totp: totpNum, otp: '' },
      );
      const authToken = loginRes.auth_token;
      if (!authToken) throw new NubraAuthError('Nubra TOTP login returned no auth_token');

      const session = await verifyPin(baseUrl, cr, devId, authToken);
      const info    = await fetchAccountInfo(baseUrl, session);
      if (info.clientCode) {
        session.clientCode = info.clientCode;
        session.name       = info.name;
        if (info.userId != null) session.userId = info.userId;
      }
      return session;
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }
}

/**
 * isTOTPError — true if the login failed because the TOTP secret is bad/unregistered.
 * Used to decide whether to wipe + re-setup vs. just retry later.
 */
export function isTOTPError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { status?: number; message?: string };
  if ((e.status ?? 0) >= 500) return false;
  const msg = String(e.message || '').toLowerCase();
  if (['fetch', 'timeout', 'network', 'abort'].some((w) => msg.includes(w))) return false;
  return (
    msg.includes('totp') ||
    msg.includes('not enabled') ||
    msg.includes('incorrect') ||
    (msg.includes('otp') && !msg.includes('temp')) ||
    (msg.includes('invalid') && (e.status ?? 0) === 400)
  );
}

// ─── One-time TOTP setup (needs SMS OTP from user once) ──────────────────────

/** Step 1: Send SMS OTP. Returns a handle to pass to finishSetup. */
export async function startSetup(cr: { phone: string; env?: string }): Promise<SetupHandle> {
  const baseUrl = baseUrlFor(cr.env);
  const devId   = `quantstack-${cr.phone.replace(/[^0-9]/g, '')}`;
  const res = await doJSON<{ temp_token?: string }>(
    baseUrl, 'POST', '/sendphoneotp', {}, { phone: cr.phone, skip_totp: false },
  );
  if (!res.temp_token) throw new NubraAuthError('Nubra /sendphoneotp returned no temp_token');
  return { tempToken: res.temp_token, deviceId: devId, baseUrl };
}

/** Step 2: Verify SMS OTP → get session → generate + enable TOTP secret. */
export async function finishSetup(
  cr: NubraCredentials,
  { tempToken, otp }: { tempToken: string; otp: string },
): Promise<{ totpSecret: string; qrImage: string; session: NubraSession }> {
  if (!tempToken || !otp) throw new NubraAuthError('Nubra TOTP setup needs tempToken and OTP', 400);
  const baseUrl = baseUrlFor(cr.env);
  const devId   = deviceIdFor(cr);

  const verified = await doJSON<{ auth_token?: string }>(
    baseUrl, 'POST', '/verifyphoneotp',
    { 'x-temp-token': tempToken, 'x-device-id': devId },
    { phone: cr.phone, otp: String(otp) },
  );
  if (!verified.auth_token) throw new NubraAuthError('Nubra OTP verification returned no auth_token');

  const session = await verifyPin(baseUrl, cr, devId, verified.auth_token);

  const generated = await doJSON<{ data?: { secret_key?: string; qr_image?: string }; secret_key?: string; qr_image?: string }>(
    baseUrl, 'GET', '/totp/generate-secret', authHeaders(devId, session.sessionToken),
  );
  const secret  = generated?.data?.secret_key || generated?.secret_key;
  const qrImage = generated?.data?.qr_image   || generated?.qr_image   || '';
  if (!secret) throw new NubraAuthError('Nubra TOTP setup returned no secret_key', 500);
  validateTOTPSecret(secret);

  // Enable TOTP (retry once at window edge, exactly like login)
  for (let attempt = 0; ; attempt++) {
    const genMs = await serverTimeMs(baseUrl);
    const code  = generateTOTP(secret, genMs);
    try {
      await doJSON(baseUrl, 'POST', '/totp/enable', authHeaders(devId, session.sessionToken), {
        mpin: cr.mpin,
        totp: code,
      });
      break;
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(genMs)) throw hintTOTPError(err);
      await sleep(msUntilNextWindow(genMs));
    }
  }

  return { totpSecret: secret, qrImage, session };
}
