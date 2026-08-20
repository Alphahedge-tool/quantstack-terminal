package feed

import (
	"context"
	"fmt"
	"sync"
	"time"

	"quantstack/compute/metrics"
)

// Router runs ONE source at a time out of a priority-ordered list, and moves to
// the next when the current one cannot serve.
//
// ── Why one at a time, and not all of them ──
//
// Running every feed at once and merging would give a faster failover and a
// worse product. Two brokers do not agree tick for tick: their depth is
// stamped at different instants and their greeks come off different models, so
// a merged stream makes the straddle rule pick whichever broker last refreshed
// rather than whichever strike is genuinely cheapest. It also multiplies the
// cost — every live subscription is billed in session weight against the
// account. One authoritative feed, cleanly replaced, keeps the numbers
// comparable across a failover.
//
// ── Why a breaker and not just a retry ──
//
// A broker that is down is down for every contract, not just this one. Without
// a breaker each session discovers that independently, every few seconds, and
// the reconnect storm is indistinguishable from an attack from the broker's
// side. The breaker is shared across sessions (see SharedBreakers) so the first
// session's failure informs all of them.
type Router struct {
	sources  []Source
	breakers *Breakers

	// Promote is how often the router checks whether a higher-priority feed has
	// recovered while a fallback is serving. Zero uses DefaultPromoteInterval.
	Promote time.Duration

	mu     sync.Mutex
	active string
	frames int64
}

// DefaultPromoteInterval trades a little churn against staying on a degraded
// fallback for the rest of the session. Thirty seconds means a broker that
// comes back is serving again within half a minute, and a broker that flaps is
// tried at most twice a minute.
const DefaultPromoteInterval = 30 * time.Second

// NewRouter takes sources in PRIORITY ORDER — index 0 is preferred. Sources
// with an empty ID are rejected, because the breaker map is keyed by it and two
// anonymous feeds would share one breaker.
func NewRouter(breakers *Breakers, sources ...Source) (*Router, error) {
	if len(sources) == 0 {
		return nil, fmt.Errorf("router needs at least one source")
	}
	seen := map[string]bool{}
	for _, s := range sources {
		id := s.ID()
		if id == "" {
			return nil, fmt.Errorf("source %T has no ID", s)
		}
		if seen[id] {
			return nil, fmt.Errorf("two sources both call themselves %q", id)
		}
		seen[id] = true
	}
	if breakers == nil {
		breakers = NewBreakers()
	}
	return &Router{sources: sources, breakers: breakers}, nil
}

// Active is the feed currently serving, for the status line and /health.
func (r *Router) Active() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.active
}

// Frames is how many data frames the router has forwarded in total.
func (r *Router) Frames() int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.frames
}

func (r *Router) setActive(id string) {
	r.mu.Lock()
	previous := r.active
	r.active = id
	r.mu.Unlock()

	// Exactly one qt_feed_active series should read 1. Clearing the previous one
	// here rather than at every call site is what keeps that true across a
	// failover, a promotion and a teardown alike.
	if previous != "" {
		metrics.Active.WithLabelValues(previous).Set(0)
	}
	if id != "" {
		metrics.Active.WithLabelValues(id).Set(1)
		if previous != "" && previous != id {
			metrics.Failovers.WithLabelValues(previous, id).Inc()
		}
	}
}

// pick returns the highest-priority source whose breaker will let it run, and
// how long until the next one becomes available if none will.
func (r *Router) pick(now time.Time) (Source, time.Duration) {
	soonest := time.Duration(0)
	for _, s := range r.sources {
		wait := r.breakers.Wait(s.ID(), now)
		if wait <= 0 {
			return s, 0
		}
		if soonest == 0 || wait < soonest {
			soonest = wait
		}
	}
	return nil, soonest
}

