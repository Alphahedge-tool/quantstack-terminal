/**
 * SmartAPI transport: rate limiting, timeouts, and error classification.
 *
 * Angel enforces per-endpoint request ceilings and answers a burst with a 403
 * that looks nothing like a rate limit. Exceeding them repeatedly gets the API
 * key banned for the day, so the limits are enforced on OUR side, below the
 * documented ceiling, with callers queued rather than rejected.
 *
 * Everything thrown from here is already a FeedError, so the router, the breaker
 * and AuthManager can all read `.code` without knowing Angel exists.
 */

import { FeedError } from '../../errors.js';

export const SMARTAPI_BASE = (process.env.ANGEL_BASE_URL || 'https://apiconnect.angelone.in')
  .replace(/\/+$/, '');

export const SMART_STREAM_URL = process.env.ANGEL_STREAM_URL
  || 'wss://smartapisocket.angelone.in/smart-stream';

/**
 * Per-endpoint requests/second, kept just under Angel's published ceiling.
 *
 * The order books are the tight ones — 1/s — which is why nothing should poll
 * them in a loop; the WebSocket order stream exists for that.
 */
const ENDPOINT_LIMITS: Record<string, number> = {
  '/rest/secure/angelbroking/order/v1/placeOrder':               18,
  '/rest/secure/angelbroking/order/v1/getOrderBook':              1,
  '/rest/secure/angelbroking/order/v1/getTradeBook':              1,
  '/rest/secure/angelbroking/order/v1/getPosition':               1,
  '/rest/secure/angelbroking/portfolio/v1/getAllHolding':         1,
  '/rest/secure/angelbroking/order/v1/details':                   9,
  '/rest/secure/angelbroking/market/v1/quote':                    9,
  '/rest/secure/angelbroking/order/v1/getLtpData':                9,
  // Historical is the tightest endpoint Angel publishes. Measured against a live
  // account: four requests in quick succession, spaced by a 3/s bucket, still
  // returned "Access denied because of exceeding access rate". 1/s holds.
  '/rest/secure/angelbroking/historical/v1/getCandleData':        1,
  '/rest/secure/angelbroking/marketData/v1/optionGreek':          9,
  '/rest/secure/angelbroking/user/v1/getRMS':                     2,
};
const DEFAULT_LIMIT = 8;

/** Order-details paths carry the id in the URL; they share one bucket. */
function limitKey(endpoint: string): string {
  const details = '/rest/secure/angelbroking/order/v1/details';
  return endpoint.startsWith(details) ? details : endpoint;
}

/** Token bucket: refills `rate` tokens/sec up to `burst`; `wait()` queues. */
class RateLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private readonly rate: number, private readonly burst: number) {
    this.tokens = burst;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
  }

  async wait(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) { this.tokens -= 1; return; }
    const needed = (1 - this.tokens) / this.rate;
    await new Promise((r) => setTimeout(r, Math.ceil(needed * 1000)));
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

const limiters = new Map<string, RateLimiter>();

function limiterFor(endpoint: string): RateLimiter {
  const key = limitKey(endpoint);
  let lim = limiters.get(key);
  if (!lim) {
    const rate = ENDPOINT_LIMITS[key] ?? DEFAULT_LIMIT;
    lim = new RateLimiter(rate, Math.max(1, Math.floor(rate)));
    limiters.set(key, lim);
  }
  return lim;
}

// ── Headers ──────────────────────────────────────────────────────────────────

/**
 * SmartAPI's mandatory client-identity headers.
 *
 * The IP and MAC headers are required but not validated — Angel only checks
 * they are present and well-formed. Defaults are deliberately loopback rather
 * than a real interface address: this is not authentication, and enumerating
 * network interfaces to satisfy a header would leak the host's LAN address to
 * the broker for no benefit.
 */
export function smartHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type':     'application/json',
    Accept:             'application/json',
    'X-UserType':       'USER',
    'X-SourceID':       'WEB',
    'X-ClientLocalIP':  process.env.ANGEL_LOCAL_IP  || '127.0.0.1',
    'X-ClientPublicIP': process.env.ANGEL_PUBLIC_IP || '127.0.0.1',
    'X-MACAddress':     process.env.ANGEL_MAC_ADDRESS || '00:00:00:00:00:00',
    'X-PrivateKey':     apiKey,
  };
}

