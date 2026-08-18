/**
 * Conversation memory.
 *
 * ── What it buys ──
 *
 * Without it every utterance must be self-contained, and the conversation reads
 * like filling in a form:
 *
 *   "what is the oi on nifty 25000 ce"
 *   "what is the oi on nifty 25100 ce"
 *   "what is the iv on nifty 25100 ce"
 *
 * With it, the same exchange is:
 *
 *   "what is the oi on nifty 25000 ce"
 *   "what about 25100"
 *   "and the iv"
 *
 * That is the entire difference between a command line and an assistant, and it
 * is why `understand()` merges memory UNDER the current turn's slots rather
 * than over them — the newest mention of a slot always wins.
 *
 * ── What it deliberately forgets ──
 *
 * Thresholds, directions and windows are NOT carried forward. They belong to
 * one instruction: "alert me if it moves 5%" followed by "what is the oi"
 * should not silently attach 5% to the next thing. Only the slots that identify
 * a CONTRACT persist, because those are what follow-ups actually elide.
 *
 * ── Expiry ──
 *
 * A conversation goes stale. Someone returning after an hour who says "what
 * about 25100" means today's front month on whatever they are looking at now,
 * not the contract they asked about before lunch. Memory older than TTL is
 * dropped rather than served, so a stale reference becomes a clarifying
 * question instead of a confidently wrong answer.
 */

import type { IntentName, Slots } from './types.js';

/** Slots that identify a contract, and therefore survive between turns. */
const STICKY: (keyof Slots)[] = ['symbol', 'exchange', 'expiry', 'strike', 'side', 'metric'];

const TTL_MS = Number(process.env.QT_ASSISTANT_MEMORY_TTL_MS || 15 * 60_000);

/** Conversations dropped once this many are tracked, oldest first. */
const MAX_SESSIONS = 200;

export interface Conversation {
  sessionId: string;
  slots:     Slots;
  /** Slot the last turn asked the user to supply. */
  awaiting?: keyof Slots;
  /** Intent that was waiting on `awaiting`. */
  pendingIntent?: IntentName;
  /**
   * Intent of the last completed turn.
   *
   * Read by the NLU to resolve elliptical follow-ups ("what about 25100"),
   * which carry a slot but no intent evidence of their own.
   */
  lastIntent?: IntentName;
  /** Chains this conversation asked to keep streaming, so they can be released. */
  subscriptions: Set<string>;
  touchedAt: number;
}

const conversations = new Map<string, Conversation>();

function evictIfNeeded(): void {
  if (conversations.size <= MAX_SESSIONS) return;
  const sorted = [...conversations.values()].sort((a, b) => a.touchedAt - b.touchedAt);
  for (const c of sorted.slice(0, conversations.size - MAX_SESSIONS)) {
    conversations.delete(c.sessionId);
  }
}

export function conversation(sessionId: string): Conversation {
  let c = conversations.get(sessionId);
  if (!c) {
    c = { sessionId, slots: {}, subscriptions: new Set(), touchedAt: Date.now() };
    conversations.set(sessionId, c);
    evictIfNeeded();
  }
  c.touchedAt = Date.now();
  return c;
}

/** Sticky slots, or nothing if the conversation has gone cold. */
export function recall(sessionId: string): Slots {
  const c = conversations.get(sessionId);
  if (!c) return {};
  if (Date.now() - c.touchedAt > TTL_MS) {
    c.slots = {};
    return {};
  }
  return { ...c.slots };
}

/**
 * Fold a turn's slots into memory.
 *
 * A new symbol clears the strike and side: "now show me banknifty" after a
 * NIFTY 25000 CE question must not leave 25000 attached, because 25000 is not a
 * BANKNIFTY strike and the resulting lookup would silently find nothing — or
 * worse, find something.
 */
export function remember(sessionId: string, slots: Slots): void {
  const c = conversation(sessionId);

  if (slots.symbol && slots.symbol !== c.slots.symbol) {
    c.slots = {};
  }
  // Likewise a new expiry invalidates the strike only if the strike was not
  // restated in the same turn — expiries have different strike ladders.
  if (slots.expiry && c.slots.expiry && slots.expiry !== c.slots.expiry && slots.strike == null) {
    delete c.slots.strike;
  }

  for (const key of STICKY) {
    const v = slots[key];
    if (v !== undefined && v !== null && v !== '') {
      (c.slots as Record<string, unknown>)[key] = v;
    }
  }
}

export function setAwaiting(
  sessionId: string, slot: keyof Slots | undefined, intent?: IntentName,
): void {
  const c = conversation(sessionId);
  c.awaiting = slot;
  c.pendingIntent = slot ? intent : undefined;
}

export function clearAwaiting(sessionId: string): void {
  setAwaiting(sessionId, undefined);
}

/**
 * Record the intent a turn resolved to.
 *
 * `unknown` is not recorded: a turn nobody understood is not a context worth
 * continuing, and storing it would let one confused reply poison every
 * follow-up after it.
 */
export function rememberIntent(sessionId: string, intent: IntentName): void {
  if (intent === 'unknown') return;
  conversation(sessionId).lastIntent = intent;
}

export function lastIntentOf(sessionId: string): IntentName | undefined {
  return conversations.get(sessionId)?.lastIntent;
}

export function forget(sessionId: string): void {
  conversations.delete(sessionId);
}

export function trackSubscription(sessionId: string, key: string): void {
  conversation(sessionId).subscriptions.add(key);
}

export function untrackSubscription(sessionId: string, key: string): void {
  conversation(sessionId).subscriptions.delete(key);
}

export function subscriptionsOf(sessionId: string): string[] {
  return [...(conversations.get(sessionId)?.subscriptions ?? [])];
}
