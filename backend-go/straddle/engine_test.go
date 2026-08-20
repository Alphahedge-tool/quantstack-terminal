package straddle

import (
	"context"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"quantstack/compute/feed"
	"quantstack/compute/metrics"
)

// scriptedSource replays a fixed list of frames and then holds the
// subscription open, which is what a real feed does between ticks.
//
// Driving the engine off this rather than off a broker is the point of the
// Source interface: the whole pipeline — ingest, book, counters, selection
// rule, vol, greeks, throttle — runs here with no token, no socket and no
// Python.
type scriptedSource struct {
	frames []feed.Event
	// pauseAfter/pause insert a gap partway through the script.
	//
	// Needed because the engine computes on a throttle timer: a script delivered
	// in one burst produces exactly ONE point, and any behaviour that only shows
	// up between consecutive points — a roll, most obviously — would be
	// untestable without letting the timer fire in the middle.
	pauseAfter int
	pause      time.Duration
	// after is closed once every frame has been delivered, so a test can wait
	// for ingestion rather than sleeping on a guess.
	after chan struct{}
}

func (s *scriptedSource) ID() string { return "scripted" }

func (s *scriptedSource) Run(ctx context.Context, _ feed.Spec, out chan<- feed.Event) error {
	for i, f := range s.frames {
		if s.pause > 0 && i == s.pauseAfter {
			select {
			case <-time.After(s.pause):
			case <-ctx.Done():
				return nil
			}
		}
		select {
		case out <- f:
		case <-ctx.Done():
			return nil
		}
	}
	close(s.after)
	<-ctx.Done()
	return nil
}

// chainFrame builds one `option` frame: a chain snapshot with a spot and both
// legs of every strike.
func chainFrame(ts int64, spotPaise float64, legs map[string][2]float64) feed.Event {
	ce := []any{}
	pe := []any{}
	for ref, px := range legs {
		ce = append(ce, map[string]any{"refId": ref + "C", "last_traded_price": px[0]})
		pe = append(pe, map[string]any{"refId": ref + "P", "last_traded_price": px[1]})
	}
	return feed.Event{
		Channel:    feed.ChanOption,
		ReceivedMs: ts,
		Data: map[string]any{
			"current_price": spotPaise,
			"ce":            ce,
			"pe":            pe,
		},
	}
}

// depthFrame is one contract's two-sided book, in paise.
func depthFrame(ts int64, ref string, bid, ask, qty float64) feed.Event {
	return feed.Event{
		Channel:    feed.ChanOrderbook,
		ReceivedMs: ts,
		Data: map[string]any{
			"refId": ref,
			"bids":  []any{map[string]any{"price": bid, "quantity": qty}},
			"asks":  []any{map[string]any{"price": ask, "quantity": qty}},
			"oi":    12_000.0,
		},
	}
}

func testConfig() Config {
	return Config{
		Symbol:   "NIFTY",
		Exchange: "NSE",
		// Far enough out that T is comfortably positive whenever the suite runs;
		// a past expiry would make every vol NaN and the assertions vacuous.
		Expiry:     "20991231",
		SpotSymbol: "NIFTY",
		Contracts: []Contract{
			{Strike: 24400, Side: "CE", RefID: "24400C"},
			{Strike: 24400, Side: "PE", RefID: "24400P"},
			{Strike: 24450, Side: "CE", RefID: "24450C"},
			{Strike: 24450, Side: "PE", RefID: "24450P"},
			{Strike: 24500, Side: "CE", RefID: "24500C"},
			{Strike: 24500, Side: "PE", RefID: "24500P"},
			{Strike: 24550, Side: "CE", RefID: "24550C"},
			{Strike: 24550, Side: "PE", RefID: "24550P"},
			{Strike: 24600, Side: "CE", RefID: "24600C"},
			{Strike: 24600, Side: "PE", RefID: "24600P"},
		},
		AtmHint:    24500,
		Token:      "test",
		DeviceID:   "test",
		ThrottleMs: 10,
	}
}

// runEngine drives a scripted feed through a real engine and collects events.
func runEngine(t *testing.T, cfg Config, frames []feed.Event) []Event {
	t.Helper()
	return runEngineWithPause(t, cfg, frames, 0, 0)
}

