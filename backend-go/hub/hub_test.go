package hub

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"quantstack/compute/feed"
	"quantstack/compute/straddle"
)

// tickingSource publishes a chain and depth for one strike, then holds the
// subscription open — enough for the engine to produce points forever without a
// broker, a token or a Python interpreter.
type tickingSource struct {
	id      string
	started chan struct{}
	once    bool
}

func (s *tickingSource) ID() string { return s.id }

func (s *tickingSource) Run(ctx context.Context, _ feed.Spec, out chan<- feed.Event) error {
	if !s.once {
		s.once = true
		close(s.started)
	}
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		now := time.Now().UnixMilli()
		frames := []feed.Event{
			{
				Channel: feed.ChanOption, ReceivedMs: now,
				Data: map[string]any{
					"current_price": 2_450_000.0,
					"ce":            []any{map[string]any{"refId": "24500C", "last_traded_price": 11_000.0}},
					"pe":            []any{map[string]any{"refId": "24500P", "last_traded_price": 9_000.0}},
				},
			},
			{
				Channel: feed.ChanOrderbook, ReceivedMs: now,
				Data: map[string]any{
					"refId": "24500C",
					"bids":  []any{map[string]any{"price": 10_900.0, "quantity": 100.0}},
					"asks":  []any{map[string]any{"price": 11_100.0, "quantity": 100.0}},
				},
			},
			{
				Channel: feed.ChanOrderbook, ReceivedMs: now,
				Data: map[string]any{
					"refId": "24500P",
					"bids":  []any{map[string]any{"price": 8_900.0, "quantity": 100.0}},
					"asks":  []any{map[string]any{"price": 9_100.0, "quantity": 100.0}},
				},
			},
		}
		for _, f := range frames {
			select {
			case out <- f:
			case <-ctx.Done():
				return nil
			}
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			return nil
		}
	}
}

func testConfig() straddle.Config {
	return straddle.Config{
		Symbol: "NIFTY", Exchange: "NSE", Expiry: "20991231", SpotSymbol: "NIFTY",
		Contracts: []straddle.Contract{
			{Strike: 24450, Side: "CE", RefID: "24450C"},
			{Strike: 24450, Side: "PE", RefID: "24450P"},
			{Strike: 24500, Side: "CE", RefID: "24500C"},
			{Strike: 24500, Side: "PE", RefID: "24500P"},
			{Strike: 24550, Side: "CE", RefID: "24550C"},
			{Strike: 24550, Side: "PE", RefID: "24550P"},
		},
		ThrottleMs: 10,
	}
}

// waitForPoint reads a subscriber's frames until a point arrives or the wait
// runs out.
func waitForPoint(t *testing.T, sub *Subscriber, within time.Duration) *straddle.Point {
	t.Helper()
	deadline := time.After(within)
	for {
		select {
		case frame, ok := <-sub.Frames():
			if !ok {
				return nil
			}
			var e straddle.Event
			if err := json.Unmarshal(frame, &e); err != nil {
				continue
			}
			if e.Event == "point" && e.Point != nil {
				return e.Point
			}
		case <-deadline:
			return nil
		}
	}
}

func newTestHub() (*Hub, *tickingSource) {
	src := &tickingSource{id: "test", started: make(chan struct{})}
	h := New(func(straddle.Config) []feed.Source { return []feed.Source{src} })
	return h, src
}

func TestSubscriberReceivesPoints(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()

	sub, replay, err := h.Subscribe(testConfig(), 0)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	// A fresh client is about to load history through the ordinary path and does
	// not want it twice, so a zero mark gets an empty, complete replay.
	if len(replay.Points) != 0 || !replay.Complete {
		t.Errorf("fresh subscribe got %d replayed points (complete=%v), want 0 and complete",
			len(replay.Points), replay.Complete)
	}

	pt := waitForPoint(t, sub, 2*time.Second)
	if pt == nil {
		t.Fatal("no point reached the subscriber")
	}
	if pt.AtmStrike != 24500 {
		t.Errorf("strike = %v, want 24500", pt.AtmStrike)
	}
	if pt.StraddlePrice != 200 {
		t.Errorf("straddle mid = %v, want 200", pt.StraddlePrice)
	}
}

