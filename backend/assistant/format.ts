/**
 * Number and phrase formatting — screen text and speech text.
 *
 * ── Why these are two different functions ──
 *
 * "1,24,500" is right on a card and unreadable aloud: a speech synthesiser
 * given that string says "one two four five zero zero" or gives up. And "one
 * lakh twenty four thousand five hundred" is right aloud and absurd in a table
 * cell. Every number this assistant emits therefore goes through one of two
 * paths, and the caller picks by destination, never by convenience.
 *
 * ── Indian grouping ──
 *
 * `toLocaleString('en-IN')` groups by lakh/crore, which is what an Indian
 * options trader reads OI in. Using the default en-US grouping here would print
 * "124,500" for a number every user in this market thinks of as "1.24 lakh".
 */

import type { MetricName } from './types.js';

const IN = 'en-IN';

// ── Screen ───────────────────────────────────────────────────────────────────

/** Compact OI/volume: 1.24L, 2.3Cr — what fits in a table cell. */
export function compactCount(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(2)}L`;
  if (abs >= 1_000)      return `${(n / 1_000).toFixed(1)}K`;
  return Math.round(n).toLocaleString(IN);
}

export function rupees(n: number): string {
  return `₹${n.toLocaleString(IN, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * One metric value, formatted for its own units.
 *
 * Greeks get more decimals than prices because they live in a much smaller
 * range — a gamma printed to two places is almost always "0.00", which reads as
 * "no gamma" rather than "small gamma".
 */
export function formatMetric(v: number, metric: MetricName): string {
  switch (metric) {
    case 'oi':
    case 'volume': return compactCount(v);
    case 'ltp':    return rupees(v);
    case 'iv':     return `${v.toFixed(2)}%`;
    case 'pcr':    return v.toFixed(2);
    case 'spot':   return v.toLocaleString(IN, { maximumFractionDigits: 2 });
    case 'delta':
    case 'theta':  return v.toFixed(3);
    case 'gamma':  return v.toFixed(5);
    case 'vega':   return v.toFixed(3);
    default:       return String(v);
  }
}

export function signedPct(pct: number, digits = 1): string {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(digits)}%`;
}

// ── Speech ───────────────────────────────────────────────────────────────────

const UNITS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = [
  '', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
];

/** 0-999 in words. The building block for the lakh/crore grouping below. */
function underThousand(n: number): string {
  if (n < 20) return UNITS[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const u = n % 10;
    return u ? `${t} ${UNITS[u]}` : t;
  }
  const h = Math.floor(n / 100);
  const rest = n % 100;
  return rest ? `${UNITS[h]} hundred ${underThousand(rest)}` : `${UNITS[h]} hundred`;
}

/**
 * A whole number in Indian-English words.
 *
 * Grouped crore / lakh / thousand / remainder, because that is how the number
 * is said here. Above a crore it degrades to a decimal phrase ("twelve point
 * four crore") — the full expansion of a nine-digit OI is a sentence nobody
 * listens to the end of.
 */
export function numberToWords(n: number): string {
  const neg = n < 0;
  let v = Math.round(Math.abs(n));
  if (v === 0) return 'zero';

  if (v >= 1_000_000_000) return `${neg ? 'minus ' : ''}${(v / 10_000_000).toFixed(1)} crore`;

  const parts: string[] = [];
  const crore = Math.floor(v / 10_000_000);
  if (crore) { parts.push(`${underThousand(crore)} crore`); v -= crore * 10_000_000; }
  const lakh = Math.floor(v / 100_000);
  if (lakh) { parts.push(`${underThousand(lakh)} lakh`); v -= lakh * 100_000; }
  const thousand = Math.floor(v / 1_000);
  if (thousand) { parts.push(`${underThousand(thousand)} thousand`); v -= thousand * 1_000; }
  if (v) parts.push(underThousand(v));

  return `${neg ? 'minus ' : ''}${parts.join(' ')}`;
}

/**
 * A metric value as speech.
 *
 * Counts become words; prices and ratios stay as digits, because a synthesiser
 * reads "24.65" correctly as "twenty four point six five" and spelling that out
 * ourselves only adds ways to be wrong.
 */
export function spokenNumber(v: number, metric: MetricName): string {
  switch (metric) {
    case 'oi':
    case 'volume': return numberToWords(v);
    case 'ltp':    return `${v.toFixed(2)} rupees`;
    case 'iv':     return `${v.toFixed(1)} percent`;
    case 'pcr':    return v.toFixed(2);
    case 'spot':   return numberToWords(v);
    default:       return v.toFixed(3);
  }
}

/** "NIFTY 25000 CE" → "nifty twenty five thousand call". */
export function spokenContract(symbol: string, strike?: number, side?: string): string {
  const parts = [symbol.toLowerCase()];
  if (strike != null) parts.push(numberToWords(strike));
  if (side === 'CE') parts.push('call');
  else if (side === 'PE') parts.push('put');
  return parts.join(' ');
}

/** "600000" ms → "10 minutes", for both screen and speech. */
export function durationPhrase(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)} seconds`;
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** Compact YYYYMMDD → "28 Aug". */
export function expiryPhrase(expiry: string): string {
  if (!/^\d{8}$/.test(expiry)) return expiry;
  const month = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ][Number(expiry.slice(4, 6)) - 1] ?? '';
  return `${Number(expiry.slice(6, 8))} ${month}`;
}
