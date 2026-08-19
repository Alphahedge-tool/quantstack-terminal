/**
 * Parity harness: the Go sidecar against the TypeScript it was ported from.
 *
 * ── What this proves, and why it is the gate ──
 *
 * A port is only worth having if it is INDISTINGUISHABLE. Every guard in
 * `analytics/black76.ts` was arrived at by a verification run against real
 * quotes — the vega floor that refuses an unidentifiable inversion, the
 * step-based convergence test, the refusal to clamp a stale straddle to a
 * plausible-looking vol. A Go implementation that is merely "close" would move
 * IV lines by fractions of a point in exactly the cases those rules exist for,
 * and nothing downstream would flag it.
 *
 * So the two implementations are run over the same inputs and diffed. Agreement
 * is required to 1e-9 on values, and EXACTLY on refusals: a bar one side calls
 * unsolvable and the other answers is a failure however small the number is.
 *
 * ── The inputs ──
 *
 * Three sweeps, because they fail differently:
 *   grid    — the well-behaved middle, where almost every real quote sits
 *   random  — a deterministic PRNG over plausible ranges, for coverage
 *   edges   — the cases the guards exist for: stale prints below intrinsic,
 *             seconds to expiry, deep wings, absurd vols
 *
 * Usage:  npm run verify:go        (with the sidecar already running)
 *         npm run verify:go -- --n 20000
 */

import {
  impliedVolStraddle, straddleGreeks, yearsToExpiry,
} from '../analytics/black76.js';
import { syntheticFuture, type OptionChainSlice } from '../analytics/syntheticFuture.js';

const BASE = (process.env.QT_GO_COMPUTE_URL || 'http://127.0.0.1:3151').replace(/\/+$/, '');
const EXPIRY = '20260820';

/** Values must agree to here. 1e-9 of a vol point is 1e-11 of vol — twelve
 *  orders of magnitude below the 0.05 tick that produced the price. */
const TOLERANCE = 1e-9;

interface Case { t: number; s: number; f: number; k: number; v?: number; g?: boolean }

/* ── Deterministic PRNG ────────────────────────────────────────────────────
   Seeded, because a parity failure has to be reproducible. A random sweep that
   cannot be re-run is a bug report with no test case in it. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2026-08-20 09:15 IST, and the session that ends at the expiry instant. */
const SESSION_OPEN = Date.UTC(2026, 7, 20, 3, 45, 0);
const SESSION_CLOSE = Date.UTC(2026, 7, 20, 10, 0, 0);

function gridCases(): Case[] {
  const out: Case[] = [];
  const forwards = [100, 5_000, 24_500, 86_050];
  const vols = [0.06, 0.12, 0.185, 0.35, 0.8];
  const offsets = [-0.04, -0.01, 0, 0.01, 0.04];
  const days = [0.2, 1, 3, 7, 30, 90];

  for (const f of forwards) {
    for (const sigma of vols) {
      for (const off of offsets) {
        for (const d of days) {
          const k = Math.round(f * (1 + off));
          const t = SESSION_CLOSE - d * 86_400_000;
          const T = yearsToExpiry(t, EXPIRY);
          if (!(T > 0)) continue;
          // Priced FROM a known vol, so the inversion has a solution to find —
          // and both sides get the identical double, since the price is built
          // here rather than by either implementation.
          const s = straddlePrice(f, k, T, sigma);
          out.push({ t, s, f, k, g: true });
        }
      }
    }
  }
  return out;
}

/** Local Black-76 straddle, so the test inputs do not come from the code under
 *  test on either side. */
function straddlePrice(F: number, K: number, T: number, sigma: number): number {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(F / K) + (v * v) / 2) / v;
  const d2 = d1 - v;
  const cdf = (x: number) => (1 + erf(x / Math.SQRT2)) / 2;
  const call = F * cdf(d1) - K * cdf(d2);
  const put = K * cdf(-d2) - F * cdf(-d1);
  return call + put;
}

