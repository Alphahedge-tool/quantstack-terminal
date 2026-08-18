/**
 * Slot extraction — turning a normalised token stream into `Slots`.
 *
 * ── The consumption rule ──
 *
 * Numbers are the whole problem. "track oi on nifty 25000 ce if it moves 5
 * percent in 10 minutes" contains three numbers that mean three unrelated
 * things, and the only thing separating them is the words around them. So this
 * file walks the tokens in a fixed order, most-constrained pattern first, and
 * every pattern MARKS the indices it consumed. A later pass can never re-read a
 * token an earlier one claimed.
 *
 * The order is deliberate:
 *
 *   1. windows/ranges   "in 10 minutes", "last week"  — anchored by a unit word
 *   2. thresholds       "5 percent", "by 20000"       — anchored by % or "by"
 *   3. sides            ce / pe                        — closed set, unambiguous
 *   4. metrics          oi / iv / ltp / …              — closed set
 *   5. expiry hints     "this week", "28 aug"          — anchored by keywords
 *   6. symbols          nifty / reliance               — needs the master
 *   7. strike           whatever large number is left
 *
 * Strike is last because it is the only slot with no anchor word of its own. By
 * the time it runs, every number that belonged to something else is gone, and
 * "the number that is left" becomes a safe rule instead of a guess.
 */

import type { NubraSession } from '../../brokers/nubra.js';
import { getCachedExpiries, todayIST } from '../../lib/instrumentCache.js';
import type { Slots, Direction, ThresholdMode, OptionSide } from '../types.js';
import {
  TIME_UNIT_MS, WINDOW_LEAD, INTERVAL_WORDS, defaultInterval,
  metricOf, sideOf, directionOf, SIGNIFICANCE_WORDS, resolveSymbolAt,
} from './lexicon.js';
import { bestMatch } from './fuzzy.js';

// ── Consumption bookkeeping ──────────────────────────────────────────────────

class Cursor {
  readonly used: boolean[];
  constructor(readonly tokens: string[]) {
    this.used = new Array(tokens.length).fill(false);
  }
  free(i: number): boolean { return i >= 0 && i < this.tokens.length && !this.used[i]; }
  at(i: number): string { return this.free(i) ? this.tokens[i] : ''; }
  take(from: number, count = 1): void {
    for (let i = from; i < from + count && i < this.used.length; i++) this.used[i] = true;
  }
  /** Tokens nothing claimed — what the grammar scores intent against. */
  remaining(): string[] {
    return this.tokens.filter((_, i) => !this.used[i]);
  }
}

const isNumber = (t: string): boolean => t !== '' && /^\d+(\.\d+)?$/.test(t);

const TIME_UNIT_NAMES = Object.keys(TIME_UNIT_MS);

/**
 * A time unit, fuzzily.
 *
 * Exact first, then a tolerant match. Both halves of the input mangle these:
 * typing truncates ("last wee"), and speech recognition drops the final
 * consonant of short words often enough that "minute" arrives as "minit" and
 * "hour" as "our". A duration that fails to parse does not error — it silently
 * falls back to a default window, so the assistant confidently answers about
 * the wrong period. That is worth being generous about.
 */
function timeUnitOf(token: string): number | null {
  if (!token) return null;
  const exact = TIME_UNIT_MS[token];
  if (exact != null) return exact;
  if (token.length < 3) return null;
  const hit = bestMatch(token, TIME_UNIT_NAMES, 0.7);
  return hit ? TIME_UNIT_MS[hit.value] : null;
}

// ── 1. Windows and ranges ────────────────────────────────────────────────────

/**
 * A duration phrase: `[lead] <n> <unit>` or `[lead] <unit>`.
 *
 * The bare-unit form matters more than it looks — "last week", "in an hour"
 * (already folded to "1 hour" by normalize) and "over the day" all arrive
 * without their own count.
 */
function readDuration(c: Cursor, i: number): { ms: number; span: number } | null {
  let j = i;
  let span = 0;

  if (WINDOW_LEAD.has(c.at(j))) { j++; span++; }
  // "the" survives normalisation and sits between the lead and the number.
  if (c.at(j) === 'the') { j++; span++; }

  let count = 1;
  if (isNumber(c.at(j))) {
    count = Number(c.at(j));
    j++;
    span++;
  }

  const unit = timeUnitOf(c.at(j));
  if (unit == null) return null;
  span++;

  return { ms: count * unit, span };
}

