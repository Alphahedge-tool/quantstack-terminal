/**
 * Watch and change capabilities.
 *
 * The half of IRIS that is not a lookup: creating standing instructions,
 * reporting what they are doing, and answering "how much has this moved" from
 * the history those instructions accumulate.
 *
 * ── Why creating a watch also starts sampling ──
 *
 * A watch with no history cannot fire, and worse, an ADAPTIVE watch with no
 * history has no idea what normal looks like. So `createWatch` reconciles the
 * chain set immediately rather than waiting for the next evaluation tick, and
 * the reply says plainly how long it will be before the watch is meaningful.
 * Silently accepting a watch that cannot fire for ten minutes — while sounding
 * like it is armed — is the single worst failure this feature could have.
 */

import type { NubraSession } from '../../brokers/nubra.js';
import type {
  Card, MetricName, OptionSide, Slots, Watch, WatchSummary,
} from '../types.js';
import { CHAIN_METRICS } from '../types.js';
import {
  addWatch, newWatchId, removeWhere, watchesFor, allWatches,
} from '../monitor/watchStore.js';
import {
  reconcileChains, summarize, recentAlerts, changeFor, coverageFor, holdChain,
} from '../monitor/engine.js';
import { LEVEL_PHRASE } from '../monitor/significance.js';
import {
  compactCount, durationPhrase, expiryPhrase, formatMetric, signedPct,
  spokenContract, spokenNumber,
} from '../format.js';
import { ToolError, type ToolResult } from './market.js';

/** Default silence after a fire. Long enough that one move is one alert. */
const DEFAULT_COOLDOWN_MS = Number(process.env.QT_ASSISTANT_COOLDOWN_MS || 5 * 60_000);

interface Target { exchange: string; symbol: string; expiry: string }

function targetOf(slots: Slots): Target {
  if (!slots.symbol) throw new ToolError('I need a symbol for that.');
  if (!slots.expiry) throw new ToolError(`I could not find a listed expiry for ${slots.symbol}.`);
  return { exchange: slots.exchange || 'NSE', symbol: slots.symbol, expiry: slots.expiry };
}

/** "NIFTY 25000 CE OI every 10 minutes" — the phrase echoed back and stored. */
function labelFor(w: Omit<Watch, 'id' | 'label' | 'createdAt' | 'firedCount'>): string {
  const contract = w.strike != null && w.side ? `${w.symbol} ${w.strike} ${w.side}` : w.symbol;
  const trigger =
      w.mode === 'auto' ? 'anything unusual'
    : w.mode === 'pct'  ? `${w.threshold}%`
    :                     compactCount(w.threshold);
  const dir = w.direction === 'up' ? ' up' : w.direction === 'down' ? ' down' : '';
  return `${contract} ${w.metric.toUpperCase()}${dir} ${trigger} / ${durationPhrase(w.windowMs)}`;
}

// ── Create ───────────────────────────────────────────────────────────────────

export async function createWatch(
  slots: Slots, session: NubraSession, sessionId: string,
): Promise<ToolResult> {
  const target = targetOf(slots);
  const metric: MetricName = slots.metric ?? 'oi';
  const isChainMetric = CHAIN_METRICS.includes(metric);

  // A per-contract metric needs a contract. Asked for, never guessed — an
  // alert on the wrong strike is worse than no alert.
  if (!isChainMetric && slots.strike == null) {
    throw new ToolError(
      `Which strike on ${target.symbol} should I watch? `
      + `Or say "the whole chain" and I will watch ${target.symbol} overall.`,
    );
  }

  const windowMs = slots.windowMs ?? 5 * 60_000;
  const mode = slots.mode ?? (slots.threshold != null ? 'pct' : 'auto');
  const threshold = slots.threshold ?? 0;

  if (mode !== 'auto' && threshold <= 0) {
    throw new ToolError('What size of move should I alert on?');
  }

  const draft = {
    exchange:  target.exchange,
    symbol:    target.symbol,
    expiry:    target.expiry,
    strike:    isChainMetric ? undefined : slots.strike,
    side:      isChainMetric ? undefined : (slots.side ?? 'CE') as OptionSide,
    metric,
    windowMs,
    threshold,
    mode,
    direction: slots.direction ?? 'either',
    cooldownMs: DEFAULT_COOLDOWN_MS,
    sessionId,
    paused:    false,
  };

  const watch: Watch = {
    ...draft,
    id:        newWatchId(),
    label:     labelFor(draft),
    createdAt: Date.now(),
    firedCount: 0,
  };

  addWatch(watch);

  // Subscribe now, not on the next tick — see the header.
  await reconcileChains(session);

  const have = coverageFor(target, watch.strike ?? null, watch.side ?? null, metric);
  const short = have < windowMs;
  // Adaptive mode needs several windows of history, not one, before its sense
  // of "normal" means anything. Say so rather than let it look armed.
  const warmup = mode === 'auto' ? windowMs * 6 : windowMs;
  const waitMs = Math.max(0, warmup - have);

  const contract = watch.strike != null ? `${target.symbol} ${watch.strike} ${watch.side}` : target.symbol;
  const trigger =
      mode === 'auto' ? 'anything statistically unusual'
    : mode === 'pct'  ? `a ${threshold}% move`
    :                   `a move of ${compactCount(threshold)}`;
  const dirPhrase = watch.direction === 'either' ? '' : ` ${watch.direction}`;

  const readyNote = waitMs > 0
    ? ` I need about ${durationPhrase(waitMs)} of history before this can fire.`
    : '';

  return {
    text:
      `Watching ${contract} ${metric.toUpperCase()}${dirPhrase} for ${trigger} `
      + `over ${durationPhrase(windowMs)}.${readyNote}`,
    speak:
      `Okay. Watching ${spokenContract(target.symbol, watch.strike, watch.side)} `
      + `${metric === 'oi' ? 'open interest' : metric} for ${trigger} over `
      + `${durationPhrase(windowMs)}.`
      + (waitMs > 0 ? ` I will need about ${durationPhrase(waitMs)} of history first.` : ''),
    cards: [watchCard('Watch created', summarize([watch]))],
  };
}

