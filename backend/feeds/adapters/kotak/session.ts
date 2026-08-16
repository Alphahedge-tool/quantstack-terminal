/**
 * Kotak Neo session — headless, in two steps.
 *
 * Kotak is the other broker besides Angel that can be logged in entirely from a
 * server. It just takes two calls, and the distinction between them matters:
 *
 *   1. tradeApiLogin     mobile + UCC + TOTP  → a VIEW token and a sid
 *   2. tradeApiValidate  the MPIN, carrying that view token → the TRADE token
 *
 * Only the trade token authorises trading and portfolio calls. The view token
 * looks like a working session and quietly fails on anything that matters, so
 * step 2 is not optional.
 *
 * The response to step 2 also carries `baseUrl` — the data-centre host this
 * account must use for every later call. It is NOT the same for every account,
 * which is why it lives in the session rather than in a constant.
 */

import { FeedError } from '../../errors.js';
import { generateTOTP } from '../../../lib/totp.js';
import { credentialsFor, type BrokerCredentials } from '../../../lib/credentialStore.js';

const LOGIN_URL    = 'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin';
const VALIDATE_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiValidate';

/**
 * Required on every Kotak call. Not a secret and not per-account — the same
 * constant for every caller. Omitting it fails with "Missing required field
 * 'NeoFinKey'", which reads like a credential problem and is not.
 */
const NEO_FIN_KEY = 'neotradeapi';

const TIMEOUT_MS = 20_000;

export interface KotakSession {
  /** The token that authorises trading. Not the view token. */
  tradeToken: string;
  sid:        string;
  /** This account's data-centre host. Required for every later call. */
  baseUrl:    string;
  ucc:        string;
  serverId:   string;
  loginAt:    number;
  label:      string;
}

interface KotakBody {
  status?:  string;
  message?: string;
  data?:    Record<string, unknown>;
  error?:   Array<{ message?: string }>;
  fault?:   { message?: string };
}

/** Kotak nests the payload under `data` on some responses and returns it flat on others. */
function dataOf(body: KotakBody): Record<string, unknown> {
  return (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
}

function str(v: unknown): string {
  return String(v ?? '').trim();
}

/**
 * POST a Kotak JSON endpoint.
 *
 * Kotak answers a FAILED login with HTTP 200 and `status: "error"` in the body,
 * so the HTTP status alone cannot be trusted — the same trap as SmartAPI, and
 * the reason both adapters check the envelope explicitly.
 */
async function postJSON(
  url: string, headers: Record<string, string>, body: unknown,
): Promise<KotakBody> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept:         'application/json',
        'neo-fin-key':  NEO_FIN_KEY,
        ...headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FeedError('TRANSIENT', `Kotak ${url}: ${(err as Error).message}`, {
      feedId: 'kotak', cause: err,
    });
  }

  const text = await res.text();
  let out: KotakBody = {};
  if (text) {
    try { out = JSON.parse(text) as KotakBody; }
    catch { out = { message: text.slice(0, 200) }; }
  }

  if (!res.ok || out.status === 'error') {
    const message = out.message
      || out.error?.[0]?.message
      || out.fault?.message
      || `Kotak HTTP ${res.status}`;
    throw new FeedError(
      res.status >= 500 ? 'TRANSIENT' : 'AUTH',
      `Kotak: ${message}`,
      { feedId: 'kotak', status: res.status },
    );
  }
  return out;
}

export async function kotakCredentials(select?: string): Promise<BrokerCredentials> {
  const creds = await credentialsFor('kotak', { select });
  if (!creds) {
    throw new FeedError(
      'AUTH',
      'Kotak credentials missing — need the Neo access token (api_key), UCC, mobile number, '
      + 'MPIN and TOTP secret in Supabase broker_accounts, or KOTAK_API_KEY / '
      + 'KOTAK_CLIENT_CODE / KOTAK_PHONE / KOTAK_MPIN / KOTAK_TOTP_SECRET in backend/.env',
      { feedId: 'kotak' },
    );
  }
  return creds;
}

