package straddle

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
	"time"

	"quantstack/compute/agg"
	"quantstack/compute/black76"
	"quantstack/compute/book"
	"quantstack/compute/chain"
	"quantstack/compute/feed"
	"quantstack/compute/market"
	"quantstack/compute/metrics"
	"quantstack/compute/tick"
)

// ── Tuning ───────────────────────────────────────────────────────────────────

// Band is how many strikes either side of ATM are priced. Matches the
// historical engine; changing it here alone would make live and history
// disagree about which straddle is being held.
const Band = 2

// DefaultThrottleMs is one computed point per this many ms, however fast ticks
// arrive. A 40-strike chain publishes hundreds of ticks a second and a chart
// can use four points a second; the browser tweens between them.
const DefaultThrottleMs = 250

// SubscribeDepth is wider than the ±Band actually priced, so ordinary intraday
// drift never walks out of the subscribed window. RearmDrift is how far the ATM
// must move before the subscription is re-centred, and RearmMin rate-limits
// that — a strike oscillating on the boundary must not be able to respawn the
// subscription on every tick.
const (
	SubscribeDepth = 8
	RearmDrift     = 4
	RearmMinMs     = 20_000
)

// DefaultReplayCap is how many emitted points are retained for reconnects.
//
// The feed only ever sends the present, so a client that was not listening for
// a while — a backgrounded tab whose socket was dropped, a laptop that slept —
// has a hole nothing downstream can fill. At four points a second, 20k entries
// is about eighty minutes, which is longer than any gap worth recovering;
// beyond that the historical catch-up path is the right answer and
// Complete:false says so.
const DefaultReplayCap = 20_000

// ReplayJoinMs is the slack allowed between a client's last known point and the
// oldest point the session can speak for, before the join counts as a hole. A
// first subscribe marks the last HISTORICAL bar, a second or two older than the
// session itself, and that is not a gap worth reloading over.
const ReplayJoinMs = 20_000

// BarIntervalMs is the width of the OHLC bars published alongside the points.
const DefaultBarIntervalMs = 60_000

// ── Configuration ────────────────────────────────────────────────────────────

// Contract is one option leg, as Node resolved it out of refdata.
//
// The contract table is passed IN rather than looked up here, and that is the
// cut line between the two processes: Node owns credentials, the instrument
// cache and every login; this process owns the socket and everything downstream
// of it. Resolving refdata here would mean a second copy of the symbol,
// expiry-format and paise-strike handling that backend/lib/instrumentCache.ts
// already gets right — and the two copies would drift.
type Contract struct {
	Strike float64 `json:"strike"`
	Side   string  `json:"side"` // CE | PE
	RefID  string  `json:"refId"`
}

// Config is one live session.
type Config struct {
	Symbol   string `json:"symbol"`
	Exchange string `json:"exchange"`
	// Expiry in either form; normalised to compact YYYYMMDD internally, which is
	// what both refdata and Nubra's option subscription key on.
	Expiry string `json:"expiry"`
	// SpotSymbol is the underlying to stream. MCX prices off a future, not a
	// cash leg, and Node resolves which — the same resolution the historical
	// engine uses, so live and history follow the same underlying.
	SpotSymbol string `json:"spotSymbol"`

	Contracts []Contract `json:"contracts"`

	// AtmHint is the last known ATM, so depth can be subscribed before the first
	// tick lands rather than after it.
	AtmHint float64 `json:"atmHint,omitempty"`

	// Credentials, minted by Node and never persisted here.
	Environment string `json:"environment,omitempty"`
	Token       string `json:"token"`
	DeviceID    string `json:"deviceId"`
	Interval    string `json:"interval,omitempty"`
	PostMarket  bool   `json:"postMarket,omitempty"`

	ThrottleMs    int `json:"throttleMs,omitempty"`
	ReplayCap     int `json:"replayCap,omitempty"`
	BarIntervalMs int `json:"barIntervalMs,omitempty"`
}

// Key identifies a session by CONTRACT, not by connection — so N tabs on the
// same expiry cost one subscription instead of N.
func (c Config) Key() string {
	return fmt.Sprintf("%s|%s|%s", feed.Upper(c.Exchange), feed.Upper(c.Symbol), feed.Compact(c.Expiry))
}