/**
 * Which slot a duration fills.
 *
 * A window (`windowMs`) is the evaluation lookback of a change question or a
 * watch: "how much did OI move in the last 10 minutes". A range (`rangeMs`) is
 * the span of a history request: "get me IV for the last week".
 *
 * They are the same phrase, so the sentence has to decide. History verbs and
 * long durations mean range; everything else means window. A day is the
 * crossover — nobody asks for an intraday alert window measured in days, and
 * nobody charts ten minutes.
 */
const HISTORY_VERBS = new Set([
  'chart', 'graph', 'plot', 'history', 'historical', 'candles', 'candle',
  'series', 'backtest', 'download', 'fetch', 'past',
]);

function durationSlot(ms: number, tokens: string[]): 'windowMs' | 'rangeMs' {
  if (tokens.some((t) => HISTORY_VERBS.has(t))) return 'rangeMs';
  return ms >= 86_400_000 ? 'rangeMs' : 'windowMs';
}

function extractDurations(c: Cursor, slots: Slots): void {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    // Only start a duration at a lead word, a number or a unit — otherwise
    // every token pays for a failed parse.
    const t = c.tokens[i];
    if (!WINDOW_LEAD.has(t) && !isNumber(t) && timeUnitOf(t) == null) continue;

    const hit = readDuration(c, i);
    if (!hit) continue;

    const slot = durationSlot(hit.ms, c.tokens);
    if (slots[slot] == null) slots[slot] = hit.ms;
    c.take(i, hit.span);
    i += hit.span - 1;
  }
}

// ── 2. Thresholds ────────────────────────────────────────────────────────────

const PERCENT_WORDS = new Set(['percent', 'percentage', '%', 'pct']);

/**
 * "5 percent", "by 20000", "more than 2 lakh".
 *
 * A percent sign is decisive. A bare number after "by"/"than" is an absolute
 * threshold. A bare number anywhere else is NOT a threshold — that is what
 * makes the strike rule at the end safe.
 */
function extractThreshold(c: Cursor, slots: Slots): void {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i) || !isNumber(c.tokens[i])) continue;

    const next = c.at(i + 1);
    if (PERCENT_WORDS.has(next)) {
      slots.threshold = Number(c.tokens[i]);
      slots.mode = 'pct';
      c.take(i, 2);
      i++;
      continue;
    }

    const prev = i > 0 ? c.tokens[i - 1] : '';
    if (prev === 'by' || prev === 'than' || prev === 'least') {
      slots.threshold = Number(c.tokens[i]);
      slots.mode ??= 'abs';
      c.take(i - 1, 2);
      continue;
    }
  }

  // A trailing "%" that normalisation left glued to its number.
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const m = /^(\d+(?:\.\d+)?)%$/.exec(c.tokens[i]);
    if (!m) continue;
    slots.threshold = Number(m[1]);
    slots.mode = 'pct';
    c.take(i);
  }
}

// ── 3. Side ──────────────────────────────────────────────────────────────────

/**
 * Every side the utterance named, in order.
 *
 * `side` keeps the first for consumers that handle one leg; `sides` carries the
 * full set and is only populated when more than one distinct leg appeared, so
 * "24200 ce" and "24200 ce and pe" stay distinguishable — the latter is a
 * straddle question and has to be answered as one.
 */
function extractSide(c: Cursor, slots: Slots): void {
  const found: OptionSide[] = [];
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const side = sideOf(c.tokens[i]);
    if (!side) continue;
    if (!found.includes(side)) found.push(side);
    c.take(i);
  }
  if (!found.length) return;
  slots.side ??= found[0];
  if (found.length > 1) slots.sides = found;
}

// ── 4. Metric ────────────────────────────────────────────────────────────────

/**
 * Metric words, first hit wins.
 *
 * "trading" and "value" are in the metric lexicon as weak synonyms for price,
 * so a stronger metric later in the sentence must not lose to them: the loop
 * keeps scanning and prefers any non-`ltp` metric it finds. "what is nifty
 * 25000 ce trading at, and its oi" should answer about OI, not the premium.
 */
const WEAK_PRICE_WORDS = new Set(['trading', 'value', 'rate', 'quote']);

function extractMetric(c: Cursor, slots: Slots): void {
  let weakIndex = -1;
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const metric = metricOf(c.tokens[i]);
    if (!metric) continue;

    if (WEAK_PRICE_WORDS.has(c.tokens[i])) {
      if (weakIndex < 0) weakIndex = i;
      continue;
    }
    slots.metric = metric;
    c.take(i);
    return;
  }
  if (weakIndex >= 0) {
    slots.metric = 'ltp';
    c.take(weakIndex);
  }
}

