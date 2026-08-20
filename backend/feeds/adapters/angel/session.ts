/**
 * Angel session: TOTP login, and the three tokens it yields.
 *
 * Unlike every other broker here, Angel's client code is the login INPUT rather
 * than something discovered afterwards — so there is no "who am I" round-trip
 * before the credentials can be used.
 *
 * Three tokens come back and they are not interchangeable:
 *
 *   jwtToken      REST calls, as `Authorization: Bearer <jwt>`
 *   refreshToken  exchanged for a new jwt without re-running TOTP
 *   feedToken     the WebSocket, and ONLY the WebSocket
 *
 * Handing the WebSocket a jwtToken authenticates fine and then delivers no
 * ticks, which is a genuinely confusing failure — hence the separate field and
 * this note.
 *
 * Login is NOT single-flighted here: `feeds/authManager.ts` already guarantees
 * one `connect()` at a time per feed, and TOTP codes are single-use within their
 * 30-second window, so a second concurrent login would consume a code the first
 * one is still using.
 */

import { FeedError } from '../../errors.js';
import { generateTOTP, msUntilNextWindow, nearWindowEdge } from '../../../lib/totp.js';
import { credentialsFor, type BrokerCredentials } from '../../../lib/credentialStore.js';
import { smartCall, smartHeaders, authHeaders } from './http.js';

import { logger } from '../../../lib/logger.js';

const log = logger('angel');

export interface AngelSession {
  clientCode:   string;
  apiKey:       string;
  jwtToken:     string;
  refreshToken: string;
  /** WebSocket only. Never send this to a REST endpoint. */
  feedToken:    string;
  loginAt:      number;
  /** Human label from the credential row, for logs. */
  label:        string;
}

interface LoginData {
  jwtToken?:     string;
  refreshToken?: string;
  feedToken?:    string;
}

interface ProfileData {
  clientcode?: string;
  name?:       string;
  exchanges?:  string[];
  products?:   string[];
}

const LOGIN_PATH   = '/rest/auth/angelbroking/user/v1/loginByPassword';
const PROFILE_PATH = '/rest/secure/angelbroking/user/v1/getProfile';
const RMS_PATH     = '/rest/secure/angelbroking/user/v1/getRMS';
const LOGOUT_PATH  = '/rest/secure/angelbroking/user/v1/logout';

/** Credentials for one Angel account, or a FeedError naming what is missing. */
export async function angelCredentials(select?: string): Promise<BrokerCredentials> {
  const creds = await credentialsFor('angel', { select });
  if (!creds) {
    throw new FeedError(
      'AUTH',
      'Angel credentials missing — need client code, API key, PIN and TOTP secret '
      + 'in Supabase broker_accounts, or ANGEL_CLIENT_CODE / ANGEL_API_KEY / '
      + 'ANGEL_PIN / ANGEL_TOTP_SECRET in backend/.env',
      { feedId: 'angel' },
    );
  }
  return creds;
}

/**
 * Log in with a freshly generated TOTP.
 *
 * The window-edge wait is the subtle part. A code generated at 29.8s into its
 * window is very likely to have rolled over by the time Angel validates it, and
 * the resulting failure is indistinguishable from a wrong secret — which then
 * trips AuthManager's backoff ladder and locks the feed out for minutes over
 * what was really a 200 ms timing problem.
 */
export async function login(creds: BrokerCredentials): Promise<AngelSession> {
  const clientCode = String(creds.clientCode ?? '').trim();
  const apiKey     = String(creds.apiKey ?? '').trim();

  if (nearWindowEdge(Date.now())) {
    await new Promise((r) => setTimeout(r, msUntilNextWindow(Date.now()) + 250));
  }

  const headers = smartHeaders(apiKey);
  const data = await smartCall<LoginData>('POST', LOGIN_PATH, headers, {
    clientcode: clientCode,
    password:   creds.mpin,
    totp:       generateTOTP(creds.totpSecret),
  });

  if (!data.jwtToken) {
    throw new FeedError('AUTH', 'Angel login returned no jwtToken', { feedId: 'angel' });
  }
  if (!data.feedToken) {
    // Not fatal for REST, but the live socket cannot work without it, and
    // discovering that at subscribe time hides the real cause.
    log.warn('login returned no feedToken — live ticks will be unavailable');
  }

  const session: AngelSession = {
    clientCode,
    apiKey,
    jwtToken:     data.jwtToken,
    refreshToken: data.refreshToken ?? '',
    feedToken:    data.feedToken ?? '',
    loginAt:      Date.now(),
    label:        creds.label,
  };

  // Confirm the account we actually landed in. Cheap, and it catches the case
  // where a client code was edited in Supabase but the API key still belongs to
  // a different account — which otherwise shows up as an empty position book.
  try {
    const profile = await smartCall<ProfileData>(
      'GET', PROFILE_PATH, authHeaders(headers, session.jwtToken),
    );
    const confirmed = String(profile.clientcode ?? '').trim();
    if (confirmed && confirmed.toUpperCase() !== clientCode.toUpperCase()) {
      log.warn(`logged in as ${confirmed}, not ${clientCode} — using ${confirmed}`);
      session.clientCode = confirmed;
    }
  } catch (err) {
    // A profile failure is not a login failure. The session works.
    log.warn(`getProfile failed (session is still valid): ${(err as Error).message}`);
  }

  log.info(`logged in as ${session.clientCode} (${session.label})`);
  return session;
}

/**
 * Cheap liveness probe. Used by `ping()` and by the health prober.
 *
 * getRMS is the right call for this: it is authenticated, it is rate-limited
 * generously enough to poll, and it does not mutate anything.
 */
export async function verify(session: AngelSession): Promise<void> {
  await smartCall(
    'GET', RMS_PATH,
    authHeaders(smartHeaders(session.apiKey), session.jwtToken),
  );
}

/** Best-effort logout. A failure here does not matter — the token still expires. */
export async function logout(session: AngelSession): Promise<void> {
  try {
    await smartCall('POST', LOGOUT_PATH,
      authHeaders(smartHeaders(session.apiKey), session.jwtToken),
      { clientcode: session.clientCode });
  } catch {
    /* the session is being discarded either way */
  }
}
