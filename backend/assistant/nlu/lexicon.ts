/**
 * The domain vocabulary.
 *
 * Every word this engine understands lives here, mapped to the canonical value
 * the rest of the system uses. Nothing downstream ever matches a raw English
 * word — grammar.ts matches vocabulary *classes* ("a metric word appeared"),
 * which is what keeps adding a synonym a one-line change instead of a new
 * branch in six patterns.
 *
 * ── Symbols are not in here ──
 *
 * Metric and time words are a closed set that ships with the code. Tradable
 * symbols are not: they come from the instrument master, they change with
 * listings, and they are exchange-specific. Hard-coding them would guarantee
 * the assistant confidently reports on a contract that was delisted last month.
 * `resolveSymbol()` therefore queries the live cache and falls back to a small
 * set of index aliases only for the case where the master has not warmed yet.
 */

import { getCachedRefdata, todayIST, WARM_EXCHANGES } from '../../lib/instrumentCache.js';
import type { NubraSession } from '../../brokers/nubra.js';
import type { MetricName, ThresholdMode, Direction, OptionSide } from '../types.js';
import { bestMatch, similar } from './fuzzy.js';

// ── Metrics ──────────────────────────────────────────────────────────────────

/**
 * Synonym → canonical metric.
 *
 * The keys are what survives normalize.ts, so several spoken forms have already
 * collapsed before they get here ("open interest" → "oi"). What remains is the
 * genuinely different words people use for the same quantity.
 */
export const METRIC_WORDS: Record<string, MetricName> = {
  oi:            'oi',
  openinterest:  'oi',
  interest:      'oi',
  positions:     'oi',

  ltp:           'ltp',
  price:         'ltp',
  premium:       'ltp',
  quote:         'ltp',
  rate:          'ltp',
  trading:       'ltp',
  value:         'ltp',

  iv:            'iv',
  volatility:    'iv',
  vol:           'iv',

  volume:        'volume',
  traded:        'volume',
  turnover:      'volume',

  delta:         'delta',
  gamma:         'gamma',
  vega:          'vega',
  theta:         'theta',
  decay:         'theta',

  pcr:           'pcr',
  ratio:         'pcr',

  spot:          'spot',
  underlying:    'spot',
  index:         'spot',
};

/** Human units, for card labels and speech. */
export const METRIC_UNIT: Record<MetricName, string> = {
  oi:     'contracts',
  ltp:    '₹',
  iv:     '%',
  volume: 'contracts',
  delta:  '',
  gamma:  '',
  vega:   '',
  theta:  '',
  pcr:    '',
  spot:   '',
};

/** How the voice says a metric. "o i" would be read as a word otherwise. */
export const METRIC_SPOKEN: Record<MetricName, string> = {
  oi:     'open interest',
  ltp:    'price',
  iv:     'implied volatility',
  volume: 'volume',
  delta:  'delta',
  gamma:  'gamma',
  vega:   'vega',
  theta:  'theta',
  pcr:    'put call ratio',
  spot:   'spot',
};

const METRIC_KEYS = Object.keys(METRIC_WORDS);

/** Canonical metric for one token, fuzzy. */
export function metricOf(token: string): MetricName | null {
  const direct = METRIC_WORDS[token];
  if (direct) return direct;
  const hit = bestMatch(token, METRIC_KEYS, 0.82);
  return hit ? METRIC_WORDS[hit.value] : null;
}

// ── Time ─────────────────────────────────────────────────────────────────────

export const TIME_UNIT_MS: Record<string, number> = {
  second: 1_000,
  seconds: 1_000,
  minute: 60_000,
  minutes: 60_000,
  hour:   3_600_000,
  hours:  3_600_000,
  day:    86_400_000,
  days:   86_400_000,
  week:   604_800_000,
  weeks:  604_800_000,
  month:  2_592_000_000,
  months: 2_592_000_000,
  year:   31_536_000_000,
  years:  31_536_000_000,
};

/** Words that mean "a window follows" — "last 10 minutes", "over an hour". */
export const WINDOW_LEAD = new Set([
  'last', 'past', 'over', 'in', 'within', 'across', 'during', 'for', 'previous',
]);

/**
 * Candle interval a duration implies, when the user asked for history without
 * naming one.
 *
 * Chosen so a request returns roughly 100-400 points: enough to draw, few
 * enough to ship over a socket. The thresholds are the same buckets the chart
 * pages already use.
 */