func runEngineWithPause(
	t *testing.T, cfg Config, frames []feed.Event, pauseAfter int, pause time.Duration,
) []Event {
	t.Helper()

	src := &scriptedSource{
		frames: frames, pauseAfter: pauseAfter, pause: pause, after: make(chan struct{}),
	}
	router, err := feed.NewRouter(feed.NewBreakers(), src)
	if err != nil {
		t.Fatalf("router: %v", err)
	}

	var got []Event
	done := make(chan struct{})
	collected := make(chan Event, 256)

	eng, err := New(cfg, func(e Event) {
		select {
		case collected <- e:
		default:
		}
	})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		defer close(done)
		_ = eng.Run(ctx, router)
	}()

	<-src.after
	// One throttle window plus slack: the engine computes on a timer, so the
	// point for the last frame has not been built at the moment the frame lands.
	time.Sleep(150 * time.Millisecond)
	cancel()
	<-done

	for {
		select {
		case e := <-collected:
			got = append(got, e)
			continue
		default:
		}
		break
	}
	return got
}

func pointsOf(events []Event) []Point {
	var out []Point
	for _, e := range events {
		if e.Event == "point" && e.Point != nil {
			out = append(out, *e.Point)
		}
	}
	return out
}

// The core rule: cheapest two-sided straddle in the band wins, and the point
// carries the identities the chart draws.
func TestSelectsCheapestTwoSidedStraddle(t *testing.T) {
	ts := time.Now().UnixMilli()
	frames := []feed.Event{
		// Spot 24,510 in paise → ATM snaps to 24500.
		chainFrame(ts, 2_451_000, map[string][2]float64{
			"24400": {20_000, 4_000},
			"24450": {15_000, 6_000},
			"24500": {11_000, 9_000},
			"24550": {8_000, 13_000},
			"24600": {5_000, 18_000},
		}),
		// 24500 is the cheapest pair at 200 total; 24450 is deliberately dearer
		// so a rule that simply took the ATM would pass and a rule that took the
		// cheapest would too. 24550 is made cheapest of all, so only the
		// cheapest-of-band rule picks it.
		depthFrame(ts+1, "24500C", 10_900, 11_100, 500),
		depthFrame(ts+1, "24500P", 8_900, 9_100, 500),
		depthFrame(ts+1, "24450C", 14_900, 15_100, 500),
		depthFrame(ts+1, "24450P", 5_900, 6_100, 500),
		depthFrame(ts+1, "24550C", 3_900, 4_100, 500),
		depthFrame(ts+1, "24550P", 3_900, 4_100, 500),
	}

	pts := pointsOf(runEngine(t, testConfig(), frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}
	last := pts[len(pts)-1]

	if last.AtmStrike != 24550 {
		t.Errorf("selected strike = %v, want 24550 (the cheapest two-sided pair)", last.AtmStrike)
	}
	// 39 + 41 = 80 mid per leg, 160 for the pair.
	if got, want := last.StraddlePrice, 80.0; got != want {
		t.Errorf("straddle mid = %v, want %v", got, want)
	}
	// Put-call parity on the selected strike: F = K + CE − PE. The two legs are
	// priced identically here, so the forward is the strike.
	if got, want := last.SyntheticFuture, 24550.0; got != want {
		t.Errorf("synthetic future = %v, want %v", got, want)
	}
	if last.Spot != 24510 {
		t.Errorf("spot = %v, want 24510 (paise converted)", last.Spot)
	}
}

// A leg quoted on only one side cannot be priced honestly, and the strike must
// be skipped rather than half-priced off its LTP.
func TestSkipsStrikeWithNoDepthOnOneSide(t *testing.T) {
	ts := time.Now().UnixMilli()
	cfg := testConfig()

	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{
			"24500": {11_000, 9_000},
			"24450": {15_000, 6_000},
		}),
		depthFrame(ts+1, "24500C", 10_900, 11_100, 500),
		depthFrame(ts+1, "24500P", 8_900, 9_100, 500),
	}
	pts := pointsOf(runEngine(t, cfg, frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}
	// 24450 has chain LTPs but no depth, so it falls back to LTP on BOTH sides
	// (150 + 60 = 210) and loses to 24500's 200 — the assertion is that the
	// selected strike is one with real, complete quotes.
	if pts[len(pts)-1].AtmStrike != 24500 {
		t.Errorf("selected %v, want 24500", pts[len(pts)-1].AtmStrike)
	}
}

