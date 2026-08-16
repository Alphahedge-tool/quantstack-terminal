/**
 * Nubra auth routes:
 *   GET  /api/nubra/status          → session info
 *   POST /api/nubra/login           → headless TOTP login
 *   POST /api/nubra/logout          → clear session
 *   POST /api/nubra/setup/start     → send SMS OTP (one-time setup)
 *   POST /api/nubra/setup/finish    → verify OTP + enable TOTP
 */

import { route, readJSON, ApiError } from '../server.js';
import { login, startSetup, finishSetup, type NubraCredentials } from '../brokers/nubra.js';
import {
  setSession, clearSession, requireSession, sessionStatus,
} from '../lib/sessionStore.js';
import { credentialsFor } from '../lib/credentialStore.js';

// GET /api/nubra/status
route('GET', '/api/nubra/status', () => ({
  status: true,
  ...sessionStatus(),
}));

// POST /api/nubra/login
// Body: { phone, mpin, totpSecret, env? }
route('POST', '/api/nubra/login', async (req) => {
  const body = await readJSON<{
    phone?: string; mpin?: string; totpSecret?: string; env?: string;
  }>(req);

  // The frontend can POST {} and let the server supply everything: the login
  // page's "Connect" button sends blank fields for exactly this reason, and on
  // a shared terminal the person clicking it does not have the credentials.
  // Supabase first, then NUBRA_* env vars (lib/credentialStore.ts).
  const stored = await credentialsFor('nubra', { env: body.env });

  const cr: NubraCredentials = {
    phone:       body.phone      || stored?.phone      || '',
    mpin:        body.mpin       || stored?.mpin       || '',
    totpSecret:  body.totpSecret || stored?.totpSecret || '',
    env:         (body.env as 'PROD' | 'UAT' | undefined) || stored?.env,
  };

  if (!cr.phone || !cr.mpin || !cr.totpSecret) {
    throw new ApiError(
      'phone, mpin and totpSecret are required — or store them in Supabase '
      + 'broker_accounts (enabled + auto_login) or set the NUBRA_* env vars',
      400,
    );
  }

  try {
    const session = await login(cr);
    setSession(session);
    return {
      status: true,
      message: 'Logged in to Nubra',
      clientCode: session.clientCode,
      phone:      session.phone,
      loginAt:    session.loginAt,
    };
  } catch (err) {
    throw new ApiError((err as Error).message || 'Nubra login failed', 401);
  }
});

// POST /api/nubra/logout
route('POST', '/api/nubra/logout', () => {
  clearSession();
  return { status: true, message: 'Logged out' };
});

// POST /api/nubra/setup/start — triggers SMS OTP
// Body: { phone, env? }
route('POST', '/api/nubra/setup/start', async (req) => {
  const body = await readJSON<{ phone?: string; env?: string }>(req);
  const phone = body.phone || process.env.NUBRA_PHONE || '';
  if (!phone) throw new ApiError('phone is required', 400);
  try {
    const handle = await startSetup({ phone, env: body.env });
    return { status: true, tempToken: handle.tempToken, message: 'OTP sent to registered mobile' };
  } catch (err) {
    throw new ApiError((err as Error).message || 'Setup start failed', 500);
  }
});

// POST /api/nubra/setup/finish — verify OTP + enable TOTP
// Body: { phone, mpin, tempToken, otp, env? }
route('POST', '/api/nubra/setup/finish', async (req) => {
  const body = await readJSON<{
    phone?: string; mpin?: string; tempToken?: string; otp?: string; env?: string;
  }>(req);
  const cr: NubraCredentials = {
    phone:      body.phone || process.env.NUBRA_PHONE || '',
    mpin:       body.mpin  || process.env.NUBRA_MPIN  || '',
    totpSecret: '',    // not needed yet — will be set after generation
    env:        (body.env as 'PROD' | 'UAT' | undefined),
  };
  if (!cr.phone || !cr.mpin || !body.tempToken || !body.otp) {
    throw new ApiError('phone, mpin, tempToken and otp are required', 400);
  }
  try {
    const { totpSecret, session } = await finishSetup(cr, {
      tempToken: body.tempToken!,
      otp:       body.otp!,
    });
    setSession(session);
    return {
      status: true,
      totpSecret,
      message: 'TOTP enabled — save this secret in NUBRA_TOTP_SECRET',
      clientCode: session.clientCode,
      loginAt:    session.loginAt,
    };
  } catch (err) {
    throw new ApiError((err as Error).message || 'Setup finish failed', 500);
  }
});

// GET /api/nubra/expiries?symbol=NIFTY&exchange=NSE&date=2026-08-08
route('GET', '/api/nubra/expiries', async (_req, _res, { query }) => {
  const session = requireSession();
  const { rollingOptionRows } = await import('../lib/nubraData.js');
  const symbol   = query.get('symbol');
  const exchange = query.get('exchange') || 'NSE';
  const date     = query.get('date') || undefined;
  if (!symbol) throw new ApiError('symbol is required', 400);
  const rows = await rollingOptionRows({ symbol, exchange, date, session });
  const expiries = [...new Set(rows.map((r) => r.expiry))].sort();
  return { status: true, symbol, exchange, expiries };
});
