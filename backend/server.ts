/**
 * QuantStack Backend — HTTP server.
 *
 * Fastify underneath, with the route-registration API that the twelve route
 * modules already use kept exactly as it was.
 *
 * ── Why the handler signature did not change ──
 *
 * `route()` still takes `(req, res, { url, query })` over raw node objects, and
 * fifty-three registrations across twelve files still compile untouched. That
 * is deliberate: swapping the server and rewriting every route in one step
 * would mean a regression anywhere in the API could be either change, on a
 * backend that carries a live broker session. The framework moves first; the
 * handlers can become idiomatic Fastify one file at a time, and
 * `apps/api/routes/` in ARCHITECTURE.md is where that lands.
 *
 * ── What Fastify actually took over ──
 *
 *   routing        a radix tree instead of a `Map` of exact `METHOD /path`
 *                  strings — so `/api/x/:id` is now expressible, which it was
 *                  not before
 *   CORS           @fastify/cors, same three headers as the hand-rolled version
 *   compression    @fastify/compress, same 8 KB threshold and same zlib level 1
 *   errors         setErrorHandler over the same errorStatus/errorBody pair
 *   404            setNotFoundHandler, same JSON body as before
 *   logging        Fastify's own pino instance is DISABLED; lib/logger.ts stays
 *                  the single logger so log shape does not fork
 *
 * ── The two things that need care ──
 *
 * 1. RAW RESPONSES. Four SSE routes, the Zerodha HTML callback and `/metrics`
 *    write to `res` themselves. Fastify must be told to keep its hands off, or
 *    it will try to send a second response over a stream that is already
 *    running. `reply.hijack()` does that, and the adapter below decides by
 *    asking whether the handler sent headers — no route file has to declare it.
 *
 * 2. THE BODY. `readJSON(req)` reads the raw request stream, and Fastify's
 *    default parser consumes that stream first, which would have made every
 *    POST see an empty body. The content-type parser below keeps the raw buffer
 *    and hands it to `readJSON` instead. This is the one piece of the migration
 *    that fails silently rather than loudly if it is wrong, which is why
 *    scripts/verifyServer.ts asserts a POST body round-trips.
 */

import http from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import compress from '@fastify/compress';

import { FeedError, httpStatusFor } from './feeds/errors.js';
import { logger } from './lib/logger.js';
import {
  httpRequests, httpDuration, httpInFlight, scrape, contentType,
} from './lib/metrics.js';

const log = logger('qt-backend');

const PORT = Number(process.env.QT_BACKEND_PORT || 3101);

// Loopback only, deliberately.
//
// `listen(port)` with no host binds every interface, which put an API holding a
// logged-in broker session — order placement included — on the LAN behind
// nothing but `Access-Control-Allow-Origin: *`. Anyone on the same Wi-Fi could
// reach http://<this-machine>:3101/api/trading/*.
//
// Set QT_BIND_HOST=0.0.0.0 to share the terminal on a network you trust, and
// only alongside a reverse proxy that authenticates.
const HOST = process.env.QT_BIND_HOST || '127.0.0.1';

// A straddle session is ~22.5k points; as raw JSON that's several MB of mostly
// digits, which gzip crushes by an order of magnitude. Below this size the
// compression costs more than the transfer saves.
const GZIP_MIN_BYTES = 8 * 1024;

/** Largest body accepted. A straddle POST is a few hundred bytes; this is slack. */
const BODY_LIMIT = 2 * 1024 * 1024;

// ─── Route table ──────────────────────────────────────────────────────────────

type RouteHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: { url: URL; query: URLSearchParams },
) => Promise<unknown> | unknown;

interface Registration {
  method:  string;
  path:    string;
  handler: RouteHandler;
}

/**
 * Registrations, in declaration order.
 *
 * Kept as a list rather than handed straight to Fastify because `route()` is
 * called at module-evaluation time — every `import './routes/x.js'` in main.ts
 * registers while this module is still initialising — and Fastify will not
 * accept routes after `listen()`. So they queue here and are added in
 * `build()`, which also keeps `/api/health` and `/metrics` below in the same
 * ordering as the rest.
 */
const registrations: Registration[] = [];

