import { logger } from './logger.js';
import { computeRequests, computeDuration, computeBars } from './metrics.js';

const log = logger('compute');

/**
 * Client for `backend-go` — the Go compute sidecar.
 *
 * ── The contract this file enforces ──
 *
 * The sidecar is an OPTIMISATION, never a dependency. Every caller has a
 * TypeScript implementation of the same maths (that is what the Go package was
 * ported FROM), so this client's job is not to make the sidecar work — it is to
 * decide, quickly and quietly, whether to use it at all. A backend that 500s
 * because a helper process is not running would be a worse product than the one
 * we started with.
 *
 * So: off unless `QT_GO_COMPUTE=1`, a health probe before the first real call,
 * a hard timeout on every request, and any failure disables the sidecar for a
 * cooldown rather than being retried per request. The caller gets `null` and
 * computes locally.
 *
 * ── Why the flag is opt-in ──
 *
 * The two implementations are verified equal by `scripts/verifyGo.ts`, but
 * "verified today on my inputs" is not "trusted on every contract in every
 * session". Opt-in means the migration can ship, run beside production traffic,
 * and be turned off from an env var rather than a deploy.
 */

const ENABLED = process.env.QT_GO_COMPUTE === '1';

/**
 * One port variable, read by both halves.
 *
 * `QT_GO_COMPUTE_PORT` is what the Go service binds to, so it is also what this
 * client dials — deriving the URL from it rather than hardcoding 3151 twice.
 * Moving the sidecar used to mean setting two variables that nothing checked
 * against each other, and getting it half-right looked exactly like a sidecar
 * that was down: the backend logged "unreachable" and quietly computed locally
 * while the process it wanted was running one port over.
 *
 * `QT_GO_COMPUTE_URL` still wins outright, for a sidecar on another host.
 */
const PORT = process.env.QT_GO_COMPUTE_PORT || '3151';
const BASE = (process.env.QT_GO_COMPUTE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

/**
 * A whole session's inversion is the unit of work, and a cold 22k-bar batch on
 * a loaded machine is still well inside this. Long enough not to fire on real
 * work, short enough that a hung sidecar costs one request rather than a page.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How long a failure keeps the sidecar out of rotation.
 *
 * Without this, a sidecar that is down turns every single request into a failed
 * connection attempt plus the local computation — strictly slower than never
 * having enabled it. One probe a minute is enough to notice it coming back.
 */
const COOLDOWN_MS = 60_000;

let disabledUntil = 0;
let healthy: boolean | null = null;
let probe: Promise<boolean> | null = null;

export interface ComputeBar {
  /** Epoch ms. */
  t: number;
  /** Straddle mid — CE + PE. */
  s: number;
  /** Synthetic forward at this bar. */
  f: number;
  /** The strike being held. */
  k: number;
  /** A vol the feed already published, in vol points. Present means "do not
   *  invert this bar" — see the Go `Bar.V`. */
  v?: number;
  /** Compute greeks for this bar. */
  g?: boolean;
}

export interface ComputeVolResult {
  count: number;
  iv: Array<number | null>;
  vega?: Array<number | null>;
  theta?: Array<number | null>;
  delta?: Array<number | null>;
  gamma?: Array<number | null>;
  solved: number;
  workers: number;
  tookMs: number;
  version: string;
}

export function goComputeEnabled(): boolean {
  return ENABLED;
}

export function goComputeUrl(): string {
  return BASE;
}

/** Why the sidecar is not being used right now, for the health route. */
export function goComputeStatus(): { enabled: boolean; url: string; healthy: boolean | null; cooldownMs: number } {
  return {
    enabled: ENABLED,
    url: BASE,
    healthy,
    cooldownMs: Math.max(0, disabledUntil - Date.now()),
  };
}

async function request<T>(path: string, body: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const abort = AbortSignal.timeout(timeoutMs);
  /**
   * Timed around the WHOLE call, encode and decode included.
   *
   * The sidecar publishes its own `tookMs`, and that is the truth about the
   * maths. This is the truth about what Node paid, which is a different number:
   * `JSON.stringify` on a 22k-bar batch is single-threaded work on the event
   * loop, and it is charged to this process whether the solve was fast or not.
   * The gap between the two series is the cost of the boundary — the number
   * that decides whether more should move across it.
   */
  const stop = computeDuration.startTimer({ endpoint: path });
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: abort,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      computeRequests.inc({ endpoint: path, outcome: `http_${res.status}` });
      throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
    }
    const out = await res.json() as T;
    computeRequests.inc({ endpoint: path, outcome: 'success' });
    return out;
  } catch (err) {
    // A rejected fetch never reached the `!res.ok` branch, so it has not been
    // counted yet. Distinguished from an HTTP failure because the two mean
    // different things: one is a sidecar that answered badly, the other is a
    // sidecar that is not there.
    if ((err as Error)?.name === 'TimeoutError') {
      computeRequests.inc({ endpoint: path, outcome: 'timeout' });
    } else if (!/→ \d{3}/.test((err as Error)?.message || '')) {
      computeRequests.inc({ endpoint: path, outcome: 'unreachable' });
    }
    throw err;
  } finally {
    stop();
  }
}