/**
 * Abramowitz-Stegun 7.1.26, used ONLY to manufacture test prices.
 *
 * Its ~1.5e-7 accuracy would be unacceptable inside the pricer — that is
 * exactly why `black76.ts` uses Hart instead — but it is irrelevant here: both
 * implementations receive the identical double whatever this returns, so an
 * error in it cannot make them agree or disagree.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = t * (0.254829592
    + t * (-0.284496736
      + t * (1.421413741
        + t * (-1.453152027
          + t * 1.061405429))));
  return sign * (1 - poly * Math.exp(-ax * ax));
}

function randomCases(n: number): Case[] {
  const rand = mulberry32(0x51DE);
  const out: Case[] = [];
  for (let i = 0; i < n; i += 1) {
    const f = 100 + rand() * 90_000;
    const k = f * (0.85 + rand() * 0.3);
    const t = SESSION_OPEN + rand() * (SESSION_CLOSE - SESSION_OPEN) - rand() * 40 * 86_400_000;
    const T = yearsToExpiry(t, EXPIRY);
    if (!(T > 0)) continue;
    const sigma = 0.02 + rand() * 1.5;
    const s = straddlePrice(f, k, T, sigma);
    out.push({ t, s, f, k, g: rand() > 0.3 });
  }
  return out;
}

function edgeCases(): Case[] {
  const t = SESSION_OPEN;
  return [
    // Stale print below |F − K| — an arbitrage, no implied vol exists.
    { t, s: 10, f: 24_500, k: 24_000, g: true },
    // At and above F + K, the other end of the bracket.
    { t, s: 49_000, f: 24_500, k: 24_500, g: true },
    { t, s: 60_000, f: 24_500, k: 24_500, g: true },
    // Seconds to expiry: extrinsic value under a tick, vega under the floor.
    { t: SESSION_CLOSE - 1_000, s: 3, f: 24_500, k: 24_500, g: true },
    { t: SESSION_CLOSE - 60_000, s: 12, f: 24_500, k: 24_500, g: true },
    // Past the expiry instant — T <= 0.
    { t: SESSION_CLOSE + 60_000, s: 100, f: 24_500, k: 24_500, g: true },
    // Deep wings, where the polynomial CDF branch gives way to the continued
    // fraction.
    { t, s: 0.05, f: 24_500, k: 40_000, g: true },
    { t, s: 0.05, f: 24_500, k: 9_000, g: true },
    // Degenerate inputs the guards must refuse identically.
    { t, s: 0, f: 24_500, k: 24_500, g: true },
    { t, s: 300, f: 0, k: 24_500, g: true },
    { t, s: 300, f: 24_500, k: 0, g: true },
    // A fed vol: no inversion, greeks only. The one path where the two sides
    // must agree on something they did NOT solve for.
    { t, s: 300, f: 24_500, k: 24_500, v: 18.4, g: true },
    { t, s: 300, f: 24_500, k: 24_450, v: 7.25, g: true },
  ];
}

/* ── Comparison ───────────────────────────────────────────────────────────── */

interface Mismatch { i: number; field: string; ts: unknown; go: unknown; input: Case }

function near(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;          // refusals must match exactly
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= TOLERANCE * scale;
}

/** The TypeScript answer, in exactly the shape the Go service returns. */
function localSolve(c: Case): { iv: number | null; vega: number | null; theta: number | null; delta: number | null; gamma: number | null } {
  const T = yearsToExpiry(c.t, EXPIRY);
  const empty = { iv: null, vega: null, theta: null, delta: null, gamma: null };

  let sigma: number;
  let iv: number | null = null;
  if (c.v != null && c.v > 0) {
    sigma = c.v / 100;
  } else {
    sigma = impliedVolStraddle(c.s, c.f, c.k, T);
    if (!Number.isFinite(sigma) || !(sigma > 0)) return empty;
    iv = sigma * 100;
  }

  if (!c.g) return { ...empty, iv };
  const g = straddleGreeks(c.f, c.k, T, sigma);
  if (!g) return { ...empty, iv };
  return { iv, vega: g.vega, theta: g.theta, delta: g.delta, gamma: g.gamma };
}

async function compare(label: string, cases: Case[]): Promise<Mismatch[]> {
  const res = await fetch(`${BASE}/v1/straddle/vol`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiry: EXPIRY, bars: cases, greeks: true }),
  });
  if (!res.ok) throw new Error(`sidecar ${res.status}: ${await res.text()}`);

  const go = await res.json() as {
    iv: Array<number | null>; vega?: Array<number | null>; theta?: Array<number | null>;
    delta?: Array<number | null>; gamma?: Array<number | null>;
    workers: number; tookMs: number;
  };

  if (go.iv.length !== cases.length) {
    throw new Error(`sidecar returned ${go.iv.length} values for ${cases.length} bars`);
  }

  const mismatches: Mismatch[] = [];
  let worst = 0;
  let solvedTs = 0;

  for (let i = 0; i < cases.length; i += 1) {
    const ts = localSolve(cases[i]);
    if (ts.iv !== null) solvedTs += 1;

    const fields: Array<[string, number | null, number | null]> = [
      ['iv', ts.iv, go.iv[i] ?? null],
      ['vega', ts.vega, go.vega?.[i] ?? null],
      ['theta', ts.theta, go.theta?.[i] ?? null],
      ['delta', ts.delta, go.delta?.[i] ?? null],
      ['gamma', ts.gamma, go.gamma?.[i] ?? null],
    ];

    for (const [field, a, b] of fields) {
      if (near(a, b)) {
        if (a !== null && b !== null) {
          const scale = Math.max(1, Math.abs(a));
          worst = Math.max(worst, Math.abs(a - b) / scale);
        }
        continue;
      }
      mismatches.push({ i, field, ts: a, go: b, input: cases[i] });
    }
  }

  const verdict = mismatches.length ? 'FAIL' : 'ok';
  console.log(
    `  ${label.padEnd(8)} ${String(cases.length).padStart(6)} bars · ` +
    `${String(solvedTs).padStart(6)} solved · worst relative diff ${worst.toExponential(2)} · ` +
    `go ${go.tookMs}ms on ${go.workers} worker(s) — ${verdict}`,
  );
  return mismatches;
}

