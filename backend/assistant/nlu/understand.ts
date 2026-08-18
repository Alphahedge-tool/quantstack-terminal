/**
 * The scorer — utterance in, `Interpretation` out.
 *
 * ── The blend ──
 *
 * Four signals, weighted, because each one alone has a failure mode this engine
 * would hit within a day of real use:
 *
 *   anchors (0.42)   Precise but brittle. Nails the phrasings that were
 *                    enumerated, scores 0 on the ones that were not.
 *   exemplars (0.30) Robust but blunt. Catches unseen wordings, and happily
 *                    rates "cancel my nifty watch" as `watch.create` because
 *                    they share most of their trigrams. Never trusted alone —
 *                    which is what `require`/`veto` gates are for.
 *   slot fit (0.20)  The domain's own evidence. An utterance carrying a window
 *                    and a threshold is a watch, whatever verb it used.
 *   prior (0.08)     Tie-break only, so a rare-but-decisive intent like `stop`
 *                    is not buried by a verbose one.
 *
 * The weights sum to 1 and are tuned so a clean match lands ~0.8+, a plausible
 * one ~0.5, and noise below CONFIDENCE_FLOOR. They are constants in one place
 * on purpose: tuning is a numbers change, never a control-flow change.
 *
 * ── Asking beats guessing ──
 *
 * Two outcomes short-circuit the tools:
 *
 *   confidence < FLOOR   → `unknown`, and the caller offers alternates.
 *   `needs` unmet        → the intent stands, but `missing` is populated and
 *                          the caller asks one question to fill it.
 *
 * Both exist because the cost of a wrong answer here is not a bad sentence, it
 * is a trader acting on the open interest of a contract they did not ask about.
 */

import type { NubraSession } from '../../brokers/nubra.js';
import type { IntentName, Interpretation, Slots } from '../types.js';
import { normalize } from './normalize.js';
import { extract, resolveExpiry, type ExpiryHint } from './entities.js';
import { INTENT_RULES, type IntentRule } from './grammar.js';
import { dice, similar } from './fuzzy.js';

/**
 * Passing the `require` gate is itself evidence, and is scored as such.
 *
 * It was not, originally, and that was wrong in a way that only showed up on
 * real traffic. "iv of 24200 ce and pe of next expiry" contains no question
 * word, so it scored 0 on anchors and landed at 0.28 — under the floor, and
 * answered with "I am not sure I follow" despite naming a metric, a strike, two
 * sides and an expiry. Traders type telegraphically; the engine has to read
 * telegraphic input.
 *
 * A constant for every surviving rule does not disturb their RELATIVE ranking —
 * it lifts the whole field, which is exactly the intent: a rule whose gate
 * passed has matched a required keyword group and deserves to clear the "did
 * you understand me at all" bar. Utterances that match no gate still score 0
 * and still come back as unknown.
 */
const W_GATE     = 0.20;
const W_ANCHOR   = 0.32;
const W_EXEMPLAR = 0.24;
const W_SLOT     = 0.18;
const W_PRIOR    = 0.06;

/** Below this the engine asks instead of acting. */
export const CONFIDENCE_FLOOR = 0.34;

/** Fuzzy floor for a single word matching a vocabulary group member. */
const WORD_FLOOR = 0.86;

// ── Word-group matching ──────────────────────────────────────────────────────

/**
 * Does any token match any word in `group`?
 *
 * Exact first (the common case, and free), then fuzzy — so "notifiy" still
 * matches "notify" but "notice" does not clear the floor.
 */
function groupHit(tokens: string[], group: string[]): boolean {
  const set = new Set(group);
  for (const t of tokens) if (set.has(t)) return true;
  for (const t of tokens) {
    if (t.length < 4) continue;      // short tokens fuzz into everything
    for (const w of group) {
      if (w.length < 4) continue;
      if (similar(t, w) >= WORD_FLOOR) return true;
    }
  }
  return false;
}

function anchorScore(tokens: string[], rule: IntentRule): number {
  const groups = rule.anchors ?? [];
  if (!groups.length) return 0.5;    // no anchors declared — neutral, not zero
  let hits = 0;
  for (const g of groups) if (groupHit(tokens, g)) hits++;
  return hits / groups.length;
}

function exemplarScore(text: string, rule: IntentRule): number {
  let best = 0;
  for (const ex of rule.exemplars) {
    const s = dice(text, ex);
    if (s > best) best = s;
  }
  return best;
}

/**
 * How well the extracted slots support this intent.
 *
 * `needs` present is worth more than `prefers` present, and an intent with
 * neither declared sits at neutral rather than at zero — `help` and `greeting`
 * legitimately carry no slots and must not be punished for it.
 */
