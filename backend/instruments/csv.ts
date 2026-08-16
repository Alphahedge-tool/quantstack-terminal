/**
 * Minimal RFC-4180 CSV reader for instrument masters.
 *
 * Zerodha and Kotak both publish theirs as CSV, and both need the quoting rules
 * honoured: company names carry commas (`RELIANCE INDUSTRIES, LTD`) and Kotak's
 * segment files are semicolon-delimited in some regions. A naive `split(',')`
 * shifts every column after the first quoted field, which surfaces later as
 * thousands of instruments with a strike where the lot size should be.
 */

/** Sniff the delimiter from the header, ignoring anything inside quotes. */
function delimiterFor(header: string): string {
  let commas = 0;
  let semis  = 0;
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas += 1;
    else if (!quoted && ch === ';') semis += 1;
  }
  return commas >= semis ? ',' : ';';
}

function parseRow(line: string, delimiter: string): string[] {
  const values: string[] = [];
  let value  = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      // `""` inside a quoted field is one literal quote.
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (ch === delimiter && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += ch;
    }
  }
  values.push(value.trim());
  return values;
}

/** Rows as header-keyed records. Returns `[]` for an empty or header-only file. */
export function parseCSV(text: string): Array<Record<string, string>> {
  const lines = String(text ?? '')
    .replace(/^﻿/, '')     // Kotak's files are BOM-prefixed
    .split(/\r?\n/)
    .filter((line) => line.trim());

  if (lines.length < 2) return [];

  const delimiter = delimiterFor(lines[0]);
  const headers   = parseRow(lines[0], delimiter).map((h) => h.trim().replace(/;$/, ''));

  return lines.slice(1).map((line) => {
    const values = parseRow(line, delimiter);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? ''])) as Record<string, string>;
  });
}