// Run serves `spec` until the context is cancelled.
//
// It only returns an error when every source has been tried and none can run at
// all — which is a genuine "this contract cannot be served" and is what the
// caller reports to the client. A source that merely fails is demoted, not
// fatal.
func (r *Router) Run(ctx context.Context, spec Spec, out chan<- Event) error {
	for ctx.Err() == nil {
		src, wait := r.pick(time.Now())
		if src == nil {
			// Everything is in cooldown. Waiting is right: the alternative is
			// returning an error the caller can only respond to by retrying, which
			// is the same wait with more churn in between.
			EmitBlocking(ctx, out, Event{
				Channel: ChanStatus, Status: "waiting",
				Message: fmt.Sprintf("Every feed is in cooldown; next attempt in %s", wait.Round(time.Second)),
			})
			t := time.NewTimer(wait)
			select {
			case <-t.C:
				continue
			case <-ctx.Done():
				t.Stop()
				return nil
			}
		}

		id := src.ID()
		r.setActive(id)
		EmitBlocking(ctx, out, Event{
			Feed: id, Channel: ChanStatus, Status: "feed",
			Message: fmt.Sprintf("Serving from %s", id),
		})

		err := r.serve(ctx, src, spec, out)
		r.setActive("")

		if ctx.Err() != nil {
			return nil
		}

		if err == nil {
			// A source that returns cleanly without the context ending has decided
			// it is finished with this spec — end of the post-market snapshot, say.
			// Not a failure, so no breaker trip, but there is nothing left to do.
			EmitBlocking(ctx, out, Event{
				Feed: id, Channel: ChanStatus, Status: "ended",
				Message: fmt.Sprintf("%s finished this subscription", id),
			})
			return nil
		}

		cooldown := r.breakers.Trip(id, time.Now())
		EmitBlocking(ctx, out, Event{
			Feed: id, Channel: ChanStatus, Status: "failover",
			Message: fmt.Sprintf("%s failed (%v); parked for %s", id, err, cooldown.Round(time.Second)),
		})
	}
	return nil
}

// serve runs one source and forwards its events, cancelling it early if a
// higher-priority feed becomes available again.
//
// The forwarding is not a plain copy: every data frame both resets that
// source's breaker (proof it works, not just that it connected) and is counted,
// so /health can distinguish a feed that is serving from one that is merely
// selected.
func (r *Router) serve(ctx context.Context, src Source, spec Spec, out chan<- Event) error {
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	id := src.ID()
	preferred := r.higherPriority(id)

	raw := make(chan Event, 512)
	errc := make(chan error, 1)
	go func() { errc <- src.Run(runCtx, spec, raw) }()

	promote := r.Promote
	if promote <= 0 {
		promote = DefaultPromoteInterval
	}
	var promoteTick <-chan time.Time
	if len(preferred) > 0 {
		ticker := time.NewTicker(promote)
		defer ticker.Stop()
		promoteTick = ticker.C
	}

	for {
		select {
		case <-ctx.Done():
			cancel()
			<-errc
			return nil

		case e, ok := <-raw:
			if !ok {
				return <-errc
			}
			if e.Feed == "" {
				e.Feed = id
			}
			if e.Channel.IsData() {
				r.breakers.Succeed(id, time.Now())
				r.mu.Lock()
				r.frames++
				r.mu.Unlock()
				metrics.Frames.WithLabelValues(id, string(e.Channel)).Inc()
				if !Emit(ctx, out, e) {
					metrics.FramesDropped.WithLabelValues(id).Inc()
				}
			} else {
				EmitBlocking(ctx, out, e)
			}

		case err := <-errc:
			// Drain whatever the source published on its way out — the last frames
			// before a failure are usually the ones that explain it.
			for {
				select {
				case e := <-raw:
					if e.Feed == "" {
						e.Feed = id
					}
					EmitBlocking(ctx, out, e)
					continue
				default:
				}
				break
			}
			if err == nil {
				return nil
			}
			return err

		case <-promoteTick:
			now := time.Now()
			for _, better := range preferred {
				if r.breakers.Wait(better, now) > 0 {
					continue
				}
				EmitBlocking(ctx, out, Event{
					Feed: id, Channel: ChanStatus, Status: "promoting",
					Message: fmt.Sprintf("%s is available again; switching back from %s", better, id),
				})
				cancel()
				<-errc
				// Nil, not an error: this source did nothing wrong, and tripping its
				// breaker on the way out would park a healthy feed.
				return nil
			}
		}
	}
}

