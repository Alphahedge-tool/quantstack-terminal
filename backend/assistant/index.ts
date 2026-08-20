/**
 * IRIS — the engine facade.
 *
 * One entry point: `ask(text, sessionId)` → `Reply`. Everything else in this
 * folder is reachable only through here, so the socket layer never has to know
 * that there is an NLU, a monitor or a chain feed behind it.
 *
 * ── The turn ──
 *
 *   1. understand      text + memory        → Interpretation
 *   2. gate            confidence, missing  → maybe a question instead
 *   3. dispatch        intent               → a tool
 *   4. remember        slots                → memory for the next turn
 *
 * Step 2 is the one that makes this usable. An assistant that always acts will
 * eventually act on a misheard strike, and in a trading terminal the user will
 * believe it — the number will look plausible. So a low-confidence turn asks,
 * and a turn missing a required slot asks for exactly that slot and nothing
 * else. One question, never a form.
 *
 * ── Errors are answers ──
 *
 * A `ToolError` is not a failure to report as "something went wrong"; it is the
 * assistant explaining why it cannot answer — "25000 CE is not in this chain,
 * nearest are 24950, 25050". That text is more useful than the answer would
 * have been, so it is returned as a normal reply with `error: true` rather than
 * thrown at the socket.
 */

import type { NubraSession } from '../brokers/nubra.js';
import { getSession } from '../lib/sessionStore.js';
import type { Interpretation, IntentName, Reply, Slots } from './types.js';
import { IRIS_NAME } from './types.js';
import { understand, CONFIDENCE_FLOOR } from './nlu/understand.js';
import {
  conversation, recall, remember, setAwaiting, clearAwaiting, forget,
  rememberIntent, lastIntentOf,
} from './memory.js';
import { ToolError, readContract, readChain, readBuildup, readHistory } from './tools/market.js';
import {
  createWatch, listWatches, cancelWatches, listAlerts, readChange, subscribeChain,
} from './tools/watches.js';
import { startMonitor, reconcileChains, releaseHeld } from './monitor/engine.js';

import { logger } from '../lib/logger.js';

const log = logger('iris');

export { onAlert, recentAlerts, monitorStats } from './monitor/engine.js';
export { chainStats } from './chainFeed.js';

// ── Questions ────────────────────────────────────────────────────────────────

/**
 * What to ask when a slot is missing.
 *
 * Phrased as a question a person would actually answer in one word, because
 * that is what the slot-filling path in `understand()` expects back. "Which
 * symbol?" gets "nifty"; "Please provide the underlying instrument identifier"
 * gets a sigh.
 */
const SLOT_QUESTION: Partial<Record<keyof Slots, string>> = {
  symbol:    'Which symbol?',
  strike:    'Which strike?',
  side:      'Call or put?',
  metric:    'Which metric — OI, price, IV or a greek?',
  windowMs:  'Over what time window?',
  threshold: 'How big a move should trigger it?',
  expiry:    'Which expiry?',
};

const HELP_TEXT = [
  `I watch option chains and tell you when something moves. Ask me things like:`,
  ``,
  `  · "what's the OI on nifty 25000 CE"`,
  `  · "how much has that moved in the last 10 minutes"`,
  `  · "show me the banknifty chain"`,
  `  · "where's the OI buildup in nifty"`,
  `  · "track OI on nifty 25000 CE, tell me if it moves 5% in 10 min"`,
  `  · "let me know if anything significant happens on banknifty"`,
  `  · "get me the historical IV for nifty 25000 CE last week"`,
  `  · "what are you watching" · "cancel that watch" · "any alerts"`,
  ``,
  `Follow-ups work — after asking about one strike, "and the 25100?" or "what about the IV" keeps the context.`,
].join('\n');

const HELP_SPEAK =
  `I watch option chains and tell you when something moves. Ask me for open interest, `
  + `price, implied volatility or greeks on any strike. Ask how much something has moved `
  + `over a window. Or tell me to track a contract and alert you when it moves.`;

// ── Public API ───────────────────────────────────────────────────────────────

let started = false;

/** Start the monitor and restore any persisted watches. Idempotent. */
export function startAssistant(): void {
  if (started) return;
  started = true;
  startMonitor();
  const session = getSession();
  if (session) {
    reconcileChains(session).catch((err) =>
      log.warn(`could not restore watch subscriptions: ${(err as Error).message}`),
    );
  }
  log.info(`${IRIS_NAME} ready`);
}

/** Release everything a disconnecting conversation held. */
export function endConversation(sessionId: string): void {
  releaseHeld(sessionId);
  forget(sessionId);
}

export interface AskOptions {
  sessionId: string;
  /** Echoed back on the reply so the client can match its pending turn. */
  id?: string;
}

