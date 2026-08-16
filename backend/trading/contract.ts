/**
 * Broker report row → canonical contract.
 *
 * This is the join that makes the whole layer worth having. Order books,
 * position reports and fill streams all come back speaking the BROKER's
 * vocabulary — its trading symbol, its segment string, its token. None of that
 * means anything to another broker. Resolving it to a canonical contract is what
 * lets a Kotak position be priced by an Angel tick, or a Zerodha order book be
 * displayed next to a Nubra chart of the same strike.
 *
 * ── Resolution order ──
 *
 *   1. broker symbol + broker segment, against that broker's own master
 *   2. broker token + broker segment, for reports that omit the symbol
 *   3. reconstruct from the row's own fields (strike, expiry, option type)
 *
 * Step 3 matters more than it looks. A master is a day old at worst but can be
 * stale, and a contract listed this morning may be missing from it. Falling back
 * to the row's own fields means a freshly-listed strike still resolves, rather
 * than showing as an unidentified position on the one day it is most likely to
 * be traded.
 */

import { instruments } from '../instruments/store.js';
import {
  canonicalSymbol, canonicalExchange, expiryKey, expiryKeyToISO,
  type ContractType,
} from '../instruments/symbol.js';
import type { InstrumentKey, InstrumentKind, OptionSide } from '../feeds/identity.js';
import type { Contract } from './types.js';

/** A broker report row, in the loosest shape all four share. */
export interface ReportRow {
  /** The broker's trading symbol. */
  brsymbol?:   string;
  /** The broker's segment, as the report spelled it. */
  brexchange?: string;
  token?:      string;
  /** Fallback fields, used when the master cannot resolve the row. */
  underlying?: string;
  expiry?:     string;
  strike?:     number | string;
  optionType?: string;
  lot?:        number;
}

function upper(v: unknown): string {
  return String(v ?? '').trim().toUpperCase();
}

/** Underlying exchange for an InstrumentKey, from a master segment. */
function exchangeForKey(segment: string): string {
  switch (segment) {
    case 'NFO': return 'NSE';
    case 'BFO': return 'BSE';
    default:    return segment;
  }
}

function kindOf(type: ContractType): InstrumentKind {
  if (type === 'FUT') return 'FUT';
  if (type === 'CE' || type === 'PE') return 'OPT';
  return 'SPOT';
}

/**
 * Contract type from whatever the row offers.
 *
 * The symbol suffix is checked last but is the most reliable signal — brokers
 * disagree on `instrumentType` spellings far more than exchanges disagree on
 * how a trading symbol ends.
 */
function typeOf(row: ReportRow): ContractType {
  const opt = upper(row.optionType);
  if (opt === 'CE' || opt === 'PE') return opt;

  const sym = upper(row.brsymbol);
  if (sym.endsWith('CE')) return 'CE';
  if (sym.endsWith('PE')) return 'PE';
  if (sym.endsWith('FUT')) return 'FUT';
  return 'EQ';
}

/** The empty contract, for a row nothing can identify. */
function unresolved(row: ReportRow): Contract {
  const label = String(row.brsymbol ?? '').trim() || String(row.token ?? '') || 'unknown';
  return {
    symbol: '', key: null, resolved: false,
    exchange: canonicalExchange(row.brexchange),
    underlying: upper(row.underlying), expiry: '', strike: null, optionType: '',
    lot: Number(row.lot) || 1,
    label,
  };
}

/**
 * Resolve one broker report row.
 *
 * Never throws and never returns null: an unidentifiable position is still a
 * position, and the caller gets a Contract with `key: null` that the UI can
 * render and flag rather than a row that silently vanished.
 */
export function resolveContract(broker: string, row: ReportRow): Contract {
  const brsymbol   = String(row.brsymbol ?? '').trim();
  const brexchange = String(row.brexchange ?? '').trim();

  // 1. The broker's own symbol, against its own master.
  let hit = brsymbol ? instruments.resolveBroker(broker, brsymbol, brexchange) : null;

  // 2. Its token, for reports that carry no symbol.
  if (!hit && row.token) hit = instruments.resolveToken(broker, String(row.token), brexchange);

  if (hit) {
    const kind = kindOf(hit.instrumentType);
    const key: InstrumentKey | null = hit.symbol
      ? {
          exchange: exchangeForKey(hit.exchange),
          asset:    hit.name,
          kind,
          expiry:   hit.expiry || undefined,
          strike:   hit.strike ?? undefined,
          side:     (hit.optionType || undefined) as OptionSide | undefined,
        }
      : null;

    return {
      symbol:     hit.symbol,
      key,
      resolved:   true,
      exchange:   hit.exchange,
      underlying: hit.name,
      expiry:     hit.expiry,
      strike:     hit.strike,
      optionType: hit.optionType,
      lot:        hit.lotsize || Number(row.lot) || 1,
      label:      hit.symbol || brsymbol,
    };
  }

  // 3. Rebuild from the row itself.
  const type   = typeOf(row);
  const expiry = type === 'EQ' ? '' : (expiryKeyToISO(expiryKey(row.expiry ?? '')) ?? '');
  const strikeRaw = Number(row.strike);
  const strike = (type === 'CE' || type === 'PE') && Number.isFinite(strikeRaw) && strikeRaw > 0
    ? strikeRaw
    : null;

  // The root is either stated, or recovered by stripping the expiry block off
  // the trading symbol — `NIFTY28AUG2624500CE` → `NIFTY`.
  let underlying = upper(row.underlying);
  if (!underlying || underlying === upper(brsymbol)) {
    const part = expiryKey(row.expiry ?? '');
    underlying = part && upper(brsymbol).includes(part)
      ? upper(brsymbol).split(part)[0]
      : upper(brsymbol).replace(/\d{1,2}[A-Z]{3}\d{2}.*$/, '').replace(/-(EQ|BE)$/, '');
  }
  if (!underlying) return unresolved(row);

  const symbol   = canonicalSymbol({ name: underlying, type, expiry, strike });
  const exchange = canonicalExchange(brexchange);

  return {
    symbol,
    // A key is only offered when every part a lookup needs is present.
    // A half-built key that resolves to nothing is worse than an explicit null,
    // because callers treat a non-null key as usable.
    key: symbol && exchange && (type === 'EQ' || expiry)
      ? {
          exchange: exchangeForKey(exchange),
          asset:    underlying,
          kind:     kindOf(type),
          expiry:   expiry || undefined,
          strike:   strike ?? undefined,
          side:     (type === 'CE' || type === 'PE' ? type : undefined) as OptionSide | undefined,
        }
      : null,
    resolved: false,
    exchange,
    underlying,
    expiry,
    strike,
    optionType: type === 'CE' || type === 'PE' ? type : '',
    lot:        Number(row.lot) || 1,
    label:      symbol || brsymbol || 'unknown',
  };
}

/**
 * Which brokers could price this contract right now.
 *
 * Used by the positions view to show that a Kotak position is being priced by
 * an Angel feed — provenance the user should be able to see rather than infer.
 */
export function pricingBrokersFor(contract: Contract): string[] {
  return contract.key ? instruments.brokersFor(contract.key) : [];
}
