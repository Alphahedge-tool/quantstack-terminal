/**
 * The monitor — chain ticks in, alerts out.
 *
 * ── Shape of the loop ──
 *
 *   chainFeed  →  sample()      every published snapshot, ~1/s
 *                 writes one point per (strike, side, metric) into SeriesStore
 *
 *   timer      →  evaluate()    every EVAL_MS
 *                 for each active watch: window-delta, gate, maybe fire
 *
 * Sampling and evaluation are deliberately separate clocks. Sampling has to
 * track the feed (miss a tick and the series has a hole); evaluation does not
 * need to run per tick, and running it there would re-score every watch several
 * times a second for no benefit. Splitting them also means a slow evaluation
 * can never back-pressure the feed.
 *
 * ── Why a watch does not own its subscription ──
 *
 * Watches acquire chains through `chainFeed`, which is ref-counted, so ten
 * watches on the NIFTY chain share one python process and one 20-weight
 * subscription. The engine holds the handles and reconciles them against the
 * watch set whenever it changes — a watch being deleted releases its chain, and
 * the chain only actually stops when the last watch on it is gone.
 *
 * ── Firing discipline ──
 *
 * Three gates, all necessary:
 *
 *   cooldown    a drifting contract crossing a threshold prints a delta every
 *               evaluation; without a cooldown that is an alert per second.
 *   direction   "tell me if it drops" must not fire on a rise.
 *   re-arm      after firing, the watch will not fire again until the metric
 *               comes back inside the threshold. Otherwise a sustained move
 *               re-fires on every cooldown expiry for as long as it lasts.
 */

import type { NubraSession } from '../../brokers/nubra.js';
import {
  acquireChain, legKey, type ChainHandle, type ChainSnapshot, type ChainQuote,
} from '../chainFeed.js';
import type {
  AlertEvent, BuildupKind, MetricName, Watch, WatchSummary,
} from '../types.js';
import { CHAIN_METRICS } from '../types.js';
import { SeriesStore, MetricSeries } from './series.js';
import { scoreSignificance, shouldFire, LEVEL_PHRASE } from './significance.js';
import {
  allWatches, markFired, requiredChains, getWatch,
} from './watchStore.js';
import { formatMetric, spokenNumber } from '../format.js';

const EVAL_MS = Number(process.env.QT_ASSISTANT_EVAL_MS || 5_000);

/** Alerts retained for "what fired earlier". */
const ALERT_HISTORY = 200;

/** Metrics sampled off every chain tick. */
const SAMPLED: MetricName[] = ['oi', 'ltp', 'iv', 'volume', 'delta', 'gamma', 'vega', 'theta'];

const series = new SeriesStore();
const chains = new Map<string, ChainHandle>();
const history: AlertEvent[] = [];

/**
 * Watches currently outside their threshold.
 *
 * This is the re-arm gate: an id in here has fired and has not yet come back
 * inside, so it will not fire again. Cleared when the delta falls back under
 * the threshold, which is what makes one sustained move produce one alert.
 */
const latched = new Set<string>();

type AlertSink = (alert: AlertEvent) => void;
const sinks = new Set<AlertSink>();

let timer: NodeJS.Timeout | null = null;
let sessionRef: NubraSession | null = null;

// ── Sampling ─────────────────────────────────────────────────────────────────

const chainKeyOf = (w: { exchange: string; symbol: string; expiry: string }): string =>
  `${w.exchange}:${w.symbol}:${w.expiry}`;

function metricOfQuote(q: ChainQuote, metric: MetricName): number | undefined {
  switch (metric) {
    case 'oi':     return q.oi;
    case 'ltp':    return q.ltp;
    case 'iv':     return q.iv;
    case 'volume': return q.volume;
    case 'delta':  return q.delta;
    case 'gamma':  return q.gamma;
    case 'vega':   return q.vega;
    case 'theta':  return q.theta;
    default:       return undefined;
  }
}

/**
 * Put/call ratio for a snapshot.
 *
 * OI-weighted across the whole chain, which is the reading traders mean by
 * "PCR" without qualification. Returns undefined rather than 0 when the call
 * side has no OI — a zero denominator here means the chain has not populated,
 * and reporting 0 would look like an extreme bullish signal.
 */
function pcrOf(snap: ChainSnapshot): number | undefined {
  let ce = 0;
  let pe = 0;
  for (const q of snap.quotes.values()) {
    if (q.oi == null) continue;
    if (q.side === 'CE') ce += q.oi;
    else pe += q.oi;
  }
  return ce > 0 ? pe / ce : undefined;
}

