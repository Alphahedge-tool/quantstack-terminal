/**
 * Zerodha session — headless login without a browser popup.
 *
 * Kite Connect has no login endpoint. The documented flow is: send the user to
 * kite.zerodha.com, they log in, Kite redirects back with a `request_token`, and
 * you exchange that for an `access_token`. That needs a human and a browser,
 * which a terminal that auto-logs-in at boot cannot have.
 *
 * So the web login is driven directly over `fetch` with a cookie jar:
 *
 *   1. GET  /connect/login?api_key=…      seeds cookies + sess_id
 *   2. POST /api/login    {user_id, password}          → request_id
 *   3. POST /api/twofa    {request_id, twofa_value}    → cookies are now authorised
 *   4. GET  /connect/login…&skip_session=true          → redirect carrying request_token
 *   5. POST /session/token {api_key, request_token, checksum} → access_token
 *
 * Step 4 is the one with a trap: the redirect chain must be walked MANUALLY.
 * `fetch` would not replay our cookies across hops, and following the final hop
 * would deliver the request_token to the registered redirect URL — which Kite
 * honours exactly once, so the token would be spent before step 5 sees it.
 *
 * ── The one thing that cannot be automated ──
 *
 * The very first time an account connects to an app, Kite parks the user on an
 * "Authorize" screen that only clears when a human clicks it. There is no
 * headless path. That case is detected and reported as `needsAuthorize` so the
 * UI can show the popup once; every later login is headless.
 */

import crypto from 'node:crypto';

import { FeedError } from '../../errors.js';
import { generateTOTP, msUntilNextWindow, nearWindowEdge } from '../../../lib/totp.js';
import { credentialsFor, type BrokerCredentials } from '../../../lib/credentialStore.js';

import { logger } from '../../../lib/logger.js';

const log = logger('zerodha');

const KITE_API = 'https://api.kite.trade';
const KITE_WEB = 'https://kite.zerodha.com';

/** Kite's web login rejects obvious bot user-agents. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const TIMEOUT_MS = 20_000;

export interface ZerodhaSession {
  apiKey:      string;
  accessToken: string;
  userId:      string;
  loginAt:     number;
  label:       string;
}

/** Raised when Kite needs the one-time human "Authorize" click. */
export class NeedsAuthorizeError extends FeedError {
  readonly loginUrl: string;
  constructor(loginUrl: string) {
    super(
      'AUTH',
      'Zerodha needs a one-time app authorization: open the Kite login page once and click '
      + '"Authorize". Auto-login runs headless from then on.',
      { feedId: 'zerodha' },
    );
    this.loginUrl = loginUrl;
  }
}

// ── Cookie jar ───────────────────────────────────────────────────────────────

interface Jar {
  header(): string;
  absorb(res: Response): void;
  names(): string[];
}

function cookieJar(): Jar {
  const jar = new Map<string, string>();
  return {
    header: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    names:  () => [...jar.keys()],
    absorb(res) {
      const lines = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean) as string[];
      for (const line of lines) {
        const pair = line.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    },
  };
}

function jarHeaders(jar: Jar, extra: Record<string, string> = {}): Record<string, string> {
  const cookie = jar.header();
  return { 'User-Agent': USER_AGENT, ...(cookie ? { Cookie: cookie } : {}), ...extra };
}

function requestTokenOf(url: string): string {
  try { return new URL(url).searchParams.get('request_token') || ''; }
  catch { return ''; }
}

export function loginUrl(apiKey: string): string {
  return `${KITE_WEB}/connect/login?v=3&api_key=${encodeURIComponent(apiKey)}`;
}

/**
 * Walk a redirect chain by hand, keeping cookies and STOPPING at the hop that
 * carries a request_token. See the header note on why this cannot use `fetch`'s
 * automatic redirect following.
 */