/**
 * Is the sidecar up? Probed once and remembered.
 *
 * Deliberately NOT re-probed per call: the probe is only there to keep the
 * first real request from paying a connection timeout, and after that the
 * request itself is the health check — a failing one trips the cooldown below.
 */
export async function goComputeReady(): Promise<boolean> {
  if (!ENABLED) return false;
  if (Date.now() < disabledUntil) return false;
  if (healthy !== null) return healthy;
  if (probe) return probe;

  probe = (async () => {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
      healthy = res.ok;
      if (res.ok) {
        const info = await res.json().catch(() => ({})) as Record<string, unknown>;
        log.info(
          `Go sidecar up at ${BASE} — v${info.version ?? '?'} on ${info.go ?? '?'}, ${info.cores ?? '?'} cores`,
        );
      } else {
        log.warn(`Go sidecar health → ${res.status}; using the TypeScript path`);
      }
    } catch (e) {
      healthy = false;
      log.warn(`Go sidecar unreachable at ${BASE} (${(e as Error).message}); using the TypeScript path`);
    } finally {
      probe = null;
    }
    if (!healthy) disabledUntil = Date.now() + COOLDOWN_MS;
    return healthy ?? false;
  })();

  return probe;
}

/** Take the sidecar out of rotation for a cooldown. Exported for the verify
 *  script, which needs to prove the fallback path actually engages. */
export function markGoComputeDown(reason: string): void {
  healthy = false;
  disabledUntil = Date.now() + COOLDOWN_MS;
  log.warn(`Go sidecar disabled for ${COOLDOWN_MS / 1000}s: ${reason}`);
}

/**
 * Solve a batch of bars, or return null to say "compute it yourself".
 *
 * Null is the ONLY failure mode this function has. It never throws: a caller
 * that had to try/catch around an optimisation would end up with the fallback
 * logic duplicated at every call site, and one of those copies would eventually
 * be missing.
 */
export async function goSolveStraddleVol(
  expiry: string,
  bars: ComputeBar[],
  greeks: boolean,
): Promise<ComputeVolResult | null> {
  if (!bars.length) return null;
  if (!await goComputeReady()) return null;

  try {
    const out = await request<ComputeVolResult>('/v1/straddle/vol', { expiry, bars, greeks });
    // A length mismatch means the two sides disagree about the shape of the
    // answer, and indexing a shorter column onto the points would silently
    // shift every value after the gap. Refuse the whole response.
    if (!Array.isArray(out.iv) || out.iv.length !== bars.length) {
      markGoComputeDown(`returned ${out.iv?.length} values for ${bars.length} bars`);
      return null;
    }
    // Bars that came back with no vol are not a failure — a straddle printing
    // below |F − K| has no implied vol to find. But a RATIO that moves is a
    // data-quality signal, and it is invisible without both numbers.
    computeBars.inc({ outcome: 'solved' }, out.solved);
    computeBars.inc({ outcome: 'unsolved' }, Math.max(0, bars.length - out.solved));
    return out;
  } catch (e) {
    markGoComputeDown((e as Error).message);
    return null;
  }
}
