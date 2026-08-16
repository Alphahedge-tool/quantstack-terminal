/**
 * HTTP client for the qt-backend service.
 *
 * The backend's contract (backend/server.ts) is uniform and worth encoding once
 * here rather than at every call site:
 *
 *   • Every response is JSON with a `status` boolean.
 *   • `status: false` means the REQUEST failed; `message` says why and `code`
 *     is the field to branch on. Matching on message text works right up until
 *     a second broker words its failures differently.
 *   • A non-2xx carries the same shape, so one parser covers both.
 *   • `FEED_AUTH_REQUIRED` is the signal that the user must sign in again —
 *     it is surfaced as a distinct flag so the shell can route to login instead
 *     of painting a generic error banner.
 */

import { z } from 'zod';

/** Vite proxies `/api` to the backend in dev; in production this is same-origin. */
const BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiFailure extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly feed: string | undefined;

  constructor(message: string, status: number, code?: string, feed?: string) {
    super(message);
    this.name = 'ApiFailure';
    this.status = status;
    this.code = code;
    this.feed = feed;
  }

  /** The session is gone — the useful UI is a sign-in prompt, not an error. */
  get isAuth(): boolean {
    return this.code === 'FEED_AUTH_REQUIRED' || this.status === 401;
  }
}

/**
 * Thrown when the backend answered successfully but not in the shape we parse.
 * Kept distinct from ApiFailure: one is the service saying no, the other is a
 * contract drift between the two repos, and they want different fixes.
 */
export class SchemaFailure extends Error {
  readonly issues: z.ZodIssue[];
  constructor(path: string, issues: z.ZodIssue[]) {
    super(`Unexpected response shape from ${path}`);
    this.name = 'SchemaFailure';
    this.issues = issues;
  }
}

const errorEnvelope = z.object({
  status: z.literal(false).optional(),
  message: z.string().optional(),
  code: z.string().optional(),
  feed: z.string().optional(),
});

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return `${BASE}${path}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    // Skip empties rather than sending `?expiry=` — several backend routes
    // treat a present-but-blank param as a real filter and return nothing.
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${BASE}${path}?${qs}` : `${BASE}${path}`;
}

/**
 * One request, validated against `schema`.
 *
 * Validation is not defensive decoration: these payloads cross a repo boundary
 * and the two sides deploy independently. Parsing at the edge means a drift
 * shows up here, named, instead of as `undefined is not an object` three
 * components deep during a fast market.
 */
/*
 * Generic over the SCHEMA, not over its output type.
 *
 * `z.ZodType<T>` pins input and output to the same `T`, so a schema using
 * `.default()` would infer `T` from its INPUT side — every defaulted field
 * coming back optional and every consumer having to re-guard a field the parse
 * guarantees. Taking `S extends z.ZodTypeAny` and returning `z.infer<S>` gives
 * the parsed output, which is the whole point of parsing.
 */
export async function request<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  options: RequestOptions = {},
): Promise<z.infer<S>> {
  const { method = 'GET', body, query, signal } = options;

  const init: RequestInit = { method, signal, headers: {} };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), init);
  } catch (err) {
    // An aborted request is the caller changing its mind, not a failure.
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiFailure(
      'Cannot reach the backend. Is qt-backend running on port 3101?',
      0,
      'NETWORK',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiFailure(
      `${path} returned a non-JSON body (HTTP ${response.status})`,
      response.status,
      'BAD_BODY',
    );
  }

  // The backend puts failures in the body even on a 200 — check both.
  const envelope = errorEnvelope.safeParse(payload);
  const failed =
    !response.ok ||
    (envelope.success && envelope.data.status === false);

  if (failed) {
    const info = envelope.success ? envelope.data : {};
    throw new ApiFailure(
      info.message || `Request to ${path} failed (HTTP ${response.status})`,
      response.status,
      info.code,
      info.feed,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new SchemaFailure(path, parsed.error.issues);
  return parsed.data;
}

export const api = {
  get: <S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<z.infer<S>> => request(path, schema, { ...opts, method: 'GET' }),

  post: <S extends z.ZodTypeAny>(
    path: string,
    schema: S,
    body?: unknown,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<z.infer<S>> => request(path, schema, { ...opts, method: 'POST', body }),
};
