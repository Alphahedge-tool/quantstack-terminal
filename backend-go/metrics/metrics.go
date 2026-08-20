// Package metrics is the Prometheus surface for both Go binaries.
//
// ── Why the Go side needs its own, when Node already has one ──
//
// Node measures what it EXPERIENCED — a round trip that includes the loopback,
// the encode of a 22k-bar batch and the decode of the reply. This process
// measures what it DID. When the two disagree, the difference is the cost of
// the process boundary, and that number is what decides whether more of the hot
// path should move across it. One set of metrics could not answer that; two
// can.
//
// The other half is that marketd owns state Node cannot see at all: which
// broker is currently serving, how many frames a second the socket is really
// carrying, how often the Python bridge has been restarted. None of that
// reaches Node except as points, which is exactly the signal that stays healthy
// while everything behind it degrades.
//
// ── Cardinality ──
//
// Same rule as the Node side, and it matters more here because this process
// sees individual contracts. Nothing is ever labelled by strike, expiry or
// refId. The labels used are closed sets:
//
//	feed      nubra | scripted | (a future broker)
//	channel   option | orderbook | greeks | ohlcv | index
//	exchange  NSE | BSE | MCX
//	outcome   a small fixed vocabulary per metric
package metrics

import (
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

// Registry is private rather than prometheus.DefaultRegisterer, so /metrics
// reports exactly what this package declares and a dependency cannot register
// a colliding name into it.
var Registry = prometheus.NewRegistry()

func init() {
	// Go runtime metrics: goroutines, heap, GC pause quantiles, thread count.
	//
	// `go_goroutines` is the one to watch here. Every live session owns a
	// handful — the engine loop, the router, the source, the stderr drain — and
	// a count that climbs without sessions climbing means one of them is not
	// being cancelled, which is the failure mode a long-running feed process has
	// most of.
	Registry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
}

// ── Feed ingestion ───────────────────────────────────────────────────────────

var (
	// Frames is the pulse of the whole process. A rate that goes to zero while
	// the source still reports itself connected is precisely the silent-failure
	// case the watchdog exists for — and this series is how it is seen from
	// outside.
	Frames = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_feed_frames_total",
		Help: "Market data frames received from a source, by channel.",
	}, []string{"feed", "channel"})

	// FramesDropped counts frames the consumer could not keep up with.
	//
	// Non-zero is not automatically bad: dropping is deliberate, so that a slow
	// consumer cannot stop the socket draining and take the subscription down
	// with it. A sustained rate means the engine loop is behind, which is a
	// different and worse problem than a burst.
	FramesDropped = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_feed_frames_dropped_total",
		Help: "Frames discarded because the consumer was not keeping up.",
	}, []string{"feed"})

	// Restarts counts source restarts, including watchdog kills.
	//
	// Read together with Frames: rising restarts WITH frames flowing is a broker
	// cycling connections, which is normal. Rising restarts with no frames is a
	// setup problem — no Python, no SDK, a token that is not accepted.
	Restarts = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_feed_restarts_total",
		Help: "Source subscriptions torn down and reopened, by reason.",
	}, []string{"feed", "reason"})

	Failovers = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_feed_failovers_total",
		Help: "Router moved a subscription from one source to another.",
	}, []string{"from", "to"})

	// BreakerOpen is a gauge rather than a counter because it is a STATE: the
	// question is "is this feed parked right now", not "how often has it been".
	BreakerOpen = factory().NewGaugeVec(prometheus.GaugeOpts{
		Name: "qt_feed_breaker_open",
		Help: "1 when a feed is parked by its breaker, 0 when it may be tried.",
	}, []string{"feed"})

	// Active marks which source is serving. Exactly one series should be 1.
	Active = factory().NewGaugeVec(prometheus.GaugeOpts{
		Name: "qt_feed_active",
		Help: "1 for the source currently serving a subscription.",
	}, []string{"feed"})
)

// ── The straddle engine ──────────────────────────────────────────────────────

