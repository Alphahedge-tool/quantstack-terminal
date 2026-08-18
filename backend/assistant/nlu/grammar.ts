/**
 * Intent rules.
 *
 * ── How an intent is described ──
 *
 * Not as regexes over the sentence. Regexes over free speech become a
 * combinatorial thicket — "track the oi", "keep an eye on oi", "let me know if
 * oi", "ping me when oi" are one intent and four unrelated patterns, and the
 * fifth phrasing always arrives.
 *
 * Instead each intent declares evidence:
 *
 *   require   groups that MUST each contribute a word, or the rule is out.
 *             This is the hard gate — "cancel my watch" can never be scored as
 *             `watch.create` no matter how many other words overlap.
 *   anchors   groups that ADD confidence when present. Partial credit: an
 *             intent matching three of four anchor groups outscores one
 *             matching two, which is what ranks near-misses sensibly.
 *   exemplars whole phrasings, compared by trigram similarity. This is what
 *             catches wordings nobody enumerated — the statistical half.
 *   veto      words that rule the intent out entirely.
 *   slots     which extracted slots make this intent more or less plausible.
 *
 * The scorer in understand.ts blends all four. Nothing here knows about
 * scoring; this file is pure description, so tuning weights never means editing
 * intent definitions and adding an intent never means touching the scorer.
 */

import type { IntentName, Slots } from '../types.js';

export interface IntentRule {
  name: IntentName;
  /** Every group must match at least one word. Empty = no gate. */
  require?: string[][];
  /** Each matching group adds partial credit. */
  anchors?: string[][];
  /** Whole-phrase examples for the similarity scorer. */
  exemplars: string[];
  /** Any of these present disqualifies the rule outright. */
  veto?: string[];
  /** Slots that must be present (from the utterance or memory) before acting. */
  needs?: (keyof Slots)[];
  /** Slots whose presence supports this reading. */
  prefers?: (keyof Slots)[];
  /**
   * Tie-break weight. Above 1 for intents that are rare but unmistakable when
   * they do occur, so a short utterance ("stop") is not out-scored by a long
   * intent whose exemplars happen to share trigrams.
   */
  prior?: number;
}

// Groups reused across rules. Naming them keeps the rules readable and means a
// new synonym lands in one place.
const G: Record<string, string[]> = {
  ask:      ['what', 'whats', 'show', 'give', 'tell', 'get', 'fetch', 'display', 'how', 'is', 'are'],
  imperative: ['track', 'watch', 'monitor', 'follow', 'alert', 'notify', 'ping', 'warn', 'flag', 'keep'],
  condition: ['if', 'when', 'whenever', 'once', 'incase', 'should', 'in'],
  // Deliberately WITHOUT buildup/unwinding: those are chain.watchlist's own
  // anchors, and leaving them here made "where is the oi buildup" score as a
  // change question — which answers with one number when the user asked which
  // strikes are moving.
  change:   ['change', 'changes', 'changed', 'move', 'moves', 'moved', 'moving',
             'movement', 'shift', 'shifts', 'delta', 'difference', 'diff', 'swing',
             'jump', 'jumped', 'spike', 'spiked', 'drop', 'dropped', 'rise', 'rose',
             'fall', 'fell', 'increase', 'increased', 'decrease', 'decreased',
             'added', 'shed'],
  metric:   ['oi', 'iv', 'ltp', 'volume', 'delta', 'gamma', 'vega', 'theta', 'pcr',
             'spot', 'price', 'premium', 'volatility', 'interest'],
  history:  ['history', 'historical', 'chart', 'graph', 'plot', 'candles', 'candle',
             'series', 'past', 'download', 'backtest', 'yesterday', 'previous'],
  chain:    ['chain', 'chains', 'optionchain', 'strikes', 'ladder', 'board'],
  /**
   * Positioning language — `chain.watchlist`'s territory.
   *
   * A named group because three other intents have to VETO it. These words all
   * co-occur with a metric ("where is the oi buildup"), so without an explicit
   * veto the reading intents match on the metric alone and answer with a single
   * number where the user asked which strikes are moving — and conversation
   * memory makes that worse, not better, by supplying a strike from an earlier
   * turn and pushing the wrong intent's slot score up.
   */
  buildup:  ['buildup', 'building', 'built', 'unwind', 'unwinding', 'covering',
             'accumulation', 'writers', 'writing', 'activity', 'action', 'hot'],
  stopWord: ['stop', 'cancel', 'remove', 'delete', 'drop', 'clear', 'kill', 'end',
             'unwatch', 'untrack', 'disable', 'off'],
  list:     ['list', 'show', 'what', 'which', 'my', 'active', 'all', 'current', 'any'],
  watchNoun: ['watch', 'watches', 'watching', 'alert', 'alerts', 'tracking',
              'tracked', 'monitor', 'monitors', 'monitoring', 'subscription',
              'subscriptions', 'notification', 'notifications'],
  /**
   * What `watch.list` alone may gate on.
   *
   * "alert" is missing on purpose. In this domain a bare "any alerts?" means
   * "did anything fire", not "show me my configured watches" — those are
   * opposite answers, and `watchNoun` matching both sent every such question to
   * the wrong one. Cancellation still uses the wide set, because "remove that
   * alert" unambiguously means the rule, not the firing.
   */
  watchOnly: ['watch', 'watches', 'watching', 'tracking', 'tracked', 'monitor',
              'monitors', 'monitoring', 'subscription', 'subscriptions'],
};

