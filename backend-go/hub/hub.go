// Package hub is the fan-out layer: it owns live sessions, keyed by contract,
// and the WebSocket connections that read from them.
//
// ── Why a session outlives the socket that asked for it ──
//
// This is the same design backend/live/wsStraddle.ts arrived at, and for the
// same reason. The feed only ever sends the present, so anything a client is
// not connected for is lost to it permanently. The case that matters most is a
// tab left in the background for an hour whose socket the OS, the browser or an
// intermediary quietly dropped. Tearing the session down the moment that socket
// closed meant the reconnect respawned the bridge, waited seconds for depth to
// arm, and started emitting from *now* — with the intervening minutes missing
// from the live feed and from the chart.
//
// So:
//
//   - Subscribers fan out from one session, so N tabs on one contract cost one
//     broker subscription instead of N.
//   - Losing the last subscriber starts a grace timer rather than a stop, so the
//     session keeps computing across a reconnect and the client's `since`
//     replays the hole out of the engine's retained window.
//   - Complete:false on that replay is the honest answer when the gap is older
//     than the window: the client refills from history instead.
//
// A `stop` from a client is still a stop — it means "I am done", not "I dropped"
// — but only of that client's own subscription; the session goes when nobody is
// left and the grace period expires.
package hub

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"quantstack/compute/feed"
	"quantstack/compute/metrics"
	"quantstack/compute/straddle"
)

// DefaultGrace is how long a session with no subscribers keeps running.
//
// Long enough to cover a reconnect that has to wait out a laptop waking up or a
// network coming back; short enough that a closed tab does not hold a broker
// subscription for the rest of the session.
const DefaultGrace = 2 * time.Minute

// SendQueue is how many frames may be outstanding to one slow client.
//
// A client that cannot keep up is DISCONNECTED rather than allowed to back the
// session up: the alternative is one stalled browser throttling the compute
// loop that every other subscriber reads from. It reconnects and replays.
const SendQueue = 512

// Hub holds every live session in the process.
type Hub struct {
	mu       sync.Mutex
	sessions map[string]*session

	// NewSource builds the ordered feed list for a session. Injected rather than
	// hardcoded so a test can drive the whole hub off a scripted source without
	// a broker, a token or a Python interpreter.
	NewSources func(straddle.Config) []feed.Source

	Breakers *feed.Breakers
	Grace    time.Duration
}

func New(newSources func(straddle.Config) []feed.Source) *Hub {
	h := &Hub{
		sessions:   map[string]*session{},
		NewSources: newSources,
		Breakers:   feed.NewBreakers(),
		Grace:      DefaultGrace,
	}
	registerOnce.Do(func() {
		// Read at scrape time from the hub, never incremented at the call sites
		// — a session ends through four different paths and the one that forgot
		// would leave the gauge wrong forever.
		metrics.RegisterHub(
			func() float64 { return float64(len(h.Sessions())) },
			func() float64 {
				var total int
				for _, s := range h.Sessions() {
					total += s.Subscribers
				}
				return float64(total)
			},
		)
	})
	return h
}

// One process serves one hub; the tests build several, and registering a
// duplicate collector name would panic the suite rather than the server.
var registerOnce sync.Once

// ── Subscribers ──────────────────────────────────────────────────────────────

// Subscriber is one client's view of a session.
type Subscriber struct {
	out    chan []byte
	closed chan struct{}
	once   sync.Once
}

func newSubscriber() *Subscriber {
	return &Subscriber{out: make(chan []byte, SendQueue), closed: make(chan struct{})}
}

// Frames is the stream of encoded events to write to the socket. It closes when
// the subscriber is dropped.
func (s *Subscriber) Frames() <-chan []byte { return s.out }

// Close detaches this subscriber. Idempotent: a socket error and an explicit
// stop from the client both land here, often at the same moment.
func (s *Subscriber) Close() {
	s.once.Do(func() {
		close(s.closed)
		close(s.out)
	})
}

// send never blocks. See SendQueue for why a slow client is dropped rather than
// waited for.
func (s *Subscriber) send(frame []byte) bool {
	select {
	case <-s.closed:
		return false
	default:
	}
	select {
	case s.out <- frame:
		return true
	default:
		// One drop is a laptop that went to sleep. A RATE means the fan-out is
		// producing faster than a browser can render, which the user sees as a
		// chart that freezes and then jumps.
		metrics.SubscriberDrops.Inc()
		s.Close()
		return false
	}
}

// ── Sessions ─────────────────────────────────────────────────────────────────

