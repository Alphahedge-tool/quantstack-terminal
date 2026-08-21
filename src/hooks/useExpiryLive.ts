/**
 * The expiry cockpit over `/ws/expiry`.
 *
 * ── What this replaces ──
 *
 * A four-second poll of `/api/expiry/state`. The socket pushes on the chain's
 * own clock (throttled server-side to ~1/s), so the top line moves with the
 * feed instead of lagging it by up to four seconds — which on expiry afternoon
 * is the difference between watching a move and reading about one.
 *
 * ── Why the poll is still here ──
 *
 * As a fallback, not as the primary. `useExpiryState` is passed `enabled` only
 * while the socket is NOT delivering, so the page keeps working when the socket
 * cannot connect — a proxy that drops upgrades, a backend mid-restart — and
 * costs nothing when it can. The moment a state frame lands, polling stops.
 *
 * ── The only merge rule ──
 *
 * A frame replaces everything it carries, with one exception: `bars` may arrive
 * as a tail rather than the whole series, because by late session the series is
 * ~147 KB and gains one minute at a time. `barsFull` says which it is, and
 * defaults to a full replace when absent — so the failure mode of an older
 * server is a bigger frame, never a mis-spliced chart.
 *
 * Reconnects stay self-healing: a fresh socket has been sent nothing, so the
 * server's first frame to it is a full series by construction. No backfill, no
 * `since`, and no way for the page to sit on a half-applied update.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { LiveSocket, type SocketState } from '@/lib/socket';
import { expiryFrameSchema, type ExpiryFrame, type ExpiryState } from '@/schemas/expiry';

function parseFrame(raw: unknown): ExpiryFrame | null {
  const parsed = expiryFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * One module-level socket, like the quote channel.
 *
 * The cockpit is a single page, but a connection that is torn down and rebuilt
 * on every re-render would re-acquire the chain each time — and a cold chain
 * costs up to twenty seconds. The socket outlives the component; the effect
 * below only attaches listeners and sets the subscription.
 */
const expirySocket = new LiveSocket<ExpiryFrame>('/ws/expiry', parseFrame);

export interface ExpiryLive {
  /** Newest pushed state, or null before the first frame lands. */
  state: ExpiryState | null;
  socket: SocketState;
  /** True once a state frame has arrived — what the poll's `enabled` keys off. */
  streaming: boolean;
  /** Server-side progress while a cold chain comes up, and any error it raised. */
  status: string;
  error: string | null;
}

export function useExpiryLive(
  symbol: string,
  exchange: string,
  expiry: string,
  enabled = true,
): ExpiryLive {
  const [state, setState] = useState<ExpiryState | null>(null);
  const [socket, setSocketState] = useState<SocketState>('closed');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  /*
   * Which contract the held state belongs to.
   *
   * Frames for the PREVIOUS symbol can still be in flight when the user
   * switches, and rendering one under the new heading would show the wrong
   * contract's numbers with total confidence. The server drops superseded
   * subscriptions too, but the client must not depend on that race.
   */
  const wanted = useRef({ symbol, exchange, expiry });
  wanted.current = { symbol, exchange, expiry };

  useEffect(() => {
    if (!enabled || !symbol) return undefined;

    // Clear immediately: the old contract's state must not sit on screen under
    // the new one's heading while the first frame is in flight.
    setState(null);
    setError(null);
    setStatus('connecting');

    const offState = expirySocket.onState(setSocketState);
    const offFrame = expirySocket.onFrame((frame) => {
      switch (frame.event) {
        case 'state': {
          const w = wanted.current;
          // Compare on what the server echoes back, not on what we asked for:
          // an empty `expiry` means "front", and the server resolves it.
          if (
            frame.symbol.toUpperCase() !== w.symbol.toUpperCase()
            || frame.exchange.toUpperCase() !== w.exchange.toUpperCase()
          ) return;
          const { event: _event, barsFrom, barsFull, ...rest } = frame;
          setState((prev) => {
            /*
             * Splice only when the server said to AND there is something to
             * splice onto. Without a previous series a tail is meaningless, and
             * taking it as the whole thing would silently drop the session's
             * history — so that case falls back to whatever arrived.
             */
            const bars = barsFull || !prev
              ? rest.bars
              : [...prev.bars.slice(0, barsFrom), ...rest.bars];
            return { status: true, ...rest, bars } as ExpiryState;
          });
          setError(null);
          setStatus('live');
          break;
        }
        case 'status':
          setStatus(frame.status);
          break;
        case 'error':
          setError(frame.message);
          break;
        case 'pong':
          break;
      }
    });

    expirySocket.connect();
    // A factory, not a fixed payload: a reconnect must re-subscribe to whatever
    // contract is on screen NOW, not the one that was showing when the socket
    // first opened.
    expirySocket.subscribe(() => {
      const w = wanted.current;
      if (!w.symbol) return null;
      return {
        type: 'subscribe',
        symbol: w.symbol,
        exchange: w.exchange,
        ...(w.expiry ? { expiry: w.expiry } : {}),
      };
    });

    return () => {
      offState();
      offFrame();
    };
  }, [symbol, exchange, expiry, enabled]);

  /*
   * Close on unmount, unlike the quote channel.
   *
   * The quote socket is mounted once at the shell and stays for the session.
   * This one belongs to a single page, and holding it open after navigating
   * away would keep a chain subscribed for a cockpit nobody is looking at —
   * which is the exact cost the socket was added to avoid.
   */
  useEffect(() => () => expirySocket.close(), []);

  return useMemo(
    () => ({
      state,
      socket,
      streaming: state !== null && socket === 'open',
      status,
      error,
    }),
    [state, socket, status, error],
  );
}