async function jarGet(jar: Jar, startUrl: string, maxHops = 10): Promise<{ url: string; requestToken: string }> {
  let url = startUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const res = await fetch(url, {
      redirect: 'manual',
      headers: jarHeaders(jar, { Accept: 'text/html,application/xhtml+xml,*/*' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    jar.absorb(res);

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      const token = requestTokenOf(url);
      if (token) return { url, requestToken: token };
      continue;
    }
    if (res.status >= 400) {
      throw new FeedError('TRANSIENT', `Zerodha login page returned HTTP ${res.status}`, { feedId: 'zerodha' });
    }
    return { url, requestToken: requestTokenOf(url) };
  }
  throw new FeedError('TRANSIENT', 'Zerodha login redirected too many times', { feedId: 'zerodha' });
}

interface KiteEnvelope<T> { status?: string; message?: string; error_type?: string; data?: T }

async function jarPost<T>(
  jar: Jar, url: string, form: Record<string, string>, referer?: string,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: jarHeaders(jar, {
      'Content-Type':   'application/x-www-form-urlencoded',
      Accept:           'application/json',
      'X-Kite-Version': '3',
      ...(referer ? { Referer: referer } : {}),
    }),
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  jar.absorb(res);

  const out = await res.json().catch(() => ({})) as KiteEnvelope<T>;
  if (!res.ok || out.status === 'error') {
    throw new FeedError('AUTH', out.message || `Zerodha HTTP ${res.status}`, { feedId: 'zerodha' });
  }
  return out.data as T;
}

// ── 2FA ──────────────────────────────────────────────────────────────────────

/**
 * Kite reports a rejected TOTP generically. The overwhelmingly common cause is
 * the wrong secret — people paste the QR's URL or the app's display name rather
 * than the base32 key — so say so instead of leaving "invalid 2FA" to interpret.
 */
function hintTOTP(err: Error): Error {
  if (!/totp|two.?fa|2fa/i.test(err.message)) return err;
  return new FeedError(
    'AUTH',
    `${err.message} — check the TOTP secret is the base32 key from Kite's External TOTP `
    + 'setup ("Can\'t scan? Copy key"), and that this machine\'s clock is in sync',
    { feedId: 'zerodha' },
  );
}

/**
 * Submit the 2FA code, retrying once if it was minted in the dying seconds of
 * its window. Same reasoning as the Angel adapter: a timing loss and a wrong
 * secret are indistinguishable from the response, and only one of them is worth
 * backing off for.
 */
async function submitTOTP(
  jar: Jar, userId: string, secret: string, requestId: string, twofaType: string | undefined, referer: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const at = Date.now();
    try {
      await jarPost(jar, `${KITE_WEB}/api/twofa`, {
        user_id:     userId,
        request_id:  requestId,
        twofa_value: generateTOTP(secret),
        ...(twofaType ? { twofa_type: twofaType } : {}),
      }, referer);
      return;
    } catch (err) {
      if (attempt > 0 || !nearWindowEdge(at)) throw hintTOTP(err as Error);
      await new Promise((r) => setTimeout(r, msUntilNextWindow(at) + 250));
    }
  }
  throw new FeedError('AUTH', 'Zerodha 2FA failed', { feedId: 'zerodha' });
}

// ── Token exchange ───────────────────────────────────────────────────────────

function checksum(apiKey: string, requestToken: string, apiSecret: string): string {
  return crypto.createHash('sha256').update(`${apiKey}${requestToken}${apiSecret}`).digest('hex');
}

export async function exchangeRequestToken(
  creds: BrokerCredentials, requestToken: string,
): Promise<{ accessToken: string; userId: string }> {
  const apiKey    = String(creds.apiKey ?? '');
  const apiSecret = String(creds.apiSecret ?? '');

  const res = await fetch(`${KITE_API}/session/token`, {
    method: 'POST',
    headers: {
      'Content-Type':   'application/x-www-form-urlencoded',
      'X-Kite-Version': '3',
      Accept:           'application/json',
    },
    body: new URLSearchParams({
      api_key:       apiKey,
      request_token: requestToken,
      checksum:      checksum(apiKey, requestToken, apiSecret),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const out = await res.json().catch(() => ({})) as KiteEnvelope<{ access_token?: string; user_id?: string }>;
  if (!res.ok || out.status === 'error' || !out.data?.access_token) {
    throw new FeedError(
      'AUTH',
      `Zerodha token exchange failed: ${out.message || `HTTP ${res.status}`}`,
      { feedId: 'zerodha' },
    );
  }
  return { accessToken: out.data.access_token, userId: String(out.data.user_id ?? '') };
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function zerodhaCredentials(select?: string): Promise<BrokerCredentials> {
  const creds = await credentialsFor('zerodha', { select });
  if (!creds) {
    throw new FeedError(
      'AUTH',
      'Zerodha credentials missing — need API key, API secret, user ID and TOTP secret in '
      + 'Supabase broker_accounts, or ZERODHA_API_KEY / ZERODHA_API_SECRET / '
      + 'ZERODHA_USER_ID / ZERODHA_TOTP_SECRET in backend/.env. The account password goes '
      + 'in ZERODHA_PASSWORD (or the row\'s pin column).',
      { feedId: 'zerodha' },
    );
  }
  return creds;
}

/** Drive the five-step headless login. */
export async function login(creds: BrokerCredentials): Promise<ZerodhaSession> {
  const apiKey   = String(creds.apiKey ?? '');
  const userId   = String(creds.clientCode ?? '');
  // Kite's WEB login wants the account password, which is not the API secret and
  // not a PIN. It lives in the row's `pin` column for want of a better one.
  const password = String(creds.mpin ?? '') || String(process.env.ZERODHA_PASSWORD ?? '');

  if (!password) {
    throw new FeedError(
      'AUTH',
      'Zerodha headless login needs the Kite account password (ZERODHA_PASSWORD, '
      + 'or the broker_accounts pin column)',
      { feedId: 'zerodha' },
    );
  }

  const jar = cookieJar();

  // 1. Seed cookies.
  const entry = await jarGet(jar, loginUrl(apiKey));

  // 2. Password → request_id.
  const login = await jarPost<{ request_id?: string; twofa_type?: string }>(
    jar, `${KITE_WEB}/api/login`, { user_id: userId, password }, entry.url,
  );
  if (!login?.request_id) {
    throw new FeedError('AUTH', 'Zerodha login did not return a request_id', { feedId: 'zerodha' });
  }

  // 3. TOTP → the jar is now an authorised Kite session.
  await submitTOTP(jar, userId, String(creds.totpSecret ?? ''), login.request_id, login.twofa_type, entry.url);

  // 4. Replay with skip_session so Kite mints a token instead of showing the
  //    "already logged in" interstitial.
  const replay = new URL(entry.url);
  replay.searchParams.set('skip_session', 'true');
  const { url: landed, requestToken } = await jarGet(jar, replay.toString());

  if (!requestToken) {
    if (/\/connect\/(authorize|finish)/.test(landed)) throw new NeedsAuthorizeError(loginUrl(apiKey));
    throw new FeedError(
      'AUTH',
      'Zerodha login succeeded but returned no request_token — check the API key is active and '
      + 'its redirect URL matches the one registered in the Kite developer console',
      { feedId: 'zerodha' },
    );
  }

  // 5. Exchange.
  const { accessToken, userId: confirmed } = await exchangeRequestToken(creds, requestToken);

  log.info(`logged in as ${confirmed || userId} (${creds.label})`);
  return {
    apiKey,
    accessToken,
    userId:  confirmed || userId,
    loginAt: Date.now(),
    label:   creds.label,
  };
}

/**
 * Finish a MANUAL browser login.
 *
 * Kite Connect has no login endpoint; the browser flow ends by redirecting to
 * the app's registered URL with `?request_token=…`, and that token is
 * single-use and short-lived. This turns it into a session, exactly as step 5
 * of the headless login does — so everything downstream cannot tell the two
 * apart.
 *
 * Needed even with headless login working, for the case Zerodha allows no way
 * around: the first time an account connects to an app, Kite parks on an
 * "Authorize" screen that only a human click clears.
 */
export async function sessionFromRequestToken(
  creds: BrokerCredentials, requestToken: string,
): Promise<ZerodhaSession> {
  const { accessToken, userId } = await exchangeRequestToken(creds, requestToken);
  log.info(`logged in as ${userId} (${creds.label}) via browser login`);
  return {
    apiKey:  String(creds.apiKey ?? ''),
    accessToken,
    userId,
    loginAt: Date.now(),
    label:   creds.label,
  };
}

// ── Authenticated calls ──────────────────────────────────────────────────────

export function kiteHeaders(session: ZerodhaSession): Record<string, string> {
  return {
    Accept:           'application/json',
    'X-Kite-Version': '3',
    Authorization:    `token ${session.apiKey}:${session.accessToken}`,
  };
}

/**
 * One Kite REST call.
 *
 * `TokenException` is Kite's expired-session signal and arrives as HTTP 403 —
 * mapped to AUTH so AuthManager re-logs-in rather than the breaker counting it
 * as an outage.
 */
export async function kiteCall<T>(
  session: ZerodhaSession,
  path: string,
  { method = 'GET', query, body }: {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    query?: Record<string, string | number | undefined>;
    body?: Record<string, string>;
  } = {},
): Promise<T> {
  const url = new URL(KITE_API + path);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...kiteHeaders(session),
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body ? new URLSearchParams(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FeedError('TRANSIENT', `Kite ${path}: ${(err as Error).message}`, {
      feedId: 'zerodha', cause: err,
    });
  }

  const out = await res.json().catch(() => ({})) as KiteEnvelope<T>;

  if (!res.ok || out.status === 'error') {
    const type = String(out.error_type ?? '');
    const code = type === 'TokenException' || res.status === 403 ? 'AUTH'
      : res.status === 429 ? 'RATE_LIMIT'
      : res.status >= 500  ? 'TRANSIENT'
      : 'BAD_REQUEST';
    throw new FeedError(code, `Kite ${path}: ${out.message || `HTTP ${res.status}`}`, {
      feedId: 'zerodha', status: res.status,
    });
  }

  return out.data as T;
}
