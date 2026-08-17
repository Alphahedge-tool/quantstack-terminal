/**
 * Live straddle ticks, appended to a loaded session.
 *
 * The backend does the work: it holds the broker socket, applies the same
 * cheapest-of-band rule the historical engine uses, and pushes one finished
 * StraddlePoint roughly every 250ms. This module is transport plus lifecycle —
 * deliberately, so the live line and the walked session cannot disagree about
 * what a straddle point is.
 *
 * ── One feed per CONTRACT, not per component ──
 *
 * Both the chart slot and the page's stat strip need today's newest point, and
 * the page deliberately resolves the focused contract a second time (the query
 * cache makes that free). Doing the same naively with a socket is not free: it
 * would open a second connection, run a second subscription against the broker
 * fan-out, and — worse — give the two views separate buffers that drift apart,
 * so the strip and the chart could disagree about the last trade.
 *
 * So a session is keyed by contract and reference-counted. The first consumer
 * opens it, the last one closes it, and everyone reads the same buffer. This is
 * the same reasoning `lib/socket.ts` gives for `LiveSocket` being a class rather
 * than a hook, applied one level up.
 *
 * ── Points are batched, not streamed into React ──
 *
 * Four points a second, each triggering a re-render that re-aggregates a
 * 22,000-point session into candles, is four full rebuilds a second for four
 * pixels of new line. Ticks land in a buffer and are published on a timer.
 *
 * The reference terminal solves this differently — it hands the chart an
 * imperative `push()` handle and calls `series.update()` per tick, with no React
 * involvement. That is faster and right at their scale. It is NOT what this
 * does, because it needs a second code path that buckets a live point into the
 * current interval alongside the one `aggregated` already uses for history, and
 * two bucketing implementations that must agree exactly is the bug shape that
 * had the DTE median disagreeing with its own table for two rounds of this
 * project. One path, published at 1 Hz, is measurably fast enough.
 *
 * ── Surviving a background tab ──
 *
 * A hidden tab cannot paint — browsers stop firing requestAnimationFrame — and
 * nothing here changes that, nor should it. What matters is that the tab returns
 * to a COMPLETE chart rather than a flat line, which is a data problem:
 *
 *   SINCE      every reconnect resubscribes with the newest point already held,
 *              and the backend replays the hole out of the session it kept
 *              running. Minutes spent disconnected arrive as history.
 *   ONGAP      when the backend cannot reach back that far it says so, and the
 *              caller reloads from history. The only honest way to close a long
 *              hole.
 *   HEARTBEAT  a half-open TCP connection leaves `readyState` at OPEN forever.
 *              A silence watchdog turns that into a reconnect, re-checked the
 *              instant the tab becomes visible because timers themselves are
 *              throttled to about once a minute in the background.
 */

import { useEffect, useState } from 'react';
import { LiveSocket } from '@/lib/socket';
import {
  parseLiveStraddleFrame,
  type LiveRoll,
  type LiveStraddleFrame,
} from '@/schemas/liveStraddle';
import type { StraddlePoint } from '@/schemas/market';

/**
 * How often accumulated ticks are published.
 *
 * One second. The feed produces ~4 points in that window, so at the 1m candles
 * a comparison forces, a publish usually changes one candle's close. Faster buys
 * nothing a reader can see; slower makes the live edge feel detached from the
 * clock beside it.
 */
const FLUSH_MS = 1_000;

/**
 * Total silence tolerated before the socket is presumed dead.
 *
 * Deliberately more than twice `LiveSocket`'s 15s ping: a hidden tab's timers
 * are throttled to roughly one per minute, so a ping due at 15s may not fire
 * until 60. Anything tighter would declare a healthy background feed dead and
 * reconnect it for no reason.
 */
const SILENCE_MS = 90_000;

export type LiveStraddleState =
  | 'idle' | 'connecting' | 'live' | 'reconnecting' | 'closed' | 'error';

export interface LiveStraddleSnapshot {
  /** Live points since the session opened, oldest first, ready to concat. */
  points: StraddlePoint[];
  rolls: LiveRoll[];
  /** The newest point, without walking the array. Null before the first tick. */
  last: StraddlePoint | null;
  state: LiveStraddleState;
  /** One short line for the UI — "Live", "Market closed", a broker error. */
  status: string;
}

const EMPTY: LiveStraddleSnapshot = {
  points: [], rolls: [], last: null, state: 'idle', status: '',
};

interface Contract {
  symbol: string;
  exchange: string;
  expiry: string;
}

type Listener = (snapshot: LiveStraddleSnapshot) => void;

