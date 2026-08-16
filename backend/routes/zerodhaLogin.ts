/**
 * Zerodha's MANUAL browser login.
 *
 *   GET  /api/brokers/zerodha/login-url   → { loginUrl }
 *   GET  /api/brokers/zerodha/callback    ← Kite redirects here with ?request_token=…
 *   POST /api/brokers/zerodha/callback    { request_token }  (paste-it-in fallback)
 *
 * ── Why a manual path exists at all when auto-login works ──
 *
 * Kite Connect has no login endpoint. The headless login in
 * `feeds/adapters/zerodha/session.ts` works around that by driving
 * kite.zerodha.com's own web login over fetch(), and it covers the daily case
 * completely. But there is one state Zerodha allows no way around: the FIRST
 * time an account connects to an API app, Kite parks on an "Authorize" screen
 * that clears only when a human clicks it. 2FA has already passed at that
 * point, so the failure is not a credential problem and no amount of retrying
 * fixes it — the adapter raises `NeedsAuthorizeError`, and this is where that
 * click happens. Afterwards every login is headless again.
 *
 * It is also the escape hatch when the web login changes shape, which it has
 * done before: the browser flow is Zerodha's supported path and cannot break in
 * the same way.
 *
 * ── The request token is single-use ──
 *
 * Kite honours a `request_token` exactly once and for a few minutes. Both the
 * GET and the POST therefore exchange it immediately and install the resulting
 * session; there is no "store it and use it later".
 */

import { route, readJSON, ApiError } from '../server.js';
import { feedById } from '../feeds/registry.js';
import { ZerodhaFeed } from '../feeds/adapters/zerodha/index.js';
import { loginUrl, sessionFromRequestToken } from '../feeds/adapters/zerodha/session.js';
import {
  listBrokerAccounts, normalizeBroker, type BrokerCredentials,
} from '../lib/credentialStore.js';

/**
 * The two credentials the BROWSER flow actually needs.
 *
 * Deliberately not `zerodhaCredentials()`, which requires the complete headless
 * set — user id, password and TOTP secret. Those are what the browser login
 * exists to avoid needing: the human supplies them to Kite directly. Demanding
 * them here would block the manual path on exactly the accounts that need it,
 * which is what happens with a row that has no TOTP secret stored.
 *
 *   api_key     identifies the app, and builds the login URL
 *   api_secret  signs the request-token exchange (sha256 of key+token+secret)
 */
async function browserCreds(): Promise<BrokerCredentials> {
  const row = (await listBrokerAccounts()).find(
    (r) => normalizeBroker(r.broker) === 'zerodha' && r.enabled,
  );

  const apiKey    = String(row?.api_key    ?? process.env.ZERODHA_API_KEY    ?? '').trim();
  const apiSecret = String(row?.api_secret ?? process.env.ZERODHA_API_SECRET ?? '').trim();

  const missing: string[] = [];
  if (!apiKey)    missing.push('API key');
  if (!apiSecret) missing.push('API secret');
  if (missing.length) {
    throw new ApiError(
      `Zerodha browser login needs ${missing.join(' and ')} in broker_accounts `
      + '(or ZERODHA_API_KEY / ZERODHA_API_SECRET in backend/.env).',
      400,
    );
  }

  return {
    broker:     'zerodha',
    apiKey,
    apiSecret,
    clientCode: String(row?.client_code ?? row?.username ?? '').trim() || undefined,
    phone:      '',
    mpin:       '',
    totpSecret: '',
    label:      String(row?.alias ?? row?.client_code ?? 'zerodha'),
    source:     row ? 'supabase' : 'env',
  };
}

/** The configured Zerodha feed, or a 404 explaining why there is none. */
function zerodhaFeed(id = 'zerodha'): ZerodhaFeed {
  const feed = feedById(id);
  if (!(feed instanceof ZerodhaFeed)) {
    throw new ApiError(
      `No Zerodha feed is configured. Add "zerodha" to QT_FEEDS in backend/.env and restart.`,
      404,
    );
  }
  return feed;
}

/**
 * The URL to open in a browser.
 *
 * Read from the stored credentials rather than taken as a parameter: the api
 * key identifies which app the token will belong to, and letting a caller pass
 * one would allow minting a session for an app the server cannot then use.
 */
route('GET', '/api/brokers/zerodha/login-url', async () => {
  const creds = await browserCreds();
  return {
    status: true,
    loginUrl: loginUrl(String(creds.apiKey)),
    message: 'Open this in a browser, sign in, and approve. You will be redirected back '
      + 'with a request_token — paste it here if the redirect does not reach this server.',
  };
});

/** Exchange a request token and install the session. */
async function finish(requestToken: string, feedId: string) {
  if (!requestToken) throw new ApiError('request_token is required', 400);

  const creds = await browserCreds();
  const feed = zerodhaFeed(feedId);

  const session = await sessionFromRequestToken(creds, requestToken);
  await feed.adoptSession(session);

  return {
    status: true,
    broker: 'zerodha',
    userId: session.userId,
    message: `Signed in as ${session.userId}. Auto-login runs headless from now on.`,
  };
}

/**
 * Kite's redirect target.
 *
 * Returns HTML rather than JSON: a human is looking at this tab, having just
 * been bounced here by the broker. A raw JSON body would read as an error even
 * on success.
 */
async function handleCallback(
  _req: unknown,
  res: import('node:http').ServerResponse,
  ctx: { query: URLSearchParams },
) {
  const requestToken = String(ctx.query.get('request_token') ?? '');
  const feedId = String(ctx.query.get('feed') ?? 'zerodha');

  let title: string;
  let detail: string;
  try {
    const out = await finish(requestToken, feedId);
    title = 'Zerodha connected';
    detail = out.message;
  } catch (err) {
    title = 'Zerodha login failed';
    detail = (err as Error).message;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8">`
    + `<title>${title}</title>`
    + `<body style="font:15px system-ui;background:#0b0d10;color:#e6e9ef;padding:48px">`
    + `<h2 style="margin:0 0 8px">${title}</h2>`
    + `<p style="color:#9aa4b2;margin:0">${detail}</p>`
    + `<p style="color:#9aa4b2;margin:24px 0 0">You can close this tab.</p>`
    + `</body>`,
  );
  // Already written — tell the server not to serialise a JSON body on top.
  return undefined;
}

route('GET', '/api/brokers/zerodha/callback', handleCallback);

/**
 * The path Kite developer consoles are usually already pointed at.
 *
 * Zerodha's redirect URL is registered per API app on their site, and existing
 * apps here are registered against `/zerodha/callback` — the path the earlier
 * admin console used. Accepting it too means the only thing that has to change
 * on Zerodha's side is the PORT, and an app registered for a sibling project
 * keeps working rather than dead-ending on ERR_CONNECTION_REFUSED with a valid,
 * single-use token stranded in the address bar.
 */
route('GET', '/zerodha/callback', handleCallback);

/**
 * Paste-in fallback.
 *
 * The registered redirect URL often points somewhere this server is not — a
 * production domain, or `https://127.0.0.1` with no listener. Rather than
 * require the Kite developer console to be reconfigured before anyone can log
 * in, the token can be lifted out of the address bar and posted here.
 */
route('POST', '/api/brokers/zerodha/callback', async (req) => {
  const body = await readJSON<{ request_token?: string; requestToken?: string; feed?: string }>(req);
  const token = String(body.request_token ?? body.requestToken ?? '').trim();
  return finish(token, String(body.feed ?? 'zerodha'));
});
