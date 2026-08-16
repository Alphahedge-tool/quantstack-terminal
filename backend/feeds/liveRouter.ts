/**
 * One live tick channel, any broker behind it.
 *
 * `MarketDataFeed.subscribe()` is per-adapter: Angel's SmartStream V2, Kotak's
 * HSM binary socket, Zerodha's Kite ticker and Upstox's protobuf feed each speak
 * a different protocol and each hand back a different token space. This router
 * is the single seam that hides all of that. Consumers say:
 *
 *      const stop = liveRouter.subscribe(keys, onTick)
 *
 * and never learn which broker answered — or that it changed mid-session.
 *
 * ── Why switching needs its own machinery ──
 *
 * Failing over a REST call is easy: the request is over in 300 ms and you retry
 * it elsewhere. A subscription is a standing relationship. Switching one means
 * re-establishing N symbols on a different broker, in a different token space,
 * without the consumer seeing a gap or a duplicate — and the token space is the
 * hard part. Angel's `43215` means nothing to Zerodha. What survives the switch
 * is the canonical symbol (instruments/symbol.ts), which every adapter resolves
 * against its own master. That is why `subscribe()` takes InstrumentKeys and
 * nothing else.
 *
 * ── Make-before-break ──
 *
 * A switch subscribes on the NEW feed before tearing down the old one, so the
 * two overlap for a moment rather than leaving a hole. Overlap is the safe
 * failure: `dedupe` drops the repeated ticks, whereas a gap silently puts a flat
 * segment in the middle of a chart and nothing downstream can tell it happened.
 */

import type { InstrumentKey } from './identity.js';
import { keyOf } from './identity.js';
import type { MarketDataFeed, Tick, FeedId } from './types.js';
import { feeds, feedById } from './registry.js';
import { ensureConnected } from './authManager.js';
import { stateOf } from './breaker.js';
import { instruments } from '../instruments/store.js';
import { symbolOf, segmentOf } from '../instruments/symbol.js';

/** How long the old feed keeps running after a switch, for overlap. */
const OVERLAP_MS = Number(process.env.QT_LIVE_OVERLAP_MS || 3_000);

/**
 * A tick is a duplicate if the same instrument reports the same timestamp twice
 * during the overlap window. Feeds stamp to the millisecond, so this is exact
 * rather than a tolerance.
 */
const DEDUPE_WINDOW_MS = OVERLAP_MS + 2_000;

export type TickHandler = (tick: Tick) => void;

/** Why the active feed changed. Surfaced to the UI so a switch is never silent. */
export type SwitchReason =
  | 'initial'
  | 'unhealthy'      // breaker opened or connect failed
  | 'no-coverage'    // active feed's master has no row for a requested contract
  | 'manual';        // an operator pinned a different feed

export interface SwitchEvent {
  from:   FeedId | null;
  to:     FeedId;
  reason: SwitchReason;
  /** Contracts that survived the move. */
  keys:   number;
  at:     number;
}

interface Subscription {
  keys:    InstrumentKey[];
  handler: TickHandler;
}

// ── Candidate selection ──────────────────────────────────────────────────────

/**
 * Can this feed actually carry every one of these contracts?
 *
 * Two independent gates, and both matter. `capabilities.live` says the adapter
 * implements a socket at all; the canonical table says this particular broker
 * lists these particular contracts. A broker can pass the first and fail the
 * second — Zerodha carries no MCX options, so switching an MCX straddle to it
 * would connect happily and then deliver nothing.
 */
function covers(feed: MarketDataFeed, broker: string, keys: InstrumentKey[]): boolean {
  if (!feed.capabilities.live || typeof feed.subscribe !== 'function') return false;
  // No master loaded for this broker means we cannot prove coverage. Treat that
  // as "cannot serve" rather than optimistically switching into a black hole.
  if (!instruments.has(broker)) return false;
  return keys.every((k) => instruments.resolve(broker, symbolOf(k), segmentOf(k.exchange, k.kind)) != null);
}

export class LiveRouter {
  /** Every consumer subscription, by handle id. */
  private readonly subs = new Map<number, Subscription>();
  private nextId = 1;

  /** The feed currently carrying ticks, and its teardown. */
  private active: { feed: MarketDataFeed; broker: string; stop: () => void } | null = null;

