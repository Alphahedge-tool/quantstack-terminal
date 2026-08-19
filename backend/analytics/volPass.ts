/**
 * The modelled-vol pass — one batch, after the walk, instead of one solve per
 * bar inside it.
 *
 * ── Why this exists ──
 *
 * `rollingStraddle` used to invert Black-76 inline, bar by bar, in the middle
 * of its walk. That is the CPU this whole Go/Node split is about: a session is
 * ~22k bars, a bounded Newton solve each, all of it on the one thread that also
 * has to serve every live tick on /ws/straddle. Nothing else could run until
 * the walk finished.
 *
 * Collecting the work and resolving it in ONE call changes two things at once.
 * It hands the Go sidecar a batch worth crossing a process boundary for — a
 * per-bar RPC would cost more in loopback than the maths costs in V8 — and even
 * with the sidecar off, it puts every model call in one place that can be
 * awaited, measured, and swapped.
 *
 * ── Why the bookkeeping moved here too ──
 *
 * The greek baselines, the coverage counters and a roll's vega/theta step were
 * all accumulated inside the walk, which means they depended on values that no
 * longer exist at that point in the loop. They are now derived in a single
 * ordered scan over the finished points — same order, same definitions, and
 * with the advantage that "the first bar that HAD a greek" is now decided after
 * every greek is known rather than as they arrive.
 */

import { impliedVolStraddle, straddleGreeks, yearsToExpiry } from './black76.js';
import { goSolveStraddleVol, type ComputeBar } from '../lib/computeClient.js';
import type { StraddlePoint } from './syntheticFuture.js';

/** One bar the walk could not answer from the feed alone. */
export interface ModelRequest {
  /** Index into the points array this fills in. */
  index: number;
  time: number;
  straddle: number;
  forward: number;
  strike: number;
  /** The feed's vol in points, when it had one. Present means the bar needs
   *  greeks but NOT an inversion. */
  fedIv?: number;
  /** Whether this bar needs greeks at all — false when the feed published them. */
  wantGreeks: boolean;
}

/** Anything with the roll fields the pass fills in. Structural rather than the
 *  engine's own `RollEvent`, so this module does not import the engine. */
export interface RollLike {
  time: number;
  /** Optional in the engine's own type, so it is optional here — the pass
   *  assigns both fields on every roll it reaches. */
  vegaJump?: number | null;
  thetaJump?: number | null;
}

export interface VolPassResult {
  /** Where the numbers came from. Logged, and asserted by `verifyGo.ts`. */
  source: 'go' | 'local';
  solved: number;
  requested: number;
  tookMs: number;
  /** Session baselines — the "vs 9:15 open" reference the greek lines read against. */
  entryVega: number | null;
  entryTheta: number | null;
  /** Coverage counters, so the UI can tell a flat vega line from an absent one. */
  greekBars: number;
  modelledGreekBars: number;
}

/**
 * Fill in every bar the feed left short, then re-derive the session bookkeeping.
 *
 * Mutates `points` and `rollEvents` in place. They are the engine's own arrays
 * and it is about to return them; copying 22k points to hand back a new array
 * would cost more than the pass itself.
 */
export async function applyModelledVol(
  expiry: string,
  points: StraddlePoint[],
  rollEvents: RollLike[],
  pending: ModelRequest[],
): Promise<VolPassResult> {
  const started = Date.now();
  const wantGreeks = pending.some((p) => p.wantGreeks);

  let source: VolPassResult['source'] = 'local';
  let solved = 0;

  if (pending.length) {
    const bars: ComputeBar[] = pending.map((p) => ({
      t: p.time,
      s: p.straddle,
      f: p.forward,
      k: p.strike,
      ...(p.fedIv != null ? { v: p.fedIv } : {}),
      ...(p.wantGreeks ? { g: true } : {}),
    }));

    const go = await goSolveStraddleVol(expiry, bars, wantGreeks);

    if (go) {
      source = 'go';
      solved = go.solved;
      for (let i = 0; i < pending.length; i += 1) {
        const req = pending[i];
        const point = points[req.index];
        const iv = go.iv[i];
        // Only when the bar actually needed an inversion. A fed vol is the
        // feed's number and must not be overwritten by a round-tripped copy of
        // itself.
        if (req.fedIv == null && iv != null && iv > 0) {
          point.iv = iv;
          point.ivSource = 'black76';
        }
        if (req.wantGreeks) {
          const vega = go.vega?.[i] ?? null;
          const theta = go.theta?.[i] ?? null;
          // Vega and theta are taken as a PAIR from one source, so a bar can
          // never mix a fed vega with a modelled theta.
          if (vega != null || theta != null) {
            point.vega = vega ?? undefined;
            point.theta = theta ?? undefined;
            point.delta = go.delta?.[i] ?? undefined;
            point.gamma = go.gamma?.[i] ?? undefined;
            point.greekSource = 'black76';
          }
        }
      }
    } else {
      // The TypeScript path — identical maths, same guards, same NaN
      // discipline. This is not a degraded mode; it is what the Go package was
      // ported from, and it is what runs unless QT_GO_COMPUTE=1.
      for (const req of pending) {
        const point = points[req.index];
        const T = yearsToExpiry(req.time, expiry);

        let sigma: number;
        if (req.fedIv != null) {
          sigma = req.fedIv / 100;
        } else {
          sigma = impliedVolStraddle(req.straddle, req.forward, req.strike, T);
          if (!Number.isFinite(sigma) || !(sigma > 0)) continue;
          point.iv = sigma * 100;
          point.ivSource = 'black76';
        }
        solved += 1;

        if (req.wantGreeks) {
          const g = straddleGreeks(req.forward, req.strike, T, sigma);
          if (g) {
            point.vega = g.vega;
            point.theta = g.theta;
            point.delta = g.delta;
            point.gamma = g.gamma;
            point.greekSource = 'black76';
          }
        }
      }
    }
  }

  /*
   * One ordered scan for everything that used to be accumulated in the walk.
   *
   * Roll events are matched POSITIONALLY against the points that carry
   * `isRollEvent`, because that is exactly how they were pushed — one event per
   * such point, in order. Matching by timestamp would look more robust and be
   * less so: two bars can share a millisecond on a 1s walk that had a gap
   * filled, and a time-keyed lookup would then attribute both jumps to one
   * event.
   */
  let entryVega: number | null = null;
  let entryTheta: number | null = null;
  let prevVega: number | null = null;
  let prevTheta: number | null = null;
  let greekBars = 0;
  let modelledGreekBars = 0;
  let roll = 0;

  for (const point of points) {
    const vega = point.vega ?? null;
    const theta = point.theta ?? null;

    if (point.isRollEvent && roll < rollEvents.length) {
      const event = rollEvents[roll];
      // Null when either side of the step had no greek — a jump measured
      // against an absent value is not a jump.
      event.vegaJump = vega != null && prevVega != null ? vega - prevVega : null;
      event.thetaJump = theta != null && prevTheta != null ? theta - prevTheta : null;
      roll += 1;
    }

    if (entryVega === null && vega != null) entryVega = vega;
    if (entryTheta === null && theta != null) entryTheta = theta;
    if (vega != null || theta != null) greekBars += 1;
    if (point.greekSource === 'black76') modelledGreekBars += 1;

    if (vega != null) prevVega = vega;
    if (theta != null) prevTheta = theta;
  }

  return {
    source,
    solved,
    requested: pending.length,
    tookMs: Date.now() - started,
    entryVega,
    entryTheta,
    greekBars,
    modelledGreekBars,
  };
}
