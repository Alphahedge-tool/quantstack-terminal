/**
 * Canonical instrument identity.
 *
 * Consumers address instruments STRUCTURALLY — never by a broker's symbol
 * string. This is what makes failover work: if feed 1 dies after the strike
 * list is built, feed 2 receives `{ exchange, asset, expiry, strike, side }`,
 * which it can resolve against its own instrument master. Handing it
 * "NIFTY11AUG2624500CE" would not survive the switch.
 *
 * Each adapter owns the mapping between InstrumentKey and its own symbols.
 * Nothing outside `feeds/adapters/` may construct or read a broker symbol.
 */

export type InstrumentKind = 'SPOT' | 'FUT' | 'OPT';
export type OptionSide     = 'CE' | 'PE';

export interface InstrumentKey {
  exchange: string;          // NSE | BSE | MCX
  asset:    string;          // NIFTY | RELIANCE | CRUDEOIL   (underlying)
  kind:     InstrumentKind;
  /** ISO `YYYY-MM-DD`. Required for FUT and OPT, absent for SPOT. */
  expiry?:  string;
  /** Rupees. OPT only. */
  strike?:  number;
  side?:    OptionSide;
}

/**
 * Stable string form, used as a Map key and in log lines.
 * e.g. `NSE:NIFTY:OPT:2026-08-11:24500:CE`
 */
export function keyOf(k: InstrumentKey): string {
  return [
    k.exchange.toUpperCase(),
    k.asset.toUpperCase(),
    k.kind,
    k.expiry ?? '',
    k.strike ?? '',
    k.side ?? '',
  ].join(':');
}

/** Inverse of `keyOf`. Throws on a malformed string rather than guessing. */
export function parseKey(s: string): InstrumentKey {
  const [exchange, asset, kind, expiry, strike, side] = s.split(':');
  if (!exchange || !asset || !kind) throw new Error(`Malformed instrument key: ${s}`);
  return {
    exchange,
    asset,
    kind:   kind as InstrumentKind,
    expiry: expiry || undefined,
    strike: strike ? Number(strike) : undefined,
    side:   (side || undefined) as OptionSide | undefined,
  };
}

/**
 * Normalise an expiry to `YYYY-MM-DD`.
 *
 * Nubra's refdata carries `YYYYMMDD` (see instrumentCache.parseRows) while the
 * straddle routes accept both that and the dashed form. Every adapter funnels
 * expiries through here so a key built from one feed matches a key built from
 * another.
 */
export function normalizeExpiry(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `YYYYMMDD`, for adapters whose upstream wants the compact form. */
export function compactExpiry(iso: string | undefined): string | undefined {
  return iso ? iso.replace(/-/g, '') : undefined;
}

// ── Convenience constructors ─────────────────────────────────────────────────

export const optionKey = (
  exchange: string, asset: string, expiry: string, strike: number, side: OptionSide,
): InstrumentKey => ({
  exchange: exchange.toUpperCase(),
  asset:    asset.toUpperCase(),
  kind:     'OPT',
  expiry:   normalizeExpiry(expiry),
  strike,
  side,
});

export const spotKey = (exchange: string, asset: string): InstrumentKey => ({
  exchange: exchange.toUpperCase(),
  asset:    asset.toUpperCase(),
  kind:     'SPOT',
});

export const futureKey = (
  exchange: string, asset: string, expiry?: string,
): InstrumentKey => ({
  exchange: exchange.toUpperCase(),
  asset:    asset.toUpperCase(),
  kind:     'FUT',
  expiry:   normalizeExpiry(expiry),
});