export function defaultInterval(rangeMs: number): string {
  if (rangeMs <= 2 * 3_600_000)      return '1m';
  if (rangeMs <= 12 * 3_600_000)     return '5m';
  if (rangeMs <= 3 * 86_400_000)     return '15m';
  if (rangeMs <= 14 * 86_400_000)    return '1h';
  if (rangeMs <= 200 * 86_400_000)   return '1d';
  return '1w';
}

/** Explicit interval words → the string charts/timeseries expects. */
export const INTERVAL_WORDS: Record<string, string> = {
  tick: '1s', second: '1s', minute: '1m', hourly: '1h', daily: '1d',
  weekly: '1w', monthly: '1mth',
};

// ── Comparators + direction ──────────────────────────────────────────────────

export const UP_WORDS = new Set([
  'up', 'rise', 'rises', 'rising', 'rose', 'increase', 'increases', 'increased',
  'increasing', 'gain', 'gains', 'gained', 'jump', 'jumps', 'jumped', 'spike',
  'spikes', 'spiked', 'above', 'over', 'exceed', 'exceeds', 'crosses', 'higher',
  'buildup', 'builds', 'building', 'add', 'adds', 'added', 'surge', 'surges',
]);

export const DOWN_WORDS = new Set([
  'down', 'fall', 'falls', 'falling', 'fell', 'drop', 'drops', 'dropped',
  'decrease', 'decreases', 'decreased', 'decline', 'declines', 'declined',
  'below', 'under', 'lower', 'unwind', 'unwinds', 'unwinding', 'shed', 'sheds',
  'reduce', 'reduces', 'reduced', 'crash', 'crashes', 'slump',
]);

/** Words that mean "either direction" — the default for a change watch. */
export const EITHER_WORDS = new Set([
  'change', 'changes', 'changed', 'move', 'moves', 'moved', 'moving',
  'movement', 'shift', 'shifts', 'swing', 'swings', 'differ', 'vary',
]);

export function directionOf(token: string): Direction | null {
  if (UP_WORDS.has(token))     return 'up';
  if (DOWN_WORDS.has(token))   return 'down';
  if (EITHER_WORDS.has(token)) return 'either';
  return null;
}

/**
 * Words that mean "you decide what counts as big".
 *
 * This is what routes a watch to adaptive significance instead of a fixed
 * threshold — "tell me if anything significant happens on the nifty chain" has
 * no number in it, and inventing one (5%? 10%?) would be wrong for every
 * contract but the one it was tuned on. See monitor/significance.ts.
 */
export const SIGNIFICANCE_WORDS = new Set([
  'significant', 'significantly', 'notable', 'unusual', 'abnormal', 'big',
  'large', 'sharp', 'meaningful', 'material', 'anything', 'something',
  'interesting', 'weird', 'strange', 'spike', 'sudden',
]);

export function thresholdModeOf(tokens: string[]): ThresholdMode | null {
  for (const t of tokens) if (SIGNIFICANCE_WORDS.has(t)) return 'auto';
  return null;
}

// ── Option side ──────────────────────────────────────────────────────────────

export function sideOf(token: string): OptionSide | null {
  if (token === 'ce') return 'CE';
  if (token === 'pe') return 'PE';
  return null;
}

// ── Symbols ──────────────────────────────────────────────────────────────────

/**
 * Index aliases that must resolve even with a cold instrument master.
 *
 * Not a symbol list — a bootstrap. The master is the authority and this map is
 * consulted only to seed the fuzzy candidate set so "hey iris, nifty pcr" works
 * in the first seconds after a restart, before refdata has warmed.
 */
const INDEX_ALIASES: Record<string, string> = {
  nifty:      'NIFTY',
  banknifty:  'BANKNIFTY',
  finnifty:   'FINNIFTY',
  midcpnifty: 'MIDCPNIFTY',
  sensex:     'SENSEX',
  bankex:     'BANKEX',
  crudeoil:   'CRUDEOIL',
  naturalgas: 'NATURALGAS',
  gold:       'GOLD',
  silver:     'SILVER',
};

/**
 * Tradable assets, cached.
 *
 * Rebuilt lazily and at most once a minute: refdata itself is cached on disk by
 * instrumentCache, but flattening it to a symbol set is O(rows) and rows number
 * in the hundreds of thousands. Once a minute is far more often than a listing
 * changes and far less often than an utterance arrives.
 */
interface SymbolIndex {
  /** lowercase spoken form → canonical asset name. */
  byToken:  Map<string, string>;
  /** canonical asset → the exchange its rows came from. */
  exchange: Map<string, string>;
  builtAt:  number;
}

let symbolIndex: SymbolIndex | null = null;
let building: Promise<SymbolIndex> | null = null;

const INDEX_TTL_MS = 60_000;

