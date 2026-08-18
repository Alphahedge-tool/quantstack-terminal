/**
 * Verify the IRIS language engine.
 *
 * Runs offline — no session, no network, no market. Symbol resolution falls
 * back to the index aliases in lexicon.ts, which is exactly the degraded mode
 * the engine has to survive before login, so testing there is testing the worst
 * case rather than a convenient one.
 *
 * Each case asserts the intent and the slots that MATTER for that intent. It
 * deliberately does not assert confidence values: those move whenever the
 * weights are tuned, and a test that pins them would turn every tuning pass
 * into a test-rewriting pass. What must not change is which intent wins and
 * which contract the slots point at.
 *
 *   npm run verify:assistant
 */

import { understand } from '../assistant/nlu/understand.js';
import { normalize } from '../assistant/nlu/normalize.js';
import type { IntentName, Slots } from '../assistant/types.js';

interface Case {
  say:    string;
  intent: IntentName;
  /** Only the slots worth pinning for this utterance. */
  want?:  Partial<Slots>;
  /**
   * Conversation memory in play for this turn.
   *
   * Worth testing explicitly, because memory CHANGES routing: it fills slots,
   * which raises the slot-fit score of any intent that wanted them. A rule that
   * routes correctly from a cold start can route wrongly two turns into a
   * conversation — which is exactly the bug "where is the oi buildup" hit once
   * an earlier turn had put a strike in memory.
   */
  memory?: Partial<Slots>;
  /** Intent of the previous turn, for elliptical follow-ups. */
  lastIntent?: IntentName;
}

const CASES: Case[] = [
  // ── Conversational ──
  { say: 'hey iris',                     intent: 'greeting' },
  { say: 'hello',                        intent: 'greeting' },
  { say: 'what can you do',              intent: 'help' },
  { say: 'help me',                      intent: 'help' },
  { say: 'stop',                         intent: 'stop' },
  { say: 'be quiet',                     intent: 'stop' },

  // ── Reads ──
  {
    say: 'what is the oi on nifty 25000 ce',
    intent: 'metric.get',
    want: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi' },
  },
  {
    // Spoken numerals — the path that only exists because of voice input.
    say: 'open interest on nifty twenty five thousand call',
    intent: 'metric.get',
    want: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi' },
  },
  {
    say: 'what is nifty 25000 ce trading at',
    intent: 'quote.get',
    want: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'ltp' },
  },
  {
    say: 'how much has the oi changed in the last 10 minutes on nifty 25000 pe',
    intent: 'change.get',
    want: { symbol: 'NIFTY', strike: 25000, side: 'PE', metric: 'oi', windowMs: 600_000 },
  },
  {
    say: 'show me the nifty option chain',
    intent: 'chain.summary',
    want: { symbol: 'NIFTY' },
  },
  {
    say: 'what is the pcr on banknifty',
    intent: 'chain.summary',
    want: { symbol: 'BANKNIFTY', metric: 'pcr' },
  },
  {
    say: 'where is the oi buildup in nifty',
    intent: 'chain.watchlist',
    want: { symbol: 'NIFTY' },
  },
  {
    say: 'get me the historical iv for nifty last week',
    intent: 'history.get',
    want: { symbol: 'NIFTY', metric: 'iv', rangeMs: 604_800_000 },
  },

  // ── Watches ──
  {
    say: 'track the oi on nifty 25000 ce and tell me if it moves 5 percent in 10 minutes',
    intent: 'watch.create',
    want: {
      symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi',
      threshold: 5, mode: 'pct', windowMs: 600_000,
    },
  },
  {
    // No number anywhere — this is the case that must route to adaptive mode
    // rather than inventing a threshold.
    say: 'let me know if anything significant happens on the banknifty chain',
    intent: 'watch.create',
    want: { symbol: 'BANKNIFTY', mode: 'auto' },
  },
  {
    say: 'notify me when banknifty 56000 pe oi drops by 20000',
    intent: 'watch.create',
    want: {
      symbol: 'BANKNIFTY', strike: 56000, side: 'PE', metric: 'oi',
      threshold: 20000, mode: 'abs', direction: 'down',
    },
  },
  { say: 'what are you watching',  intent: 'watch.list' },
  { say: 'list my watches',        intent: 'watch.list' },
  { say: 'stop watching nifty',    intent: 'watch.cancel' },
  { say: 'cancel that watch',      intent: 'watch.cancel' },
  { say: 'any alerts',             intent: 'alerts.recent' },
  { say: 'what fired',             intent: 'alerts.recent' },

  // ── Streaming ──
  {
    say: 'subscribe to the nifty option chain',
    intent: 'subscribe.chain',
    want: { symbol: 'NIFTY' },
  },

  // ── Robustness ──
  {
    // Typos in both the metric and the verb.
    say: 'what is the open intrest on nifty',
    intent: 'metric.get',
    want: { symbol: 'NIFTY', metric: 'oi' },
  },
  {
    // "bank nifty" as two tokens, the way speech renders it.
    say: 'what is the oi on bank nifty 56000 ce',
    intent: 'metric.get',
    want: { symbol: 'BANKNIFTY', strike: 56000, side: 'CE', metric: 'oi' },
  },
  {
    // Indian numbering in a threshold.
    say: 'alert me if nifty 25000 ce oi moves by two lakh',
    intent: 'watch.create',
    want: { symbol: 'NIFTY', strike: 25000, threshold: 200_000, mode: 'abs' },
  },

  // ── Mid-conversation routing ──
  //
  // Same utterances, but with a contract already in memory. Every one of these
  // routed correctly cold and has to keep doing so warm.
  {
    say: 'where is the oi buildup in nifty',
    intent: 'chain.watchlist',
    memory: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi' },
  },
  {
    // The elision that memory exists for: no symbol, no side, just a strike.
    say: 'what about 25100',
    intent: 'metric.get',
    lastIntent: 'metric.get',
    memory: { symbol: 'NIFTY', side: 'CE', metric: 'oi', expiry: '20260818' },
    want: { symbol: 'NIFTY', strike: 25100, side: 'CE', metric: 'oi' },
  },
  {
    // A follow-up that changes only the metric.
    say: 'and the iv',
    intent: 'metric.get',
    memory: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi' },
    want: { symbol: 'NIFTY', strike: 25000, metric: 'iv' },
  },
  {
    say: 'how much has it moved in the last 10 minutes',
    intent: 'change.get',
    memory: { symbol: 'NIFTY', strike: 25000, side: 'CE', metric: 'oi' },
    want: { symbol: 'NIFTY', strike: 25000, windowMs: 600_000 },
  },

  // ── Telegraphic input ──
  //
  // All four of these came from real usage and all four used to fail. Traders
  // type in fragments: no question word, no verb, typos, and both legs of a
  // strike named at once. A grammar that only handles well-formed questions
  // handles roughly none of the traffic.
  {
    // No question word at all — used to score 0.28 and fall under the floor.
    say: 'iv of 24200 ce and pe of next expiry',
    intent: 'metric.get',
    memory: { symbol: 'NIFTY' },
    want: { symbol: 'NIFTY', strike: 24200, metric: 'iv', sides: ['CE', 'PE'] },
  },
  {
    // Same, with the typo an actual user made.
    say: 'iv of 24200 ce nad pe of next expiry okay',
    intent: 'metric.get',
    memory: { symbol: 'NIFTY' },
    want: { symbol: 'NIFTY', strike: 24200, metric: 'iv' },
  },
  {
    // A bare metric with a contract in memory and NO previous intent — the
    // state a conversation lands in after an errored turn.
    say: 'iv',
    intent: 'metric.get',
    memory: { symbol: 'NIFTY', strike: 24200 },
    want: { symbol: 'NIFTY', strike: 24200, metric: 'iv' },
  },
  {
    // Truncated unit. Used to silently fall back to a 1-day range and answer
    // confidently about the wrong period.
    say: 'get me the historical iv for nifty 25000 ce last wee',
    intent: 'history.get',
    want: { symbol: 'NIFTY', strike: 25000, metric: 'iv', rangeMs: 604_800_000 },
  },
];