func (c Config) validate() error {
	switch {
	case feed.Upper(c.Symbol) == "":
		return fmt.Errorf("symbol is required")
	case feed.Upper(c.Exchange) == "":
		return fmt.Errorf("exchange is required")
	case feed.Compact(c.Expiry) == "":
		return fmt.Errorf("expiry is required")
	case len(c.Contracts) == 0:
		// Resolvable only by Node, which owns refdata — so this is reported as a
		// bad request rather than retried.
		return fmt.Errorf("no option contracts supplied for %s %s %s",
			feed.Upper(c.Exchange), feed.Upper(c.Symbol), feed.Compact(c.Expiry))
	}
	return nil
}

// ── Engine ───────────────────────────────────────────────────────────────────

// leg is one contract's live state, as read at selection time.
type leg struct {
	bid, ask *float64
	iv       *float64
	firm     bool // both sides came off real depth, not an LTP fallback
	delta    *float64
	gamma    *float64
	vega     *float64
	theta    *float64
	oi       *float64
	volume   *float64
	metrics  *book.Metrics
}

type legKey struct {
	strike float64
	side   string
}

// Engine holds one contract's live state and computes points off it.
//
// Everything mutable is touched by exactly ONE goroutine — the loop in Run —
// except the replay window, which a reconnecting client reads. That is the only
// mutex in the engine, and it is held for the length of a slice copy.
type Engine struct {
	cfg      Config
	expiry   string // compact YYYYMMDD
	exchange string
	symbol   string

	strikes  []float64
	step     float64
	refByLeg map[legKey]string
	legByRef map[string]legKey

	// Live per-contract state, keyed by the broker's refId.
	bookByRef  map[string]book.Book
	greekByRef map[string]tick.Dict
	tickByRef  map[string]tick.Dict
	oiByRef    map[string]*agg.Counter
	volByRef   map[string]*agg.Counter

	spot     float64
	haveSpot bool

	prevStrike float64
	havePrev   bool
	prevVega   *float64
	prevTheta  *float64

	bars *agg.Aggregator

	// Subscription centre, and when it was last moved.
	centre     float64
	haveCentre bool
	lastRearm  time.Time
	rearmWant  float64
	rearmDue   bool

	replayMu  sync.Mutex
	replay    []replayEntry
	replayCap int
	startedAt int64

	emit func(Event)
}

type replayEntry struct {
	point Point
	roll  *Roll
}

// New builds an engine. It does no I/O — Run opens the subscription.
func New(cfg Config, emit func(Event)) (*Engine, error) {
	if err := cfg.validate(); err != nil {
		return nil, err
	}

	e := &Engine{
		cfg:        cfg,
		expiry:     feed.Compact(cfg.Expiry),
		exchange:   feed.Upper(cfg.Exchange),
		symbol:     feed.Upper(cfg.Symbol),
		refByLeg:   map[legKey]string{},
		legByRef:   map[string]legKey{},
		bookByRef:  map[string]book.Book{},
		greekByRef: map[string]tick.Dict{},
		tickByRef:  map[string]tick.Dict{},
		oiByRef:    map[string]*agg.Counter{},
		volByRef:   map[string]*agg.Counter{},
		replayCap:  or(cfg.ReplayCap, DefaultReplayCap),
		startedAt:  time.Now().UnixMilli(),
		emit:       emit,
	}

	seenStrike := map[float64]bool{}
	for _, c := range cfg.Contracts {
		side := strings.ToUpper(strings.TrimSpace(c.Side))
		if side != "CE" && side != "PE" {
			continue
		}
		if c.RefID == "" || !(c.Strike > 0) {
			continue
		}
		k := legKey{c.Strike, side}
		// First row wins, matching the refdata handling on the Node side: a
		// strike listed twice is the same contract under two rows, and taking the
		// later one would silently switch which refId the whole session watches.
		if _, dup := e.refByLeg[k]; dup {
			continue
		}
		e.refByLeg[k] = c.RefID
		e.legByRef[c.RefID] = k
		if !seenStrike[c.Strike] {
			seenStrike[c.Strike] = true
			e.strikes = append(e.strikes, c.Strike)
		}
	}
	if len(e.strikes) == 0 {
		return nil, fmt.Errorf("no usable CE/PE contracts in the supplied table")
	}
	sort.Float64s(e.strikes)
	e.step = chain.InferStep(e.strikes)
	e.bars = agg.NewAggregator(int64(or(cfg.BarIntervalMs, DefaultBarIntervalMs)))

	if cfg.AtmHint > 0 {
		e.centre = chain.NearestStrike(cfg.AtmHint, e.strikes, e.step)
		e.haveCentre = true
	}
	return e, nil
}