// ── 5. Expiry ────────────────────────────────────────────────────────────────

/**
 * What the user said about expiry, before it can be turned into a date.
 *
 * Resolution needs the symbol (each underlying has its own expiry ladder), and
 * the symbol is extracted after this — so the hint is captured here and
 * `resolveExpiry` converts it once both are known.
 */
export type ExpiryHint =
  | { kind: 'nearest' }
  | { kind: 'nth';     n: number }        // "next", "second", "third" expiry
  | { kind: 'monthly' }
  | { kind: 'date';    month: number; day?: number; year?: number };

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const ORDINALS: Record<string, number> = {
  next: 2, second: 2, third: 3, fourth: 4, far: 3, following: 2,
};

function extractExpiryHint(c: Cursor): ExpiryHint | null {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const t = c.tokens[i];

    // Explicit compact date the client may have injected.
    if (/^\d{8}$/.test(t)) {
      const year = Number(t.slice(0, 4));
      if (year > 2000 && year < 2100) {
        c.take(i);
        return { kind: 'date', year, month: Number(t.slice(4, 6)), day: Number(t.slice(6, 8)) };
      }
    }

    if (MONTHS[t] != null) {
      const month = MONTHS[t];
      // "28 aug" and "aug 28" both occur.
      const before = i > 0 && isNumber(c.at(i - 1)) ? Number(c.tokens[i - 1]) : null;
      const after  = isNumber(c.at(i + 1)) ? Number(c.tokens[i + 1]) : null;
      const day = before != null && before <= 31 ? before
                : after  != null && after  <= 31 ? after
                : undefined;
      if (before != null && before <= 31) c.take(i - 1);
      if (day === after && after != null)  c.take(i + 1);
      c.take(i);
      return { kind: 'date', month, day };
    }

    if (t === 'monthly' || (t === 'month' && c.at(i + 1) === 'expiry')) {
      c.take(i);
      return { kind: 'monthly' };
    }

    if (t === 'expiry' || t === 'expiries' || t === 'exp') {
      const prev = i > 0 ? c.tokens[i - 1] : '';
      const nth = ORDINALS[prev];
      if (nth) { c.take(i - 1, 2); return { kind: 'nth', n: nth }; }
      if (prev === 'monthly') { c.take(i - 1, 2); return { kind: 'monthly' }; }
      if (prev === 'current' || prev === 'this' || prev === 'nearest' || prev === 'weekly') {
        c.take(i - 1, 2);
        return { kind: 'nearest' };
      }
      c.take(i);
      return { kind: 'nearest' };
    }

    // "this week" / "next week" only count as expiry talk when no window has
    // claimed them — extractDurations runs first precisely so "in the last
    // week" is a range and "next week expiry" is an expiry.
    if (t === 'week' && i > 0) {
      const prev = c.tokens[i - 1];
      if (prev === 'this' || prev === 'current') { c.take(i - 1, 2); return { kind: 'nearest' }; }
      if (prev === 'next') { c.take(i - 1, 2); return { kind: 'nth', n: 2 }; }
    }
  }
  return null;
}

/**
 * Turn a hint into a compact YYYYMMDD that the symbol actually lists.
 *
 * Always snapped to a real expiry from the master. A date the user names is
 * matched to the nearest listed expiry rather than used verbatim: "the 28th"
 * said on a Tuesday means that week's expiry, and passing an unlisted date
 * downstream produces an empty chain and no explanation.
 */