export function route(method: string, path: string, handler: RouteHandler): void {
  registrations.push({ method: method.toUpperCase(), path, handler });
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// ─── Body ─────────────────────────────────────────────────────────────────────

/**
 * Where the content-type parser leaves the untouched body for `readJSON`.
 *
 * A symbol on the raw request rather than a field on FastifyRequest, because
 * `readJSON` is handed `req.raw` and has no route back to the Fastify wrapper.
 */
const RAW_BODY = Symbol.for('qt.rawBody');

export async function readJSON<T = Record<string, unknown>>(
  req: http.IncomingMessage,
): Promise<T> {
  const stashed = (req as unknown as Record<symbol, unknown>)[RAW_BODY];

  if (stashed !== undefined) {
    const buf = stashed as Buffer;
    if (!buf.length) return {} as T;
    try {
      return JSON.parse(buf.toString('utf8')) as T;
    } catch {
      throw new ApiError('Invalid JSON body', 400);
    }
  }

  /*
   * Stream fallback.
   *
   * Only reached when the request did not go through Fastify's parser — a
   * content type nothing registered, or a direct call in a test. Reading the
   * stream here is still correct in that case because nothing has consumed it.
   */
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new ApiError('Request body too large', 413);
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new ApiError('Invalid JSON body', 400);
  }
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
  return 500;
}

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

// ─── Dispatch ─────────────────────────────────────────────────────────────────

let boundPort = PORT;
export function getPort(): number { return boundPort; }

/**
 * Wrap a legacy handler as a Fastify handler.
 *
 * The return contract is unchanged: a value becomes the JSON body, and a
 * handler that wrote the response itself is left alone. The difference is that
 * "left alone" now has to be said out loud via `hijack()`, because Fastify —
 * unlike the old dispatcher — would otherwise send a response of its own on top
 * of a stream that is already open.
 */
function adapt(handler: RouteHandler) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const url = new URL(request.raw.url ?? '/', `http://localhost:${boundPort}`);
    const result = await handler(request.raw, reply.raw, { url, query: url.searchParams });

    // The handler owns the response: SSE, the Zerodha HTML callback, /metrics.
    if (reply.raw.headersSent || reply.raw.writableEnded) {
      reply.hijack();
      return reply;
    }

    /*
     * Undefined with nothing written.
     *
     * The old dispatcher wrote nothing here and the request hung until the
     * client gave up. Answering 204 instead is a deliberate change: a hung
     * request is indistinguishable from a slow broker call, and this is the one
     * behaviour worth not carrying across.
     */
    if (result === undefined) {
      reply.code(204);
      return null;
    }

    return result;
  };
}

// ─── Build ────────────────────────────────────────────────────────────────────

let app: FastifyInstance | null = null;