// The engine must not emit anything before it knows where spot is: an ATM
// derived from no underlying is not a straddle, it is a guess.
func TestNoPointsWithoutSpot(t *testing.T) {
	ts := time.Now().UnixMilli()
	frames := []feed.Event{
		depthFrame(ts, "24500C", 10_900, 11_100, 500),
		depthFrame(ts, "24500P", 8_900, 9_100, 500),
	}
	if pts := pointsOf(runEngine(t, testConfig(), frames)); len(pts) != 0 {
		t.Fatalf("emitted %d points with no spot", len(pts))
	}
}

// A change of held strike is a roll, and the roll carries where it came from.
func TestRollIsReportedWhenTheStrikeChanges(t *testing.T) {
	ts := time.Now().UnixMilli()
	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{"24500": {11_000, 9_000}}),
		depthFrame(ts, "24500C", 10_900, 11_100, 500),
		depthFrame(ts, "24500P", 8_900, 9_100, 500),
		// Second pass: 24550 becomes far cheaper, forcing the held strike to move.
		chainFrame(ts+400, 2_455_000, map[string][2]float64{"24550": {4_000, 4_000}}),
		depthFrame(ts+400, "24550C", 1_900, 2_100, 500),
		depthFrame(ts+400, "24550P", 1_900, 2_100, 500),
	}

	// Three frames, a pause long enough for the throttle to fire, then three
	// more: the first batch settles on 24500 and the second forces the move.
	events := runEngineWithPause(t, testConfig(), frames, 3, 120*time.Millisecond)
	var roll *Roll
	for _, e := range events {
		if e.Roll != nil {
			roll = e.Roll
		}
	}
	if roll == nil {
		t.Fatal("no roll reported across a change of strike")
	}
	if roll.FromStrike != 24500 || roll.ToStrike != 24550 {
		t.Errorf("roll %v → %v, want 24500 → 24550", roll.FromStrike, roll.ToStrike)
	}
}

// Vol is solved when the feed does not publish one — the addition over the
// TypeScript engine, and the reason the IV line no longer stops when the greeks
// stream goes quiet.
func TestSolvesImpliedVolWhenTheFeedPublishesNone(t *testing.T) {
	ts := time.Now().UnixMilli()
	cfg := testConfig()
	// A month out, so the straddle has real time value to invert.
	cfg.Expiry = time.Now().AddDate(0, 1, 0).Format("20060102")

	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{"24500": {30_000, 30_000}}),
		depthFrame(ts, "24500C", 29_900, 30_100, 500),
		depthFrame(ts, "24500P", 29_900, 30_100, 500),
	}
	pts := pointsOf(runEngine(t, cfg, frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}
	last := pts[len(pts)-1]
	if last.IV == nil {
		t.Fatal("no implied vol on a straddle that has one")
	}
	if last.IVSource != "black76" {
		t.Errorf("ivSource = %q, want black76", last.IVSource)
	}
	if *last.IV <= 0 || *last.IV > 300 {
		t.Errorf("iv = %v, outside any plausible range", *last.IV)
	}
	// Greeks follow from the solved vol, so a long straddle must show positive
	// vega and negative theta.
	if last.Vega == nil || *last.Vega <= 0 {
		t.Errorf("vega = %v, want positive for a long straddle", last.Vega)
	}
	if last.Theta == nil || *last.Theta >= 0 {
		t.Errorf("theta = %v, want negative for a long straddle", last.Theta)
	}
}

