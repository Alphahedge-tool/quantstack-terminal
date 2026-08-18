/**
 * String similarity — the tolerance layer under every match in the NLU.
 *
 * ── Why two measures ──
 *
 * They fail in opposite directions, and the engine needs both.
 *
 *   Dice on character trigrams is order-insensitive and length-forgiving. It is
 *   what makes "open intrest" match "open interest" and "banknifty" match "bank
 *   nifty". But short strings have almost no trigrams, so it rates "ce" against
 *   "pe" far higher than it should.
 *
 *   Damerau-Levenshtein counts edits, including the transposition that a real
 *   typist actually makes ("teh"). It is exact on short tokens — where Dice is
 *   blind — but O(n·m), so it is only ever run against a small candidate set.
 *
 * So: Dice screens, edit distance decides. `similar()` blends them with the
 * blend weighted toward edit distance on short inputs, which is the regime Dice
 * gets wrong.
 *
 * ── Why not a library ──
 *
 * This is ~90 lines and it is on the hot path of every utterance. A dependency
 * here would be a supply-chain surface for something the engine can own
 * outright, and the blend above is the actual product — no library ships it.
 */

/** Character trigrams, padded so word starts and ends carry signal. */
function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/**
 * Sørensen-Dice coefficient over trigrams. 0..1.
 *
 * Cached: the lexicon compares the same few hundred vocabulary entries against
 * every incoming token, and re-splitting a fixed vocabulary string on every
 * keystroke is pure waste.
 */
const TRIGRAM_CACHE = new Map<string, Set<string>>();

function cachedTrigrams(s: string): Set<string> {
  let hit = TRIGRAM_CACHE.get(s);
  if (!hit) {
    hit = trigrams(s);
    // Unbounded growth would be a leak on free-text input. The vocabulary is
    // small and fixed; user tokens are not, so the cache is capped and cleared
    // wholesale rather than evicted one at a time (an LRU here would cost more
    // than the recompute it saves).
    if (TRIGRAM_CACHE.size > 4_000) TRIGRAM_CACHE.clear();
    TRIGRAM_CACHE.set(s, hit);
  }
  return hit;
}

export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const ta = cachedTrigrams(a);
  const tb = cachedTrigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/**
 * Damerau-Levenshtein distance with adjacent transposition.
 *
 * Bounded by `max`: the callers only ever ask "is this within 2 edits", and
 * bailing out of the row scan once every cell exceeds the bound turns the
 * common no-match case from O(n·m) into something close to O(n).
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev2: number[] = [];
  let prev:  number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr:  number[] = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
      // Transposition — "teh" → "the" is one edit, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev  = curr;
    curr  = new Array(b.length + 1);
  }
  return prev[b.length];
}

/**
 * Blended similarity, 0..1.
 *
 * Short strings lean on edit distance because trigrams barely exist below ~5
 * characters; long strings lean on Dice because a long phrase with one word
 * reordered is still the same phrase, and edit distance punishes that hard.
 */
export function similar(a: string, b: string): number {
  if (a === b) return 1;
  const len = Math.max(a.length, b.length);
  if (!len) return 0;

  const norm  = 1 - editDistance(a, b, Math.ceil(len / 2)) / len;
  const edits = Math.max(0, norm);
  const d     = dice(a, b);

  // Crossover at ~8 chars: below it edit distance dominates, above it Dice does.
  const wEdit = Math.max(0.2, Math.min(0.85, 8 / len));
  return edits * wEdit + d * (1 - wEdit);
}

/**
 * Best match for `token` among `candidates`, or null below `floor`.
 *
 * Exact hits short-circuit — the overwhelmingly common case, and worth not
 * paying a full scan for.
 */
export function bestMatch<T extends string>(
  token: string,
  candidates: readonly T[],
  floor = 0.72,
): { value: T; score: number } | null {
  if (!token) return null;
  for (const c of candidates) if (c === token) return { value: c, score: 1 };

  let best: T | null = null;
  let bestScore = 0;
  for (const c of candidates) {
    // Cheap length gate before the expensive comparison. Two strings whose
    // lengths differ by more than half the longer one cannot clear `floor`.
    if (Math.abs(c.length - token.length) > Math.max(c.length, token.length) / 2) continue;
    const s = similar(token, c);
    if (s > bestScore) { bestScore = s; best = c; }
  }
  return best && bestScore >= floor ? { value: best, score: bestScore } : null;
}