type session struct {
	key    string
	cfg    straddle.Config
	engine *straddle.Engine
	cancel context.CancelFunc

	mu    sync.Mutex
	subs  map[*Subscriber]struct{}
	grace *time.Timer

	// last carries the most recent status and state frames, replayed to a client
	// the moment it attaches. Without it a tab that joins a running session sees
	// nothing at all until the next tick, which outside market hours is never.
	lastStatus []byte
	lastState  []byte

	startedAt time.Time
	done      chan struct{}
}

// Subscribe attaches a client to the session for this contract, starting one if
// there is not already a session running.
//
// The returned Replay is what the client missed since `sinceMs`; a zero
// `sinceMs` means "I have no history", and gets an empty, complete replay
// rather than the whole retained window — a fresh client is about to load
// history through the ordinary path and does not want it twice.
func (h *Hub) Subscribe(cfg straddle.Config, sinceMs int64) (*Subscriber, straddle.Replay, error) {
	key := cfg.Key()

	h.mu.Lock()
	sess, existed := h.sessions[key]
	if !existed {
		created, err := h.start(cfg)
		if err != nil {
			h.mu.Unlock()
			metrics.SessionsStarted.WithLabelValues("rejected").Inc()
			return nil, straddle.Replay{}, err
		}
		sess = created
		h.sessions[key] = sess
		metrics.SessionsStarted.WithLabelValues("started").Inc()
	}
	h.mu.Unlock()

	sub := newSubscriber()

	sess.mu.Lock()
	// Cancelling the grace timer is what makes a reconnect free: the session was
	// already computing, so the client rejoins a warm feed instead of respawning
	// a subscription and waiting for depth.
	if sess.grace != nil {
		sess.grace.Stop()
		sess.grace = nil
	}
	sess.subs[sub] = struct{}{}
	status, state := sess.lastStatus, sess.lastState
	sess.mu.Unlock()

	if status != nil {
		sub.send(status)
	}
	if state != nil {
		sub.send(state)
	}

	var replay straddle.Replay
	if sinceMs > 0 {
		replay = sess.engine.ReplaySince(sinceMs)
	} else {
		replay.Complete = true
	}
	return sub, replay, nil
}

// Replay re-reads the retained window of a RUNNING session without attaching.
//
// This is what a `resume` asks for: the client is already attached and only
// wants the hole its socket was down for. Going through Subscribe would attach a
// second time and then detach, which is harmless today but only because the
// grace timer happens not to fire while another subscriber is present — a
// coincidence, not a design.
//
// A session that is no longer running gets an incomplete, empty replay rather
// than an error: the honest answer is "this feed cannot speak for that gap",
// and the client already knows what to do with Complete:false.
func (h *Hub) Replay(cfg straddle.Config, sinceMs int64) straddle.Replay {
	h.mu.Lock()
	sess := h.sessions[cfg.Key()]
	h.mu.Unlock()
	if sess == nil {
		return straddle.Replay{Points: []straddle.Point{}, Rolls: []straddle.Roll{}}
	}
	return sess.engine.ReplaySince(sinceMs)
}

// Unsubscribe detaches a client and arms the grace timer if it was the last.
func (h *Hub) Unsubscribe(cfg straddle.Config, sub *Subscriber) {
	key := cfg.Key()

	h.mu.Lock()
	sess := h.sessions[key]
	h.mu.Unlock()
	if sess == nil {
		sub.Close()
		return
	}

	sess.mu.Lock()
	delete(sess.subs, sub)
	empty := len(sess.subs) == 0
	if empty && sess.grace == nil {
		grace := h.Grace
		if grace <= 0 {
			grace = DefaultGrace
		}
		sess.grace = time.AfterFunc(grace, func() { h.retire(key, sess) })
	}
	sess.mu.Unlock()
	sub.Close()
}

// retire stops a session that is still empty when its grace expires.
func (h *Hub) retire(key string, sess *session) {
	h.mu.Lock()
	defer h.mu.Unlock()

	sess.mu.Lock()
	stillEmpty := len(sess.subs) == 0
	sess.mu.Unlock()
	if !stillEmpty {
		return
	}
	// Only remove the session that is actually registered: a client may have
	// reconnected, found the map empty and started a fresh session under the
	// same key while this timer was in flight, and retiring THAT one would kill
	// a subscription somebody is watching.
	if h.sessions[key] != sess {
		return
	}
	delete(h.sessions, key)
	sess.cancel()
	log.Printf("[hub] retired %s after %s", key, time.Since(sess.startedAt).Round(time.Second))
}

