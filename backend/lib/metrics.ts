/**
 * Prometheus metrics.
 *
 * ── What this is for ──
 *
 * The log says what happened once. Metrics say how often, how long, and how
 * that compares to an hour ago — which is the question actually being asked
 * when something feels wrong. "The chart is laggy" is not answerable from a log
 * at all; it is answerable from `qt_http_request_duration_seconds` and
 * `nodejs_eventloop_lag_seconds` side by side.
 *
 * The event loop lag is the single most important series here, and it is why
 * the default collector is on. This backend's whole Go migration exists because
 * a chain publishing hundreds of frames a second shares one thread with every
 * HTTP route; lag is the number that says whether that is still true.
 *
 * ── Cardinality is the one rule ──
 *
 * Every distinct combination of label values is a separate time series held in
 * memory, in the scraper, and forever in storage. A label like `symbol` looks
 * harmless until someone searches for a hundred underlyings; a label like
 * `expiry` or `strike` is unbounded by construction and would take the whole
 * monitoring stack down with it.
 *
 * So the labels used here are closed sets, and stay that way:
 *
 *   feed      nubra | angel | zerodha | kotak    (the registry, plus instances)
 *   route     a REGISTERED route, or 'unknown'   (never the raw path)
 *   exchange  NSE | BSE | MCX
 *   channel   quotes | straddle | orders | assistant
 *   engine    typescript | go
 *
 * If a new label is added, the question to answer first is what bounds it.
 *
 * ── Gauges are collected, not pushed ──
 *
 * Anything that is a STATE rather than an event — is this feed up, how many
 * sessions are running, how many rows are cached — is read at scrape time from
 * the thing that owns it, via a `collect()` callback. Pushing state means every
 * writer must remember to update the gauge on every path, and the one path that
 * forgets leaves a metric that is confidently wrong forever. Counters are the
 * opposite: those must be incremented at the event, because nothing retains a
 * count of things that already happened.
 */

import {
  Registry, Counter, Gauge, Histogram, collectDefaultMetrics,
} from 'prom-client';

/**
 * A private registry rather than the global default.
 *
 * The default registry is process-global and shared with any dependency that
 * decides to register something on it. Owning ours means `/metrics` reports
 * exactly what this file declares, and a duplicate-name crash from a library is
 * not possible.
 */
export const registry = new Registry();

registry.setDefaultLabels({ service: 'qt-backend' });

/**
 * Node runtime metrics: heap, GC pauses, handles, and the event loop lag.
 *
 * `nodejs_eventloop_lag_p99_seconds` is the one to alert on. Sustained lag
 * above a few tens of milliseconds means synchronous work is starving the
 * socket handlers, and every price on the screen is late by that much.
 */
// No `prefix` option: prom-client already names these `nodejs_*` and
// `process_*`, and adding one produces `nodejs_nodejs_eventloop_lag_seconds` —
// which no off-the-shelf Node dashboard or alert rule will match.
collectDefaultMetrics({ register: registry });

const PREFIX = 'qt_';

// ── HTTP ─────────────────────────────────────────────────────────────────────