// A vol the feed already published must be used as-is rather than re-solved:
// two slightly different numbers for the same quantity is worse than one.
func TestPrefersTheFeedsOwnVol(t *testing.T) {
	ts := time.Now().UnixMilli()
	cfg := testConfig()
	cfg.Expiry = time.Now().AddDate(0, 1, 0).Format("20060102")

	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{"24500": {30_000, 30_000}}),
		depthFrame(ts, "24500C", 29_900, 30_100, 500),
		depthFrame(ts, "24500P", 29_900, 30_100, 500),
		{
			Channel:    feed.ChanGreeks,
			ReceivedMs: ts + 1,
			Data: []any{
				map[string]any{"refId": "24500C", "iv": 17.5, "vega": 12.0, "theta": -4.0},
				map[string]any{"refId": "24500P", "iv": 17.5, "vega": 12.5, "theta": -4.5},
			},
		},
	}
	pts := pointsOf(runEngine(t, cfg, frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}
	last := pts[len(pts)-1]
	if last.IVSource != "feed" {
		t.Fatalf("ivSource = %q, want feed", last.IVSource)
	}
	if last.IV == nil || *last.IV != 17.5 {
		t.Errorf("iv = %v, want the fed 17.5 unchanged", last.IV)
	}
	if last.GreekSource != "feed" {
		t.Errorf("greekSource = %q, want feed", last.GreekSource)
	}
	// Straddle greek is CE + PE.
	if last.Vega == nil || *last.Vega != 24.5 {
		t.Errorf("vega = %v, want 24.5 (12.0 + 12.5)", last.Vega)
	}
}

// Open interest, volume and the depth-derived numbers must ride on the point
// they were observed with.
func TestMicrostructureRidesOnThePoint(t *testing.T) {
	ts := time.Now().UnixMilli()
	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{"24500": {11_000, 9_000}}),
		{
			Channel:    feed.ChanOrderbook,
			ReceivedMs: ts,
			Data: map[string]any{
				"refId":  "24500C",
				"bids":   []any{map[string]any{"price": 10_900.0, "quantity": 900.0}},
				"asks":   []any{map[string]any{"price": 11_100.0, "quantity": 100.0}},
				"oi":     40_000.0,
				"volume": 1_500.0,
			},
		},
		{
			Channel:    feed.ChanOrderbook,
			ReceivedMs: ts,
			Data: map[string]any{
				"refId":  "24500P",
				"bids":   []any{map[string]any{"price": 8_900.0, "quantity": 100.0}},
				"asks":   []any{map[string]any{"price": 9_100.0, "quantity": 900.0}},
				"oi":     60_000.0,
				"volume": 2_500.0,
			},
		},
	}

	pts := pointsOf(runEngine(t, testConfig(), frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}
	m := pts[len(pts)-1].Micro
	if m == nil {
		t.Fatal("no micro block on a point built from full depth")
	}
	if !m.Firm {
		t.Error("firm = false on a point whose legs both came off real depth")
	}
	// Each leg is 2 rupees wide, so getting out of both costs 4.
	if m.SpreadRs == nil || *m.SpreadRs != 4 {
		t.Errorf("spreadRs = %v, want 4", m.SpreadRs)
	}
	if m.TotalOI == nil || *m.TotalOI != 100_000 {
		t.Errorf("totalOi = %v, want 100000", m.TotalOI)
	}
	// PCR is put OI over call OI: 60k / 40k.
	if m.PCR == nil || *m.PCR != 1.5 {
		t.Errorf("pcr = %v, want 1.5", m.PCR)
	}
	// The two legs are mirror images, so their imbalances cancel to zero.
	if m.Imbalance == nil || *m.Imbalance != 0 {
		t.Errorf("imbalance = %v, want 0 for mirrored books", m.Imbalance)
	}
}

