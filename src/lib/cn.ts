/**
 * Class-name joiner.
 *
 * Deliberately not `clsx` — the whole need is "drop falsy, join with a space",
 * and a dependency for eight lines is a dependency to keep upgraded forever.
 */
export type ClassValue = string | number | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  let out = '';
  for (const value of values) {
    if (!value && value !== 0) continue;
    out = out ? `${out} ${value}` : String(value);
  }
  return out;
}