export function authHeaders(base: Record<string, string>, jwt: string): Record<string, string> {
  return { ...base, Authorization: `Bearer ${jwt}` };
}

// ── Envelope ─────────────────────────────────────────────────────────────────

export interface SmartEnvelope<T = unknown> {
  status?:    boolean;
  message?:   string;
  errorcode?: string;
  data?:      T;
}

/**
 * Angel error codes that mean "this session is finished".
 *
 * Necessary because SmartAPI answers an expired token with HTTP 200 and
 * `status: false`. Without this table an expired JWT classifies as a generic
 * failure, AuthManager never re-logs-in, and the feed stays dead until restart.
 */
const AUTH_ERROR_CODES = new Set([
  'AG8001',  // invalid token
  'AG8002',  // token expired
  'AG8003',  // token missing
  'AB8050',  // invalid refresh token
  'AB8051',  // refresh token expired
  'AB1010',  // session expired / not logged in
]);

const RATE_ERROR_CODES = new Set(['AB1004', 'AB2002']);

const FEED_ID = 'angel';

/** Turn a `status: false` envelope into the right FeedError. */
function envelopeError(body: SmartEnvelope, endpoint: string): FeedError {
  const code    = String(body.errorcode ?? '').toUpperCase();
  const message = `${body.message || 'SmartAPI request failed'}`
    + `${code ? ` [${code}]` : ''} (${endpoint})`;

  if (AUTH_ERROR_CODES.has(code)) return new FeedError('AUTH', message, { feedId: FEED_ID });
  if (RATE_ERROR_CODES.has(code)) return new FeedError('RATE_LIMIT', message, { feedId: FEED_ID });
  return new FeedError('BAD_REQUEST', message, { feedId: FEED_ID });
}

const TIMEOUT_MS = 20_000;

/**
 * One rate-limited SmartAPI call.
 *
 * Returns the envelope's `data`. A `status: false` body throws, so callers never
 * have to check both an HTTP status and an envelope flag.
 */
export async function smartCall<T = unknown>(
  method: 'GET' | 'POST',
  endpoint: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<T> {
  await limiterFor(endpoint).wait();

  let res: Response;
  try {
    res = await fetch(SMARTAPI_BASE + endpoint, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Timeouts and socket failures are transient by definition — let the breaker
    // count them rather than reporting a broken request.
    throw new FeedError('TRANSIENT', `SmartAPI ${endpoint}: ${(err as Error).message}`, {
      feedId: FEED_ID, cause: err,
    });
  }

  const text = await res.text();
  let parsed: SmartEnvelope<T> = {};
  if (text) {
    try { parsed = JSON.parse(text) as SmartEnvelope<T>; }
    catch { parsed = { message: text.slice(0, 200) }; }
  }

  if (!res.ok) {
    const message = parsed.message || `HTTP ${res.status}`;

    /**
     * Angel answers a BURST with 403 and "Access denied because of exceeding
     * access rate" — the same status it uses for a bad token.
     *
     * Reading that as AUTH is actively harmful. getOrderBook and getPosition
     * are capped at one request per second each, so a busy screen trips it
     * routinely; the books then report `code: AUTH`, the UI says the account is
     * not signed in, and anything that reacts to AUTH by dropping the session
     * throws away a perfectly good login and re-runs TOTP — turning a 200 ms
     * back-off into a re-authentication storm against the endpoint that was
     * already asking us to slow down.
     *
     * The message is the only thing that separates the two cases at this layer,
     * so it is what decides.
     */
    const rateLimited = /access rate|rate limit|too many requests/i.test(message);

    throw new FeedError(
      rateLimited                                  ? 'RATE_LIMIT'
        : res.status === 401 || res.status === 403 ? 'AUTH'
        : 'TRANSIENT',
      `SmartAPI ${endpoint}: ${message}`,
      { feedId: FEED_ID, status: res.status },
    );
  }

  if (parsed.status === false) throw envelopeError(parsed, endpoint);

  return (parsed.data ?? ({} as T)) as T;
}