// The retained window is what makes a reconnect cheap; it must hand back only
// what came after the client's mark.
func TestReplayReturnsOnlyWhatCameAfterTheMark(t *testing.T) {
	eng, err := New(testConfig(), func(Event) {})
	if err != nil {
		t.Fatalf("engine: %v", err)
	}
	// Real epoch timestamps, not 1..5: ReplayJoinMs is twenty seconds of slack,
	// which on a toy scale would swallow the whole window and make every mark
	// look complete.
	base := time.Now().UnixMilli()
	for i := int64(1); i <= 5; i++ {
		eng.retain(Point{Time: base + i*1000, AtmStrike: 24500}, nil)
	}

	got := eng.ReplaySince(base + 2500)
	if len(got.Points) != 3 {
		t.Fatalf("replayed %d points, want 3", len(got.Points))
	}
	if got.Points[0].Time != base+3000 {
		t.Errorf("first replayed point at %d, want %d", got.Points[0].Time, base+3000)
	}
	if !got.Complete {
		t.Error("complete = false for a mark inside the retained window")
	}

	// A mark older than anything retained is a hole the feed cannot fill, and
	// saying so is what sends the client to the history endpoint instead.
	if stale := eng.ReplaySince(base - 10*60*1000); stale.Complete {
		t.Error("complete = true for a mark older than the window")
	}
}

// A contract table with no usable legs is a bad request, not something to retry
// a socket over.
func TestRejectsAnEmptyContractTable(t *testing.T) {
	cfg := testConfig()
	cfg.Contracts = nil
	if _, err := New(cfg, func(Event) {}); err == nil {
		t.Fatal("accepted a config with no contracts")
	}

	cfg.Contracts = []Contract{{Strike: 0, Side: "XX", RefID: ""}}
	if _, err := New(cfg, func(Event) {}); err == nil {
		t.Fatal("accepted a config whose only contract is unusable")
	}
}

// The instrumentation must actually move when the engine does.
//
// Worth a test because a metric that is never incremented looks identical to a
// system that is idle — and the whole point of qt_engine_points_total is to
// tell those two apart at 3am.
func TestMetricsRecordAComputedPoint(t *testing.T) {
	before := testutil.ToFloat64(metrics.Points)
	beforeFeed := testutil.ToFloat64(metrics.IVSource.WithLabelValues("feed"))

	ts := time.Now().UnixMilli()
	cfg := testConfig()
	cfg.Expiry = time.Now().AddDate(0, 1, 0).Format("20060102")

	frames := []feed.Event{
		chainFrame(ts, 2_450_000, map[string][2]float64{"24500": {30_000, 30_000}}),
		depthFrame(ts, "24500C", 29_900, 30_100, 500),
		depthFrame(ts, "24500P", 29_900, 30_100, 500),
		{
			Channel:    feed.ChanGreeks,
			ReceivedMs: ts + 1,
			Data:       []any{map[string]any{"refId": "24500C", "iv": 17.5, "vega": 12.0}},
		},
	}
	pts := pointsOf(runEngine(t, cfg, frames))
	if len(pts) == 0 {
		t.Fatal("no points emitted")
	}

	if after := testutil.ToFloat64(metrics.Points); after <= before {
		t.Errorf("qt_engine_points_total did not move: %v → %v", before, after)
	}
	if after := testutil.ToFloat64(metrics.IVSource.WithLabelValues("feed")); after <= beforeFeed {
		t.Error("qt_engine_iv_source_total{source=\"feed\"} did not move on a fed vol")
	}
	// One pass of the selection rule per emitted point, at minimum.
	if testutil.CollectAndCount(metrics.ComputeDuration) == 0 {
		t.Error("no compute duration observed")
	}
}

// A band with nothing two-sided must be counted as a skip, not silently
// produce nothing: "the engine is quiet" and "the engine is broken" look the
// same from outside without this.
func TestMetricsRecordASkipWhenNothingIsQuotable(t *testing.T) {
	before := testutil.ToFloat64(metrics.Skips.WithLabelValues("no_spot"))

	ts := time.Now().UnixMilli()
	frames := []feed.Event{
		depthFrame(ts, "24500C", 10_900, 11_100, 500),
		depthFrame(ts, "24500P", 8_900, 9_100, 500),
	}
	if pts := pointsOf(runEngine(t, testConfig(), frames)); len(pts) != 0 {
		t.Fatalf("emitted %d points with no spot", len(pts))
	}
	if after := testutil.ToFloat64(metrics.Skips.WithLabelValues("no_spot")); after <= before {
		t.Errorf("qt_engine_skips_total{reason=\"no_spot\"} did not move: %v → %v", before, after)
	}
}