var (
	Points = factory().NewCounter(prometheus.CounterOpts{
		Name: "qt_engine_points_total",
		Help: "Straddle points computed.",
	})

	Rolls = factory().NewCounter(prometheus.CounterOpts{
		Name: "qt_engine_rolls_total",
		Help: "Points where the held strike changed.",
	})

	// ComputeDuration is the cost of one pass of the selection rule: reading
	// every leg in the band, pricing it, solving a vol and deriving greeks.
	//
	// Buckets are tight and small on purpose. This runs on the engine's only
	// goroutine, once per throttle window (250ms by default), so anything past
	// a few milliseconds is eating into the budget for the next tick — and the
	// default Prometheus ladder starts at 5ms, which would put every healthy
	// pass in one bucket and show nothing at all.
	ComputeDuration = factory().NewHistogram(prometheus.HistogramOpts{
		Name:    "qt_engine_compute_duration_seconds",
		Help:    "Time for one pass of the rolling-straddle selection rule.",
		Buckets: []float64{0.00005, 0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.05},
	})

	// IVSource is a data-quality series, not a performance one. A shift from
	// `feed` to `black76` means the broker's greeks stream went quiet: the IV
	// line keeps moving, it is just being modelled rather than observed, and
	// nothing on the chart says so.
	IVSource = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_engine_iv_source_total",
		Help: "Where each point's implied vol came from.",
	}, []string{"source"})

	// Skips counts throttle windows that produced no point, by why.
	//
	// The engine going quiet is normally correct — no spot yet, nothing in the
	// band two-sided — and this is what tells those apart from a bug without
	// turning on debug logging in production.
	Skips = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_engine_skips_total",
		Help: "Compute passes that produced no point, by reason.",
	}, []string{"reason"})

	Rearms = factory().NewCounter(prometheus.CounterOpts{
		Name: "qt_engine_rearms_total",
		Help: "Subscriptions re-centred because the ATM drifted out of the window.",
	})

	// MarketOpen lets every other series be read in context. A tick rate of zero
	// at 03:00 is the market being shut, not an outage, and an alert that cannot
	// tell the difference gets muted within a week.
	MarketOpen = factory().NewGaugeVec(prometheus.GaugeOpts{
		Name: "qt_market_open",
		Help: "1 while an exchange is inside its trading window.",
	}, []string{"exchange"})
)

// ── The hub ──────────────────────────────────────────────────────────────────

var (
	// SubscriberDrops counts clients disconnected for not draining their queue.
	//
	// One is a laptop that went to sleep. A rate is a signal that the fan-out is
	// producing faster than a browser can render, which shows up to the user as
	// a chart that freezes and then jumps.
	SubscriberDrops = factory().NewCounter(prometheus.CounterOpts{
		Name: "qt_hub_subscriber_drops_total",
		Help: "Subscribers dropped for not keeping up with the fan-out.",
	})

	SessionsStarted = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_hub_sessions_started_total",
		Help: "Sessions opened, by outcome.",
	}, []string{"outcome"})
)

// RegisterHub publishes session and subscriber counts read at SCRAPE time from
// the hub itself.
//
// Collected rather than incremented, for the reason the package comment gives:
// these are states, not events. A session can end through four paths — a grace
// expiry, an engine that returned, a shutdown, a client that stopped — and the
// one path that forgot to decrement would leave the gauge confidently wrong for
// the life of the process. Asking the hub what it currently holds cannot drift.
//
// Called once, from whichever binary owns a hub. `computed` has none and
// therefore publishes neither series, which is correct: a metric that is always
// zero is worse than an absent one, because it looks like an answer.
func RegisterHub(sessions, subscribers func() float64) {
	Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "qt_hub_sessions",
		Help: "Live sessions running; each one is one broker subscription.",
	}, sessions))
	Registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{
		Name: "qt_hub_subscribers",
		Help: "Clients attached across all sessions.",
	}, subscribers))
}

// ── The batch solver ─────────────────────────────────────────────────────────

var (
	SolveDuration = factory().NewHistogram(prometheus.HistogramOpts{
		Name: "qt_solve_duration_seconds",
		Help: "Time to solve one whole batch of bars.",
		// A session walk is ~22k bars across every core; a live single-bar call
		// is microseconds. Both populations are real and the ladder must show
		// them apart.
		Buckets: []float64{0.0001, 0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5},
	})

	// SolveBars separates a bar with no solution from a bar that failed.
	//
	// `unsolved` is not an error: a straddle printing below |F − K| is an
	// arbitrage with no implied vol at all, and the honest answer is null. But a
	// RATIO that moves means the quotes changed character, and that is only
	// visible with both numbers.
	SolveBars = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_solve_bars_total",
		Help: "Bars submitted for inversion, by outcome.",
	}, []string{"outcome"})
)

// ── HTTP ─────────────────────────────────────────────────────────────────────

