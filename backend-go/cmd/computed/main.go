// Command computed is the Go compute service — stage 1 of the split described
// in the Go/Node cut line.
//
// ── What it is for ──
//
// Node still owns every route, every broker session, every credential and the
// whole assistant. This process owns exactly one thing: numeric work that runs
// in a loop over bars, where V8's single thread is the constraint. Today that
// is Black-76 inversion and the greeks derived from it — the per-bar cost in
// `engine/rollingStraddle.ts` that currently blocks the event loop, and with it
// every live tick on /ws/straddle.
//
// ── Why every endpoint is a batch ──
//
// A session walk is ~22k bars. One HTTP round trip per bar would spend more
// time in the loopback stack than V8 spends doing the maths, and the migration
// would make the product slower — which is the usual way a "port the hot loop"
// project fails. So the unit of work here is a whole session: one request in,
// one columnar response out, and the fan-out across cores happens inside.
//
// ── Why columnar out ──
//
// 22k objects of {iv, vega, theta, delta, gamma} is roughly 2.6 MB of JSON with
// the keys repeated 22k times. Five parallel arrays carry the same numbers in
// about a third of that, and Node indexes them straight back onto its points.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"

	"quantstack/compute/black76"
	"quantstack/compute/chain"
)

const version = "0.1.0"

// Bars below this many are computed on the calling goroutine. Spinning up
// workers for a handful of bars costs more in scheduling than the work itself,
// and the live path asks for exactly that shape — one bar at a time.
const parallelThreshold = 512

// ── Wire types ──────────────────────────────────────────────────────────────

// Bar is one bar's worth of inputs. Short JSON names on purpose: this array is
// the request body for a whole session, and "straddlePrice" repeated 22k times
// is 300 KB of key.
type Bar struct {
	T float64 `json:"t"` // epoch ms
	S float64 `json:"s"` // straddle mid (CE + PE)
	F float64 `json:"f"` // synthetic forward
	K float64 `json:"k"` // strike

	// V is a vol the FEED already published, in vol points, and its presence
	// means "do not invert this bar".
	//
	// A bar can need greeks without needing an inversion: the broker carries
	// iv_bid/iv_ask further back than it carries vega and theta, so there is a
	// window with a real fed vol and no greeks at all. Solving for a vol the
	// feed already stated would be both wasted work and a second, slightly
	// different number for the same quantity.
	V float64 `json:"v,omitempty"`

	// G asks for greeks on this bar specifically. Per-bar rather than per-batch
	// because the two gaps do not line up: a bar can have fed greeks and no fed
	// vol, in which case it needs the inversion and nothing else.
	G bool `json:"g,omitempty"`
}

type volRequest struct {
	// Expiry as YYYYMMDD or YYYY-MM-DD. Applied to every bar — one request is
	// one contract, which is also what the engine's walk is.
	Expiry string `json:"expiry"`
	Bars   []Bar  `json:"bars"`
	// Greeks are computed from the vol that was just solved for. Off by default:
	// the risk-reversal path wants vol alone and should not pay for four more
	// closed forms per bar.
	Greeks bool `json:"greeks"`
}

// volResponse is columnar, and every column is []*float64 so that "no solution"
// is null rather than 0 or NaN.
//
// This distinction is the whole contract. A straddle printing below |F − K| is
// an arbitrage with no implied vol at all, and a zero there would be plotted as
// a real observation of zero volatility.
type volResponse struct {
	Count int        `json:"count"`
	IV    []*float64 `json:"iv"`
	Vega  []*float64 `json:"vega,omitempty"`
	Theta []*float64 `json:"theta,omitempty"`
	Delta []*float64 `json:"delta,omitempty"`
	Gamma []*float64 `json:"gamma,omitempty"`
	// Diagnostics the Node side logs, so a slow batch can be attributed to this
	// process rather than guessed at.
	Solved  int    `json:"solved"`
	Workers int    `json:"workers"`
	TookMs  int64  `json:"tookMs"`
	Version string `json:"version"`
}

// ptr returns nil for anything that is not a real number, which is how NaN
// becomes JSON null. Every non-finite value in this service goes through here.
func ptr(v float64) *float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

// ── Handlers ────────────────────────────────────────────────────────────────