// N tabs on one contract must cost one broker subscription, not N.
func TestTwoSubscribersShareOneSession(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()

	cfg := testConfig()
	subA, _, err := h.Subscribe(cfg, 0)
	if err != nil {
		t.Fatalf("subscribe A: %v", err)
	}
	subB, _, err := h.Subscribe(cfg, 0)
	if err != nil {
		t.Fatalf("subscribe B: %v", err)
	}

	if got := len(h.Sessions()); got != 1 {
		t.Fatalf("%d sessions running, want 1", got)
	}
	if got := h.Sessions()[0].Subscribers; got != 2 {
		t.Errorf("session reports %d subscribers, want 2", got)
	}

	// Both must actually receive, not just be counted.
	if waitForPoint(t, subA, 2*time.Second) == nil {
		t.Error("subscriber A received no point")
	}
	if waitForPoint(t, subB, 2*time.Second) == nil {
		t.Error("subscriber B received no point")
	}
}

// The grace period is the whole reason a session outlives its socket: a
// reconnect must find it still computing.
func TestSessionSurvivesItsLastSubscriberForTheGracePeriod(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()
	h.Grace = 500 * time.Millisecond

	cfg := testConfig()
	sub, _, err := h.Subscribe(cfg, 0)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if waitForPoint(t, sub, 2*time.Second) == nil {
		t.Fatal("no point before the drop")
	}

	dropped := time.Now().UnixMilli()
	h.Unsubscribe(cfg, sub)

	// Still running, still computing, with nobody attached.
	time.Sleep(200 * time.Millisecond)
	sessions := h.Sessions()
	if len(sessions) != 1 {
		t.Fatalf("%d sessions inside the grace period, want 1", len(sessions))
	}
	if !sessions[0].RetiringSoon {
		t.Error("an empty session is not marked as retiring")
	}

	// The reconnect: the window holds what the client missed while it was gone.
	rejoined, replay, err := h.Subscribe(cfg, dropped)
	if err != nil {
		t.Fatalf("resubscribe: %v", err)
	}
	if len(replay.Points) == 0 {
		t.Error("the reconnect replayed nothing from a session that kept computing")
	}
	if !replay.Complete {
		t.Error("replay reported incomplete for a gap well inside the window")
	}
	h.Unsubscribe(cfg, rejoined)
}

func TestSessionRetiresOnceTheGraceExpires(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()
	h.Grace = 150 * time.Millisecond

	cfg := testConfig()
	sub, _, err := h.Subscribe(cfg, 0)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	h.Unsubscribe(cfg, sub)

	deadline := time.After(2 * time.Second)
	for len(h.Sessions()) > 0 {
		select {
		case <-deadline:
			t.Fatal("session still running well past its grace period — a closed tab would hold a broker subscription all session")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// A malformed config must fail the subscribe rather than leaving a dead session
// registered under its key.
func TestBadConfigLeavesNoSession(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()

	cfg := testConfig()
	cfg.Contracts = nil
	if _, _, err := h.Subscribe(cfg, 0); err == nil {
		t.Fatal("accepted a config with no contracts")
	}
	if got := len(h.Sessions()); got != 0 {
		t.Errorf("%d sessions left behind by a failed subscribe, want 0", got)
	}
}

// Replay must not require attaching: `resume` asks for the window on a session
// the client is already reading.
func TestReplayReadsWithoutAttaching(t *testing.T) {
	h, _ := newTestHub()
	defer h.Shutdown()

	cfg := testConfig()
	sub, _, err := h.Subscribe(cfg, 0)
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	if waitForPoint(t, sub, 2*time.Second) == nil {
		t.Fatal("no point")
	}

	before := h.Sessions()[0].Subscribers
	replay := h.Replay(cfg, 0)
	if len(replay.Points) == 0 {
		t.Error("replay returned nothing from a session that has emitted points")
	}
	if after := h.Sessions()[0].Subscribers; after != before {
		t.Errorf("replay changed the subscriber count from %d to %d", before, after)
	}

	// An unknown contract gets an empty, incomplete replay rather than an error:
	// "this feed cannot speak for that gap" is the honest answer, and the client
	// already knows what to do with it.
	unknown := cfg
	unknown.Symbol = "BANKNIFTY"
	if got := h.Replay(unknown, 0); got.Complete || len(got.Points) != 0 {
		t.Errorf("replay of an unknown session = %+v, want empty and incomplete", got)
	}
}
