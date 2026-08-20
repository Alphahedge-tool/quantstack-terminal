// Command marketd is the live market engine.
//
// ── What moved here, and why ──
//
// `computed` (stage 1) was stateless: Node held the ticks and sent batches of
// numbers over for solving. That took the Black-76 loop off the event loop but
// left everything else on it — the socket, the per-tick parse, the depth book,
// the selection rule, the throttle timer — all sharing one thread with every
// HTTP route the terminal serves. A chain publishing a few hundred frames a
// second is enough to make an unrelated /api call wait behind a JSON.parse.
//
// So this process takes the whole hot path: it opens the subscription, decodes
// every frame, keeps the books, tracks OI and volume, runs the rolling-ATM
// straddle rule, solves the vol, derives the greeks, aggregates the bars, and
// publishes finished points over a WebSocket. Node keeps what only Node can do
// — logins, credentials, the instrument cache, the routes, the assistant — and
// hands this process a contract table and a token.
//
// ── What this process is NOT allowed to do ──
//
// It never logs in, never stores a credential, never writes to the database and
// never reads refdata. Every one of those already works in Node and a second
// implementation would be a second thing to keep correct. The token it holds is
// the one Node minted, for as long as the session runs, and it goes no further
// than the broker's socket.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"quantstack/compute/api"
	"quantstack/compute/feed"
	"quantstack/compute/hub"
	"quantstack/compute/market"
	"quantstack/compute/metrics"
	"quantstack/compute/straddle"
)

const service = "quantstack-marketd"

// LiveStraddlePath mirrors the path backend/live/wsStraddle.ts already serves,
// so the frontend protocol is unchanged whichever process is behind it.
const LiveStraddlePath = "/ws/live/straddle"

// ── Client protocol ──────────────────────────────────────────────────────────
//
// JSON both ways, one message per frame, and the same verbs the TypeScript
// channel speaks:
//
//	→ { type: 'subscribe', symbol, exchange, expiry, contracts, token, ... , since? }
//	→ { type: 'resume', since }
//	→ { type: 'ping' }
//	→ { type: 'stop' }
//
//	← { event: 'status',   status, message? }
//	← { event: 'point',    point, roll? }
//	← { event: 'bar',      bar }
//	← { event: 'state',    status, bar }        market clock
//	← { event: 'backfill', points, rolls, complete }
//	← { event: 'pong',     t }
//	← { event: 'error',    message }

type clientMessage struct {
	Type  string `json:"type"`
	Since int64  `json:"since,omitempty"`
	// The subscribe frame carries a whole straddle.Config inline. Flattened
	// rather than nested so the frame Node sends is the frame the browser
	// protocol already looks like.
	straddle.Config
}

type backfillFrame struct {
	Event    string           `json:"event"`
	Points   []straddle.Point `json:"points"`
	Rolls    []straddle.Roll  `json:"rolls"`
	Complete bool             `json:"complete"`
}

// ── Connection handling ──────────────────────────────────────────────────────

const (
	// writeWait bounds a single frame write. A client whose TCP window has
	// closed must not be able to hold the writer goroutine indefinitely.
	writeWait = 10 * time.Second
	// pongWait / pingPeriod detect the half-open connection that is the whole
	// reason the session survives its socket: a dropped tab looks exactly like a
	// quiet one until a ping goes unanswered.
	pongWait   = 70 * time.Second
	pingPeriod = 25 * time.Second
	// maxMessage caps an inbound frame. The largest legitimate one is a subscribe
	// carrying a full contract table — a few hundred KB at the widest chain.
	maxMessage = 4 << 20
)

type server struct {
	hub      *hub.Hub
	upgrader websocket.Upgrader
	started  time.Time

	mu    sync.Mutex
	conns int
}

