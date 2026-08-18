/**
 * Utterance normalisation — the first pass over anything a human said.
 *
 * ── Why this is bigger than a lowercase() ──
 *
 * Half the input to this engine arrives from a microphone. Browser speech
 * recognition does not return "25000 CE"; it returns "twenty five thousand
 * call", or "25 thousand call", or "twenty-five thousand ce", depending on the
 * engine, the accent and the sentence around it. It writes "nifty" as "nifty",
 * "NIFTY" and occasionally "knifty". It renders "banknifty" as "bank nifty".
 *
 * Every one of those has to become the same token stream before the grammar
 * sees it, or the grammar grows a branch per transcription quirk and becomes
 * unmaintainable. So this file does the ugly work once:
 *
 *   1. lowercase, strip punctuation that never carries meaning
 *   2. expand contractions ("what's" → "what is")
 *   3. fold Indian-numbering words (lakh, crore) and English scale words
 *      (thousand, hundred) into digits
 *   4. fold shorthand ("25k" → "25000", "5m" → "5 min" only where unambiguous)
 *   5. normalise domain spellings ("bank nifty" → "banknifty", "call" → "ce")
 *
 * ── The ambiguity rule ──
 *
 * Where a fold could be wrong, it is not applied here. "5m" is five minutes in
 * "last 5m" and five million nowhere in this domain, so it folds. But a bare
 * "25" could be a strike, a quantity or a percentage, so it stays a number and
 * the entity extractor decides using surrounding words. Normalisation must
 * never make a decision that needs context — that is what entities.ts is for.
 */

// ── Contractions ─────────────────────────────────────────────────────────────

const CONTRACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\bwhat's\b/g,   'what is'],
  [/\bwhats\b/g,    'what is'],
  [/\bhow's\b/g,    'how is'],
  [/\bit's\b/g,     'it is'],
  [/\bthat's\b/g,   'that is'],
  [/\bthere's\b/g,  'there is'],
  [/\blet's\b/g,    'let us'],
  [/\bdon't\b/g,    'do not'],
  [/\bdoesn't\b/g,  'does not'],
  [/\bdidn't\b/g,   'did not'],
  [/\bisn't\b/g,    'is not'],
  [/\bcan't\b/g,    'can not'],
  [/\bwon't\b/g,    'will not'],
  [/\bi'm\b/g,      'i am'],
  [/\bi've\b/g,     'i have'],
  [/\bi'd\b/g,      'i would'],
  [/\byou're\b/g,   'you are'],
  [/\bwe're\b/g,    'we are'],
];

// ── Number words ─────────────────────────────────────────────────────────────

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Scale words, including the Indian ones.
 *
 * `lakh` and `crore` matter: an Indian trader saying an OI threshold says "two
 * lakh contracts", never "two hundred thousand". Dropping them would leave the
 * threshold at 2.
 */
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  k: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  lac: 100_000,
  lacs: 100_000,
  million: 1_000_000,
  crore: 10_000_000,
  crores: 10_000_000,
  billion: 1_000_000_000,
};

const NUMBER_WORD = new Set([
  ...Object.keys(UNITS), ...Object.keys(TENS), ...Object.keys(SCALES), 'and', 'point',
]);

/**
 * Collapse a run of number words into a single numeric token.
 *
 * Standard accumulator: `current` holds the group being built, `total` holds
 * completed groups. A scale word multiplies the current group and, for scales
 * of a thousand or more, banks it — which is what makes "two lakh twenty five
 * thousand" come out as 225000 rather than 2 × 100000 × 25 × 1000.
 *
 * Returns null when the run held no actual number ("and" alone), so the caller
 * can leave the words untouched instead of emitting a spurious 0.
 */
function foldNumberWords(words: string[]): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  /** Digits after "point", for "zero point five". */
  let decimals: string | null = null;

  for (const w of words) {
    if (w === 'and') continue;

    if (w === 'point') { decimals = ''; continue; }

    if (decimals !== null) {
      const d = UNITS[w];
      if (d == null || d > 9) break;
      decimals += String(d);
      seen = true;
      continue;
    }

    if (UNITS[w] != null) { current += UNITS[w]; seen = true; continue; }
    if (TENS[w]  != null) { current += TENS[w];  seen = true; continue; }

    const scale = SCALES[w];
    if (scale != null) {
      seen = true;
      // "hundred" scales the pending group in place ("twenty five hundred" =
      // 2500); the larger scales close it out and bank the result.
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      continue;
    }
    break;
  }

  if (!seen) return null;
  const whole = total + current;
  return decimals ? Number(`${whole}.${decimals}`) : whole;
}

/**
 * Replace every run of number words in a token list with its numeral.
 *
 * Runs are found greedily and folded whole, because the boundaries matter:
 * "twenty five thousand" is one run (25000) and "twenty five thousand five
 * hundred" is still one run (25500), but "five hundred nifty" ends the run at
 * "nifty".
 */
function foldNumbersInTokens(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (!NUMBER_WORD.has(tokens[i]) || tokens[i] === 'and' || tokens[i] === 'point') {
      out.push(tokens[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < tokens.length && NUMBER_WORD.has(tokens[j])) j++;

    // A trailing "and" / "point" belongs to the sentence, not the number.
    let end = j;
    while (end > i && (tokens[end - 1] === 'and' || tokens[end - 1] === 'point')) end--;

    const value = foldNumberWords(tokens.slice(i, end));
    if (value == null) {
      out.push(...tokens.slice(i, end));
    } else {
      out.push(String(value));
    }
    for (let k = end; k < j; k++) out.push(tokens[k]);
    i = j;
  }
  return out;
}

// ── Domain spellings ─────────────────────────────────────────────────────────

/**
 * Rewrites applied AFTER number folding, on the joined string.
 *
 * Order matters inside this list: the multi-word forms have to fire before the
 * single-word ones, or "bank nifty" becomes "bank" + a NIFTY match and the
 * symbol resolves to the wrong index.
 */
const REWRITES: ReadonlyArray<[RegExp, string]> = [
  // Index names as speech renders them.
  [/\bbank\s+nifty\b/g,        'banknifty'],
  [/\bnifty\s+bank\b/g,        'banknifty'],
  [/\bfin\s*nifty\b/g,         'finnifty'],
  [/\bmidcap\s+nifty\b/g,      'midcpnifty'],
  [/\bnifty\s+midcap\b/g,      'midcpnifty'],
  [/\bsensex\b/g,              'sensex'],
  [/\bknifty\b/g,              'nifty'],
  [/\bnifty\s+fifty\b/g,       'nifty'],
  [/\bnifty\s*50\b/g,          'nifty'],
  [/\bcrude\s*oil\b/g,         'crudeoil'],
  [/\bnatural\s*gas\b/g,       'naturalgas'],

  // Option side. "call"/"put" are what a voice user says; CE/PE is what the
  // instrument master keys on.
  [/\bcalls?\b/g,              'ce'],
  [/\bputs?\b/g,               'pe'],
  [/\bc\.?e\.?\b/g,            'ce'],
  [/\bp\.?e\.?\b/g,            'pe'],

  // Metric names. Every one of these is something a trader says out loud.
  // Any "open int…" is open interest in this domain, so the tail is left loose
  // rather than enumerated: "intrest", "interst" and "intetest" all arrive from
  // real typing, and an exact list would miss the next one.
  [/\bopen\s+int\w*\b/g,        'oi'],
  [/\bo\.?\s?i\.?\b/g,          'oi'],
  [/\bimplied\s+vol(?:atility)?\b/g, 'iv'],
  [/\bi\.?\s?v\.?\b/g,          'iv'],
  [/\bvol\b/g,                  'volume'],
  [/\bltp\b/g,                  'ltp'],
  [/\blast\s+traded\s+price\b/g, 'ltp'],
  [/\bput\s*call\s*ratio\b/g,   'pcr'],
  [/\bcall\s*put\s*ratio\b/g,   'pcr'],
  [/\bp\.?\s?c\.?\s?r\.?\b/g,   'pcr'],
  [/\bmax\s*pain\b/g,           'maxpain'],
  [/\bunderlying\b/g,           'spot'],

  // Time shorthand. Unambiguous in this domain — see the header's rule.
  [/\b(\d+)\s*mins?\b/g,        '$1 minute'],
  [/\b(\d+)\s*m\b/g,            '$1 minute'],
  [/\b(\d+)\s*hrs?\b/g,         '$1 hour'],
  [/\b(\d+)\s*h\b/g,            '$1 hour'],
  [/\b(\d+)\s*secs?\b/g,        '$1 second'],
  [/\b(\d+)\s*s\b/g,            '$1 second'],
  [/\b(\d+)\s*d\b/g,            '$1 day'],
  [/\b(\d+)\s*w\b/g,            '$1 week'],
  [/\bhalf\s+an?\s+hour\b/g,    '30 minute'],
  [/\ban?\s+hour\b/g,           '1 hour'],
];

/** `25k` → `25000`. Kept separate because it needs a function replacer. */
function foldShorthandScale(s: string): string {
  return s
    .replace(/\b(\d+(?:\.\d+)?)\s*k\b/g,  (_m, n) => String(Math.round(Number(n) * 1_000)))
    .replace(/\b(\d+(?:\.\d+)?)\s*lakhs?\b/g, (_m, n) => String(Math.round(Number(n) * 100_000)))
    .replace(/\b(\d+(?:\.\d+)?)\s*crores?\b/g, (_m, n) => String(Math.round(Number(n) * 10_000_000)));
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface Normalized {
  /** The rewritten sentence, single-spaced. What the grammar matches against. */
  text:   string;
  /** `text` split on whitespace. What the entity extractor walks. */
  tokens: string[];
  /** The caller's original string, kept for echoing back verbatim. */
  raw:    string;
}

export function normalize(raw: string): Normalized {
  let s = String(raw ?? '').toLowerCase().trim();

  // Strip anything that cannot carry meaning here. `.` survives the first pass
  // because it is inside decimals and inside "c.e."; it is removed below, after
  // the rewrites that depend on it, and only when not between digits.
  s = s.replace(/[,!?;:"“”'’`()\[\]{}]/g, ' ');
  s = s.replace(/[—–]/g, ' ');
  // Hyphens join words speech splits ("twenty-five", "bank-nifty"): become
  // spaces so the number folder and the rewrites both see word boundaries.
  s = s.replace(/-/g, ' ');

  for (const [re, to] of CONTRACTIONS) s = s.replace(re, to);

  s = foldShorthandScale(s);

  let tokens = s.split(/\s+/).filter(Boolean);
  tokens = foldNumbersInTokens(tokens);
  s = tokens.join(' ');

  for (const [re, to] of REWRITES) s = s.replace(re, to);

  // Now the dots have done their work.
  s = s.replace(/\.(?!\d)/g, ' ');
  s = s.replace(/\s+/g, ' ').trim();

  return { text: s, tokens: s.split(' ').filter(Boolean), raw: String(raw ?? '') };
}