export const httpRequests = new Counter({
  name: `${PREFIX}http_requests_total`,
  help: 'HTTP requests served, by route and outcome.',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

/**
 * Buckets chosen for what this backend actually serves, not the library
 * default.
 *
 * The default ladder tops out at 10s, which puts every straddle history request
 * — a 22k-bar session walk — in the same bucket as a timeout. These span the
 * three populations that exist here: a cached read (single-digit ms), a live
 * chain query (hundreds of ms), and a full session compute (seconds).
 */
export const httpDuration = new Histogram({
  name: `${PREFIX}http_request_duration_seconds`,
  help: 'Wall time from request received to response written.',
  labelNames: ['method', 'route'] as const,
  buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const httpInFlight = new Gauge({
  name: `${PREFIX}http_requests_in_flight`,
  help: 'Requests currently being served.',
  registers: [registry],
});

// ── Feeds ────────────────────────────────────────────────────────────────────

export const feedLogins = new Counter({
  name: `${PREFIX}feed_logins_total`,
  help: 'Broker login attempts, by outcome.',
  labelNames: ['feed', 'outcome'] as const,
  registers: [registry],
});

export const feedFailures = new Counter({
  name: `${PREFIX}feed_failures_total`,
  help: 'Requests a feed could not serve, by classified fault code.',
  labelNames: ['feed', 'code'] as const,
  registers: [registry],
});

/**
 * Failovers, labelled by where the subscription went and why.
 *
 * `from` is deliberately included and is deliberately allowed to be 'none' —
 * the first subscription of a session has no predecessor, and folding that into
 * the same series as a real switch would make every restart look like an
 * outage.
 */
export const feedFailovers = new Counter({
  name: `${PREFIX}feed_failovers_total`,
  help: 'Live subscription moved from one feed to another.',
  labelNames: ['from', 'to', 'reason'] as const,
  registers: [registry],
});

export const feedTicks = new Counter({
  name: `${PREFIX}feed_ticks_total`,
  help: 'Ticks received from a feed and dispatched to subscribers.',
  labelNames: ['feed'] as const,
  registers: [registry],
});

/**
 * Ticks dropped by de-duplication, which is not an error.
 *
 * Two feeds briefly overlapping during a failover is the design working, and
 * this series is how that window is measured. A rate that stays high after a
 * switch settles means the overlap is not being torn down.
 */
export const feedTicksDeduped = new Counter({
  name: `${PREFIX}feed_ticks_deduped_total`,
  help: 'Duplicate ticks suppressed during a feed overlap.',
  registers: [registry],
});

// ── WebSocket channels ───────────────────────────────────────────────────────

export const wsConnections = new Gauge({
  name: `${PREFIX}ws_connections`,
  help: 'Open WebSocket connections, by channel.',
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const wsMessages = new Counter({
  name: `${PREFIX}ws_messages_total`,
  help: 'WebSocket frames, by channel and direction.',
  labelNames: ['channel', 'direction'] as const,
  registers: [registry],
});

// ── Live straddle engine ─────────────────────────────────────────────────────

export const liveSessions = new Gauge({
  name: `${PREFIX}live_sessions`,
  help: 'Live straddle sessions running, by which engine is computing them.',
  labelNames: ['engine'] as const,
  registers: [registry],
});

export const straddlePoints = new Counter({
  name: `${PREFIX}straddle_points_total`,
  help: 'Computed straddle points emitted to clients.',
  labelNames: ['engine'] as const,
  registers: [registry],
});

export const straddleRolls = new Counter({
  name: `${PREFIX}straddle_rolls_total`,
  help: 'Rolls — the held strike changed between two points.',
  labelNames: ['engine'] as const,
  registers: [registry],
});

/**
 * How a point got its implied vol.
 *
 * Not a performance metric: it is a data-quality one. A sudden shift from
 * `feed` to `black76` means the broker's greeks stream went quiet, which the
 * chart cannot show and nobody would otherwise notice — the line keeps moving,
 * it is just being modelled rather than observed.
 */
export const ivSource = new Counter({
  name: `${PREFIX}straddle_iv_source_total`,
  help: 'Where each point\'s implied vol came from.',
  labelNames: ['source'] as const,
  registers: [registry],
});

// ── Instrument cache ─────────────────────────────────────────────────────────

export const refdataFetches = new Counter({
  name: `${PREFIX}refdata_fetches_total`,
  help: 'Instrument master downloads, by outcome.',
  labelNames: ['exchange', 'outcome'] as const,
  registers: [registry],
});

export const refdataDuration = new Histogram({
  name: `${PREFIX}refdata_fetch_duration_seconds`,
  help: 'Time to download and parse one exchange\'s instrument master.',
  labelNames: ['exchange'] as const,
  // A cold NSE master is tens of megabytes and legitimately takes tens of
  // seconds, so the ladder runs much further out than the HTTP one.
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  registers: [registry],
});

// ── Caches ───────────────────────────────────────────────────────────────────

export const cacheAccess = new Counter({
  name: `${PREFIX}cache_access_total`,
  help: 'Cache reads, by cache and outcome.',
  labelNames: ['cache', 'outcome'] as const,
  registers: [registry],
});

// ── The Go processes, as seen from Node ──────────────────────────────────────

/**
 * Calls into the Go sidecar, measured from THIS side.
 *
 * marketd and computed publish their own metrics, and those are the truth about
 * what they did. This series is the truth about what Node experienced, which is
 * a different number: it includes the loopback, the JSON encode of a 22k-bar
 * batch, and the decode of the response. When the two disagree, the difference
 * is the cost of the boundary — and that is exactly the number that decides
 * whether more should move across it.
 */
export const computeRequests = new Counter({
  name: `${PREFIX}compute_requests_total`,
  help: 'Requests to the Go compute sidecar, by endpoint and outcome.',
  labelNames: ['endpoint', 'outcome'] as const,
  registers: [registry],
});

export const computeDuration = new Histogram({
  name: `${PREFIX}compute_request_duration_seconds`,
  help: 'Round trip to the Go compute sidecar, as measured by Node.',
  labelNames: ['endpoint'] as const,
  buckets: [0.001, 0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const computeBars = new Counter({
  name: `${PREFIX}compute_bars_total`,
  help: 'Bars sent for solving, and how many came back with a vol.',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

/**
 * Give the closed label sets a zero before anything happens.
 *
 * A labelled metric does not exist until it is first written, so a freshly
 * started backend exposes no `qt_ws_connections` at all — and a dashboard panel
 * reading it shows "No data", which looks identical to a broken scrape. Worse,
 * `rate()` over a counter that appears mid-window treats its first value as a
 * reset and reports a spike that never happened.
 *
 * Only safe for label sets that are genuinely fixed and small. This is why the
 * label rule at the top of the file matters: `feed` is not pre-seeded here,
 * because the registry is configured at runtime.
 */
const CHANNELS = ['quotes', 'straddle', 'orders', 'assistant'] as const;
const ENGINES = ['typescript', 'go'] as const;

for (const channel of CHANNELS) {
  wsConnections.set({ channel }, 0);
  for (const direction of ['in', 'out'] as const) {
    wsMessages.inc({ channel, direction }, 0);
  }
}
for (const engine of ENGINES) {
  liveSessions.set({ engine }, 0);
  straddlePoints.inc({ engine }, 0);
  straddleRolls.inc({ engine }, 0);
}

// ── Collected gauges ─────────────────────────────────────────────────────────

/**
 * State read at scrape time from whoever owns it.
 *
 * Registered through a function rather than at module load because these reach
 * into the feed registry and the instrument cache, and importing those here at
 * import time would make this module part of a cycle: the feed code logs, the
 * logger is fine, but the feed code also wants to increment counters from this
 * file. `installCollectors()` is called once from main.ts, after everything is
 * loaded.
 */
let installed = false;

export function installCollectors(sources: {
  feeds: () => Array<{ id: string; priority: number }>;
  breakerState: (id: string) => 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  isConnected: (id: string) => boolean;
  cacheStats: () => { cached: number; entries: Array<{ key: string; rows: number; assets: number }> };
}): void {
  if (installed) return;
  installed = true;

  /**
   * 1 when the feed holds a usable session, 0 when it does not.
   *
   * The classic `up`-style series, and the one an alert should fire on. It is
   * NOT the same as the breaker being closed: a feed can be logged in and still
   * be parked because its last three requests failed.
   */
  new Gauge({
    name: `${PREFIX}feed_up`,
    help: 'Feed holds a live authenticated session.',
    labelNames: ['feed'] as const,
    registers: [registry],
    collect() {
      for (const { id } of sources.feeds()) {
        this.set({ feed: id }, sources.isConnected(id) ? 1 : 0);
      }
    },
  });

  /**
   * Breaker position as a number, because Prometheus has no enums.
   *
   * 0 closed, 1 half-open, 2 open — ordered so that "greater than zero" means
   * "not serving normally" and a single threshold covers both bad states.
   */
  new Gauge({
    name: `${PREFIX}feed_breaker_state`,
    help: 'Circuit breaker: 0 closed, 1 half-open, 2 open.',
    labelNames: ['feed'] as const,
    registers: [registry],
    collect() {
      const rank = { CLOSED: 0, HALF_OPEN: 1, OPEN: 2 } as const;
      for (const { id } of sources.feeds()) {
        this.set({ feed: id }, rank[sources.breakerState(id)]);
      }
    },
  });

  new Gauge({
    name: `${PREFIX}feed_priority`,
    help: 'Configured failover order; lower is preferred.',
    labelNames: ['feed'] as const,
    registers: [registry],
    collect() {
      for (const { id, priority } of sources.feeds()) {
        this.set({ feed: id }, priority);
      }
    },
  });

  new Gauge({
    name: `${PREFIX}instrument_rows`,
    help: 'Instrument master rows resident in memory, by exchange and date slot.',
    labelNames: ['slot'] as const,
    registers: [registry],
    collect() {
      // The slot key is `EXCHANGE|DATE`. Bounded by MAX_RESIDENT_SLOTS, which is
      // what makes it safe as a label — an unbounded date label would otherwise
      // be exactly the mistake this file warns about.
      for (const entry of sources.cacheStats().entries) {
        this.set({ slot: entry.key }, entry.rows);
      }
    },
  });

  new Gauge({
    name: `${PREFIX}instrument_slots_resident`,
    help: 'Instrument master slots held in the memory cache.',
    registers: [registry],
    collect() {
      this.set(sources.cacheStats().cached);
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Time an async operation into a histogram, whatever its outcome.
 *
 * A failure that is not timed is a hole in the latency series precisely when
 * latency is interesting — a broker timing out at 30s is the slowest thing that
 * happens all day, and excluding it makes the p99 look healthy.
 */
export async function observe<T>(
  histogram: Histogram<string>,
  labels: Record<string, string>,
  fn: () => Promise<T>,
): Promise<T> {
  const end = histogram.startTimer(labels);
  try {
    return await fn();
  } finally {
    end();
  }
}

/** The exposition text, for the /metrics route. */
export async function scrape(): Promise<string> {
  return registry.metrics();
}

export function contentType(): string {
  return registry.contentType;
}