  /**
   * The contract set the active subscription was opened with.
   *
   * Compared before re-subscribing, because on every adapter `subscribe()` means
   * "tear the socket down and open a new one". Without this, a consumer joining
   * or leaving with the SAME contracts rebuilds the broker socket for no reason
   * — and on Angel, rapid rebuilds are what earn a `socket hang up` and a
   * throttle, so the churn is self-reinforcing.
   */
  private activeKeySig = '';

  /** Feeds we have decided not to use, and until when. */
  private readonly parked = new Map<FeedId, number>();

  /** Operator pin — set by POST /api/feeds/live/pin. Overrides priority order. */
  private pinned: FeedId | null = null;

  private readonly recentTicks = new Map<string, number>();
  private readonly switches: SwitchEvent[] = [];

  private resubscribing: Promise<void> | null = null;

  // ── public API ─────────────────────────────────────────────────────────────

  /**
   * Start receiving ticks for `keys`. Returns an unsubscribe function.
   *
   * The returned function is idempotent — calling it twice is not an error, so a
   * consumer with both a cleanup path and an error path does not have to guard.
   */
  subscribe(keys: InstrumentKey[], handler: TickHandler): () => void {
    const id = this.nextId++;
    this.subs.set(id, { keys: [...keys], handler });
    void this.reconcile('initial');

    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subs.delete(id);
      if (this.subs.size === 0) this.teardown();
      else void this.reconcile('initial');
    };
  }

  /** Every contract any consumer currently wants, de-duplicated. */
  private wantedKeys(): InstrumentKey[] {
    const seen = new Map<string, InstrumentKey>();
    for (const sub of this.subs.values()) {
      for (const k of sub.keys) seen.set(keyOf(k), k);
    }
    return [...seen.values()];
  }

  /**
   * Pick the best feed for the current key set.
   *
   * Order: the operator's pin, then registry priority. A feed is skipped when
   * its breaker is open, when it is parked after a recent failure, or when the
   * canonical table says it cannot carry every requested contract.
   */
  private choose(keys: InstrumentKey[]): { feed: MarketDataFeed; broker: string } | null {
    const now = Date.now();
    const registered = feeds();

    if (this.pinned) {
      const hit = registered.find((r) => r.feed.id === this.pinned);
      // A pin is an instruction, not a suggestion: honour it even if coverage is
      // partial, but not if the adapter has no socket at all.
      if (hit && hit.feed.capabilities.live && typeof hit.feed.subscribe === 'function') {
        return { feed: hit.feed, broker: hit.broker };
      }
    }

    for (const { feed, broker } of registered) {
      if (stateOf(feed.id) === 'OPEN') continue;
      const until = this.parked.get(feed.id);
      if (until && until > now) continue;
      if (!covers(feed, broker, keys)) continue;
      return { feed, broker };
    }
    return null;
  }

  /**
   * Bring the active feed in line with what consumers want.
   *
   * Single-flighted: subscription churn (a chart adding strikes one at a time)
   * would otherwise open several sockets to the same broker in parallel.
   */
  private async reconcile(reason: SwitchReason): Promise<void> {
    if (this.resubscribing) return this.resubscribing;
    this.resubscribing = this.reconcileOnce(reason)
      .catch((err) => console.error(`[live] reconcile failed: ${(err as Error).message}`))
      .finally(() => { this.resubscribing = null; });
    return this.resubscribing;
  }

  private async reconcileOnce(reason: SwitchReason): Promise<void> {
    const keys = this.wantedKeys();
    if (!keys.length) { this.teardown(); return; }

    const choice = this.choose(keys);
    if (!choice) {
      console.warn(`[live] no feed can carry ${keys.length} contract(s) — ticks paused`);
      this.teardown();
      return;
    }

    // Already on the right feed: re-subscribe in place so newly added contracts
    // are picked up, but do not count it as a switch.
    const sameFeed = this.active?.feed.id === choice.feed.id;

    // …and if the contracts are identical too, there is nothing to do. This is
    // the common case by far: a second panel mounting, a component remounting,
    // or a consumer leaving while others still want the same instruments.
    // Re-subscribing there would drop a healthy socket and open another one
    // carrying exactly the same tokens.
    const sig = keys.map(keyOf).sort().join('|');
    if (sameFeed && this.active && sig === this.activeKeySig) return;

    let stop: () => void;
    try {
      await ensureConnected(choice.feed);
      stop = choice.feed.subscribe!(keys, (tick) => this.dispatch(tick));
    } catch (err) {
      // This feed cannot take the subscription. Park it briefly so the next
      // candidate is tried instead of retrying the same failure immediately.
      console.warn(`[live] ${choice.feed.id} subscribe failed: ${(err as Error).message}`);
      this.parked.set(choice.feed.id, Date.now() + 60_000);
      if (this.parked.size >= feeds().length) {
        console.error('[live] every feed parked — ticks paused until one recovers');
        return;
      }
      return this.reconcileOnce('unhealthy');
    }

    const previous = this.active;
    this.active = { feed: choice.feed, broker: choice.broker, stop };
    this.activeKeySig = sig;

    if (previous) {
      // Make-before-break: let the old socket run a moment so the handover has
      // overlap rather than a gap. Duplicates are filtered in dispatch().
      const old = previous;
      setTimeout(() => { try { old.stop(); } catch { /* already gone */ } }, sameFeed ? 0 : OVERLAP_MS);
    }

    if (!sameFeed) {
      const event: SwitchEvent = {
        from: previous?.feed.id ?? null,
        to:   choice.feed.id,
        reason: previous ? reason : 'initial',
        keys: keys.length,
        at:   Date.now(),
      };
      this.switches.push(event);
      if (this.switches.length > 50) this.switches.shift();
      console.log(
        `[live] ${event.from ?? '(none)'} → ${event.to} (${event.reason}, ${event.keys} contracts)`,
      );
    }
  }

  /**
   * Fan one tick out to every consumer that asked for that instrument.
   *
   * Ticks are dropped rather than broadcast to everyone: a straddle chart and a
   * position panel can be subscribed at once, and sending each the other's
   * contracts would have them silently plotting instruments they never asked for.
   */
  private dispatch(tick: Tick): void {
    const id = keyOf(tick.key);

    // Overlap de-duplication. Only active while two feeds are running, but the
    // map is cheap enough to keep unconditionally.
    const dedupeKey = `${id}@${tick.ts}`;
    const now = Date.now();
    if (this.recentTicks.has(dedupeKey)) return;
    this.recentTicks.set(dedupeKey, now);
    if (this.recentTicks.size > 4_000) {
      for (const [k, at] of this.recentTicks) {
        if (now - at > DEDUPE_WINDOW_MS) this.recentTicks.delete(k);
      }
    }

    for (const sub of this.subs.values()) {
      if (!sub.keys.some((k) => keyOf(k) === id)) continue;
      try {
        sub.handler(tick);
      } catch (err) {
        // One bad consumer must not kill the fan-out for the others.
        console.error(`[live] subscriber threw: ${(err as Error).message}`);
      }
    }
  }

  private teardown(): void {
    if (!this.active) return;
    try { this.active.stop(); } catch { /* already gone */ }
    this.active = null;
    // Must be cleared with `active`, or the next subscribe would compare against
    // a signature whose socket no longer exists and skip opening one.
    this.activeKeySig = '';
    this.recentTicks.clear();
  }

  // ── control plane ──────────────────────────────────────────────────────────

  /**
   * Force a move to another feed, or clear a pin with `null`.
   *
   * Exists because "which broker am I looking at?" must be answerable AND
   * settable: when two feeds price the same straddle differently, being able to
   * hold one of them still is what makes the difference investigable.
   */
  async pin(id: FeedId | null): Promise<void> {
    if (id && !feedById(id)) throw new Error(`Unknown feed: ${id}`);
    this.pinned = id;
    this.parked.clear();
    await this.reconcile('manual');
  }

  /** Drop the current feed and pick again — for a broker that has gone quiet. */
  async rotate(reason: SwitchReason = 'unhealthy'): Promise<void> {
    if (this.active) this.parked.set(this.active.feed.id, Date.now() + 60_000);
    await this.reconcile(reason);
  }

  status() {
    return {
      serving:     this.active?.feed.id ?? null,
      broker:      this.active?.broker ?? null,
      pinned:      this.pinned,
      subscribers: this.subs.size,
      contracts:   this.wantedKeys().length,
      parked:      [...this.parked.entries()]
        .filter(([, until]) => until > Date.now())
        .map(([id, until]) => ({ id, until })),
      switches:    this.switches.slice(-10),
    };
  }
}

/** Process-wide live channel. */
export const liveRouter = new LiveRouter();
