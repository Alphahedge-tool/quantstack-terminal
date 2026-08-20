// Command computed is the stateless compute service — stage 1 of the split
// described in the Go/Node cut line.
//
// It serves the batch endpoints in package api and nothing else: no sockets, no
// sessions, no credentials. Node still owns every route, every broker login and
// the whole assistant; this process owns numeric work that runs in a loop over
// bars, where V8's single thread is the constraint.
//
// The handlers themselves moved into package api when `marketd` arrived, so a
// deployment can choose: run this for the solver alone, or run marketd for one
// process that serves the solver AND owns the live engine. Both answer the same
// paths on the same contract, and backend/lib/computeClient.ts cannot tell them
// apart — which is the point.
package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"time"

	"quantstack/compute/api"
	"quantstack/compute/metrics"
)

func main() {
	port := os.Getenv("QT_GO_COMPUTE_PORT")
	if port == "" {
		port = "3151"
	}
	if _, err := strconv.Atoi(port); err != nil {
		log.Fatalf("[computed] QT_GO_COMPUTE_PORT=%q is not a port", port)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", metrics.Instrument("/health", func(w http.ResponseWriter, _ *http.Request) {
		api.WriteJSON(w, map[string]any{
			"status":  true,
			"service": "quantstack-compute",
			"version": api.Version,
			"go":      runtime.Version(),
			"cores":   runtime.GOMAXPROCS(0),
			"ts":      time.Now().UnixMilli(),
		})
	}))
	api.Mount(mux)
	metrics.Seed()

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
		api.Version, port, runtime.GOMAXPROCS(0), runtime.Version())

	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("[computed] %v", err)
	}
}