function slotScore(slots: Slots, rule: IntentRule): number {
  const needs   = rule.needs   ?? [];
  const prefers = rule.prefers ?? [];
  if (!needs.length && !prefers.length) return 0.5;

  const has = (k: keyof Slots) => slots[k] !== undefined && slots[k] !== null;

  const needHits   = needs.filter(has).length;
  const preferHits = prefers.filter(has).length;

  const needPart   = needs.length   ? needHits / needs.length     : 1;
  const preferPart = prefers.length ? preferHits / prefers.length : 0.5;

  return needPart * 0.7 + preferPart * 0.3;
}

function vetoed(tokens: string[], rule: IntentRule): boolean {
  if (!rule.veto?.length) return false;
  const set = new Set(rule.veto);
  return tokens.some((t) => set.has(t));
}

function gated(tokens: string[], rule: IntentRule): boolean {
  for (const group of rule.require ?? []) {
    if (!groupHit(tokens, group)) return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface UnderstandContext {
  session: NubraSession | null;
  /**
   * Slots carried forward from earlier turns.
   *
   * Merged UNDER the utterance's own slots, never over them: "and the 25100?"
   * must take its strike from this turn and its symbol from memory, and the
   * reverse would pin the conversation to whatever was said first.
   */
  memory?: Slots;
  /**
   * Slot the previous turn asked for. When set, a bare answer ("banknifty",
   * "10 minutes") is routed to that slot instead of being scored as a new
   * intent — which is what stops "nifty" alone from reading as a greeting.
   */
  awaiting?: keyof Slots;
  /** Intent the previous turn was building, resumed once `awaiting` is filled. */
  pendingIntent?: IntentName;
  /**
   * Intent of the previous COMPLETED turn.
   *
   * Powers elliptical follow-ups — see `CONTINUABLE` below.
   */
  lastIntent?: IntentName;
}

/**
 * Intents a bare slot may silently continue.
 *
 * "what about 25100" carries a strike and nothing else: no verb, no metric, no
 * question word. Every rule's gate is token-based, so nothing matches and the
 * turn scores as unknown — even though its meaning is obvious from the turn
 * before it. Repeating the previous intent against the new slot is what makes
 * a conversation a conversation.
 *
 * Reads only. `watch.create` is deliberately absent: continuing it would mean
 * "and 25100" silently arms a second alert on a contract the user was merely
 * asking about, and a standing instruction must always be stated out loud.
 * Same for `watch.cancel`, where the silent version deletes things.
 */
const CONTINUABLE = new Set<IntentName>([
  'metric.get', 'quote.get', 'change.get',
  'chain.summary', 'chain.watchlist', 'history.get',
]);

/** Slots that, alone, are enough to mean "the same question about this". */
const CONTINUATION_SLOTS: (keyof Slots)[] = ['strike', 'symbol', 'side', 'metric', 'expiry'];

export async function understand(
  raw: string,
  ctx: UnderstandContext,
): Promise<Interpretation> {
  const { text, tokens } = normalize(raw);

  if (!tokens.length) {
    return {
      intent: 'unknown', slots: {}, confidence: 0, missing: [],
      normalized: '', alternates: [],
    };
  }

  const { slots: fresh, expiryHint } = await extract(tokens, ctx.session);

  // ── Slot-filling turn ──
  //
  // Handled before scoring, not after: a one-word reply to "which symbol?" has
  // no intent evidence at all, and running it through the scorer would produce
  // a confident wrong answer rather than the obvious right one.
  if (ctx.awaiting && ctx.pendingIntent) {
    const filled = fresh[ctx.awaiting] !== undefined;
    if (filled) {
      const merged = mergeSlots(fresh, ctx.memory);
      await attachExpiry(merged, expiryHint, ctx.session);
      const rule = INTENT_RULES.find((r) => r.name === ctx.pendingIntent);
      return {
        intent: ctx.pendingIntent,
        slots: merged,
        confidence: 0.9,
        missing: rule ? missingSlots(merged, rule) : [],
        normalized: text,
        alternates: [],
      };
    }
  }

  // ── Score every rule ──
  const scored: Array<{ intent: IntentName; confidence: number }> = [];

  for (const rule of INTENT_RULES) {
    if (vetoed(tokens, rule)) continue;
    if (gated(tokens, rule))  continue;

    const merged = mergeSlots(fresh, ctx.memory);
    // Every rule reaching here passed its gate — see W_GATE. Rules that declare
    // no gate get half credit: they have proved nothing, but they were not
    // required to.
    const gate = (rule.require?.length ?? 0) > 0 ? 1 : 0.5;
    const raw =
        gate                        * W_GATE
      + anchorScore(tokens, rule)   * W_ANCHOR
      + exemplarScore(text, rule)   * W_EXEMPLAR
      + slotScore(merged, rule)     * W_SLOT
      + Math.min(1, (rule.prior ?? 1) - 0.5) * W_PRIOR;

    scored.push({ intent: rule.name, confidence: Math.max(0, Math.min(1, raw)) });
  }

  scored.sort((a, b) => b.confidence - a.confidence);

  const top = scored[0];
  if (!top || top.confidence < CONFIDENCE_FLOOR) {
    // ── Elliptical follow-up ──
    //
    // Nothing scored, but the turn DID name a contract and the previous turn
    // was a question that can be re-asked. "what about 25100" after "what is
    // the oi on nifty 25000 ce" is the whole point of having memory.
    const continuation = ctx.lastIntent && CONTINUABLE.has(ctx.lastIntent)
      && CONTINUATION_SLOTS.some((k) => fresh[k] !== undefined);

    if (continuation) {
      const slots = mergeSlots(fresh, ctx.memory);
      await attachExpiry(slots, expiryHint, ctx.session);
      applyDefaults(slots, ctx.lastIntent!);
      const rule = INTENT_RULES.find((r) => r.name === ctx.lastIntent);
      return {
        intent: ctx.lastIntent!,
        // Below a clean match on purpose: this is inference from context, not
        // evidence in the sentence, and the number should say so.
        confidence: 0.55,
        slots,
        missing: rule ? missingSlots(slots, rule) : [],
        normalized: text,
        alternates: scored.slice(0, 3),
      };
    }

    return {
      intent: 'unknown',
      slots: mergeSlots(fresh, ctx.memory),
      confidence: top?.confidence ?? 0,
      missing: [],
      normalized: text,
      alternates: scored.slice(0, 3),
    };
  }

  const rule = INTENT_RULES.find((r) => r.name === top.intent)!;
  const slots = mergeSlots(fresh, ctx.memory);
  await attachExpiry(slots, expiryHint, ctx.session);
  applyDefaults(slots, top.intent);

  return {
    intent: top.intent,
    slots,
    confidence: top.confidence,
    missing: missingSlots(slots, rule),
    normalized: text,
    alternates: scored.slice(1, 4),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** This turn's slots win; memory only fills holes. */
function mergeSlots(fresh: Slots, memory?: Slots): Slots {
  if (!memory) return { ...fresh };
  const out: Slots = { ...fresh };
  for (const [k, v] of Object.entries(memory) as [keyof Slots, unknown][]) {
    if (out[k] === undefined && v !== undefined) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  // `rest` is this turn's leftover text and must never be inherited — an old
  // remainder shown in a clarification is confusing at best.
  if (fresh.rest === undefined) delete out.rest;
  return out;
}

async function attachExpiry(
  slots: Slots, hint: ExpiryHint | null, session: NubraSession | null,
): Promise<void> {
  if (!slots.symbol) return;
  // An expiry the user named this turn overrides one carried in memory; with no
  // hint at all, an inherited expiry stands and only a bare symbol resolves to
  // the front month.
  if (hint || !slots.expiry) {
    const resolved = await resolveExpiry(
      slots.symbol, slots.exchange || 'NSE', hint, session,
    );
    if (resolved) slots.expiry = resolved;
  }
}

/**
 * Intent-specific defaults.
 *
 * Only for slots where a missing value has one obviously correct reading. A
 * default that could plausibly be several things belongs in `needs` so the
 * engine asks — the window on a watch is 5 minutes because that is the shortest
 * useful OI horizon, but the SYMBOL is never defaulted.
 */
function applyDefaults(slots: Slots, intent: IntentName): void {
  switch (intent) {
    case 'watch.create':
      slots.windowMs  ??= 5 * 60_000;
      slots.direction ??= 'either';
      slots.mode      ??= slots.threshold != null ? 'pct' : 'auto';
      slots.metric    ??= 'oi';
      break;
    case 'change.get':
      slots.windowMs ??= 10 * 60_000;
      slots.metric   ??= 'oi';
      break;
    case 'chain.watchlist':
      slots.windowMs ??= 15 * 60_000;
      slots.metric   ??= 'oi';
      break;
    case 'metric.get':
      slots.metric ??= 'ltp';
      break;
    case 'quote.get':
      slots.metric = 'ltp';
      break;
    case 'history.get':
      slots.rangeMs  ??= 86_400_000;
      slots.metric   ??= 'ltp';
      break;
    default:
      break;
  }
}

function missingSlots(slots: Slots, rule: IntentRule): (keyof Slots)[] {
  return (rule.needs ?? []).filter(
    (k) => slots[k] === undefined || slots[k] === null || slots[k] === '',
  );
}
