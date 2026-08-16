/**
 * Binds the `/ws/live/quotes` socket to the quote store.
 *
 * One module-level socket, shared by every page. Mounting the provider connects
 * it; components below simply read `useQuote(symbol)`.
 */

import { useEffect, useMemo, useRef } from 'react';
import { LiveSocket } from '@/lib/socket';
import { keyOf, type InstrumentKey } from '@/lib/symbol';
import { liveFrameSchema, type LiveFrame } from '@/schemas/market';
import type { ContractKey } from '@/schemas/trading';
import { useQuoteStore } from '@/stores/quoteStore';

/**
 * Frames this channel does not model return null and are skipped rather than
 * throwing — the server may add event types, and a parse error must not take
 * down a live tape over a frame we never read.
 */
function parseFrame(raw: unknown): LiveFrame | null {
  const parsed = liveFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const quoteSocket = new LiveSocket<LiveFrame>('/ws/live/quotes', parseFrame);

/**
 * Opens the socket for the lifetime of the mounting component and routes frames
 * into the store. Mount ONCE, at the shell.
 */
export function useLiveQuoteChannel(): void {
  useEffect(() => {
    const { applyQuotes, setSocket, setCarrying } = useQuoteStore.getState();

    const offState = quoteSocket.onState(setSocket);
    const offFrame = quoteSocket.onFrame((frame) => {
      switch (frame.event) {
        case 'quotes':
          applyQuotes(frame.quotes);
          break;
        case 'status':
          setCarrying(frame.carrying, frame.broker);
          break;
        case 'pong':
          break;
      }
    });

    quoteSocket.connect();
    return () => {
      offState();
      offFrame();
      // The socket itself is intentionally left open — see LiveSocket's header.
      // Only this shell mounts the channel, and it unmounts on page teardown.
    };
  }, []);
}

/**
 * A contract as the books deliver it. Only the key is needed to subscribe;
 * taking the whole row would tie this hook to one book's shape.
 */
export interface Priceable {
  key: ContractKey | null;
}

/**
 * The wire form of a resolved key.
 *
 * Nulls are normalised to absent. The backend's `toKey` treats them the same
 * way, but sending `strike: null` for a future is claiming a fact about the
 * contract that is not true, and the frame is also what a reader sees first in
 * the network tab when a subscription misbehaves.
 */
function wireKey(key: ContractKey): InstrumentKey {
  return {
    exchange: key.exchange,
    asset: key.asset,
    kind: key.kind,
    expiry: key.expiry ?? undefined,
    strike: key.strike ?? undefined,
    side: key.side ?? undefined,
  };
}

/**
 * Declares the contracts a page wants priced.
 *
 * ── Keys, not symbols ──
 *
 * The server subscribes by InstrumentKey and rejects anything that is not an
 * object (`backend/live/wsQuotes.ts:79`). Sending canonical symbol strings —
 * which this hook did until now — produced an empty key set on every subscribe,
 * so the socket connected, reported `carrying: false`, and never delivered a
 * tick. Nothing surfaced as an error; the P&L column simply only moved when the
 * REST book re-polled, which is the exact problem the socket exists to fix.
 *
 * Frames still come BACK keyed by canonical symbol, so `useQuote(symbol)` and
 * the store are unaffected. Only the outbound direction speaks in keys.
 *
 * The server holds one subscription set per connection, so this REPLACES rather
 * than adds. Keys are sorted into a comparison string so a book that re-fetches
 * the same rows in a different order does not re-subscribe — which would reset
 * the tape on every poll.
 */
export function useQuoteSubscription(contracts: Priceable[]): void {
  const previous = useRef<string>('');

  /**
   * Deduped and sorted, with unresolvable rows dropped.
   *
   * A `key: null` contract is a position the instrument master could not
   * identify. It is still shown in the book — and it is still not priceable, so
   * sending it would only earn a "not carried by any master" warning server-side.
   */
  const keys = useMemo(() => {
    const byId = new Map<string, InstrumentKey>();
    for (const contract of contracts) {
      if (!contract.key || !contract.key.asset || !contract.key.exchange) continue;
      const key = wireKey(contract.key);
      byId.set(keyOf(key), key);
    }
    return [...byId.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [contracts]);

  useEffect(() => {
    const fingerprint = keys.map(([id]) => id).join('|');
    if (fingerprint === previous.current) return;
    previous.current = fingerprint;
    quoteSocket.subscribe({ type: 'subscribe', keys: keys.map(([, key]) => key) });
  }, [keys]);
}