// POST /v1/straddle/vol
//
// Implied vol per bar, and optionally the straddle greeks derived from it. The
// IV is returned in VOL POINTS (18.4), not as a decimal, because that is what
// `StraddlePoint.iv` carries and what the chart plots — converting on the Node
// side would put the same *100 in two places.
func handleVol(w http.ResponseWriter, r *http.Request) {
	var req volRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, fmt.Errorf("malformed body: %w", err))
		return
	}
	if req.Expiry == "" {
		fail(w, http.StatusBadRequest, errors.New("expiry is required"))
		return
	}
	// One guard, once, rather than a NaN per bar: an unparseable expiry makes
	// every T meaningless, and answering with 22k nulls would look like a
	// market with no vol rather than a bad request.
	if math.IsNaN(black76.YearsToExpiry(0, req.Expiry)) {
		fail(w, http.StatusBadRequest, fmt.Errorf("unparseable expiry %q", req.Expiry))
		return
	}

	started := time.Now()
	n := len(req.Bars)

	res := volResponse{Count: n, IV: make([]*float64, n), Version: version}
	if req.Greeks {
		res.Vega = make([]*float64, n)
		res.Theta = make([]*float64, n)
		res.Delta = make([]*float64, n)
		res.Gamma = make([]*float64, n)
	}

	// Each index is written by exactly one goroutine and read by none of them,
	// so the slices need no lock — the only shared mutable state is the solved
	// counter, which is per-worker and summed at the end.
	solve := func(i int) int {
		b := req.Bars[i]
		tee := black76.YearsToExpiry(b.T, req.Expiry)

		sigma := b.V / 100
		if !(b.V > 0) {
			sigma = black76.ImpliedVolStraddle(b.S, b.F, b.K, tee)
			if math.IsNaN(sigma) || !(sigma > 0) {
				// No implied vol exists for this quote — typically a stale
				// straddle printing below |F − K|. The column stays null, and
				// no greek is derived from a vol that was never recovered.
				return 0
			}
			res.IV[i] = ptr(sigma * 100)
		}

		if req.Greeks && b.G {
			if g, ok := black76.StraddleGreeksOf(b.F, b.K, tee, sigma); ok {
				res.Vega[i] = ptr(g.Vega)
				res.Theta[i] = ptr(g.Theta)
				res.Delta[i] = ptr(g.Delta)
				res.Gamma[i] = ptr(g.Gamma)
			}
		}
		return 1
	}

	workers := 1
	if n >= parallelThreshold {
		workers = min(runtime.GOMAXPROCS(0), 16)
	}

	solved := 0
	if workers <= 1 {
		for i := range req.Bars {
			solved += solve(i)
		}
	} else {
		// Contiguous blocks rather than a work queue: the bars are already in
		// time order, adjacent bars sit in the same cache lines, and every one
		// costs about the same (a bounded Newton solve), so there is nothing for
		// dynamic scheduling to balance.
		var wg sync.WaitGroup
		counts := make([]int, workers)
		size := (n + workers - 1) / workers
		for wkr := 0; wkr < workers; wkr++ {
			lo := wkr * size
			hi := min(lo+size, n)
			if lo >= hi {
				continue
			}
			wg.Add(1)
			go func(wkr, lo, hi int) {
				defer wg.Done()
				local := 0
				for i := lo; i < hi; i++ {
					local += solve(i)
				}
				counts[wkr] = local
			}(wkr, lo, hi)
		}
		wg.Wait()
		for _, c := range counts {
			solved += c
		}
	}

	res.Solved = solved
	res.Workers = workers
	res.TookMs = time.Since(started).Milliseconds()
	writeJSON(w, res)
}

// POST /v1/synthetic — one chain snapshot to its implied forward.
func handleSynthetic(w http.ResponseWriter, r *http.Request) {
	var slice chain.Slice
	if err := json.NewDecoder(r.Body).Decode(&slice); err != nil {
		fail(w, http.StatusBadRequest, fmt.Errorf("malformed body: %w", err))
		return
	}
	writeJSON(w, chain.SyntheticFuture(slice))
}

// GET /health — what Node's readiness check calls before routing anything here.
func handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, map[string]any{
		"status":  true,
		"service": "quantstack-compute",
		"version": version,
		"go":      runtime.Version(),
		"cores":   runtime.GOMAXPROCS(0),
		"ts":      time.Now().UnixMilli(),
	})
}

// ── Plumbing ────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("[computed] write failed: %v", err)
	}
}

func fail(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]any{"status": false, "message": err.Error()})
}

// post routes one path and rejects every other method with 405 rather than
// silently treating a GET as an empty batch.
func post(mux *http.ServeMux, path string, h http.HandlerFunc) {
	mux.HandleFunc(path, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			fail(w, http.StatusMethodNotAllowed, fmt.Errorf("%s takes POST", path))
			return
		}
		h(w, r)
	})
}

func main() {
	port := os.Getenv("QT_GO_COMPUTE_PORT")
	if port == "" {
		port = "3151"
	}
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatalf("[computed] QT_GO_COMPUTE_PORT=%q is not a port", port)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth)
	post(mux, "/v1/straddle/vol", handleVol)
	post(mux, "/v1/synthetic", handleSynthetic)

	srv := &http.Server{
		Addr:    "127.0.0.1:" + port,
		Handler: mux,
		// Loopback only, and generous: a cold 22k-bar batch is the point of the
		// service, and a 30s default would cut off exactly the request this
		// exists to serve.
		ReadHeaderTimeout: 5 * time.Second,
		WriteTimeout:      120 * time.Second,
	}

	log.Printf("[computed] quantstack-compute %s on 127.0.0.1:%s — %d cores, %s",
		version, port, runtime.GOMAXPROCS(0), runtime.Version())

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[computed] %v", err)
	}
}
