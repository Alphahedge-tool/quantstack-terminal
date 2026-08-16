/**
 * One broker's row for one contract.
 *
 * Every broker's instrument master is normalised into this shape by a loader in
 * `instruments/loaders/`. The fields split cleanly in two:
 *
 *   canonical  symbol, exchange, name, expiry, strike, optionType, lotsize
 *              — identical across brokers for the same contract, and the only
 *                fields anything outside an adapter is allowed to read.
 *
 *   broker      brsymbol, brexchange, token, exchangeToken
 *              — whatever THIS broker calls it. Sealed inside the adapter that
 *                loaded it; leaking one of these into a consumer is exactly how
 *                feed switching breaks, because the next broker cannot use it.
 */

import type { ContractType } from './symbol.js';

export interface InstrumentRow {
  // ── canonical ──
  /** `NIFTY28AUG2624500CE`. The join key across every broker. */
  symbol:        string;
  /** Canonical exchange/segment: NSE | NFO | BSE | BFO | MCX | CDS | BCD. */
  exchange:      string;
  /** Underlying root — NIFTY, RELIANCE, CRUDEOIL. */
  name:          string;
  /** ISO `YYYY-MM-DD`, or '' for cash. */
  expiry:        string;
  strike:        number | null;
  optionType:    '' | 'CE' | 'PE';
  lotsize:       number;
  ticksize?:     number;
  instrumentType: ContractType;

  // ── broker-specific ──
  /** The broker's own trading symbol. */
  brsymbol:      string;
  /** The broker's own segment string (`nse_fo`, `NFO`, …). */
  brexchange:    string;
  /** The broker's instrument token — what its WebSocket subscribes by. */
  token:         string;
  /** Zerodha publishes a second, exchange-scoped token. */
  exchangeToken?: string;
}

/** What a loader produces. */
export type InstrumentRows = InstrumentRow[];