function sample(snap: ChainSnapshot): void {
  const key = chainKeyOf(snap);
  const t = snap.updatedAt || Date.now();

  for (const q of snap.quotes.values()) {
    for (const metric of SAMPLED) {
      const v = metricOfQuote(q, metric);
      if (v == null) continue;
      series.push(SeriesStore.key(key, q.strike, q.side, metric), t, v);
    }
  }

  if (snap.spot != null) {
    series.push(SeriesStore.key(key, null, null, 'spot'), t, snap.spot);
  }
  const pcr = pcrOf(snap);
  if (pcr != null) {
    series.push(SeriesStore.key(key, null, null, 'pcr'), t, pcr);
  }
}

// ── Chain reconciliation ─────────────────────────────────────────────────────

/**
 * Bring the live chain set in line with what the watches need.
 *
 * Called after every watch mutation. Acquiring is async and the watch set can
 * change while an acquire is in flight, so the result is re-checked before it
 * is stored — otherwise a watch created and deleted quickly would leak a
 * subscription that nothing ever releases.
 */
export async function reconcileChains(session: NubraSession | null): Promise<void> {
  if (session) sessionRef = session;
  const active = sessionRef;
  if (!active) return;

  const wanted = requiredChains();
  const wantedKeys = new Set(wanted.map(chainKeyOf));

  for (const [key, handle] of [...chains]) {
    if (wantedKeys.has(key)) continue;
    handle.release();
    chains.delete(key);
    series.dropChain(key);
  }

  for (const target of wanted) {
    const key = chainKeyOf(target);
    if (chains.has(key)) continue;
    // Reserve the slot before awaiting, so two concurrent reconciles cannot
    // both decide to acquire the same chain.
    chains.set(key, PENDING);
    try {
      const handle = await acquireChain({ ...target, session: active }, sample);
      if (chains.get(key) === PENDING) chains.set(key, handle);
      else handle.release();          // no longer wanted — undo immediately
    } catch (err) {
      chains.delete(key);
      console.warn(`[iris/monitor] could not subscribe ${key}: ${(err as Error).message}`);
    }
  }
}

/** Placeholder so a slot can be reserved across an await. */
const PENDING: ChainHandle = {
  key: '__pending__',
  snapshot: () => null,
  release: () => {},
};

// ── Conversation-held chains ─────────────────────────────────────────────────

/**
 * Chains a CONVERSATION is sampling, as opposed to a watch.
 *
 * "How much has the OI moved in the last 10 minutes" needs 10 minutes of
 * history, and a chain nothing is watching has none. Asking the question starts
 * sampling, so the answer is available a few minutes later and every follow-up
 * is instant — and so a user who asks about a chain, then sets a watch on it,
 * finds the watch already has history behind it.
 *
 * Keyed by `sessionId|chainKey` so two conversations holding the same chain
 * each own their own reference and neither can release the other's.
 */
const held = new Map<string, ChainHandle>();

export async function holdChain(
  sessionId: string,
  target: { exchange: string; symbol: string; expiry: string },
  session: NubraSession,
): Promise<void> {
  sessionRef = session;
  const chainKey = chainKeyOf(target);
  const holdKey = `${sessionId}|${chainKey}`;
  if (held.has(holdKey)) return;

  held.set(holdKey, PENDING);
  try {
    const handle = await acquireChain({ ...target, session }, sample);
    if (held.get(holdKey) === PENDING) held.set(holdKey, handle);
    else handle.release();
  } catch (err) {
    held.delete(holdKey);
    console.warn(`[iris/monitor] could not hold ${chainKey}: ${(err as Error).message}`);
  }
}

/** Release every chain a conversation was holding — called on disconnect. */
export function releaseHeld(sessionId: string): void {
  const prefix = `${sessionId}|`;
  for (const [key, handle] of [...held]) {
    if (!key.startsWith(prefix)) continue;
    handle.release();
    held.delete(key);
  }
}

/**
 * Window-change for an arbitrary contract, from whatever history exists.
 *
 * Returns null when the series cannot cover the window — the caller turns that
 * into "I have only been watching this for two minutes" rather than a number,
 * because a delta measured over a shorter span than asked for is a wrong
 * answer dressed as a right one.
 */