export const INTENT_RULES: readonly IntentRule[] = [
  // ── Conversational ────────────────────────────────────────────────────────
  {
    name: 'stop',
    require: [['stop', 'quiet', 'silence', 'shush', 'hush', 'enough', 'nevermind',
               'shut', 'mute', 'abort', 'wait']],
    // Without these vetoes "stop watching nifty" and "stop the stream" would
    // both be swallowed as barge-in and the user's actual command lost.
    veto: ['watch', 'watches', 'watching', 'alert', 'alerts', 'tracking', 'track',
           'monitor', 'stream', 'streaming', 'subscription', 'feed', 'chain'],
    exemplars: ['stop', 'stop talking', 'be quiet', 'shut up', 'silence', 'never mind',
                'enough', 'cancel that', 'hold on'],
    prior: 1.35,
  },
  {
    name: 'greeting',
    require: [['hi', 'hello', 'hey', 'yo', 'iris', 'morning', 'evening', 'namaste',
               'sup', 'greetings', 'thanks', 'thank']],
    veto: [...G.metric, ...G.chain, 'track', 'watch', 'alert'],
    exemplars: ['hi', 'hello', 'hey iris', 'good morning', 'are you there',
                'thanks', 'thank you'],
    prior: 1.15,
  },
  {
    name: 'help',
    require: [['help', 'can', 'able', 'commands', 'command', 'do', 'capabilities',
               'options', 'usage', 'guide', 'how']],
    anchors: [['you', 'your'], ['what', 'which', 'tell', 'show', 'list']],
    veto: [...G.chain],
    exemplars: ['help', 'what can you do', 'what commands do you support',
                'how do i use this', 'show me what you can do',
                'what are your capabilities', 'help me'],
    prior: 1.1,
  },

  // ── Watches ───────────────────────────────────────────────────────────────
  {
    name: 'watch.create',
    require: [[...G.imperative, 'let', 'inform', 'message', 'shout']],
    anchors: [G.condition, G.change,
              G.metric, ['me', 'us']],
    veto: [...G.stopWord, 'list', 'listing'],
    needs: ['symbol', 'metric'],
    prefers: ['strike', 'windowMs', 'threshold', 'side'],
    exemplars: [
      'track the oi on nifty 25000 ce and tell me if it moves 5 percent in 10 minutes',
      'watch open interest on banknifty 56000 pe',
      'alert me when the iv on nifty spikes',
      'notify me if oi changes significantly in the last 5 minutes',
      'keep an eye on the 25000 call open interest',
      'let me know if anything significant happens on the nifty chain',
      'ping me when the price crosses 200',
      'monitor delta on reliance 3000 ce every 10 minutes',
      'tell me if there is a big oi buildup',
    ],
    prior: 1.2,
  },
  {
    name: 'watch.list',
    require: [G.watchOnly],
    anchors: [G.list],
    veto: [...G.stopWord, 'fired', 'triggered', 'recent', 'happened'],
    exemplars: [
      'what are you watching', 'list my watches', 'show active alerts',
      'my watches', 'what alerts do i have', 'show me all my tracking',
      'which contracts are you monitoring',
    ],
    prior: 1.1,
  },
  {
    name: 'watch.cancel',
    require: [G.stopWord, G.watchNoun],
    exemplars: [
      'stop watching nifty', 'cancel that watch', 'remove the oi alert',
      'delete all my watches', 'unwatch banknifty', 'clear my alerts',
      'stop tracking the 25000 ce', 'turn off that monitor',
    ],
    prior: 1.25,
  },
  {
    name: 'alerts.recent',
    require: [['alert', 'alerts', 'fired', 'triggered', 'notification',
               'notifications', 'happened', 'anything']],
    anchors: [['recent', 'latest', 'last', 'any', 'new', 'today', 'so'],
              ['what', 'show', 'list', 'did', 'have']],
    veto: ['track', 'create', 'set', 'watching'],
    exemplars: [
      'any alerts', 'what fired', 'show me recent alerts',
      'did anything trigger', 'what happened so far', 'latest notifications',
      'anything new',
    ],
    prior: 1.05,
  },

  // ── Reads ─────────────────────────────────────────────────────────────────
  {
    name: 'change.get',
    require: [G.change],
    anchors: [G.ask, G.metric,
              ['much', 'far', 'many'], ['last', 'past', 'over', 'in']],
    veto: [...G.imperative, ...G.stopWord, ...G.buildup],
    needs: ['symbol'],
    prefers: ['metric', 'windowMs', 'strike'],
    exemplars: [
      'how much has the oi changed in the last 10 minutes',
      'what is the change in open interest',
      'how much did nifty 25000 ce move in the last hour',
      'oi change last 5 minutes',
      'has the iv moved much today',
      'what is the oi buildup on banknifty',
      'how far has the price moved',
    ],
    prior: 1.15,
  },
  {
    name: 'metric.get',
    require: [G.metric],
    anchors: [G.ask, ['current', 'now', 'right', 'latest']],
    veto: [...G.imperative, ...G.stopWord, ...G.history, ...G.change, ...G.buildup],
    needs: ['symbol'],
    prefers: ['metric', 'strike', 'side'],
    exemplars: [
      'what is the oi on nifty 25000 ce',
      'current open interest for banknifty 56000 pe',
      'show me the iv',
      'what is the delta on the 25000 call',
      'give me the volume', 'theta on nifty 25000 pe',
    ],
    prior: 1.0,
  },
  {
    name: 'quote.get',
    require: [['price', 'ltp', 'trading', 'quote', 'premium', 'rate', 'worth', 'cost']],
    anchors: [G.ask, ['at', 'now', 'current']],
    veto: [...G.imperative, ...G.stopWord, ...G.history, ...G.change, ...G.buildup],
    needs: ['symbol'],
    prefers: ['strike', 'side'],
    exemplars: [
      'what is nifty 25000 ce trading at', 'price of banknifty 56000 pe',
      'what is the ltp', 'how much is the 25000 call', 'quote me nifty spot',
    ],
    prior: 1.0,
  },
  {
    name: 'chain.summary',
    require: [[...G.chain, 'pcr', 'maxpain', 'atm', 'summary', 'overview']],
    anchors: [G.ask],
    veto: [...G.imperative, ...G.stopWord, ...G.history],
    needs: ['symbol'],
    exemplars: [
      'show me the nifty option chain', 'what is the pcr on banknifty',
      'max pain for nifty', 'chain summary', 'give me the option chain',
      'where is the atm strike',
    ],
    prior: 1.1,
  },
  {
    name: 'chain.watchlist',
    require: [[...G.buildup, 'active', 'unusual', 'happening', 'busy', 'interesting']],
    anchors: [G.ask, G.chain],
    veto: [...G.stopWord],
    needs: ['symbol'],
    exemplars: [
      'what is building up in nifty', 'where is the unusual activity',
      'show me the oi buildup', 'which strikes are hot',
      'what are the writers doing', 'where is the action on banknifty',
    ],
    prior: 1.1,
  },
  {
    name: 'history.get',
    require: [G.history],
    anchors: [G.ask, G.metric,
              ['last', 'past', 'over', 'since', 'from']],
    veto: [...G.stopWord],
    needs: ['symbol'],
    prefers: ['metric', 'rangeMs', 'interval'],
    exemplars: [
      'get me the historical iv for nifty last week',
      'chart the oi on banknifty 56000 ce for the past 5 days',
      'show me 5 minute candles for nifty',
      'plot delta history', 'download the price series',
      'what did the oi look like yesterday',
    ],
    prior: 1.15,
  },

  // ── Streaming control ─────────────────────────────────────────────────────
  {
    name: 'subscribe.chain',
    // "open" is NOT a gate word here. It is the first half of "open interest",
    // and admitting it routed every misspelled OI question to the streamer.
    require: [['subscribe', 'stream', 'streaming', 'live', 'connect', 'start']],
    anchors: [G.chain, ['to', 'the']],
    veto: [...G.stopWord, 'un', 'unsubscribe'],
    needs: ['symbol'],
    exemplars: [
      'subscribe to the nifty option chain', 'stream banknifty live',
      'start the live chain for nifty', 'connect to nifty chain',
      'go live on nifty',
    ],
    prior: 1.1,
  },
  {
    name: 'unsubscribe.chain',
    require: [['unsubscribe', 'disconnect']],
    anchors: [G.chain],
    exemplars: [
      'unsubscribe from nifty', 'disconnect the chain',
      'stop streaming banknifty', 'drop the live feed',
    ],
    prior: 1.2,
  },
];

/** Rules by name, for the dispatcher. */
export const RULE_BY_NAME = new Map<IntentName, IntentRule>(
  INTENT_RULES.map((r) => [r.name, r]),
);