var (
	httpRequests = factory().NewCounterVec(prometheus.CounterOpts{
		Name: "qt_go_http_requests_total",
		Help: "HTTP requests served by this process.",
	}, []string{"path", "status"})

	httpDuration = factory().NewHistogramVec(prometheus.HistogramOpts{
		Name:    "qt_go_http_request_duration_seconds",
		Help:    "Wall time to serve one HTTP request.",
		Buckets: []float64{0.0005, 0.005, 0.025, 0.1, 0.5, 1, 2.5, 5, 10, 30},
	}, []string{"path"})
)

// ── Registration plumbing ────────────────────────────────────────────────────

// factory wraps the registry so every declaration above registers itself and
// panics on a duplicate name at startup rather than silently shadowing.
func factory() promauto {
	return promauto{Registry}
}

type promauto struct{ r prometheus.Registerer }

func (p promauto) NewCounter(o prometheus.CounterOpts) prometheus.Counter {
	c := prometheus.NewCounter(o)
	p.r.MustRegister(c)
	return c
}

func (p promauto) NewCounterVec(o prometheus.CounterOpts, labels []string) *prometheus.CounterVec {
	c := prometheus.NewCounterVec(o, labels)
	p.r.MustRegister(c)
	return c
}

func (p promauto) NewGauge(o prometheus.GaugeOpts) prometheus.Gauge {
	g := prometheus.NewGauge(o)
	p.r.MustRegister(g)
	return g
}

func (p promauto) NewGaugeVec(o prometheus.GaugeOpts, labels []string) *prometheus.GaugeVec {
	g := prometheus.NewGaugeVec(o, labels)
	p.r.MustRegister(g)
	return g
}

func (p promauto) NewHistogram(o prometheus.HistogramOpts) prometheus.Histogram {
	h := prometheus.NewHistogram(o)
	p.r.MustRegister(h)
	return h
}

func (p promauto) NewHistogramVec(o prometheus.HistogramOpts, labels []string) *prometheus.HistogramVec {
	h := prometheus.NewHistogramVec(o, labels)
	p.r.MustRegister(h)
	return h
}

// ── Serving ──────────────────────────────────────────────────────────────────

// Handler is the scrape endpoint.
func Handler() http.Handler {
	return promhttp.HandlerFor(Registry, promhttp.HandlerOpts{
		// A collector that panics must not take the process with it: this is a
		// live market engine, and a monitoring bug is not a reason to stop
		// serving prices.
		ErrorHandling: promhttp.ContinueOnError,
	})
}

// Instrument wraps a handler so its path is timed and counted.
//
// The path comes from the ROUTE, passed in by the caller, never from the
// request — an unrouted URL would otherwise mint a permanent time series per
// scanner probe, which is the one way a metrics endpoint becomes a memory leak
// from outside.
func Instrument(path string, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h(rec, r)
		httpDuration.WithLabelValues(path).Observe(time.Since(started).Seconds())
		httpRequests.WithLabelValues(path, strconv.Itoa(rec.status)).Inc()
	}
}

// statusRecorder remembers the status code, which net/http does not expose
// after the fact.
type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.written {
		s.status = code
		s.written = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	s.written = true
	return s.ResponseWriter.Write(b)
}

// ── Zero-initialisation ──────────────────────────────────────────────────────

// Seed gives the closed label sets a zero before anything happens.
//
// A labelled metric does not exist until first written, so a freshly started
// process exposes nothing — and a dashboard panel reading it shows "No data",
// which looks exactly like a broken scrape. Worse, `rate()` over a counter that
// appears mid-window treats its first value as a counter reset and reports a
// spike that never occurred.
//
// Only the genuinely fixed sets are seeded. Feed ids are not: they come from
// configuration, and inventing a series for a broker that was never enabled
// would be its own kind of lie.
func Seed(exchanges ...string) {
	for _, source := range []string{"feed", "black76", "none"} {
		IVSource.WithLabelValues(source)
	}
	for _, reason := range []string{"no_spot", "band_not_quotable"} {
		Skips.WithLabelValues(reason)
	}
	for _, outcome := range []string{"solved", "unsolved"} {
		SolveBars.WithLabelValues(outcome)
	}
	for _, outcome := range []string{"started", "rejected"} {
		SessionsStarted.WithLabelValues(outcome)
	}
	for _, ex := range exchanges {
		MarketOpen.WithLabelValues(ex)
	}
}
