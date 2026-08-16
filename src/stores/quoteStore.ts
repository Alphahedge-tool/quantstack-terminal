/**
 * Live quotes, indexed by canonical symbol.
 *
 * Frames carry `symbol` (NIFTY18AUG2624300CE) rather than a structural key —
 * exactly the field `/api/trading/positions` puts on every row — so joining a
 * tick to a position is a map lookup and neither side needs key-encoding logic
 * of its own.
 *
 * ── Why a store rather than query cache ──
 *
 * Quotes arrive as a push stream at up to 4Hz. Writing them through TanStack
 * Query would invalidate and re-render every subscriber of the book on each
 * flush. Here, a component selects the ONE symbol it renders and re-renders
 * only when that symbol moves.
 */

import { create } from 'zustand';
import type { Quote } from '@/schemas/market';
import type { SocketState } from '@/lib/socket';

/** A quote plus the direction of its last change, which is what drives the
 *  tick-flash. Derived on write because the previous value is only available
 *  here — a component seeing just the new price cannot know which way it went. */
export interface TickedQuote extends Quote {
  tick: 'up' | 'down' | 'flat';
}

interface QuoteState {
  quotes: Record<string, TickedQuote>;
  socket: SocketState;
  /** Whether a feed is actually carrying the subscribed contracts. Connected
   *  but not carrying is a real state — the socket is up and prices are not
   *  coming — and the status bar has to be able to say so. */
  carrying: boolean;
  carryingBroker: string | null;

  applyQuotes: (incoming: Quote[]) => void;
  setSocket: (state: SocketState) => void;
  setCarrying: (carrying: boolean, broker?: string) => void;
  clear: () => void;
}

export const useQuoteStore = create<QuoteState>((set) => ({
  quotes: {},
  socket: 'closed',
  carrying: false,
  carryingBroker: null,

  applyQuotes: (incoming) =>
    set((state) => {
      if (incoming.length === 0) return state;
      const quotes = { ...state.quotes };
      for (const quote of incoming) {
        const previous = quotes[quote.symbol];
        let tick: TickedQuote['tick'] = 'flat';
        if (
          previous?.ltp !== undefined &&
          quote.ltp !== undefined &&
          quote.ltp !== previous.ltp
        ) {
          tick = quote.ltp > previous.ltp ? 'up' : 'down';
        }
        quotes[quote.symbol] = { ...quote, tick };
      }
      return { quotes };
    }),

  setSocket: (socket) => set({ socket }),
  setCarrying: (carrying, broker) =>
    set({ carrying, carryingBroker: broker ?? null }),
  clear: () => set({ quotes: {}, carrying: false, carryingBroker: null }),
}));

/** Selector for a single symbol. Using this instead of reading `.quotes` in a
 *  component is what keeps a 200-row book from re-rendering on every flush. */
export function useQuote(symbol: string | undefined): TickedQuote | undefined {
  return useQuoteStore((s) => (symbol ? s.quotes[symbol] : undefined));
}
