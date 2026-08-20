package feed

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// fakeSource is a Source whose behaviour a test dictates: fail immediately,
// publish and hold, or publish and then fail.
type fakeSource struct {
	id     string
	fail   error
	frames int
	runs   atomic.Int64
	hold   bool
}

func (f *fakeSource) ID() string { return f.id }

func (f *fakeSource) Run(ctx context.Context, _ Spec, out chan<- Event) error {
	f.runs.Add(1)
	for i := 0; i < f.frames; i++ {
		select {
		case out <- Event{Feed: f.id, Channel: ChanOption, Data: map[string]any{"n": i}}:
		case <-ctx.Done():
			return nil
		}
	}
	if f.fail != nil {
		return f.fail
	}
	if f.hold {
		<-ctx.Done()
	}
	return nil
}

// collect drains a router for a while and reports what came out.
func collect(t *testing.T, r *Router, d time.Duration) (data []Event, status []Event) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()

	out := make(chan Event, 256)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = r.Run(ctx, Spec{Symbol: "NIFTY"}, out)
	}()

	deadline := time.After(d)
	for {
		select {
		case e := <-out:
			if e.Channel.IsData() {
				data = append(data, e)
			} else {
				status = append(status, e)
			}
		case <-deadline:
			cancel()
			<-done
			return data, status
		}
	}
}

// The primary serves while it can; a failure promotes the next feed rather than
// ending the subscription.
func TestFailoverPromotesTheNextFeed(t *testing.T) {
	primary := &fakeSource{id: "primary", fail: errors.New("token expired")}
	backup := &fakeSource{id: "backup", frames: 3, hold: true}

	r, err := NewRouter(NewBreakers(), primary, backup)
	if err != nil {
		t.Fatalf("router: %v", err)
	}

	data, status := collect(t, r, 400*time.Millisecond)

	if backup.runs.Load() == 0 {
		t.Fatal("backup was never tried after the primary failed")
	}
	if len(data) < 3 {
		t.Errorf("forwarded %d data frames, want at least the backup's 3", len(data))
	}
	var sawFailover bool
	for _, s := range status {
		if s.Status == "failover" {
			sawFailover = true
		}
	}
	if !sawFailover {
		t.Error("no failover status was published; a switch must be visible in the stream")
	}
}

// A feed that is down is down for every contract, so the first failure must
// park it for all of them rather than each session rediscovering it.
func TestBreakerParksAFailedFeed(t *testing.T) {
	b := NewBreakers()
	b.Base = 50 * time.Millisecond

	if wait := b.Wait("nubra", time.Now()); wait != 0 {
		t.Fatalf("a feed with no history is already parked for %s", wait)
	}

	now := time.Now()
	first := b.Trip("nubra", now)
	if b.Wait("nubra", now) <= 0 {
		t.Fatal("a tripped breaker did not park the feed")
	}
	// Doubling per consecutive failure, so a broker that is genuinely down is
	// tried less and less rather than hammered.
	second := b.Trip("nubra", now)
	if second <= first {
		t.Errorf("second cooldown %s is not longer than the first %s", second, first)
	}

	// Data — not a successful connect — is what clears it.
	b.Succeed("nubra", now)
	if wait := b.Wait("nubra", now); wait != 0 {
		t.Errorf("feed still parked for %s after publishing data", wait)
	}
}

func TestBreakerCooldownIsCapped(t *testing.T) {
	b := NewBreakers()
	b.Base = time.Second
	b.Max = 2 * time.Second

	now := time.Now()
	var last time.Duration
	for i := 0; i < 10; i++ {
		last = b.Trip("nubra", now)
	}
	// The cap plus its jitter. Without a cap, a broker that was down over lunch
	// would stay parked for hours after coming back.
	if last > b.Max+b.Max/4 {
		t.Errorf("cooldown grew to %s, past the %s cap", last, b.Max)
	}
}

// Health is what /health reports, and it must distinguish a feed that is
// serving from one that is merely known about.
func TestSnapshotReportsPerFeedState(t *testing.T) {
	b := NewBreakers()
	now := time.Now()
	b.Succeed("nubra", now)
	b.Trip("zerodha", now)

	byID := map[string]Health{}
	for _, h := range b.Snapshot(now) {
		byID[h.ID] = h
	}
	if !byID["nubra"].Available {
		t.Error("a feed that just published data is reported unavailable")
	}
	if byID["zerodha"].Available {
		t.Error("a tripped feed is reported available")
	}
	if byID["zerodha"].CooldownMs <= 0 {
		t.Error("a tripped feed reports no cooldown")
	}
	if byID["nubra"].LastDataMs == 0 {
		t.Error("no last-data stamp on a feed that published")
	}
}

// Backoff must not reset merely because a source connected — connecting proves
// nothing about whether ticks follow.
func TestBackoffGrowsAndStaysAboveMin(t *testing.T) {
	b := NewBackoff(10*time.Millisecond, 100*time.Millisecond)
	for i := 0; i < 20; i++ {
		d := b.Next()
		if d < b.Min {
			t.Fatalf("delay %s fell below the floor %s", d, b.Min)
		}
		if d > b.Max {
			t.Fatalf("delay %s exceeded the cap %s", d, b.Max)
		}
	}
	if b.Attempt() != 20 {
		t.Errorf("attempt = %d, want 20", b.Attempt())
	}
	b.Reset()
	if b.Attempt() != 0 {
		t.Error("reset did not clear the schedule")
	}
}

// Two sources under one name would share a breaker, so one failing would park
// the other.
func TestRouterRejectsDuplicateFeedIDs(t *testing.T) {
	a := &fakeSource{id: "same"}
	b := &fakeSource{id: "same"}
	if _, err := NewRouter(NewBreakers(), a, b); err == nil {
		t.Fatal("accepted two sources with the same ID")
	}
	if _, err := NewRouter(NewBreakers()); err == nil {
		t.Fatal("accepted a router with no sources")
	}
}

func TestCompactAndUpperNormalise(t *testing.T) {
	if got := Compact(" 2026-08-11 "); got != "20260811" {
		t.Errorf("Compact = %q, want 20260811", got)
	}
	if got := Upper(" mcx "); got != "MCX" {
		t.Errorf("Upper = %q, want MCX", got)
	}
}