// start builds and launches a session. Caller holds h.mu.
func (h *Hub) start(cfg straddle.Config) (*session, error) {
	sess := &session{
		key:       cfg.Key(),
		cfg:       cfg,
		subs:      map[*Subscriber]struct{}{},
		startedAt: time.Now(),
		done:      make(chan struct{}),
	}

	engine, err := straddle.New(cfg, sess.broadcast)
	if err != nil {
		return nil, err
	}
	sess.engine = engine

	router, err := feed.NewRouter(h.Breakers, h.NewSources(cfg)...)
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithCancel(context.Background())
	sess.cancel = cancel

	go func() {
		defer close(sess.done)
		if err := engine.Run(ctx, router); err != nil {
			sess.broadcast(straddle.Event{Event: "error", Message: err.Error()})
		}
		// A session whose engine has returned cannot serve anyone; drop it so the
		// next subscribe starts a fresh one rather than attaching to a corpse.
		h.mu.Lock()
		if h.sessions[sess.key] == sess {
			delete(h.sessions, sess.key)
		}
		h.mu.Unlock()
		sess.closeAll()
	}()

	log.Printf("[hub] started %s — %d strikes", sess.key, engine.Strikes())
	return sess, nil
}

// broadcast encodes once and fans the frame out.
//
// Encoding once rather than per subscriber is the difference between one
// marshal per point and one per point per open tab — and a chain with a dozen
// tabs on it is an ordinary trading desk.
func (s *session) broadcast(e straddle.Event) {
	frame, err := json.Marshal(e)
	if err != nil {
		log.Printf("[hub] could not encode %s event: %v", e.Event, err)
		return
	}

	s.mu.Lock()
	switch e.Event {
	case "status":
		s.lastStatus = frame
	case "state":
		s.lastState = frame
	}
	subs := make([]*Subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.mu.Unlock()

	for _, sub := range subs {
		sub.send(frame)
	}
}

func (s *session) closeAll() {
	s.mu.Lock()
	subs := make([]*Subscriber, 0, len(s.subs))
	for sub := range s.subs {
		subs = append(subs, sub)
	}
	s.subs = map[*Subscriber]struct{}{}
	s.mu.Unlock()
	for _, sub := range subs {
		sub.Close()
	}
}

// ── Introspection ────────────────────────────────────────────────────────────

// SessionInfo is one running session, for /health.
type SessionInfo struct {
	Key          string `json:"key"`
	Symbol       string `json:"symbol"`
	Exchange     string `json:"exchange"`
	Expiry       string `json:"expiry"`
	Subscribers  int    `json:"subscribers"`
	Strikes      int    `json:"strikes"`
	UptimeMs     int64  `json:"uptimeMs"`
	LastPointMs  int64  `json:"lastPointMs,omitempty"`
	RetiringSoon bool   `json:"retiringSoon"`
}

func (h *Hub) Sessions() []SessionInfo {
	h.mu.Lock()
	sessions := make([]*session, 0, len(h.sessions))
	for _, s := range h.sessions {
		sessions = append(sessions, s)
	}
	h.mu.Unlock()

	out := make([]SessionInfo, 0, len(sessions))
	for _, s := range sessions {
		s.mu.Lock()
		info := SessionInfo{
			Key:          s.key,
			Symbol:       feed.Upper(s.cfg.Symbol),
			Exchange:     feed.Upper(s.cfg.Exchange),
			Expiry:       feed.Compact(s.cfg.Expiry),
			Subscribers:  len(s.subs),
			Strikes:      s.engine.Strikes(),
			UptimeMs:     time.Since(s.startedAt).Milliseconds(),
			LastPointMs:  s.engine.LastPointTime(),
			RetiringSoon: s.grace != nil,
		}
		s.mu.Unlock()
		out = append(out, info)
	}
	return out
}

// Shutdown stops every session. Called on SIGINT so the Python children go with
// the parent rather than being orphaned holding broker subscriptions.
func (h *Hub) Shutdown() {
	h.mu.Lock()
	sessions := make([]*session, 0, len(h.sessions))
	for key, s := range h.sessions {
		sessions = append(sessions, s)
		delete(h.sessions, key)
	}
	h.mu.Unlock()

	for _, s := range sessions {
		s.cancel()
	}
	for _, s := range sessions {
		select {
		case <-s.done:
		case <-time.After(3 * time.Second):
			log.Printf("[hub] %s did not stop in time", s.key)
		}
		s.closeAll()
	}
}