function build(): FastifyInstance {
  const instance = Fastify({
    // lib/logger.ts owns logging. Fastify's own pino would be a second logger
    // with its own shape and level, and two of them is how a log stops being
    // greppable.
    logger: false,
    bodyLimit: BODY_LIMIT,
    // Trailing slashes should not be a different route. Under `routerOptions`
    // because the top-level spelling is deprecated in Fastify 5 and goes away
    // in 6.
    routerOptions: { ignoreTrailingSlash: true },
  });

  /*
   * Keep the body as a Buffer instead of parsing it.
   *
   * `readJSON` does the parsing — including the error text the frontend already
   * matches on — so parsing here as well would mean two places that can disagree
   * about what a bad body is. Registered for JSON explicitly and for everything
   * else via the catch-all, so a POST with no content-type still reaches its
   * handler rather than dying at 415.
   */
  const keepRaw = (
    request: FastifyRequest,
    payload: Buffer,
    done: (err: Error | null, body?: unknown) => void,
  ) => {
    (request.raw as unknown as Record<symbol, unknown>)[RAW_BODY] = payload;
    done(null, payload);
  };

  instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, keepRaw);
  instance.addContentTypeParser('*', { parseAs: 'buffer' }, keepRaw);

  void instance.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-device-id'],
  });

  void instance.register(compress, {
    global: true,
    threshold: GZIP_MIN_BYTES,
    encodings: ['gzip'],
    // Level 1: on payloads this repetitive the extra levels buy a few percent
    // for several times the CPU, and CPU here is latency the client waits on.
    zlibOptions: { level: 1 },
  });

  /*
   * Metrics, from `close` rather than `onResponse`.
   *
   * A route that streams (`/api/straddle/stream`, `/api/backtest/stream`)
   * hijacks the reply, so Fastify's `onResponse` never fires for it — and even
   * where it does fire it fires when the handler returned, which for a stream
   * is seconds before the response is actually done. Listening on the raw
   * socket closing is the one signal that means the same thing for both.
   */
  instance.addHook('onRequest', (request, reply, done) => {
    /*
     * The metrics label is the REGISTERED route, never the raw path.
     *
     * An unrouted request is labelled `unknown` and nothing else. Port scanners,
     * favicon probes and typo'd URLs all land here, and each distinct path would
     * otherwise become a permanent time series — the one way a metrics endpoint
     * can be turned into a memory leak from outside.
     */
    const routeLabel = request.routeOptions?.url ?? 'unknown';
    const method = request.method || 'GET';
    const stop = httpDuration.startTimer({ method, route: routeLabel });
    httpInFlight.inc();

    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      stop();
      httpInFlight.dec();
      httpRequests.inc({
        method, route: routeLabel, status: String(reply.raw.statusCode),
      });
    };
    reply.raw.on('close', settle);
    done();
  });

  instance.setErrorHandler((err, _request, reply) => {
    if (reply.raw.headersSent || reply.raw.writableEnded) return;
    void reply.code(errorStatus(err)).send(errorBody(err));
  });

  instance.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      status: false,
      message: `No route: ${request.method} ${new URL(request.raw.url ?? '/', 'http://x').pathname}`,
    });
  });

  /*
   * Routes go in LAST, and inside a `register` rather than straight onto the
   * instance.
   *
   * @fastify/compress attaches compression to each route through an `onRoute`
   * hook, so it only ever sees routes that are registered after it has finished
   * loading. `register()` defers to boot time and runs in call order, so this
   * runs after cors and compress; adding the routes directly here instead
   * registers them synchronously — before either plugin has booted — and
   * nothing is ever compressed. That failure is silent: every response is
   * correct, just several times larger than it should be.
   */
  void instance.register(async (scope) => {
    for (const { method, path, handler } of registrations) {
      scope.route({ method: method as 'GET', url: path, handler: adapt(handler) });
    }
  });

  return instance;
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

/**
 * The bare http.Server, with Fastify attached but not listening.
 *
 * Returned rather than the Fastify instance because the five WebSocket channels
 * bolt onto `server.on('upgrade')` and only need the node object. Fastify does
 * not register an upgrade listener of its own, so the two share the port
 * without either knowing about the other — exactly as they did before.
 */
export function createServer(): http.Server {
  if (!app) app = build();
  return app.server;
}

export function startServer(port = PORT, host = HOST): http.Server {
  if (!app) app = build();
  boundPort = port;

  /*
   * `listen` is async and this is not.
   *
   * main.ts takes the returned server and immediately attaches the socket
   * channels to it, which is safe before the bind completes: an upgrade
   * listener added to a server that is not yet listening is still there when it
   * starts. Awaiting here instead would mean making main.ts's whole tail async
   * for no gain.
   */
  app.listen({ port, host })
    .then(() => {
      log.info({ port, host, url: `http://${host}:${port}` }, 'http server listening');
      // Loopback is the default and the safe one. Anything else puts an API that
      // holds a logged-in broker session — order placement included — on the
      // network behind nothing but `Access-Control-Allow-Origin: *`.
      if (host !== '127.0.0.1' && host !== 'localhost') {
        log.warn(
          { host },
          'bound to a non-loopback host: the API is reachable from the network, '
          + 'carries a logged-in broker session and sets CORS to *. '
          + 'Unset QT_BIND_HOST to go back to loopback only.',
        );
      }
      log.debug(
        { routes: registrations.map((r) => `${r.method} ${r.path}`).sort() },
        `${registrations.length} routes registered`,
      );
    })
    .catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        /**
         * Exit deliberately rather than rethrowing.
         *
         * A throw from inside a rejected listen becomes an unhandled rejection,
         * and the fatal handler in lib/logger.ts would print a stack underneath
         * this message that says nothing the message has not already said.
         */
        log.error(
          { port, host },
          `port ${port} is already in use — another backend is running.\n`
          + `  Find the owner:  netstat -ano | findstr :${port}\n`
          + '  Or pick another: QT_BACKEND_PORT=3102 npm run dev',
        );
        process.exit(1);
      }
      log.error({ err }, 'http server failed to start');
      process.exit(1);
    });

  return app.server;
}
