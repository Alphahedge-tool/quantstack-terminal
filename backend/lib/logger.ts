/**
 * Structured logging.
 *
 * ── Why this exists ──
 *
 * The backend already had a logging convention — every line began with a
 * `[module]` prefix — and it worked well enough to read over a shoulder. What it
 * could not do is anything a machine needs: there is no level on a
 * `console.log`, so "the feed disconnected" and "the feed connected" are the
 * same severity to anything downstream; there is no timestamp unless the line
 * happened to include one; and the prefix is part of the message text, so
 * filtering to one module means grepping a string that also appears inside
 * messages.
 *
 * pino keeps the same shape on screen and makes all three real: `[straddle]`
 * becomes a `mod` field, the level is a field, and in production the whole line
 * is one JSON object a log shipper can index instead of a sentence it has to
 * parse.
 *
 * ── What did NOT move ──
 *
 * Everything under `scripts/`. Those are CLI tools whose output IS the product:
 * `verifyGo.ts` prints a table with ✓ and ✗ and is read by a person standing at
 * a terminal, not shipped anywhere. Routing that through a structured logger
 * would wrap each row in a timestamp and a level nobody wants, and would put the
 * pretty-printer's worker thread between the script and its own exit. They stay
 * on `console`, deliberately.
 *
 * ── Usage ──
 *
 *   const log = logger('straddle');
 *   log.info('session started');
 *   log.info({ strikes: 41, expiry }, 'contract table resolved');
 *   log.warn({ err }, 'depth re-arm failed');
 *
 * The object comes FIRST — that is pino's signature, not a style choice. Values
 * belong in it rather than interpolated into the message: a message that is a
 * constant string can be grouped, counted and alerted on, while
 * `` `subscribed ${n} instruments` `` is a thousand distinct messages.
 */

import pino from 'pino';

/**
 * Fields that must never reach a log file.
 *
 * This is not hypothetical tidiness: the live path passes a broker session
 * token through several layers, and the most likely moment for one to be logged
 * is inside an error describing a subscription that failed — which is exactly
 * the log line someone pastes into an issue. Redaction is applied by pino
 * before serialisation, so a token cannot escape by being nested inside an
 * object somebody logged whole.
 *
 * Wildcards cover one and two levels of nesting, which is as deep as anything
 * here logs. A payload deeper than that should be summarised, not logged raw.
 */
const REDACT = [
  'token', 'sessionToken', 'accessToken', 'refreshToken', 'jwtToken',
  'password', 'apiKey', 'apiSecret', 'secret', 'totp', 'mpin', 'pin',
  'authorization', 'cookie',
  '*.token', '*.sessionToken', '*.accessToken', '*.refreshToken',
  '*.password', '*.apiKey', '*.apiSecret', '*.secret', '*.totp', '*.mpin',
  '*.authorization', '*.cookie',
  '*.*.token', '*.*.sessionToken', '*.*.password', '*.*.apiKey', '*.*.secret',
  'headers.authorization', 'headers.cookie',
];

/**
 * The root logger, built on first use rather than at import.
 *
 * Lazily, and deliberately: `main.ts` loads `.env` in its own module body, and
 * in ESM every static import is evaluated BEFORE that body runs. A logger
 * configured at import time would therefore never see `QT_LOG_LEVEL` from the
 * .env file — it would read the shell environment, find nothing, and quietly
 * use the default while the setting sat in a file two lines away. Building it
 * on the first log call moves that read to a point where .env has landed.
 */
let _root: pino.Logger | null = null;

function build(): pino.Logger {
  /**
   * Levels, in the order pino ranks them: trace, debug, info, warn, error,
   * fatal.
   *
   * Default is `info` — the level at which the log describes what the backend
   * is doing without describing how. `debug` adds per-request and per-tick
   * detail and is what a session being investigated wants.
   */
  const level = process.env.QT_LOG_LEVEL
    || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

  /**
   * Pretty output when a human is watching, JSON when something is collecting.
   *
   * Detected from the TTY rather than from NODE_ENV, because the case that
   * matters is `npm run dev` piped into a file or a process manager: NODE_ENV
   * is still "development" there, but nothing is reading the colours and the
   * JSON is what makes the file useful afterwards. `QT_LOG_PRETTY` overrides
   * either way.
   */
  const pretty = process.env.QT_LOG_PRETTY != null
    ? /^(1|true|yes)$/i.test(process.env.QT_LOG_PRETTY)
    : Boolean(process.stdout.isTTY);

  return pino({
    level,
    redact: { paths: REDACT, censor: '[redacted]' },
    // Base fields. `pid` and `hostname` are pino's defaults and are worth
    // keeping in JSON mode — with several processes writing to one collector, a
    // line without them cannot be attributed. The pretty printer hides them.
    base: { pid: process.pid, service: 'qt-backend' },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            // Time only, not the date: these lines are read live, during a
            // session, where the date is today by definition.
            translateTime: 'SYS:HH:MM:ss.l',
            // `mod` is rendered inside the message instead of as a key=value
            // pair, so the output reads the way the old console lines did.
            ignore: 'pid,hostname,service,mod',
            messageFormat: '{if mod}[{mod}] {end}{msg}',
            // Fields on the same line as the message. A live session logs fast
            // enough that a four-line dump per event pushes the previous event
            // off the screen before it can be read; the stack of an Error is
            // still broken out, which is the one case worth the space.
            singleLine: true,
          },
        },
      }
      : {}),
  });
}

/**
 * The process-wide logger.
 *
 * Exported for the rare caller that genuinely has no module — process-level
 * signal handling, mainly. Prefer `logger(mod)` everywhere else, so a line can
 * be traced back to the part of the system that emitted it.
 */
export function root(): pino.Logger {
  if (!_root) _root = build();
  return _root;
}

/** A logger bound to one module — the structured form of the `[mod]` prefix. */
export function logger(mod: string): pino.Logger {
  return root().child({ mod });
}

/**
 * Normalise whatever was caught into something worth logging.
 *
 * `catch (e)` in TypeScript hands back `unknown`, and the two things that
 * usually happen to it are both bad: `String(e)` on an Error loses the stack,
 * and passing a non-Error to pino's `err` serialiser logs `{}`. This gives the
 * serialiser a real Error either way.
 *
 *   catch (e) { log.error({ err: asError(e) }, 'subscription failed'); }
 */
export function asError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(typeof e === 'string' ? e : JSON.stringify(e));
}

/**
 * Flush before the process goes.
 *
 * The pretty transport writes on a worker thread, so a `process.exit()` — or a
 * fatal error — can beat the last few lines out of the door, and the lines lost
 * are the ones explaining why the process is exiting. Registered once, here,
 * rather than remembered at each exit point.
 */
let flushed = false;
function flush(): void {
  if (flushed || !_root) return;
  flushed = true;
  try { _root.flush(); } catch { /* transport already gone */ }
}

process.on('exit', flush);
process.on('beforeExit', flush);

/**
 * Last-resort handlers.
 *
 * An unhandled rejection used to print a bare stack to stderr with no module,
 * no level and no timestamp — the least useful form of the most important
 * message. These do not swallow anything: the process still dies on an
 * uncaught exception, it just says why first.
 */
process.on('unhandledRejection', (reason) => {
  root().error({ err: asError(reason) }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  root().fatal({ err }, 'uncaught exception — exiting');
  flush();
  process.exit(1);
});