func (s *server) handleLive(w http.ResponseWriter, r *http.Request) {
	conn, err := s.upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade has already written its own response.
		log.Printf("[marketd] upgrade failed: %v", err)
		return
	}

	s.mu.Lock()
	s.conns++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.conns--
		s.mu.Unlock()
		conn.Close()
	}()

	conn.SetReadLimit(maxMessage)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// One writer goroutine, always. Gorilla permits exactly one concurrent
	// writer, and the two things that write here — the fan-out from the session
	// and the keepalive ping — run on different clocks. Funnelling both through
	// one goroutine is what makes that safe without a mutex around the socket.
	writes := make(chan []byte, hub.SendQueue)
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		ping := time.NewTicker(pingPeriod)
		defer ping.Stop()
		for {
			select {
			case frame, ok := <-writes:
				if !ok {
					_ = conn.WriteControl(websocket.CloseMessage,
						websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
						time.Now().Add(writeWait))
					return
				}
				_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
				if err := conn.WriteMessage(websocket.TextMessage, frame); err != nil {
					return
				}
			case <-ping.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(writeWait)); err != nil {
					return
				}
			}
		}
	}()

	var (
		sub      *hub.Subscriber
		cfg      straddle.Config
		pumpDone chan struct{}
		writeMu  sync.Mutex
		closed   bool
	)

	send := func(v any) {
		frame, err := json.Marshal(v)
		if err != nil {
			return
		}
		writeMu.Lock()
		defer writeMu.Unlock()
		if closed {
			return
		}
		select {
		case writes <- frame:
		default:
			// The client is not draining. Dropping the frame keeps the session's
			// broadcast loop free; the socket will fail its next ping and the
			// client reconnects with a `since`.
		}
	}
	sendErr := func(msg string) {
		send(map[string]any{"event": "error", "message": msg})
	}

	detach := func() {
		if sub == nil {
			return
		}
		s.hub.Unsubscribe(cfg, sub)
		if pumpDone != nil {
			<-pumpDone
			pumpDone = nil
		}
		sub = nil
	}

	defer func() {
		detach()
		writeMu.Lock()
		closed = true
		close(writes)
		writeMu.Unlock()
		<-writerDone
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			return
		}

		var msg clientMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			sendErr("Malformed message: " + err.Error())
			continue
		}

		switch strings.ToLower(strings.TrimSpace(msg.Type)) {
		case "ping":
			send(map[string]any{"event": "pong", "t": time.Now().UnixMilli()})

		case "stop":
			// An explicit stop is this client saying "I am done" — not "I dropped".
			// It detaches only this subscription; the session goes when nobody is
			// left and the grace period expires.
			detach()
			send(map[string]any{"event": "status", "status": "stopped"})

		case "subscribe":
			detach()
			cfg = msg.Config

			attached, replay, err := s.hub.Subscribe(cfg, msg.Since)
			if err != nil {
				sendErr(err.Error())
				continue
			}
			sub = attached

			// The backfill goes out BEFORE the live stream is pumped, so the client
			// never has to reorder a point that arrived while it was reading its
			// own history.
			if msg.Since > 0 || len(replay.Points) > 0 {
				send(backfillFrame{
					Event:    "backfill",
					Points:   nonNilPoints(replay.Points),
					Rolls:    nonNilRolls(replay.Rolls),
					Complete: replay.Complete,
				})
			}

			pumpDone = make(chan struct{})
			go func(sub *hub.Subscriber, done chan struct{}) {
				defer close(done)
				for frame := range sub.Frames() {
					writeMu.Lock()
					if closed {
						writeMu.Unlock()
						return
					}
					select {
					case writes <- frame:
					default:
					}
					writeMu.Unlock()
				}
			}(sub, pumpDone)

		case "resume":
			if sub == nil {
				sendErr("resume before subscribe")
				continue
			}
			// Resume never restarts the session — it only re-reads the window the
			// session has been filling all along, which is the whole reason the
			// session outlives the socket.
			replay := s.hub.Replay(cfg, msg.Since)
			send(backfillFrame{
				Event:    "backfill",
				Points:   nonNilPoints(replay.Points),
				Rolls:    nonNilRolls(replay.Rolls),
				Complete: replay.Complete,
			})

		default:
			sendErr("Unknown message type " + msg.Type)
		}
	}
}

// nonNilPoints and nonNilRolls keep an empty replay as `[]` rather than `null`.
// A client that does `points.length` on null throws, and an empty backfill is
// the ordinary case on a first subscribe.
func nonNilPoints(p []straddle.Point) []straddle.Point {
	if p == nil {
		return []straddle.Point{}
	}
	return p
}

func nonNilRolls(r []straddle.Roll) []straddle.Roll {
	if r == nil {
		return []straddle.Roll{}
	}
	return r
}