func or(v, fallback int) int {
	if v > 0 {
		return v
	}
	return fallback
}

// Strikes exposes the resolved grid, for the status line.
func (e *Engine) Strikes() int { return len(e.strikes) }

// ── The run loop ─────────────────────────────────────────────────────────────

// Run owns the subscription until ctx ends.
//
// The re-arm is the reason this is a loop around the router rather than a
// single call: re-centring depth means a different Spec, and a Spec is fixed
// for the life of a subscription. So the inner run is cancelled and reopened
// around the new centre — which is exactly what the TypeScript engine's
// spawnBridge does, one level down.
func (e *Engine) Run(ctx context.Context, router *feed.Router) error {
	e.emit(Event{
		Event: "status", Status: "starting",
		Message: fmt.Sprintf("%s %s · %d strikes · underlying %s",
			e.symbol, e.expiry, len(e.strikes), e.cfg.SpotSymbol),
	})

	for ctx.Err() == nil {
		runCtx, cancel := context.WithCancel(ctx)
		events := make(chan feed.Event, 1024)
		done := make(chan error, 1)

		spec := e.spec()
		go func() { done <- router.Run(runCtx, spec, events) }()

		reason := e.pump(runCtx, events, done)
		cancel()
		// Drain so the router's goroutine cannot block on a send into a channel
		// nobody is reading, which would leak it for the life of the process.
		go func() {
			for range events {
			}
		}()
		<-done
		close(events)

		if ctx.Err() != nil {
			return nil
		}
		if reason == stopFatal {
			return fmt.Errorf("no feed could serve %s %s %s", e.exchange, e.symbol, e.expiry)
		}
		// stopRearm: loop straight back round with the new centre.
	}
	return nil
}

type stopReason int

const (
	stopContext stopReason = iota
	stopRearm
	stopFatal
)

// pump is one subscription's lifetime: ingest, throttle, compute.
//
// Single-goroutine by construction. Every map above is written here and read
// here, so there is no lock on the tick path at all — which is what makes a
// chain publishing hundreds of frames a second cost nothing but the parse.
func (e *Engine) pump(ctx context.Context, events <-chan feed.Event, done <-chan error) stopReason {
	throttle := time.Duration(or(e.cfg.ThrottleMs, DefaultThrottleMs)) * time.Millisecond

	// One timer, armed on the first tick of a quiet period and disarmed after it
	// fires. A ticker would compute on a schedule whether or not anything moved,
	// which is a point per interval on a contract with no quotes.
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	armed := false
	var pendingAt int64

	// Bars close on the clock, not on the tick — see package agg.
	barTick := time.NewTicker(time.Second)
	defer barTick.Stop()

	// The market-state heartbeat. It is what tells a client watching an empty
	// chart at 08:50 that the market has not opened yet, rather than leaving
	// "no data" to mean both that and a broken feed.
	stateTick := time.NewTicker(15 * time.Second)
	defer stateTick.Stop()
	e.emitState()

	for {
		select {
		case <-ctx.Done():
			return stopContext

		case err := <-done:
			if err != nil {
				e.emit(Event{Event: "error", Message: err.Error()})
				return stopFatal
			}
			return stopContext

		case ev, ok := <-events:
			if !ok {
				return stopContext
			}
			if !e.ingest(ev) {
				continue
			}
			pendingAt = ev.ReceivedMs
			if pendingAt == 0 {
				pendingAt = time.Now().UnixMilli()
			}
			if !armed {
				armed = true
				timer.Reset(throttle)
			}

		case <-timer.C:
			armed = false
			at := pendingAt
			if at == 0 {
				at = time.Now().UnixMilli()
			}
			pendingAt = 0
			e.compute(at)
			if e.rearmDue {
				e.rearmDue = false
				e.centre, e.haveCentre = e.rearmWant, true
				e.lastRearm = time.Now()
				metrics.Rearms.Inc()
				e.emit(Event{
					Event: "status", Status: "resubscribing",
					Message: fmt.Sprintf("Depth re-armed around %g", e.rearmWant),
				})
				return stopRearm
			}

		case now := <-barTick.C:
			if bar := e.bars.Flush(now.UnixMilli()); bar != nil {
				e.emit(Event{Event: "bar", Bar: bar})
			}

		case <-stateTick.C:
			e.emitState()
		}
	}
}

