/**
 * Feed error taxonomy.
 *
 * Failover is only correct if the router can tell "this broker is broken" from
 * "this data does not exist". Without that distinction every genuinely missing
 * symbol costs one round-trip per configured feed, on every request.
 *
 * Adapters throw FeedError. The router reads `.code` and nothing else.
 */

export type FeedErrorCode =
  | 'AUTH'          // 401 / 440 — session expired, TOTP rejected, not logged in
  | 'RATE_LIMIT'    // 429, and Nubra's gateway 403 on request bursts
  | 'TRANSIENT'     // 5xx, timeout, socket reset — retry may succeed
  | 'UNSUPPORTED'   // this feed cannot serve this request at all
  | 'NOT_FOUND'     // symbol/date genuinely carries no data here
  | 'BAD_REQUEST'   // our bug — malformed request
  | 'INTERNAL';     // unclassified

export class FeedError extends Error {
  readonly code:   FeedErrorCode;
  readonly feedId: string;
  readonly status?: number;

  constructor(
    code: FeedErrorCode,
    message: string,
    opts: { feedId?: string; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name   = 'FeedError';
    this.code   = code;
    this.feedId = opts.feedId ?? 'unknown';
    this.status = opts.status;
  }

  /** Worth retrying against the SAME feed (the adapter's own backoff). */
  get retryable(): boolean {
    return this.code === 'TRANSIENT' || this.code === 'RATE_LIMIT';
  }

  /**
   * Worth trying the NEXT feed.
   *
   * NOT_FOUND and BAD_REQUEST are deliberately excluded — the data is absent or
   * the request is wrong, and neither improves by asking a different broker.
   */
  get shouldFailover(): boolean {
    return this.code === 'TRANSIENT'
        || this.code === 'RATE_LIMIT'
        || this.code === 'UNSUPPORTED'
        || this.code === 'AUTH';
  }

  /** Counts toward tripping the circuit breaker. */
  get countsAsFailure(): boolean {
    // UNSUPPORTED is a capability mismatch, not a fault — a feed that simply
    // does not carry MCX must not be marked unhealthy for saying so.
    return this.code === 'TRANSIENT' || this.code === 'RATE_LIMIT';
  }
}

// ── HTTP status → code ───────────────────────────────────────────────────────

// Mirrors the RETRYABLE set in lib/nubraData.ts. 403 is a burst rejection from
// Nubra's gateway, NOT an authorisation failure — classifying it as AUTH would
// trigger a pointless re-login (and a TOTP call) on every rate-limited batch.
const RATE_LIMIT_STATUS = new Set([403, 408, 425, 429]);
const TRANSIENT_STATUS  = new Set([500, 502, 503, 504]);

function codeForStatus(status: number): FeedErrorCode {
  if (status === 401 || status === 440) return 'AUTH';
  if (RATE_LIMIT_STATUS.has(status))    return 'RATE_LIMIT';
  if (TRANSIENT_STATUS.has(status))     return 'TRANSIENT';
  if (status === 404)                   return 'NOT_FOUND';
  if (status >= 400 && status < 500)    return 'BAD_REQUEST';
  if (status >= 500)                    return 'TRANSIENT';
  return 'INTERNAL';
}

/**
 * Wrap any thrown value as a FeedError.
 *
 * Understands the shapes the existing Nubra code throws: NubraAuthError and
 * NubraDataError both carry `.status`, and NubraDataError's message is prefixed
 * `"<status>: "` (see lib/nubraData.ts nubraFetch).
 */
export function classify(err: unknown, feedId: string): FeedError {
  if (err instanceof FeedError) return err;

  const e       = err as { name?: string; message?: string; status?: number };
  const message = String(e?.message ?? err ?? 'Unknown feed error');

  // AbortSignal.timeout() rejects with TimeoutError; fetch abort with AbortError.
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    return new FeedError('TRANSIENT', message, { feedId, cause: err });
  }

  // Undici network failures surface as a bare TypeError('fetch failed').
  if (e?.name === 'TypeError' && /fetch failed|network|socket|ECONN/i.test(message)) {
    return new FeedError('TRANSIENT', message, { feedId, cause: err });
  }

  const status = Number.isFinite(e?.status)
    ? Number(e!.status)
    : Number(message.match(/^(\d{3}):/)?.[1] ?? NaN);

  if (Number.isFinite(status)) {
    return new FeedError(codeForStatus(status), message, { feedId, status, cause: err });
  }

  if (e?.name === 'NubraAuthError' || /not logged in|session/i.test(message)) {
    return new FeedError('AUTH', message, { feedId, cause: err });
  }

  return new FeedError('INTERNAL', message, { feedId, cause: err });
}

/** HTTP status to hand back to the browser for a given feed failure. */
export function httpStatusFor(code: FeedErrorCode): number {
  switch (code) {
    case 'AUTH':        return 401;
    case 'RATE_LIMIT':  return 429;
    case 'TRANSIENT':   return 502;
    case 'UNSUPPORTED': return 501;
    case 'NOT_FOUND':   return 404;
    case 'BAD_REQUEST': return 400;
    default:            return 500;
  }
}