export async function login(creds: BrokerCredentials): Promise<KotakSession> {
  const ucc         = str(creds.clientCode);
  // Kotak's "access token" is a long-lived per-app credential, stored in the
  // api_key column alongside every other broker's key.
  const accessToken = str(creds.apiKey);
  const mobile      = str(creds.phone);

  const missing = [
    !ucc && 'UCC', !accessToken && 'access token',
    !mobile && 'mobile number', !creds.mpin && 'MPIN', !creds.totpSecret && 'TOTP secret',
  ].filter(Boolean);
  if (missing.length) {
    throw new FeedError('AUTH', `Kotak login needs ${missing.join(', ')}`, { feedId: 'kotak' });
  }

  // 1. View token.
  const loginBody = dataOf(await postJSON(
    LOGIN_URL,
    { Authorization: accessToken },
    { mobileNumber: mobile, ucc, totp: generateTOTP(creds.totpSecret) },
  ));

  const viewToken = str(loginBody.token);
  const viewSid   = str(loginBody.sid);
  if (!viewToken || !viewSid) {
    throw new FeedError('AUTH', 'Kotak login returned no view token/sid', { feedId: 'kotak' });
  }

  // 2. MPIN → trade token.
  const validated = dataOf(await postJSON(
    VALIDATE_URL,
    { Authorization: accessToken, sid: viewSid, Auth: viewToken },
    { mpin: creds.mpin },
  ));

  const tradeToken = str(validated.token);
  if (!tradeToken) {
    throw new FeedError('AUTH', 'Kotak MPIN validation returned no trade token', { feedId: 'kotak' });
  }

  const baseUrl = str(validated.baseUrl).replace(/\/+$/, '');
  if (!baseUrl) {
    // Without the data-centre host nothing after login can be addressed. Fail
    // here rather than at the first portfolio call, where it would look like a
    // routing bug in this codebase.
    throw new FeedError(
      'AUTH', 'Kotak validation returned no baseUrl — cannot address this account\'s data centre',
      { feedId: 'kotak' },
    );
  }

  console.log(`[kotak] logged in as ${ucc} (${creds.label}) via ${baseUrl}`);
  return {
    tradeToken,
    sid:      str(validated.sid) || viewSid,
    baseUrl,
    ucc,
    serverId: str(validated.hsServerId) || str(validated.serverId),
    loginAt:  Date.now(),
    label:    creds.label,
  };
}

/**
 * One authenticated Kotak call.
 *
 * Kotak's reporting endpoints take their payload as a form-encoded `jData`
 * field holding JSON — not a JSON body. Sending JSON gets a 200 with an empty
 * result rather than an error.
 */
export async function kotakCall<T>(
  session: KotakSession,
  path: string,
  { method = 'GET', jData }: { method?: 'GET' | 'POST'; jData?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${session.baseUrl}${path}`, {
      method,
      headers: {
        Accept:         'application/json',
        Sid:            session.sid,
        Auth:           session.tradeToken,
        'neo-fin-key':  NEO_FIN_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: jData == null ? undefined : new URLSearchParams({ jData: JSON.stringify(jData) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new FeedError('TRANSIENT', `Kotak ${path}: ${(err as Error).message}`, {
      feedId: 'kotak', cause: err,
    });
  }

  const text = await res.text();
  let out: KotakBody = {};
  if (text) {
    try { out = JSON.parse(text) as KotakBody; }
    catch {
      throw new FeedError('TRANSIENT', `Kotak ${path}: invalid response (HTTP ${res.status})`, {
        feedId: 'kotak', status: res.status,
      });
    }
  }

  if (!res.ok || out.status === 'error') {
    const message = out.message || out.error?.[0]?.message || `HTTP ${res.status}`;
    throw new FeedError(
      res.status === 401 || res.status === 403 ? 'AUTH'
        : res.status >= 500 ? 'TRANSIENT' : 'BAD_REQUEST',
      `Kotak ${path}: ${message}`,
      { feedId: 'kotak', status: res.status },
    );
  }

  return (out.data ?? out) as T;
}