// spec builds the subscription for the current centre.
func (e *Engine) spec() feed.Spec {
	var refIDs []string
	if e.haveCentre {
		refIDs = e.refIDsAround(e.centre)
	} else {
		refIDs = []string{}
	}
	interval := e.cfg.Interval
	if interval == "" {
		interval = "1m"
	}
	return feed.Spec{
		Environment: e.cfg.Environment,
		Token:       e.cfg.Token,
		DeviceID:    e.cfg.DeviceID,
		Exchange:    e.exchange,
		Symbol:      e.symbol,
		SpotSymbol:  e.cfg.SpotSymbol,
		Expiry:      e.expiry,
		Interval:    interval,
		Mode:        "straddle",
		RefIDs:      refIDs,
		PostMarket:  e.cfg.PostMarket,
	}
}

// refIDsAround is every leg within SubscribeDepth strikes of a centre.
func (e *Engine) refIDsAround(centre float64) []string {
	out := make([]string, 0, (2*SubscribeDepth+1)*2)
	seen := map[string]bool{}
	for i := -SubscribeDepth; i <= SubscribeDepth; i++ {
		strike := chain.NearestStrike(centre+float64(i)*e.step, e.strikes, e.step)
		for _, side := range [2]string{"CE", "PE"} {
			ref, ok := e.refByLeg[legKey{strike, side}]
			if !ok || seen[ref] {
				continue
			}
			seen[ref] = true
			out = append(out, ref)
		}
	}
	return out
}

// ── Ingestion ────────────────────────────────────────────────────────────────

// ingest folds one feed frame into the live state, and reports whether it
// changed anything worth recomputing on.
func (e *Engine) ingest(ev feed.Event) bool {
	switch ev.Channel {
	case feed.ChanOption:
		d, ok := tick.AsDict(ev.Data)
		if !ok {
			return false
		}
		if px, ok := tick.Rupees(d["current_price"]); ok {
			e.spot, e.haveSpot = px, true
		}
		touched := false
		for _, side := range [2]string{"ce", "pe"} {
			legs, ok := d[side].([]any)
			if !ok {
				continue
			}
			for _, item := range legs {
				ref := tick.RefID(item)
				if ref == "" {
					continue
				}
				row, _ := tick.AsDict(item)
				e.tickByRef[ref] = tick.Merge(e.tickByRef[ref], row)
				e.observeCounters(ref, ev.ReceivedMs, row)
				touched = true
			}
		}
		return touched

	case feed.ChanOrderbook:
		touched := false
		tick.Each(ev.Data, func(row tick.Dict) {
			ref := tick.RefID(row)
			if ref == "" {
				return
			}
			if b, ok := book.Parse(row, ev.ReceivedMs); ok {
				b.RefID = ref
				e.bookByRef[ref] = b
				touched = true
			}
			// Depth frames carry OI and volume on some builds; taking them here
			// costs one map lookup and is the only place the wings ever report
			// them.
			e.observeCounters(ref, ev.ReceivedMs, row)
		})
		return touched

	case feed.ChanGreeks:
		touched := false
		tick.Each(ev.Data, func(row tick.Dict) {
			ref := tick.RefID(row)
			if ref == "" {
				return
			}
			e.greekByRef[ref] = tick.Merge(e.greekByRef[ref], row)
			e.observeCounters(ref, ev.ReceivedMs, row)
			touched = true
		})
		return touched

	case feed.ChanOHLCV, feed.ChanIndex:
		// Only a fallback: the chain's current_price is the same underlying and
		// updates far more often, so this matters mainly before the first chain
		// frame arrives.
		if px, ok := tick.LTP(ev.Data); ok && !e.haveSpot {
			e.spot, e.haveSpot = px, true
			return true
		}
		return false

	case feed.ChanStatus:
		e.emit(Event{Event: "status", Status: ev.Status, Message: ev.Message, Feed: ev.Feed})
		return false

	case feed.ChanError:
		e.emit(Event{Event: "error", Message: ev.Message, Feed: ev.Feed})
		return false

	case feed.ChanLog:
		e.emit(Event{Event: "status", Status: "log", Message: trim(ev.Message, 200), Feed: ev.Feed})
		return false
	}
	return false
}