// ── Sources ──────────────────────────────────────────────────────────────────

// sourcesFor builds the priority-ordered feed list for a session.
//
// One entry today, and the list is still worth having: the router's contract is
// what a second broker plugs into, and building it here means adding one is a
// change to this function rather than to the engine. See the TEMPLATE in
// backend/feeds/adapters/ for the Node-side half of the same idea.
func sourcesFor(cfg straddle.Config) []feed.Source {
	silence := feed.DefaultSilence
	if v := os.Getenv("QT_FEED_SILENCE_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			silence = time.Duration(n) * time.Second
		}
	}
	return []feed.Source{
		&feed.BridgeSource{Silence: silence},
	}
}

// ── Main ─────────────────────────────────────────────────────────────────────

func main() {
	port := envOr("QT_MARKETD_PORT", "3152")
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatalf("[marketd] QT_MARKETD_PORT=%q is not a port", port)
	}
	// Loopback by default. This socket carries a live broker token in every
	// subscribe frame, and a bind to 0.0.0.0 would put that on the LAN.
	// Overridable for a container, where loopback means the container's own.
	host := envOr("QT_MARKETD_HOST", "127.0.0.1")

	srv := &server{
		hub:     hub.New(sourcesFor),
		started: time.Now(),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 64 * 1024,
			// Node is the only intended client and it does not send an Origin.
			// A browser connecting directly is fine too: the subscribe frame
			// carries its own credentials, so an origin check would gate nothing
			// that the token does not already gate.
			CheckOrigin: func(*http.Request) bool { return true },
		},
	}
	if v := os.Getenv("QT_LIVE_GRACE_SEC"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			srv.hub.Grace = time.Duration(n) * time.Second
		}
	}

	mux := http.NewServeMux()

	// The compute endpoints, so one process can serve both halves and
	// backend/lib/computeClient.ts needs no second URL.
	api.Mount(mux)

	mux.HandleFunc("/health", metrics.Instrument("/health", func(w http.ResponseWriter, _ *http.Request) {
		srv.mu.Lock()
		conns := srv.conns
		srv.mu.Unlock()
		api.WriteJSON(w, map[string]any{
			"status":      true,
			"service":     service,
			"version":     api.Version,
			"go":          runtimeVersion(),
			"cores":       cores(),
			"uptimeMs":    time.Since(srv.started).Milliseconds(),
			"connections": conns,
			"sessions":    srv.hub.Sessions(),
			"feeds":       srv.hub.Breakers.Snapshot(time.Now()),
			"ts":          time.Now().UnixMilli(),
		})
	}))

	// The market clock, so Node can badge the terminal without a second copy of
	// the session table. ?exchange=MCX
	mux.HandleFunc("/v1/market/state", metrics.Instrument("/v1/market/state", func(w http.ResponseWriter, r *http.Request) {
		exchange := r.URL.Query().Get("exchange")
		if exchange == "" {
			exchange = "NSE"
		}
		snap := market.At(exchange, time.Now())
		api.WriteJSON(w, map[string]any{
			"status": true,
			"state":  snap,
			"forced": market.Forced(),
		})
	}))

	// The socket is NOT wrapped in metrics.Instrument: a WebSocket connection
	// lasts the whole session, so it would report one request taking hours and
	// contribute nothing to a latency series. Connections are counted by the hub
	// gauges instead.
	mux.HandleFunc(LiveStraddlePath, srv.handleLive)

	httpSrv := &http.Server{
		Addr:              host + ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		// No WriteTimeout: a WebSocket connection is meant to last all session,
		// and a write deadline on the server would kill it at the first quiet
		// stretch. The per-frame deadline in the writer goroutine is the bound
		// that actually belongs here.
	}

	// Give the closed label sets a zero, so a dashboard shows 0 rather than
	// "No data" before the first event — see metrics.Seed.
	metrics.Seed("NSE", "BSE", "MCX")

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("[marketd] %s %s on %s:%s — %d cores, %s",
			service, api.Version, host, port, cores(), runtimeVersion())
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("[marketd] %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[marketd] shutting down")

	// Sessions first, then the listener. The other order leaves Python children
	// running for the length of the HTTP drain, holding broker subscriptions
	// that count against the account.
	srv.hub.Shutdown()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
	log.Printf("[marketd] stopped")
}

func envOr(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