export async function resolveExpiry(
  symbol: string,
  exchange: string,
  hint: ExpiryHint | null,
  session: NubraSession | null,
): Promise<string | undefined> {
  if (!session) return undefined;

  let expiries: string[];
  try {
    expiries = await getCachedExpiries(symbol, exchange, todayIST(), session);
  } catch {
    return undefined;
  }
  if (!expiries.length) return undefined;

  const today = todayIST().replace(/-/g, '');
  const future = expiries.filter((e) => e >= today);
  const ladder = future.length ? future : expiries;

  if (!hint || hint.kind === 'nearest') return ladder[0];

  if (hint.kind === 'nth') return ladder[Math.min(hint.n - 1, ladder.length - 1)];

  if (hint.kind === 'monthly') {
    // The monthly is the last expiry inside its calendar month. Walking the
    // ladder and taking the final entry of the first month that has a later
    // sibling identifies it without hard-coding "last Thursday" rules that
    // differ per exchange and break on holidays.
    for (let i = 0; i < ladder.length; i++) {
      const month = ladder[i].slice(0, 6);
      const next = ladder[i + 1];
      if (!next || next.slice(0, 6) !== month) return ladder[i];
    }
    return ladder[ladder.length - 1];
  }

  // kind === 'date' — snap to the closest listed expiry.
  const year = hint.year ?? Number(today.slice(0, 4));
  const day  = hint.day ?? 28;
  const wanted = `${year}${String(hint.month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  let best = ladder[0];
  let bestGap = Infinity;
  for (const e of ladder) {
    const gap = Math.abs(Number(e) - Number(wanted));
    if (gap < bestGap) { bestGap = gap; best = e; }
  }
  return best;
}

// ── 6. Symbol ────────────────────────────────────────────────────────────────

async function extractSymbol(
  c: Cursor, slots: Slots, session: NubraSession | null,
): Promise<void> {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i) || isNumber(c.tokens[i])) continue;
    const hit = await resolveSymbolAt(c.tokens, i, session);
    if (!hit) continue;
    // Guard the multi-token join: `resolveSymbolAt` may have matched
    // tokens[i]+tokens[i+1], and consuming a token another pass already owns
    // would silently drop that slot.
    if (hit.span === 2 && !c.free(i + 1)) continue;
    slots.symbol   ??= hit.symbol;
    slots.exchange ??= hit.exchange;
    c.take(i, hit.span);
    return;
  }
}

// ── 7. Strike ────────────────────────────────────────────────────────────────

/**
 * The last unclaimed number, if it is plausibly a strike.
 *
 * Floor of 10 rather than 0: single digits at this point are counts ("top 5
 * strikes"), never strikes. There is no ceiling — MCX and high-priced stocks
 * both list strikes well above any index level, so a cap would silently drop
 * exactly the contracts a commodity trader asks about.
 */
function extractStrike(c: Cursor, slots: Slots): void {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i) || !isNumber(c.tokens[i])) continue;
    const n = Number(c.tokens[i]);
    if (n < 10) continue;
    slots.strike ??= n;
    c.take(i);
    return;
  }
}

// ── Direction + interval ─────────────────────────────────────────────────────

function extractDirection(c: Cursor, slots: Slots): void {
  let either: Direction | null = null;
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const d = directionOf(c.tokens[i]);
    if (!d) continue;
    // A directional word is stronger than a neutral one wherever both appear:
    // "tell me if oi changes, especially if it drops" is a down watch.
    if (d === 'either') { either ??= d; continue; }
    slots.direction = d;
    return;
  }
  if (either) slots.direction = either;
}

function extractInterval(c: Cursor, slots: Slots): void {
  for (let i = 0; i < c.tokens.length; i++) {
    if (!c.free(i)) continue;
    const iv = INTERVAL_WORDS[c.tokens[i]];
    if (!iv) continue;
    slots.interval = iv;
    c.take(i);
    return;
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export interface Extraction {
  slots:      Slots;
  /** Tokens no slot claimed — the signal grammar.ts scores intent from. */
  remaining:  string[];
  expiryHint: ExpiryHint | null;
}

/**
 * Pull every slot this utterance offers.
 *
 * `session` may be null: symbol resolution then falls back to the index alias
 * bootstrap in lexicon.ts, which is enough for the indices but not for stocks.
 * A null session is a degraded mode, never an error — the assistant should
 * still answer "help" and "what are you watching" before login completes.
 */
export async function extract(
  tokens: string[],
  session: NubraSession | null,
): Promise<Extraction> {
  const c = new Cursor(tokens);
  const slots: Slots = {};

  extractDurations(c, slots);
  extractThreshold(c, slots);
  extractSide(c, slots);
  extractMetric(c, slots);
  const expiryHint = extractExpiryHint(c);
  await extractSymbol(c, slots, session);
  extractStrike(c, slots);
  extractDirection(c, slots);
  extractInterval(c, slots);

  // "anything significant" with no number is an adaptive threshold, not a
  // missing one. Only set it when the user gave no explicit number, so an
  // explicit "5 percent" always wins over a stray "significant".
  if (slots.threshold == null && tokens.some((t) => SIGNIFICANCE_WORDS.has(t))) {
    slots.mode = 'auto' as ThresholdMode;
  }

  if (slots.rangeMs != null && !slots.interval) {
    slots.interval = defaultInterval(slots.rangeMs);
  }

  const remaining = c.remaining();
  if (remaining.length) slots.rest = remaining.join(' ');

  return { slots, remaining, expiryHint };
}