/**
 * One contract's live feed, shared by every consumer of that contract.
 *
 * The published snapshot is replaced, never mutated: consumers hold it in React
 * state, and an in-place push would leave `points` referentially equal so no
 * dependent memo — the candle aggregation above all — would ever recompute.
 */
class LiveStraddleSession {
  private socket: LiveSocket<LiveStraddleFrame> | null = null;
  private listeners = new Set<Listener>();
  private gapListeners = new Set<() => void>();
  private refs = 0;

  private pending: { points: StraddlePoint[]; rolls: LiveRoll[] } = { points: [], rolls: [] };
  private snapshot: LiveStraddleSnapshot = EMPTY;
  /** Newest point time from any source — the reconnect's `since`. */
  private mark: number | null = null;
  private atmHint: number | null = null;
  private heard = 0;
  private flushTimer: number | null = null;
  private watchdog: number | null = null;
  /** Set when the feed has ended for a reason retrying cannot fix. */
  private done = false;

  constructor(private readonly contract: Contract) {}

  get current(): LiveStraddleSnapshot {
    return this.snapshot;
  }

  /** Seed the resume mark and ATM from whichever consumer knows them. */
  seed(since: number | null, atmHint: number | null): void {
    // The FURTHEST mark wins. Two consumers can hold histories of different
    // ages; resuming from the older one would replay points the newer already
    // has, and the merge would then have to de-duplicate what should never have
    // been requested.
    if (since != null && (this.mark == null || since > this.mark)) this.mark = since;
    if (atmHint != null) this.atmHint = atmHint;
  }

  subscribe(listener: Listener, onGap?: () => void): () => void {
    this.listeners.add(listener);
    if (onGap) this.gapListeners.add(onGap);
    this.refs += 1;
    if (this.refs === 1) this.open();

    return () => {
      this.listeners.delete(listener);
      if (onGap) this.gapListeners.delete(onGap);
      this.refs -= 1;
      if (this.refs <= 0) this.close();
    };
  }

  private publish(next: Partial<LiveStraddleSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener(this.snapshot);
  }