async function buildSymbolIndex(session: NubraSession | null): Promise<SymbolIndex> {
  const byToken  = new Map<string, string>();
  const exchange = new Map<string, string>();

  for (const [token, asset] of Object.entries(INDEX_ALIASES)) {
    byToken.set(token, asset);
  }

  if (session) {
    const day = todayIST();
    for (const ex of WARM_EXCHANGES) {
      let rows;
      try {
        rows = await getCachedRefdata(ex, day, session);
      } catch {
        // A cold or failing exchange must not blank the whole vocabulary — the
        // other exchanges, and the alias bootstrap, still answer.
        continue;
      }
      for (const r of rows) {
        const asset = r.asset;
        if (!asset) continue;
        if (!exchange.has(asset)) exchange.set(asset, ex);
        const token = asset.toLowerCase();
        if (!byToken.has(token)) byToken.set(token, asset);
      }
    }
  }

  // Alias exchanges default to NSE unless refdata said otherwise — the indices
  // above are NSE except SENSEX/BANKEX (BSE) and the MCX commodities.
  for (const [, asset] of byToken) {
    if (exchange.has(asset)) continue;
    if (asset === 'SENSEX' || asset === 'BANKEX') exchange.set(asset, 'BSE');
    else if (['CRUDEOIL', 'NATURALGAS', 'GOLD', 'SILVER'].includes(asset)) exchange.set(asset, 'MCX');
    else exchange.set(asset, 'NSE');
  }

  return { byToken, exchange, builtAt: Date.now() };
}

async function getSymbolIndex(session: NubraSession | null): Promise<SymbolIndex> {
  if (symbolIndex && Date.now() - symbolIndex.builtAt < INDEX_TTL_MS) return symbolIndex;
  // Collapse concurrent rebuilds — several utterances can land in the same tick
  // and each would otherwise walk the full master.
  building ??= buildSymbolIndex(session).then((idx) => {
    symbolIndex = idx;
    building = null;
    return idx;
  }).catch((err) => {
    building = null;
    throw err;
  });
  return building;
}

export interface SymbolHit {
  symbol:   string;
  exchange: string;
  /** How many tokens the match consumed, so the caller can skip them. */
  span:     number;
  score:    number;
}

/**
 * Find a tradable symbol starting at `tokens[i]`.
 *
 * Tries the two-token join first ("bank nifty" survives normalisation as one
 * token, but "asian paint" does not), then the single token. Fuzzy, so
 * "relaince" resolves — but at a high floor, because a loose match here sends
 * the whole query to the wrong instrument, which is worse than asking.
 */
export async function resolveSymbolAt(
  tokens: string[],
  i: number,
  session: NubraSession | null,
): Promise<SymbolHit | null> {
  const idx = await getSymbolIndex(session).catch(() => null);
  if (!idx) return null;

  const candidates = [...idx.byToken.keys()];

  const joined = i + 1 < tokens.length ? tokens[i] + tokens[i + 1] : null;
  if (joined) {
    const exact = idx.byToken.get(joined);
    if (exact) {
      return { symbol: exact, exchange: idx.exchange.get(exact) || 'NSE', span: 2, score: 1 };
    }
  }

  const token = tokens[i];
  if (token.length < 3) return null;

  const exact = idx.byToken.get(token);
  if (exact) {
    return { symbol: exact, exchange: idx.exchange.get(exact) || 'NSE', span: 1, score: 1 };
  }

  // Fuzzy only for tokens long enough to be a symbol at all, and only against
  // similarly-sized candidates. 0.86 is deliberately strict: at 0.75 "ce"-
  // adjacent noise words started matching three-letter tickers.
  const hit = bestMatch(token, candidates, 0.86);
  if (!hit) return null;
  const asset = idx.byToken.get(hit.value)!;
  return { symbol: asset, exchange: idx.exchange.get(asset) || 'NSE', span: 1, score: hit.score };
}

/** Whether a bare word looks like it was MEANT to be a symbol we do not carry. */
export async function looksLikeUnknownSymbol(
  token: string,
  session: NubraSession | null,
): Promise<boolean> {
  if (token.length < 3 || /\d/.test(token)) return false;
  if (METRIC_WORDS[token]) return false;
  const idx = await getSymbolIndex(session).catch(() => null);
  if (!idx) return false;
  for (const known of idx.byToken.keys()) {
    if (similar(token, known) > 0.7) return true;
  }
  return false;
}

/** Test seam — forces the next resolve to rebuild. */
export function resetSymbolIndex(): void {
  symbolIndex = null;
  building = null;
}