// ── List ─────────────────────────────────────────────────────────────────────

function watchCard(title: string, watches: WatchSummary[]): Card {
  return { kind: 'watches', title, watches };
}

export function listWatches(sessionId: string): ToolResult {
  // Every watch, not just this session's: a browser reload mints a new session
  // id, and a user who set five alerts before refreshing must not be told they
  // have none. The card marks which belong to the current connection.
  const mine = watchesFor(sessionId);
  const all = allWatches();
  const shown = mine.length ? mine : all;

  if (!shown.length) {
    return {
      text: 'Nothing is being watched right now.',
      speak: 'You have no active watches.',
      cards: [],
    };
  }

  const summaries = summarize(shown);
  const lines = summaries.map((w) => {
    const now = w.current != null ? formatMetric(w.current, w.metric) : '—';
    const chg = w.deltaPct != null ? ` (${signedPct(w.deltaPct)})` : '';
    return `${w.label} — now ${now}${chg}`;
  });

  return {
    text: `${shown.length} active watch${shown.length === 1 ? '' : 'es'}:\n${lines.join('\n')}`,
    speak:
      `You have ${shown.length} active watch${shown.length === 1 ? '' : 'es'}. `
      + summaries.slice(0, 3).map((w) =>
          `${spokenContract(w.symbol, w.strike, w.side)} ${w.metric === 'oi' ? 'open interest' : w.metric}`,
        ).join(', ')
      + (shown.length > 3 ? `, and ${shown.length - 3} more.` : '.'),
    cards: [watchCard('Active watches', summaries)],
  };
}

// ── Cancel ───────────────────────────────────────────────────────────────────

/**
 * Cancel by whatever the user named.
 *
 * The matcher narrows from broad to specific: with no slots at all, "cancel my
 * watches" means all of them; with a symbol it means that symbol's; with a
 * strike it means that contract's. Cancelling more than the user meant is the
 * dangerous direction, so anything that names a contract is treated as scoped.
 */
export async function cancelWatches(
  slots: Slots, session: NubraSession | null, sessionId: string,
): Promise<ToolResult> {
  const scoped = Boolean(slots.symbol || slots.strike != null || slots.watchId);

  const gone = removeWhere((w) => {
    if (slots.watchId && w.id !== slots.watchId) return false;
    if (slots.symbol && w.symbol !== slots.symbol) return false;
    if (slots.strike != null && w.strike !== slots.strike) return false;
    if (slots.side && w.side !== slots.side) return false;
    if (slots.metric && w.metric !== slots.metric) return false;
    // Unscoped "cancel everything" is limited to this conversation's own
    // watches. Wiping another tab's alerts on a bare "stop" would be a
    // surprising amount of destruction from a two-word command.
    if (!scoped && w.sessionId !== sessionId) return false;
    return true;
  });

  if (session) await reconcileChains(session);

  if (!gone.length) {
    return {
      text: 'I could not find a matching watch.',
      speak: 'I could not find a matching watch.',
      cards: [],
    };
  }

  const what = gone.length === 1 ? gone[0].label : `${gone.length} watches`;
  return {
    text: `Cancelled ${what}.`,
    speak: `Cancelled ${gone.length === 1 ? 'that watch' : `${gone.length} watches`}.`,
    cards: [],
  };
}

// ── Recent alerts ────────────────────────────────────────────────────────────