export function changeFor(
  target: { exchange: string; symbol: string; expiry: string },
  strike: number | null,
  side: string | null,
  metric: MetricName,
  windowMs: number,
): {
  from: number; to: number; abs: number; pct: number;
  significance: ReturnType<typeof scoreSignificance>;
  buildup?: BuildupKind;
  coverage: number;
} | null {
  const chainKey = chainKeyOf(target);
  const isChainMetric = CHAIN_METRICS.includes(metric);
  const s = series.get(SeriesStore.key(
    chainKey,
    isChainMetric ? null : strike,
    isChainMetric ? null : side,
    metric,
  ));
  if (!s) return null;

  const d = s.delta(windowMs);
  if (!d) return null;

  const significance = scoreSignificance({
    metric, abs: d.abs, pct: d.pct, history: s.deltaHistory(windowMs),
  });

  let buildup: BuildupKind | undefined;
  if (metric === 'oi' && strike != null && side) {
    const price = series.get(SeriesStore.key(chainKey, strike, side, 'ltp'))?.delta(windowMs);
    if (price) {
      if (Math.abs(price.pct) < 0.5) buildup = 'flat';
      else if (d.abs > 0)  buildup = price.abs > 0 ? 'long-buildup'  : 'short-buildup';
      else                 buildup = price.abs > 0 ? 'short-covering' : 'long-unwinding';
    }
  }

  return { ...d, significance, buildup, coverage: s.newest - s.oldest };
}

