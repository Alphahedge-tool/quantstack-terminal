/**
 * QuantStack Backend — HTTP server skeleton.
 * Plain node:http, zero framework dependencies.
 * Same pattern as Alphahedge's server.js but in TypeScript.
 */

import http from 'node:http';
import zlib from 'node:zlib';
import { FeedError, httpStatusFor } from './feeds/errors.js';

import { logger } from './lib/logger.js';
import {
  httpRequests, httpDuration, httpInFlight, scrape, contentType,
} from './lib/metrics.js';

const log = logger('qt-backend');

const PORT = Number(process.env.QT_BACKEND_PORT || 3101);

// A straddle session is ~22.5k points; as raw JSON that's several MB of mostly
// digits, which gzip crushes by an order of magnitude. Below this size the
// compression costs more than the transfer saves.
const GZIP_MIN_BYTES = 8 * 1024;

// ─── Route table ──────────────────────────────────────────────────────────────

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { url: URL; query: URLSearchParams },
) => Promise<unknown> | unknown;

const routes = new Map<string, RouteHandler>();

export function route(method: string, path: string, handler: RouteHandler): void {
  routes.set(`${method.toUpperCase()} ${path}`, handler);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export async function readJSON<T = Record<string, unknown>>(
  req: http.IncomingMessage,
): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new ApiError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ApiError('Invalid JSON body', 400);
  }
}

function writeJSON(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  acceptEncoding = '',
): void {
  const text = JSON.stringify(body ?? null);
  const raw  = Buffer.from(text, 'utf8');

  if (raw.length >= GZIP_MIN_BYTES && /\bgzip\b/i.test(acceptEncoding)) {
    // Level 1: on payloads this repetitive the extra levels buy a few percent
    // for several times the CPU, and CPU here is latency the client waits on.
    const packed = zlib.gzipSync(raw, { level: 1 });
    res.writeHead(status, {
      'Content-Type':     'application/json',
      'Content-Encoding': 'gzip',
      'Content-Length':   packed.length,
      Vary:               'Accept-Encoding',
    });
    res.end(packed);
    return;
  }

  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': raw.length,
  });
  res.end(raw);
}

// ─── Error shaping ────────────────────────────────────────────────────────────

/**
 * HTTP status for a thrown value.
 *
 * FeedError carries a semantic code rather than a status — an expired session
 * is AUTH whether the broker said 401 or 440 — so it maps through
 * httpStatusFor. Without this an unauthenticated request would surface as a
 * 500 and the browser would show "internal error" instead of sending the user
 * to the login page.
 */
export function errorStatus(err: unknown): number {
  if (err instanceof ApiError) return err.status;
  if (err instanceof FeedError) return httpStatusFor(err.code);
  const s = (err as { status?: number })?.status;
  return Number.isInteger(s) ? s! : 500;
}

/**
 * Response body for a thrown value.
 *
 * `code` is the field clients should branch on. Matching on message text works
 * until a second broker words its failures differently, which is exactly when
 * a silent break would be hardest to spot.
 */
export function errorBody(err: unknown): Record<string, unknown> {
  const body: Record<string, unknown> = {
    status:  false,
    message: (err as Error)?.message || 'Internal error',
  };
  if (err instanceof FeedError) {
    body.code = err.code === 'AUTH' ? 'FEED_AUTH_REQUIRED' : `FEED_${err.code}`;
    body.feed = err.feedId;
  }
  return body;
}

function applyCORS(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-device-id');
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

let boundPort = PORT;
export function getPort(): number { return boundPort; }

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  applyCORS(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url     = new URL(req.url!, `http://localhost:${boundPort}`);
  const key     = `${req.method} ${url.pathname}`;
  const handler = routes.get(key);
  const accept  = String(req.headers['accept-encoding'] || '');

  /**
   * The metrics label is the REGISTERED route, never the raw path.
   *
   * An unrouted request is labelled `unknown` and nothing else. Port scanners,
   * favicon probes and typo'd URLs all land here, and each distinct path would
   * otherwise become a permanent time series — the one way a metrics endpoint
   * can be turned into a memory leak from outside.
   */
  const routeLabel = handler ? url.pathname : 'unknown';
  const method = req.method || 'GET';
  const stop = httpDuration.startTimer({ method, route: routeLabel });
  httpInFlight.inc();

  /**
   * Recorded from `finish`, not from the end of the handler.
   *
   * A route that streams (`/api/straddle/stream`, `/api/backtest/stream`)
   * returns from its handler long before the response is done, and timing to
   * the return would report a multi-second stream as instant.
   */
  let done = false;
  const settle = (status: number) => {
    if (done) return;
    done = true;
    stop();
    httpInFlight.dec();
    httpRequests.inc({ method, route: routeLabel, status: String(status) });
  };
  res.on('close', () => settle(res.statusCode));

  if (!handler) {
    writeJSON(res, 404, { status: false, message: `No route: ${key}` }, accept);
    return;
  }

  try {
    const result = await handler(req, res, { url, query: url.searchParams });
    if (result !== undefined && !res.writableEnded) writeJSON(res, 200, result, accept);
  } catch (err) {
    if (res.writableEnded) return;
    writeJSON(res, errorStatus(err), errorBody(err), accept);
  }
}

// ─── Built-in routes ──────────────────────────────────────────────────────────

route('GET', '/api/health', () => ({
  status: true, service: 'qt-backend', ts: Date.now(), port: boundPort,
}));

/**
 * Prometheus scrape endpoint.
 *
 * Outside `/api/` deliberately: `/metrics` is the conventional path every
 * scraper defaults to, and putting it under the app's own namespace would mean
 * every deployment needs a custom `metrics_path`.
 *
 * It writes its own response rather than returning an object, because the
 * exposition format is text and the route table's default is JSON.
 */
route('GET', '/metrics', async (_req, res) => {
  res.writeHead(200, { 'Content-Type': contentType() });
  res.end(await scrape());
});

// ─── Server ───────────────────────────────────────────────────────────────────

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.writableEnded) {
        writeJSON(res, 500, { status: false, message: (err as Error)?.message || 'Internal error' });
      }
    });
  });
}

export function startServer(port = PORT): http.Server {
  const server = createServer();
  boundPort = port;
  server.listen(port, () => {
    log.info({ port, url: `http://localhost:${port}` }, 'http server listening');
    log.debug({ routes: [...routes.keys()].sort() }, `${routes.size} routes registered`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      /**
       * Exit deliberately rather than rethrowing.
       *
       * A throw from inside an event handler becomes an uncaught exception, and
       * the fatal handler in lib/logger.ts would print a stack underneath this
       * message. The stack says nothing here — the port is taken, and the text
       * below is the entire explanation — so two records of one failure would
       * only make the useful one harder to find.
       */
      log.error(
        { port },
        `Port ${port} is already in use.\n`
        + '  Something else is bound to it — another qt-backend, or a different\n'
        + '  project. The nubra-dashboard reference pins SERVER_PORT=3001 in its\n'
        + '  own .env, which is why this default moved to 3101.\n'
        + `  Find the owner:  netstat -ano | findstr :${port}\n`
        + `  Or pick another: QT_BACKEND_PORT=3102 npm run dev`,
      );
      process.exit(1);
    }
    // Anything else IS worth a stack: the fatal handler in lib/logger.ts records it.
    throw err;
  });
  return server;
}