// ── Number-word folding, tested directly ─────────────────────────────────────

const NUMBER_CASES: Array<[string, string]> = [
  ['twenty five thousand',              '25000'],
  ['twenty five thousand five hundred', '25500'],
  ['two lakh',                          '200000'],
  ['one crore',                         '10000000'],
  ['fifty six thousand',                '56000'],
  ['twenty five hundred',               '2500'],
  ['zero point five',                   '0.5'],
  ['25k',                               '25000'],
];

// ── Runner ───────────────────────────────────────────────────────────────────

function slotsMatch(got: Slots, want: Partial<Slots>): string[] {
  const bad: string[] = [];
  for (const [key, expected] of Object.entries(want) as [keyof Slots, unknown][]) {
    const actual = got[key];
    // Arrays compare by content — `sides` is the only such slot, and reference
    // equality would fail it every time.
    const same = Array.isArray(expected) && Array.isArray(actual)
      ? expected.length === actual.length && expected.every((v, i) => v === actual[i])
      : actual === expected;
    if (!same) {
      bad.push(`${key}: want ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
  return bad;
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  console.log('\n── number folding ──');
  for (const [input, expected] of NUMBER_CASES) {
    const got = normalize(input).text;
    if (got === expected) {
      passed++;
      console.log(`  ok    "${input}" → ${got}`);
    } else {
      failed++;
      console.log(`  FAIL  "${input}" → "${got}" (expected "${expected}")`);
    }
  }

  console.log('\n── intents ──');
  for (const c of CASES) {
    const r = await understand(c.say, {
      session: null, memory: c.memory, lastIntent: c.lastIntent,
    });

    const problems: string[] = [];
    if (r.intent !== c.intent) {
      problems.push(`intent: want ${c.intent}, got ${r.intent} (${r.confidence.toFixed(2)})`);
    }
    if (c.want) problems.push(...slotsMatch(r.slots, c.want));

    if (!problems.length) {
      passed++;
      console.log(`  ok    ${r.intent.padEnd(17)} ${r.confidence.toFixed(2)}  "${c.say}"`);
    } else {
      failed++;
      console.log(`  FAIL  "${c.say}"`);
      for (const p of problems) console.log(`          ${p}`);
      console.log(`          normalized: "${r.normalized}"`);
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
