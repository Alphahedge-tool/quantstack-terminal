/**
 * Reconnecting WebSocket for the backend's `/ws/live/*` channels.
 *
 * The quote socket's protocol (backend/live/wsQuotes.ts) is JSON both ways,
 * one message per frame:
 *
 *   → { type: 'subscribe', keys: InstrumentKey[] }
 *   → { type: 'ping' }
 *   ← { event: 'quotes', quotes: [{ symbol, ltp, bid?, ask?, iv?, ts }] }
 *   ← { event: 'status', carrying, broker? }
 *   ← { event: 'pong', t }
 *
 * ── Why a class and not a hook ──
 *
 * The connection must outlive any one component. A hook that opened the socket
 * would tear it down whenever the subscribing page unmounted, so navigating
 * from Positions to Orders would drop the tape and re-handshake — losing the
 * subscription set and several seconds of prices each time. The connection
 * lives here; components attach and detach listeners.
 */

export type SocketState = 'connecting' | 'open' | 'closed';

interface Listener<T> {
  (frame: T): void;
}

/** Backoff schedule, in ms. Caps rather than growing without bound: a backend
 *  restart should be picked up within a few seconds, not after a minute. */
const BACKOFF = [500, 1000, 2000, 4000, 8000, 8000];

const PING_INTERVAL = 15_000;

export class LiveSocket<TFrame> {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private pingTimer: number | null = null;
  private retryTimer: number | null = null;
  private closedByUs = false;

  private frameListeners = new Set<Listener<TFrame>>();
  private stateListeners = new Set<Listener<SocketState>>();

  private _state: SocketState = 'closed';

  /**
   * The last subscribe payload sent. Replayed on every reconnect — the server
   * holds subscriptions per-connection, so a silent reconnect that did not
   * replay would leave the UI connected and permanently priceless.
   */
  private subscription: unknown = null;

  constructor(
    private readonly path: string,
    private readonly parse: (raw: unknown) => TFrame | null,
  ) {}

  get state(): SocketState {
    return this._state;
  }

  private setState(next: SocketState): void {
    if (this._state === next) return;
    this._state = next;
    for (const listener of this.stateListeners) listener(next);
  }

  private url(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.path}`;
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUs = false;
    this.setState('connecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.setState('open');
      if (this.subscription !== null) this.send(this.subscription);
      this.startPing();
    };

    socket.onmessage = (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        return; // A malformed frame is not worth dropping the tape over.
      }
      // parse() returns null for frames this channel does not model. Ignoring
      // them is required, not lenient: the server is free to add event types,
      // and throwing here would kill a live connection over a frame we skip.
      const frame = this.parse(raw);
      if (frame === null) return;
      for (const listener of this.frameListeners) listener(frame);
    };

    socket.onerror = () => {
      // `onclose` always follows; recovery is handled there so it lives in one
      // place rather than racing two handlers to reconnect.
    };

    socket.onclose = () => {
      this.stopPing();
      this.ws = null;
      this.setState('closed');
      if (!this.closedByUs) this.scheduleRetry();
    };
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null) return;
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)];
    this.attempt += 1;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  send(payload: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  /** Replace the subscription set. Remembered so a reconnect can replay it. */
  subscribe(payload: unknown): void {
    this.subscription = payload;
    this.send(payload);
  }

  onFrame(listener: Listener<TFrame>): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onState(listener: Listener<SocketState>): () => void {
    this.stateListeners.add(listener);
    listener(this._state);
    return () => this.stateListeners.delete(listener);
  }

  close(): void {
    this.closedByUs = true;
    this.stopPing();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setState('closed');
  }
}