// observeCounters records OI and volume for a contract, from whichever channel
// happened to carry them.
func (e *Engine) observeCounters(ref string, tsMs int64, row tick.Dict) {
	if tsMs == 0 {
		tsMs = time.Now().UnixMilli()
	}
	if oi, ok := tick.OI(row); ok {
		c, exists := e.oiByRef[ref]
		if !exists {
			c = agg.NewCounter(3600)
			e.oiByRef[ref] = c
		}
		c.Observe(tsMs, oi)
	}
	if vol, ok := tick.Volume(row); ok {
		c, exists := e.volByRef[ref]
		if !exists {
			c = agg.NewCounter(3600)
			e.volByRef[ref] = c
		}
		c.Observe(tsMs, vol)
	}
}

func trim(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// ── Reading a leg ────────────────────────────────────────────────────────────

func (e *Engine) readLeg(strike float64, side string) *leg {
	ref, ok := e.refByLeg[legKey{strike, side}]
	if !ok {
		return nil
	}
	b, hasBook := e.bookByRef[ref]
	greek := e.greekByRef[ref]
	tk := e.tickByRef[ref]

	l := &leg{}

	// Depth is the honest quote; LTP stands in when the book has not arrived for
	// this contract, which is common for the outer strikes of the band.
	var fallback *float64
	if px, ok := tick.LTP(tk); ok {
		fallback = f64(px)
	} else if px, ok := tick.LTP(greek); ok {
		fallback = f64(px)
	}

	if hasBook {
		if bid, ok := b.BestBid(); ok {
			l.bid = f64(bid)
		}
		if ask, ok := b.BestAsk(); ok {
			l.ask = f64(ask)
		}
		if b.TwoSided() {
			l.firm = true
			m := b.Metrics()
			l.metrics = &m
		}
	}
	if l.bid == nil {
		l.bid = fallback
	}
	if l.ask == nil {
		l.ask = fallback
	}

	// The greeks stream is authoritative; the chain frame carries them too on
	// some builds, so it stands in when depth has not arrived.
	if iv, ok := tick.IV(greek); ok {
		l.iv = f64(iv)
	} else if iv, ok := tick.IV(tk); ok {
		l.iv = f64(iv)
	}
	for _, name := range [4]string{"delta", "gamma", "vega", "theta"} {
		v, ok := tick.Greek(greek, name)
		if !ok {
			v, ok = tick.Greek(tk, name)
		}
		if !ok {
			continue
		}
		switch name {
		case "delta":
			l.delta = f64(v)
		case "gamma":
			l.gamma = f64(v)
		case "vega":
			l.vega = f64(v)
		case "theta":
			l.theta = f64(v)
		}
	}

	if c, ok := e.oiByRef[ref]; ok {
		if v, ok := c.Last(); ok {
			l.oi = f64(v)
		}
	}
	if c, ok := e.volByRef[ref]; ok {
		if v, ok := c.Last(); ok {
			l.volume = f64(v)
		}
	}
	return l
}

// sum is the straddle's greek: CE + PE, null only when neither leg published
// one. A leg that did not publish contributes zero rather than voiding the
// pair, which is the same rule the TypeScript engine's sumLeg applies.
func sum(a, b *float64) *float64 {
	if a == nil && b == nil {
		return nil
	}
	var total float64
	if a != nil {
		total += *a
	}
	if b != nil {
		total += *b
	}
	return &total
}

// ── The straddle rule ────────────────────────────────────────────────────────

type candidate struct {
	strike   float64
	bid, ask float64
	mid      float64
	call     float64
	put      float64
	iv       *float64
	firm     bool
	ce, pe   *leg
}

// compute runs the selection rule and emits a point, if the band is quotable.
func (e *Engine) compute(atMs int64) {
	if !e.haveSpot || !(e.spot > 0) {
		metrics.Skips.WithLabelValues("no_spot").Inc()
		return
	}
	// Timed around the whole pass, not just the maths: reading every leg in the
	// band is map lookups and pointer chasing, and on a wide chain that is the
	// larger half. This runs on the engine's only goroutine once per throttle
	// window, so it is the number that says whether the budget is being kept.
	started := time.Now()
	defer func() { metrics.ComputeDuration.Observe(time.Since(started).Seconds()) }()

	atm := chain.NearestStrike(e.spot, e.strikes, e.step)
	e.noteDrift(atm)

	var best *candidate
	for _, strike := range chain.CandidateStrikes(atm, e.strikes, e.step, Band) {
		ce := e.readLeg(strike, "CE")
		pe := e.readLeg(strike, "PE")
		if ce == nil || pe == nil || ce.bid == nil || ce.ask == nil || pe.bid == nil || pe.ask == nil {
			continue
		}
		bid := *ce.bid + *pe.bid
		ask := *ce.ask + *pe.ask
		mid := (bid + ask) / 2
		if !(mid > 0) {
			continue
		}
		c := &candidate{
			strike: strike, bid: bid, ask: ask, mid: mid,
			call: (*ce.bid + *ce.ask) / 2,
			put:  (*pe.bid + *pe.ask) / 2,
			firm: ce.firm && pe.firm,
			ce:   ce, pe: pe,
		}
		// Mean of whichever legs published a vol. Averaging CE and PE is the
		// straddle's own vol only when both are quoted; one leg alone is still
		// the best estimate available and is better than dropping the field.
		var ivs []float64
		if ce.iv != nil && *ce.iv > 0 {
			ivs = append(ivs, *ce.iv)
		}
		if pe.iv != nil && *pe.iv > 0 {
			ivs = append(ivs, *pe.iv)
		}
		if len(ivs) > 0 {
			var s float64
			for _, v := range ivs {
				s += v
			}
			c.iv = f64(s / float64(len(ivs)))
		}
		if best == nil || c.mid < best.mid {
			best = c
		}
	}

	if best == nil {
		metrics.Skips.WithLabelValues("band_not_quotable").Inc()
		return // nothing in the band is two-sided yet
	}

	isRoll := e.havePrev && e.prevStrike != best.strike
	synFuture := best.strike + best.call - best.put

	point := Point{
		Time:            atMs,
		Spot:            e.spot,
		AtmStrike:       best.strike,
		SyntheticFuture: synFuture,
		CallLtp:         best.call,
		PutLtp:          best.put,
		StraddlePrice:   best.mid,
		StraddleBid:     f64(best.bid),
		StraddleAsk:     f64(best.ask),
		IsRollEvent:     isRoll,
	}

	// ── Vol ──
	//
	// Feed first, inversion second. The inversion is the addition over the
	// TypeScript engine: a contract whose greeks stream has not populated used
	// to yield a point with no vol at all, and the IV line simply stopped. T is
	// measured to the same expiry convention the historical engine uses, so the
	// two lines join without a step.
	years := black76.YearsToExpiry(float64(atMs), e.expiry)
	sigma := math.NaN()
	switch {
	case best.iv != nil && *best.iv > 0:
		point.IV, point.IVSource = best.iv, "feed"
		sigma = *best.iv / 100
	default:
		if solved := black76.ImpliedVolStraddle(best.mid, synFuture, best.strike, years); solved > 0 && !math.IsNaN(solved) {
			point.IV, point.IVSource = f64(solved*100), "black76"
			sigma = solved
		}
		// No solution is the honest answer for a straddle printing below
		// |F − K|: that quote is an arbitrage with no implied vol at all, and a
		// zero there would be plotted as a real observation of zero volatility.
	}

	// ── Greeks ──
	feedGreeks := struct{ delta, gamma, vega, theta *float64 }{
		delta: sum(best.ce.delta, best.pe.delta),
		gamma: sum(best.ce.gamma, best.pe.gamma),
		vega:  sum(best.ce.vega, best.pe.vega),
		theta: sum(best.ce.theta, best.pe.theta),
	}
	switch {
	case feedGreeks.vega != nil || feedGreeks.theta != nil:
		point.Delta, point.Gamma = feedGreeks.delta, feedGreeks.gamma
		point.Vega, point.Theta = feedGreeks.vega, feedGreeks.theta
		point.GreekSource = "feed"
	case sigma > 0 && !math.IsNaN(sigma):
		if g, ok := black76.StraddleGreeksOf(synFuture, best.strike, years, sigma); ok {
			point.Delta, point.Gamma = f64(g.Delta), f64(g.Gamma)
			point.Vega, point.Theta = f64(g.Vega), f64(g.Theta)
			point.GreekSource = "black76"
		}
	}

	point.Micro = e.micro(best)

	var roll *Roll
	if isRoll {
		roll = &Roll{
			Time:          atMs,
			FromStrike:    e.prevStrike,
			ToStrike:      best.strike,
			SynFuture:     synFuture,
			StraddlePrice: best.mid,
			VegaJump:      jump(point.Vega, e.prevVega),
			ThetaJump:     jump(point.Theta, e.prevTheta),
		}
	}

	e.prevStrike, e.havePrev = best.strike, true
	if point.Vega != nil {
		e.prevVega = point.Vega
	}
	if point.Theta != nil {
		e.prevTheta = point.Theta
	}

	// The bar tracks the straddle mid, which is the series the chart draws.
	// Volume rides along as the two legs' traded volume so a candle carries the
	// activity that produced it.
	sample := agg.Sample{TsMs: atMs, Price: best.mid}
	if point.Micro != nil {
		if point.Micro.CallVolume != nil || point.Micro.PutVolume != nil {
			sample.CumVolume = sum(point.Micro.CallVolume, point.Micro.PutVolume)
		}
		sample.CumOI = point.Micro.TotalOI
	}
	if bar := e.bars.Add(sample); bar != nil {
		e.emit(Event{Event: "bar", Bar: bar})
	}

	// Retained BEFORE the emit, so a replay asked for from inside a send path
	// can never be missing the point that is going out right now.
	metrics.Points.Inc()
	if roll != nil {
		metrics.Rolls.Inc()
	}
	source := point.IVSource
	if source == "" {
		// A point with no vol at all is its own observation, and folding it into
		// either real source would hide exactly the case worth seeing.
		source = "none"
	}
	metrics.IVSource.WithLabelValues(source).Inc()

	e.retain(point, roll)
	e.emit(Event{Event: "point", Point: &point, Roll: roll})
}

func jump(now, prev *float64) *float64 {
	if now == nil || prev == nil {
		return nil
	}
	return f64(*now - *prev)
}

// micro assembles the microstructure snapshot for the selected strike.
func (e *Engine) micro(c *candidate) *Micro {
	m := &Micro{Firm: c.firm}
	any := c.firm

	if c.ce.metrics != nil && c.pe.metrics != nil {
		ce, pe := c.ce.metrics, c.pe.metrics
		if ce.Spread != nil && pe.Spread != nil {
			// Summed: what it costs to cross out of BOTH legs is what the holder
			// of a straddle actually pays.
			m.SpreadRs = f64(*ce.Spread + *pe.Spread)
			if c.mid > 0 {
				m.SpreadBps = f64(*m.SpreadRs / c.mid * 10_000)
			}
			any = true
		}
		if ce.Imbalance != nil && pe.Imbalance != nil {
			// Averaged, not summed: an imbalance is a ratio, and adding two
			// ratios produces a number in [−2, 2] that means nothing.
			m.Imbalance = f64((*ce.Imbalance + *pe.Imbalance) / 2)
			any = true
		}
		if ce.Microprice != nil && pe.Microprice != nil {
			m.Microprice = f64(*ce.Microprice + *pe.Microprice)
			any = true
		}
	}

	m.CallOI, m.PutOI = c.ce.oi, c.pe.oi
	m.CallVolume, m.PutVolume = c.ce.volume, c.pe.volume
	if c.ce.oi != nil || c.pe.oi != nil {
		total := sum(c.ce.oi, c.pe.oi)
		m.TotalOI = total
		any = true
		if c.ce.oi != nil && *c.ce.oi > 0 && c.pe.oi != nil {
			m.PCR = f64(*c.pe.oi / *c.ce.oi)
		}
		// Change since the session's first reading, summed over the two legs.
		// Both legs must have a base for the sum to mean anything — one leg's
		// change plus the other's level is not a quantity.
		ceRef, ceOK := e.counterChange(c.strike, "CE")
		peRef, peOK := e.counterChange(c.strike, "PE")
		if ceOK && peOK {
			delta := ceRef.abs + peRef.abs
			m.OIChange = f64(delta)
			if base := *total - delta; base > 0 {
				m.OIChangePct = f64(delta / base * 100)
			}
		}
	}
	if c.ce.volume != nil || c.pe.volume != nil {
		any = true
	}
	if !any {
		return nil
	}
	return m
}

type counterDelta struct{ abs float64 }

func (e *Engine) counterChange(strike float64, side string) (counterDelta, bool) {
	ref, ok := e.refByLeg[legKey{strike, side}]
	if !ok {
		return counterDelta{}, false
	}
	c, ok := e.oiByRef[ref]
	if !ok {
		return counterDelta{}, false
	}
	abs, _, ok := c.SinceOpen()
	if !ok {
		return counterDelta{}, false
	}
	return counterDelta{abs: abs}, true
}

// noteDrift flags a re-arm when the ATM has walked far enough from the centre
// the subscription was opened around.
//
// It records the intent rather than acting on it, because tearing the
// subscription down mid-compute would drop the point being built. The pump
// acts on the flag once the point is out.
func (e *Engine) noteDrift(atm float64) {
	drifted := !e.haveCentre || math.Abs(atm-e.centre) > RearmDrift*e.step
	if !drifted || e.rearmDue {
		return
	}
	if !e.lastRearm.IsZero() && time.Since(e.lastRearm) < RearmMinMs*time.Millisecond {
		return
	}
	e.rearmWant = atm
	e.rearmDue = true
}

// emitState publishes the market clock.
func (e *Engine) emitState() {
	snap := market.At(e.exchange, time.Now())
	// Published as a gauge as well as an event, so every other series can be
	// read in context: a tick rate of zero at 03:00 is the market being shut,
	// not an outage, and an alert that cannot tell the difference gets muted
	// within a week.
	open := 0.0
	if snap.Open {
		open = 1
	}
	metrics.MarketOpen.WithLabelValues(e.exchange).Set(open)
	e.emit(Event{Event: "state", Status: string(snap.State), State: snap})
}

// ── Replay ───────────────────────────────────────────────────────────────────

func (e *Engine) retain(p Point, roll *Roll) {
	e.replayMu.Lock()
	defer e.replayMu.Unlock()
	e.replay = append(e.replay, replayEntry{p, roll})
	if len(e.replay) > e.replayCap {
		// Drop a tenth at a time, so the cap costs one copy per cap/10 points
		// instead of one per point.
		trimBy := max(1, e.replayCap/10)
		e.replay = append(e.replay[:0], e.replay[trimBy:]...)
	}
}

// ReplaySince is everything emitted after sinceMs, oldest first.
func (e *Engine) ReplaySince(sinceMs int64) Replay {
	e.replayMu.Lock()
	defer e.replayMu.Unlock()

	from := sort.Search(len(e.replay), func(i int) bool {
		return e.replay[i].point.Time > sinceMs
	})
	slice := e.replay[from:]

	out := Replay{Points: make([]Point, 0, len(slice))}
	for _, entry := range slice {
		out.Points = append(out.Points, entry.point)
		if entry.roll != nil {
			out.Rolls = append(out.Rolls, *entry.roll)
		}
	}

	// Does the replay actually reach back to where the client left off?
	//
	// Measured against the oldest thing this session can speak for — its first
	// retained point, or its own start before any point exists. Anything earlier
	// belongs to history, not to the feed, whether it fell out of the window or
	// the session simply had not begun.
	floor := e.startedAt
	if len(e.replay) > 0 {
		floor = e.replay[0].point.Time
	}
	out.Complete = sinceMs >= floor-ReplayJoinMs
	return out
}

// LastPointTime is the newest emitted point, or zero before the first one.
func (e *Engine) LastPointTime() int64 {
	e.replayMu.Lock()
	defer e.replayMu.Unlock()
	if len(e.replay) == 0 {
		return 0
	}
	return e.replay[len(e.replay)-1].point.Time
}