// higherPriority is every source ranked above id.
func (r *Router) higherPriority(id string) []string {
	var out []string
	for _, s := range r.sources {
		if s.ID() == id {
			break
		}
		out = append(out, s.ID())
	}
	return out
}

// ── Breakers ─────────────────────────────────────────────────────────────────

// Breakers tracks per-feed failure state, shared across every live session in
// the process.
//
// Sharing is the point. Ten contracts subscribed to a broker that just started
// refusing connections would otherwise each spend their own backoff schedule
// discovering it; with one breaker, the first failure parks the feed for all
// ten and the tenth session fails over immediately.
type Breakers struct {
	mu    sync.Mutex
	state map[string]*breaker

	// Base and Max bound the cooldown. Exported so a deployment that knows its
	// broker's tolerance can widen them without a rebuild.
	Base, Max time.Duration
}

type breaker struct {
	consecutive int
	openUntil   time.Time
	lastFailure time.Time
	lastData    time.Time
	trips       int64
}

func NewBreakers() *Breakers {
	return &Breakers{
		state: map[string]*breaker{},
		Base:  5 * time.Second,
		Max:   5 * time.Minute,
	}
}

func (b *Breakers) get(id string) *breaker {
	st, ok := b.state[id]
	if !ok {
		st = &breaker{}
		b.state[id] = st
	}
	return st
}

// Wait is how long until this feed may be tried, zero meaning now.
func (b *Breakers) Wait(id string, now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.get(id)
	if now.Before(st.openUntil) {
		return st.openUntil.Sub(now)
	}
	return 0
}

// Trip records a failure and returns the cooldown applied.
//
// Doubling per consecutive failure, capped. The cap matters more than the
// growth: without it a broker that is down over a lunch break would be parked
// for hours after it came back, and the session would spend the afternoon on a
// fallback nobody chose.
func (b *Breakers) Trip(id string, now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.get(id)
	st.consecutive++
	st.trips++
	st.lastFailure = now

	metrics.BreakerOpen.WithLabelValues(id).Set(1)

	cooldown := b.Base << min(st.consecutive-1, 16)
	if cooldown > b.Max || cooldown <= 0 {
		cooldown = b.Max
	}
	cooldown += time.Duration(float64(cooldown) * 0.25 * jitter())
	st.openUntil = now.Add(cooldown)
	return cooldown
}

// Succeed clears the failure count.
//
// Called on DATA, never on connect — the whole reason this package judges feeds
// on data is that connecting proves nothing about whether ticks will follow.
func (b *Breakers) Succeed(id string, now time.Time) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st := b.get(id)
	st.consecutive = 0
	st.openUntil = time.Time{}
	st.lastData = now
	metrics.BreakerOpen.WithLabelValues(id).Set(0)
}

// Health is the reportable state of one feed.
type Health struct {
	ID          string `json:"id"`
	Available   bool   `json:"available"`
	CooldownMs  int64  `json:"cooldownMs"`
	Consecutive int    `json:"consecutiveFailures"`
	Trips       int64  `json:"trips"`
	LastDataMs  int64  `json:"lastDataMs,omitempty"`
	LastFailMs  int64  `json:"lastFailureMs,omitempty"`
}

// Snapshot reports every feed the breakers have ever seen.
func (b *Breakers) Snapshot(now time.Time) []Health {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]Health, 0, len(b.state))
	for id, st := range b.state {
		h := Health{
			ID:          id,
			Available:   !now.Before(st.openUntil),
			Consecutive: st.consecutive,
			Trips:       st.trips,
		}
		if now.Before(st.openUntil) {
			h.CooldownMs = st.openUntil.Sub(now).Milliseconds()
		}
		if !st.lastData.IsZero() {
			h.LastDataMs = st.lastData.UnixMilli()
		}
		if !st.lastFailure.IsZero() {
			h.LastFailMs = st.lastFailure.UnixMilli()
		}
		out = append(out, h)
	}
	return out
}