export async function ask(text: string, opts: AskOptions): Promise<Reply> {
  const { sessionId } = opts;
  const id = opts.id ?? `r_${Date.now().toString(36)}`;
  const convo = conversation(sessionId);
  const session = getSession();

  const interpretation = await understand(text, {
    session,
    memory: recall(sessionId),
    awaiting: convo.awaiting,
    pendingIntent: convo.pendingIntent,
    lastIntent: lastIntentOf(sessionId),
  });

  // Remember before dispatch: even a turn that ends in a question has told us
  // something ("banknifty" alone still sets the symbol), and a failed lookup
  // should not erase the context the user just established.
  remember(sessionId, interpretation.slots);

  const reply = await dispatch(interpretation, { sessionId, id, session });

  // A turn that answered clears any pending question; one that asked sets it.
  if (reply.awaiting) setAwaiting(sessionId, reply.awaiting, interpretation.intent);
  else clearAwaiting(sessionId);

  // Recorded whenever the turn was UNDERSTOOD, even if the lookup then failed.
  //
  // The distinction matters more than it looks. A tool error means "I knew what
  // you asked and could not answer it" — the context is still valid, and the
  // next turn should be able to elide against it. Skipping the record on error
  // meant one "IV history is empty" reply silently poisoned the rest of the
  // conversation: every following follow-up had no intent to continue and came
  // back as "I am not sure I follow", which is how a single miss turned into
  // four in a row.
  rememberIntent(sessionId, interpretation.intent);

  return reply;
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

interface Ctx {
  sessionId: string;
  id: string;
  session: NubraSession | null;
}

async function dispatch(interp: Interpretation, ctx: Ctx): Promise<Reply> {
  const { intent, slots, confidence } = interp;
  const base = { id: ctx.id, intent, confidence };

  // ── Conversational intents: no session, no market needed ──
  switch (intent) {
    case 'greeting':
      return {
        ...base,
        text: `Hello. Ask me about a chain, or tell me what to watch.`,
        speak: `Hi. What would you like me to look at?`,
      };
    case 'help':
      return { ...base, text: HELP_TEXT, speak: HELP_SPEAK };
    case 'stop':
      return { ...base, text: 'Stopped.', speak: '' };
    case 'watch.list':
      return { ...base, ...listWatches(ctx.sessionId) };
    case 'alerts.recent':
      return { ...base, ...listAlerts(ctx.sessionId) };
    case 'unknown':
      return unknownReply(interp, ctx);
    default:
      break;
  }

  // ── Everything below needs a live session ──
  if (!ctx.session) {
    return {
      ...base,
      text: 'I am not connected to the broker yet — log in and ask me again.',
      speak: 'I am not connected to the broker yet.',
      error: true,
    };
  }

  // ── Missing slots: ask for exactly one ──
  if (interp.missing.length) {
    const slot = interp.missing[0];
    const question = SLOT_QUESTION[slot] ?? `I need the ${String(slot)}.`;
    return { ...base, text: question, speak: question, awaiting: slot };
  }

  try {
    switch (intent) {
      case 'metric.get':
      case 'quote.get':
        return { ...base, ...(await readContract(slots, ctx.session)) };

      case 'change.get':
        return { ...base, ...(await readChange(slots, ctx.session, ctx.sessionId)) };

      case 'chain.summary':
        return { ...base, ...(await readChain(slots, ctx.session)) };

      case 'chain.watchlist':
        return { ...base, ...(await readBuildup(slots, ctx.session)) };

      case 'history.get':
        return { ...base, ...(await readHistory(slots, ctx.session)) };

      case 'watch.create':
        return { ...base, ...(await createWatch(slots, ctx.session, ctx.sessionId)) };

      case 'watch.cancel':
        return { ...base, ...(await cancelWatches(slots, ctx.session, ctx.sessionId)) };

      case 'subscribe.chain':
        return { ...base, ...(await subscribeChain(slots, ctx.session, ctx.sessionId)) };

      case 'unsubscribe.chain':
        releaseHeld(ctx.sessionId);
        return {
          ...base,
          text: 'Stopped streaming. Watches keep running.',
          speak: 'Stopped streaming.',
        };

      default:
        return unknownReply(interp, ctx);
    }
  } catch (err) {
    if (err instanceof ToolError) {
      // The tool explained itself — that explanation IS the answer, and asking
      // for a slot it named ("Which strike?") keeps the conversation moving.
      const awaiting = /which strike/i.test(err.message) ? 'strike' as const
                     : /which symbol/i.test(err.message) ? 'symbol' as const
                     : undefined;
      return { ...base, text: err.message, speak: err.message, error: true, awaiting };
    }
    const message = (err as Error)?.message || 'Something went wrong.';
    log.warn(`${intent} failed: ${message}`);
    return {
      ...base,
      text: `I could not do that: ${message}`,
      speak: 'Sorry, that did not work.',
      error: true,
    };
  }
}

/**
 * Nothing matched.
 *
 * Offers the runner-up rather than a generic apology when there was one worth
 * offering — "did you mean the option chain?" is recoverable in one word, where
 * "I did not understand" makes the user start over.
 */
function unknownReply(interp: Interpretation, ctx: Ctx): Reply {
  const base = { id: ctx.id, intent: 'unknown' as IntentName, confidence: interp.confidence };
  const near = interp.alternates.find((a) => a.confidence > CONFIDENCE_FLOOR * 0.6);

  if (near) {
    const hint = INTENT_HINT[near.intent];
    if (hint) {
      return {
        ...base,
        text: `I am not sure I follow. Did you mean ${hint}?`,
        speak: `I am not sure I follow. Did you mean ${hint}?`,
      };
    }
  }

  return {
    ...base,
    text: `I did not catch that. Say "help" to hear what I can do.`,
    speak: `I did not catch that. Say help to hear what I can do.`,
  };
}

const INTENT_HINT: Partial<Record<IntentName, string>> = {
  'metric.get':      'a reading like open interest or IV',
  'quote.get':       'the price of a contract',
  'change.get':      'how much something has moved',
  'chain.summary':   'the option chain',
  'chain.watchlist': 'where the OI is building',
  'history.get':     'historical data',
  'watch.create':    'setting up a watch',
  'watch.list':      'your active watches',
  'watch.cancel':    'cancelling a watch',
  'alerts.recent':   'recent alerts',
};