/* ── Synthetic future ─────────────────────────────────────────────────────── */

async function compareSynthetic(): Promise<number> {
  const rand = mulberry32(0xC0FFEE);
  let bad = 0;

  for (let trial = 0; trial < 200; trial += 1) {
    const step = [50, 100, 25][trial % 3];
    const base = Math.round((10_000 + rand() * 70_000) / step) * step;
    const strikes: number[] = [];
    const callLtp: number[] = [];
    const putLtp: number[] = [];
    for (let i = -8; i <= 8; i += 1) {
      const k = base + i * step;
      strikes.push(k);
      // Roughly parity-consistent marks with noise, plus deliberate unquoted
      // legs — the zeros are the case the median exists to survive.
      const drop = rand() < 0.12;
      callLtp.push(drop ? 0 : Math.max(0.05, base - k + 200 + (rand() - 0.5) * 20));
      putLtp.push(drop ? 0 : Math.max(0.05, k - base + 200 + (rand() - 0.5) * 20));
    }
    const chain: OptionChainSlice & { depth?: number } = {
      strikes, callLtp, putLtp, spot: base + (rand() - 0.5) * step, depth: 2,
    };

    const res = await fetch(`${BASE}/v1/synthetic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(chain),
    });
    const go = await res.json() as Record<string, number | boolean>;
    const ts = syntheticFuture(chain, 2);

    if (ts.status !== go.status) { bad += 1; continue; }
    if (!ts.status) continue;

    for (const field of ['forward', 'atmForward', 'basis', 'atmStrike', 'strikesUsed'] as const) {
      if (!near(ts[field] as number, go[field] as number)) {
        console.log(`    synthetic trial ${trial} ${field}: ts ${ts[field]} vs go ${go[field]}`);
        bad += 1;
      }
    }
  }
  console.log(`  synth      200 chains — ${bad ? `FAIL (${bad} mismatches)` : 'ok'}`);
  return bad;
}

/* ── Entry ────────────────────────────────────────────────────────────────── */

async function main() {
  const nArg = process.argv.indexOf('--n');
  const n = nArg > -1 ? Number(process.argv[nArg + 1]) || 5_000 : 5_000;

  console.log(`\n  Go ⇄ TypeScript parity — ${BASE}\n`);

  try {
    const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2_000) });
    const info = await health.json() as Record<string, unknown>;
    console.log(`  sidecar v${info.version} · ${info.go} · ${info.cores} cores\n`);
  } catch {
    console.error(
      `  The sidecar is not answering at ${BASE}.\n` +
      `  Start it with:  npm run go:dev   (or: cd backend-go && go run ./cmd/computed)\n`,
    );
    process.exit(2);
  }

  const mismatches = [
    ...await compare('grid', gridCases()),
    ...await compare('random', randomCases(n)),
    ...await compare('edges', edgeCases()),
  ];
  const synthBad = await compareSynthetic();

  console.log('');
  if (!mismatches.length && !synthBad) {
    console.log('  PASS — the two implementations agree to 1e-9, refusals included.\n');
    return;
  }

  console.log(`  FAIL — ${mismatches.length} value mismatches, ${synthBad} synthetic mismatches\n`);
  for (const m of mismatches.slice(0, 20)) {
    console.log(
      `    [${m.i}] ${m.field}: ts=${m.ts} go=${m.go}  ` +
      `(s=${m.input.s.toFixed(4)} f=${m.input.f.toFixed(2)} k=${m.input.k} t=${m.input.t}${m.input.v ? ` v=${m.input.v}` : ''})`,
    );
  }
  if (mismatches.length > 20) console.log(`    … and ${mismatches.length - 20} more`);
  console.log('');
  process.exit(1);
}

main().catch((e) => {
  console.error(`\n  verify:go failed — ${(e as Error).message}\n`);
  process.exit(1);
});