/** How much history exists for a contract — for "I need a few more minutes". */
export function coverageFor(
  target: { exchange: string; symbol: string; expiry: string },
  strike: number | null,
  side: string | null,
  metric: MetricName,
): number {
  const isChainMetric = CHAIN_METRICS.includes(metric);
  const s = series.get(SeriesStore.key(
    chainKeyOf(target),
    isChainMetric ? null : strike,
    isChainMetric ? null : side,
    metric,
  ));
  if (!s || s.size < 2) return 0;
  return s.newest - s.oldest;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function seriesFor(w: Watch): MetricSeries | undefined {
  const chainKey = chainKeyOf(w);
  const isChainMetric = CHAIN_METRICS.includes(w.metric);
  return series.get(SeriesStore.key(
    chainKey,
    isChainMetric ? null : w.strike ?? null,
    isChainMetric ? null : w.side ?? null,
    w.metric,
  ));
}

/**
 * OI-vs-price reading for the contract a watch points at.
 *
 * Only meaningful for an OI watch on a specific contract: the four states are
 * defined by the two series moving together or apart, so both are needed and a
 * chain-level metric has neither.
 */
function buildupFor(w: Watch, oiDelta: number): BuildupKind | undefined {
  if (w.metric !== 'oi' || w.strike == null || !w.side) return undefined;
  const priceSeries = series.get(
    SeriesStore.key(chainKeyOf(w), w.strike, w.side, 'ltp'),
  );
  const price = priceSeries?.delta(w.windowMs);
  if (!price) return undefined;

  const oiUp    = oiDelta > 0;
  const priceUp = price.abs > 0;

  // A flat leg on either side means no story worth naming.
  if (Math.abs(price.pct) < 0.5) return 'flat';

  if (oiUp  && priceUp)  return 'long-buildup';
  if (oiUp  && !priceUp) return 'short-buildup';
  if (!oiUp && priceUp)  return 'short-covering';
  return 'long-unwinding';
}

const BUILDUP_PHRASE: Record<BuildupKind, string> = {
  'long-buildup':   'long buildup',
  'short-buildup':  'short buildup',
  'short-covering': 'short covering',
  'long-unwinding': 'long unwinding',
  flat:             '',
};

/** Human contract name — "NIFTY 25000 CE", or just "NIFTY" for chain metrics. */
function describeTarget(w: Watch): string {
  if (w.strike == null || !w.side) return w.symbol;
  return `${w.symbol} ${w.strike} ${w.side}`;
}

function evaluateOne(w: Watch, now: number): AlertEvent | null {
  if (w.paused) return null;

  const s = seriesFor(w);
  if (!s) return null;

  const d = s.delta(w.windowMs, now);
  if (!d) return null;              // not enough history to cover the window

  // ── direction gate ──
  if (w.direction === 'up'   && d.abs <= 0) { latched.delete(w.id); return null; }
  if (w.direction === 'down' && d.abs >= 0) { latched.delete(w.id); return null; }

  // ── threshold gate ──
  let breached: boolean;
  let significance = undefined as ReturnType<typeof scoreSignificance> | undefined;

  if (w.mode === 'auto') {
    significance = scoreSignificance({
      metric:  w.metric,
      abs:     d.abs,
      pct:     d.pct,
      history: s.deltaHistory(w.windowMs),
    });
    breached = shouldFire(significance.level);
  } else if (w.mode === 'pct') {
    breached = Math.abs(d.pct) >= w.threshold;
  } else {
    breached = Math.abs(d.abs) >= w.threshold;
  }

  if (!breached) {
    latched.delete(w.id);           // back inside — re-arm
    return null;
  }

  // ── re-arm gate ──
  if (latched.has(w.id)) return null;

  // ── cooldown gate ──
  if (w.lastFiredAt && now - w.lastFiredAt < w.cooldownMs) return null;

  latched.add(w.id);

  const direction: 'up' | 'down' = d.abs >= 0 ? 'up' : 'down';
  const buildup = buildupFor(w, d.abs);
  const target = describeTarget(w);
  const minutes = Math.round(w.windowMs / 60_000);
  const windowPhrase = minutes >= 1 ? `${minutes} min` : `${Math.round(w.windowMs / 1000)}s`;

  const verb = significance ? LEVEL_PHRASE[significance.level] : 'moved';
  const arrow = direction === 'up' ? '▲' : '▼';
  const pct = `${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%`;

  const buildupNote = buildup && buildup !== 'flat' ? ` · ${BUILDUP_PHRASE[buildup]}` : '';

  const text =
    `${arrow} ${target} ${w.metric.toUpperCase()} ${pct} over ${windowPhrase} — `
    + `${formatMetric(d.from, w.metric)} → ${formatMetric(d.to, w.metric)}${buildupNote}`;

  const speak =
    `${target.replace(/CE$/, 'call').replace(/PE$/, 'put')} `
    + `${w.metric === 'oi' ? 'open interest' : w.metric} ${verb} `
    + `${direction === 'up' ? 'up' : 'down'} ${Math.abs(d.pct).toFixed(1)} percent `
    + `over ${windowPhrase}, now ${spokenNumber(d.to, w.metric)}`
    + (buildup && buildup !== 'flat' ? `. That is ${BUILDUP_PHRASE[buildup]}.` : '.');

  return {
    id:        `a_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    watchId:   w.id,
    sessionId: w.sessionId,
    firedAt:   now,
    target:    {
      exchange: w.exchange, symbol: w.symbol, expiry: w.expiry,
      strike: w.strike, side: w.side,
    },
    metric:    w.metric,
    from:      d.from,
    to:        d.to,
    deltaPct:  d.pct,
    windowMs:  w.windowMs,
    direction,
    significance,
    buildup,
    text,
    speak,
  };
}

function evaluate(): void {
  const now = Date.now();
  for (const w of allWatches()) {
    let alert: AlertEvent | null = null;
    try {
      alert = evaluateOne(w, now);
    } catch (err) {
      // One malformed watch must never stop the rest from being evaluated.
      console.warn(`[iris/monitor] watch ${w.id} failed: ${(err as Error).message}`);
      continue;
    }
    if (!alert) continue;

    markFired(w.id, now);
    history.push(alert);
    if (history.length > ALERT_HISTORY) history.splice(0, history.length - ALERT_HISTORY);

    for (const sink of sinks) {
      try { sink(alert); } catch { /* a dead socket must not stop the others */ }
    }
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function startMonitor(): void {
  if (timer) return;
  timer = setInterval(evaluate, EVAL_MS);
  timer.unref?.();
  console.log(`[iris/monitor] evaluating every ${EVAL_MS}ms`);
}

export function stopMonitor(): void {
  if (timer) clearInterval(timer);
  timer = null;
  for (const handle of chains.values()) handle.release();
  chains.clear();
}

export function onAlert(sink: AlertSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

/** Recent alerts, newest first. Filtered by session when one is given. */
export function recentAlerts(sessionId?: string, limit = 20): AlertEvent[] {
  const all = sessionId ? history.filter((a) => a.sessionId === sessionId) : history;
  return all.slice(-limit).reverse();
}

/**
 * Watches with their live readings attached.
 *
 * The current value and the running delta come from the series rather than the
 * store, so a listing shows where the metric is NOW — which is the whole reason
 * to ask what you are watching.
 */
export function summarize(watches: Watch[]): WatchSummary[] {
  return watches.map((w) => {
    const s = seriesFor(w);
    const d = s?.delta(w.windowMs);
    return { ...w, current: s?.latest ?? undefined, deltaPct: d?.pct };
  });
}

/** Live reading for one watch — used by the tools when confirming a create. */
export function readWatch(id: string): { current: number | null; deltaPct?: number } | null {
  const w = getWatch(id);
  if (!w) return null;
  const s = seriesFor(w);
  return { current: s?.latest ?? null, deltaPct: s?.delta(w.windowMs)?.pct };
}

export function monitorStats() {
  return {
    watches: allWatches().length,
    chains:  [...chains.keys()],
    series:  series.size,
    alerts:  history.length,
  };
}