  private open(): void {
    this.done = false;
    this.heard = Date.now();

    const socket = new LiveSocket<LiveStraddleFrame>(
      '/ws/live/straddle',
      parseLiveStraddleFrame,
    );
    this.socket = socket;

    socket.onFrame((frame) => this.onFrame(frame));
    socket.onState((s) => {
      if (this.done) return;
      if (s === 'connecting') {
        this.publish({ state: this.snapshot.state === 'idle' ? 'connecting' : 'reconnecting' });
      } else if (s === 'closed') {
        this.publish({ state: 'reconnecting' });
      }
    });

    /*
     * A FACTORY, not a payload — this is why `LiveSocket.subscribe` accepts one.
     *
     * Every reconnect must carry the newest mark so the backend replays only the
     * hole. A fixed payload would resubscribe with the mark from page load and
     * ask for the whole session again on every blip.
     */
    socket.subscribe(() => ({
      type: 'subscribe',
      ...this.contract,
      ...(this.atmHint != null ? { atmHint: this.atmHint } : {}),
      ...(this.mark != null ? { since: this.mark } : {}),
    }));
    socket.connect();

    this.flushTimer = window.setInterval(() => this.flush(), FLUSH_MS);
    this.watchdog = window.setInterval(() => this.check(), 30_000);
    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onVisible);
    window.addEventListener('focus', this.onVisible);
  }

  private onFrame(frame: LiveStraddleFrame): void {
    this.heard = Date.now();

    switch (frame.event) {
      case 'point':
        this.mark = frame.point.time;
        this.pending.points.push(frame.point);
        if (frame.roll) this.pending.rolls.push(frame.roll);
        if (this.snapshot.state !== 'live') this.publish({ state: 'live', status: 'Live' });
        break;

      case 'backfill':
        if (frame.points.length) {
          this.mark = frame.points[frame.points.length - 1].time;
          // Pushed as ordinary ticks — they ARE ticks, only late. The one pass
          // that aggregates history handles them with no special case.
          this.pending.points.push(...frame.points);
          this.pending.rolls.push(...frame.rolls);
          this.publish({
            status: `Recovered ${frame.points.length} point${frame.points.length === 1 ? '' : 's'}`,
          });
        }
        // Reported AFTER any partial replay, so a reload starts from the
        // furthest point actually known rather than the original mark.
        if (!frame.complete) for (const fn of this.gapListeners) fn();
        break;

      case 'status':
        if (frame.status === 'market-closed') {
          // A real end, not a drop — retrying would reconnect all day.
          this.done = true;
          this.publish({ state: 'closed', status: frame.message || 'Market closed' });
          this.socket?.close();
          return;
        }
        if (frame.status === 'stopped') { this.publish({ state: 'idle', status: '' }); return; }
        if (frame.status === 'resumed') { this.publish({ state: 'live', status: 'Live' }); return; }
        this.publish({ status: String(frame.message || frame.status).slice(0, 80) });
        break;

      case 'error':
        this.publish({ state: 'error', status: frame.message.slice(0, 120) });
        // An auth failure fails again on every retry, so retrying is a login
        // storm against the endpoint that just refused us.
        if (frame.code === 'FEED_AUTH_REQUIRED') {
          this.done = true;
          this.socket?.close();
        }
        break;

      case 'pong':
        break;   // liveness only; `heard` above is the whole point
    }
  }

  private flush(): void {
    if (!this.pending.points.length && !this.pending.rolls.length) return;
    const { points, rolls } = this.pending;
    this.pending = { points: [], rolls: [] };
    const merged = [...this.snapshot.points, ...points];
    this.publish({
      points: merged,
      rolls: rolls.length ? [...this.snapshot.rolls, ...rolls] : this.snapshot.rolls,
      last: merged[merged.length - 1] ?? this.snapshot.last,
    });
  }

  /**
   * `LiveSocket` reconnects on close, but a socket can be dead while claiming
   * OPEN — no close event ever arrives, and silence is the only symptom.
   */
  private check = (): void => {
    if (this.done || !this.socket) return;
    if (this.socket.state === 'open' && Date.now() - this.heard > SILENCE_MS) {
      this.publish({ status: 'Feed went quiet — reconnecting…' });
      this.heard = Date.now();
      this.socket.close();
      this.socket.connect();
    }
  };

  private onVisible = (): void => {
    if (document.visibilityState !== 'visible') return;
    this.check();
    // The socket may have stayed up while the page was frozen, in which case
    // frames were dropped with no close to show for it. Asking outright is cheap
    // and is the only way to find out.
    if (this.socket?.state === 'open' && this.mark != null) {
      this.socket.send({ type: 'resume', since: this.mark });
    }
  };

  private close(): void {
    if (this.flushTimer != null) window.clearInterval(this.flushTimer);
    if (this.watchdog != null) window.clearInterval(this.watchdog);
    this.flushTimer = this.watchdog = null;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onVisible);
    window.removeEventListener('focus', this.onVisible);
    this.socket?.send({ type: 'stop' });
    this.socket?.close();
    this.socket = null;
    sessions.delete(keyOf(this.contract));
  }
}

const sessions = new Map<string, LiveStraddleSession>();

function keyOf(c: Contract): string {
  return `${c.symbol}|${c.exchange}|${c.expiry}`;
}

interface Options extends Contract {
  /** Last ATM the caller knows, so the backend can subscribe depth before the
   *  first tick rather than after it. */
  atmHint?: number | null;
  /** Newest point the caller already holds, from the loaded session. */
  since?: number | null;
  enabled: boolean;
  /**
   * The feed reported a hole it cannot fill. Reload the session from history.
   *
   * The caller is expected to throttle its own reloads — a flapping connection
   * must not become a reload storm against an endpoint that takes seconds.
   */
  onGap?: () => void;
}

export function useLiveStraddle({
  symbol, exchange, expiry, atmHint, since, enabled, onGap,
}: Options): LiveStraddleSnapshot {
  const [snapshot, setSnapshot] = useState<LiveStraddleSnapshot>(EMPTY);

  const key = enabled && symbol && expiry ? keyOf({ symbol, exchange, expiry }) : '';

  useEffect(() => {
    if (!key) {
      setSnapshot(EMPTY);
      return;
    }

    let session = sessions.get(key);
    if (!session) {
      session = new LiveStraddleSession({ symbol, exchange, expiry });
      sessions.set(key, session);
    }
    // Seeded BEFORE subscribing: the first subscriber opens the socket, and the
    // subscribe frame has to carry the mark or the backend has nothing to
    // replay from.
    session.seed(since ?? null, atmHint ?? null);

    setSnapshot(session.current);
    return session.subscribe(setSnapshot, onGap);

    // `since`, `atmHint` and `onGap` are deliberately NOT dependencies. `since`
    // changes on every history reload and `onGap` is a fresh closure each
    // render; either in the deps would tear the socket down and re-handshake
    // precisely when the chart had just been refilled. The mark that matters
    // after the first connection is the one the session tracks from the frames
    // it has actually received.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return snapshot;
}