export function listAlerts(sessionId: string): ToolResult {
  const alerts = recentAlerts(undefined, 20);
  if (!alerts.length) {
    return {
      text: 'Nothing has fired yet.',
      speak: 'Nothing has fired yet.',
      cards: [],
    };
  }
  const newest = alerts[0];
  return {
    text: `${alerts.length} recent alert${alerts.length === 1 ? '' : 's'}. Latest: ${newest.text}`,
    speak: `Most recent: ${newest.speak}`,
    cards: [{ kind: 'alerts', title: 'Recent alerts', alerts }],
  };
}

// ── Change over a window ─────────────────────────────────────────────────────

/**
 * "How much has X moved in the last N minutes."
 *
 * Answered from the monitor's own series, which means it can only speak for the
 * time it has been sampling. When that is shorter than the window asked for it
 * says so and starts sampling, rather than quietly answering over whatever it
 * happens to have — the difference between "OI is up 4% in ten minutes" and "OI
 * is up 4% in the ninety seconds I have been watching" is the whole answer.
 */
export async function readChange(
  slots: Slots, session: NubraSession, sessionId: string,
): Promise<ToolResult> {
  const target = targetOf(slots);
  const metric: MetricName = slots.metric ?? 'oi';
  const windowMs = slots.windowMs ?? 10 * 60_000;
  const isChainMetric = CHAIN_METRICS.includes(metric);

  if (!isChainMetric && slots.strike == null) {
    throw new ToolError(`Which strike on ${target.symbol}?`);
  }

  const strike = isChainMetric ? null : slots.strike!;
  const side = isChainMetric ? null : (slots.side ?? 'CE');

  // Start sampling regardless of the outcome: if the answer is "not yet", the
  // follow-up in five minutes should succeed without the user re-asking twice.
  await holdChain(sessionId, target, session);

  const change = changeFor(target, strike, side, metric, windowMs);

  if (!change) {
    const have = coverageFor(target, strike, side, metric);
    const contract = strike != null ? `${target.symbol} ${strike} ${side}` : target.symbol;
    const haveNote = have > 0
      ? `I have ${durationPhrase(have)} of history so far`
      : 'I have just started sampling it';
    return {
      text:
        `I cannot cover ${durationPhrase(windowMs)} on ${contract} yet — ${haveNote}. `
        + 'I am watching it now, so ask again shortly.',
      speak:
        `I do not have ${durationPhrase(windowMs)} of history on that yet. `
        + 'I have started watching it, so ask me again in a few minutes.',
      cards: [],
    };
  }

  const contract = strike != null ? `${target.symbol} ${strike} ${side}` : target.symbol;
  const verb = LEVEL_PHRASE[change.significance.level];
  const buildupNote = change.buildup && change.buildup !== 'flat'
    ? ` — reads as ${change.buildup.replace('-', ' ')}`
    : '';

  const rows = [
    { label: `${durationPhrase(windowMs)} ago`, value: formatMetric(change.from, metric) },
    { label: 'Now',    value: formatMetric(change.to, metric) },
    { label: 'Change', value: `${formatMetric(change.abs, metric)} (${signedPct(change.pct)})`,
      tone: (change.abs >= 0 ? 'up' : 'down') as 'up' | 'down' },
    { label: 'Unusual?', value: change.significance.level === 'normal'
        ? 'within its normal range'
        : `${change.significance.level} (${change.significance.z.toFixed(1)}σ)` },
  ];

  return {
    text:
      `${contract} ${metric.toUpperCase()} ${signedPct(change.pct)} over `
      + `${durationPhrase(windowMs)} — ${formatMetric(change.from, metric)} → `
      + `${formatMetric(change.to, metric)}${buildupNote}`,
    speak:
      `${spokenContract(target.symbol, strike ?? undefined, side ?? undefined)} `
      + `${metric === 'oi' ? 'open interest' : metric} ${verb} `
      + `${change.abs >= 0 ? 'up' : 'down'} ${Math.abs(change.pct).toFixed(1)} percent over `
      + `${durationPhrase(windowMs)}, now ${spokenNumber(change.to, metric)}`
      + (change.buildup && change.buildup !== 'flat'
          ? `. That reads as ${change.buildup.replace('-', ' ')}.` : '.'),
    cards: [{
      kind: 'change',
      title: `${contract} · ${metric.toUpperCase()} · ${durationPhrase(windowMs)}`,
      metric,
      from: change.from,
      to: change.to,
      deltaPct: change.pct,
      windowMs,
      significance: change.significance,
      rows,
    }],
  };
}

// ── Streaming control ────────────────────────────────────────────────────────

export async function subscribeChain(
  slots: Slots, session: NubraSession, sessionId: string,
): Promise<ToolResult> {
  const target = targetOf(slots);
  await holdChain(sessionId, target, session);
  return {
    text: `Streaming the ${target.symbol} ${expiryPhrase(target.expiry)} chain. I will build history as it ticks.`,
    speak: `Streaming ${target.symbol.toLowerCase()}. I will build history as it ticks.`,
    cards: [],
  };
}
