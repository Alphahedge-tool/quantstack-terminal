package feed

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"quantstack/compute/metrics"
)

// jitter is a uniform [0,1). crypto/rand rather than math/rand so that seeding
// is not something this package has to get right — it is called once per
// reconnect, which is nowhere near a hot path.
func jitter() float64 {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return 0.5
	}
	return float64(binary.BigEndian.Uint64(b[:])>>11) / float64(1<<53)
}

// ── The Nubra bridge ─────────────────────────────────────────────────────────
//
// Nubra's realtime feed only exists behind their Python SDK, so a live
// subscription is a child process rather than a socket we own. This is the Go
// twin of backend/feeds/adapters/nubra/liveBridge.ts and speaks the same
// protocol to the same script: a base64 JSON config as argv[1], NDJSON on
// stdout, anything else on stderr.
//
// What this adds over the TypeScript supervisor is the part that matters for an
// engine that is meant to stay up unattended: the process is RESTARTED on exit
// and on silence, on the shared backoff schedule, instead of the subscription
// simply ending. A bridge that dies at 11:40 used to leave the chart frozen
// until someone reloaded the tab.

// BridgeSource runs scripts/nubra_ws_bridge.py and republishes its NDJSON.
type BridgeSource struct {
	// Python is the interpreter to run. Empty uses QT_PYTHON, then "python".
	Python string
	// Script is the path to nubra_ws_bridge.py. Empty searches the usual places.
	Script string
	// Silence is how long without a DATA frame counts as a dead subscription.
	// Zero uses DefaultSilence.
	Silence time.Duration

	restarts atomic.Int64
}

// DefaultSilence is deliberately generous.
//
// The wings of a chain genuinely go quiet for tens of seconds in a slow tape,
// and killing a working subscription because nothing traded is a self-inflicted
// outage. What it does catch is the real failure — a bridge that came up, said
// "subscribed", and has published nothing at all for a minute.
const DefaultSilence = 60 * time.Second

func (b *BridgeSource) ID() string { return "nubra" }

// Restarts is how many times the child has been respawned, for the health
// endpoint. A rising count with data flowing is a broker cycling connections;
// a rising count with no data is a setup problem.
func (b *BridgeSource) Restarts() int64 { return b.restarts.Load() }

func (b *BridgeSource) python() string {
	if b.Python != "" {
		return b.Python
	}
	if p := os.Getenv("QT_PYTHON"); p != "" {
		return p
	}
	return "python"
}

// scriptPath finds nubra_ws_bridge.py.
//
// Several layouts are real — `go run ./cmd/marketd` from backend-go, a built
// binary in backend/bin, and a binary run from the repo root — and each puts a
// different number of directories between the process and backend/scripts. The
// same problem the TypeScript loader guards against, with one more case because
// this process does not live under backend/ at all.
func (b *BridgeSource) scriptPath() (string, error) {
	if b.Script != "" {
		if _, err := os.Stat(b.Script); err == nil {
			return b.Script, nil
		}
		return "", fmt.Errorf("QT_BRIDGE_SCRIPT points at %s, which does not exist", b.Script)
	}
	if env := os.Getenv("QT_BRIDGE_SCRIPT"); env != "" {
		if _, err := os.Stat(env); err == nil {
			return env, nil
		}
	}

	roots := []string{}
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, wd)
	}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}

	seen := map[string]bool{}
	var tried []string
	for _, root := range roots {
		dir := root
		// Walk up: backend-go/cmd/marketd → backend-go → repo root, and the same
		// from wherever a built binary sits.
		for i := 0; i < 5; i++ {
			for _, rel := range []string{
				filepath.Join("backend", "scripts", "nubra_ws_bridge.py"),
				filepath.Join("scripts", "nubra_ws_bridge.py"),
			} {
				cand := filepath.Join(dir, rel)
				if seen[cand] {
					continue
				}
				seen[cand] = true
				tried = append(tried, cand)
				if _, err := os.Stat(cand); err == nil {
					return cand, nil
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("nubra_ws_bridge.py not found; set QT_BRIDGE_SCRIPT. Looked in: %s",
		strings.Join(tried, ", "))
}

// bridgeConfig is the argv payload. Field names match the Python script's
// expectations exactly — this is a wire format shared with another language,
// so the tags are the contract and not a serialisation detail.
type bridgeConfig struct {
	Environment  string   `json:"environment"`
	Token        string   `json:"token"`
	DeviceID     string   `json:"deviceId"`
	Exchange     string   `json:"exchange"`
	RefIDs       []string `json:"refIds"`
	Mode         string   `json:"mode,omitempty"`
	IndexSymbols []string `json:"indexSymbols,omitempty"`
	PostMarket   bool     `json:"postMarket,omitempty"`
	Symbol       string   `json:"symbol,omitempty"`
	SpotSymbol   string   `json:"spotSymbol,omitempty"`
	Interval     string   `json:"interval,omitempty"`
	Expiry       string   `json:"expiry,omitempty"`
}

func configOf(spec Spec) bridgeConfig {
	mode := spec.Mode
	if mode == "" {
		mode = "straddle"
	}
	refIDs := spec.RefIDs
	if refIDs == nil {
		// The script distinguishes an empty list from a missing key; a nil slice
		// marshals to null, and null is not a list.
		refIDs = []string{}
	}
	return bridgeConfig{
		Environment:  spec.Environment,
		Token:        strings.TrimSpace(strings.TrimPrefix(spec.Token, "Bearer ")),
		DeviceID:     spec.DeviceID,
		Exchange:     Upper(spec.Exchange),
		RefIDs:       refIDs,
		Mode:         mode,
		IndexSymbols: spec.IndexSymbols,
		PostMarket:   spec.PostMarket,
		Symbol:       Upper(spec.Symbol),
		SpotSymbol:   spec.SpotSymbol,
		Interval:     spec.Interval,
		Expiry:       Compact(spec.Expiry),
	}
}

// Run supervises the child until the context is cancelled.
//
// It returns an error ONLY for a condition no restart can fix — no script, no
// interpreter — because returning is what tells the failover router to promote
// another feed. An ordinary crash is a restart, not a demotion: the bridge dies
// on a dropped connection often enough that treating it as a feed failure would
// have the router flapping between brokers all session.
func (b *BridgeSource) Run(ctx context.Context, spec Spec, out chan<- Event) error {
	script, err := b.scriptPath()
	if err != nil {
		EmitBlocking(ctx, out, Event{Feed: b.ID(), Channel: ChanError, Message: err.Error()})
		return err
	}

	raw, err := json.Marshal(configOf(spec))
	if err != nil {
		return fmt.Errorf("could not encode bridge config: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(raw)

	backoff := NewBackoff(750*time.Millisecond, 20*time.Second)

	for ctx.Err() == nil {
		gotData, runErr := b.runOnce(ctx, script, encoded, spec, out)

		if ctx.Err() != nil {
			return nil
		}
		// Only DATA resets the schedule — see Backoff.Reset. A child that starts
		// cleanly and publishes nothing must keep backing off, or a missing SDK
		// becomes a process-spawn loop.
		if gotData {
			backoff.Reset()
		}

		// A missing interpreter is the one crash worth giving up on: it will
		// fail identically forever, and by far the most common cause is python
		// not being on PATH at all.
		if isExecNotFound(runErr) {
			msg := fmt.Sprintf(
				"Python not found (tried %q). Live ticks need python with nubra_python_sdk installed; set QT_PYTHON to override.",
				b.python())
			EmitBlocking(ctx, out, Event{Feed: b.ID(), Channel: ChanError, Message: msg})
			return fmt.Errorf("%s", msg)
		}

		b.restarts.Add(1)
		delay := backoff.Next()
		reason := "exited"
		if runErr != nil {
			reason = runErr.Error()
		}
		// The METRIC label is a bounded classification, not the error text.
		// `reason` above is free-form and belongs in the message; a label built
		// from it would mint a series per distinct broker error string.
		metrics.Restarts.WithLabelValues(b.ID(), classifyRestart(runErr, gotData)).Inc()
		EmitBlocking(ctx, out, Event{
			Feed: b.ID(), Channel: ChanStatus, Status: "reconnecting",
			Message: fmt.Sprintf("Live bridge %s; restarting in %s (attempt %d)",
				reason, delay.Round(time.Millisecond), backoff.Attempt()),
		})

		t := time.NewTimer(delay)
		select {
		case <-t.C:
		case <-ctx.Done():
			t.Stop()
			return nil
		}
	}
	return nil
}

// runOnce is one child process, start to exit.
func (b *BridgeSource) runOnce(
	ctx context.Context, script, encoded string, spec Spec, out chan<- Event,
) (gotData bool, err error) {
	// A child of this context, cancelled by the watchdog below, so silence kills
	// the process rather than merely being reported.
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	cmd := exec.CommandContext(runCtx, b.python(), script, encoded)
	configureProcess(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return false, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return false, err
	}
	if err := cmd.Start(); err != nil {
		return false, err
	}

	EmitBlocking(ctx, out, Event{
		Feed: b.ID(), Channel: ChanStatus, Status: "connecting",
		Message: fmt.Sprintf("%s %s %s via %s", Upper(spec.Exchange), Upper(spec.Symbol), Compact(spec.Expiry), filepath.Base(script)),
	})

	var lastData atomic.Int64
	lastData.Store(time.Now().UnixMilli())
	var sawData atomic.Bool

	// ── Watchdog ──
	//
	// Judged on data, not on liveness: see the package comment. A process that
	// is alive and silent is the failure this catches, and the only way to
	// recover it is to tear the subscription down and open a new one.
	silence := b.Silence
	if silence <= 0 {
		silence = DefaultSilence
	}
	stopWatch := make(chan struct{})
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopWatch:
				return
			case <-runCtx.Done():
				return
			case now := <-ticker.C:
				if now.UnixMilli()-lastData.Load() > silence.Milliseconds() {
					EmitBlocking(ctx, out, Event{
						Feed: b.ID(), Channel: ChanStatus, Status: "stalled",
						Message: fmt.Sprintf("No market data for %s — resubscribing", silence),
					})
					cancel()
					return
				}
			}
		}
	}()

	// stderr: anything the SDK prints that is not ours. Surfaced rather than
	// swallowed — a stray traceback here is usually the whole explanation for a
	// bridge that came up and said nothing.
	//
	// Waited on before cmd.Wait() below: Wait closes the pipes, and a reader
	// still in flight would come back with "file already closed" and lose the
	// last few lines — which are the traceback.
	var errDrained sync.WaitGroup
	errDrained.Add(1)
	go func() {
		defer errDrained.Done()
		sc := bufio.NewScanner(stderr)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" {
				continue
			}
			Emit(ctx, out, Event{Feed: b.ID(), Channel: ChanLog, Message: truncate(line, 500)})
		}
	}()

	// stdout is NDJSON. bufio.Scanner with a raised limit rather than the default
	// 64 KB: one chain frame for a 40-strike expiry with depth on every leg is
	// comfortably past it, and the default would silently end the scan mid-
	// session with a token-too-long error.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 256*1024), 8<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			continue
		}
		var e Event
		if jsonErr := json.Unmarshal([]byte(line), &e); jsonErr != nil {
			Emit(ctx, out, Event{Feed: b.ID(), Channel: ChanLog, Message: truncate(line, 500)})
			continue
		}
		e.Feed = b.ID()
		if e.ReceivedMs == 0 {
			e.ReceivedMs = time.Now().UnixMilli()
		}
		if e.Channel.IsData() {
			lastData.Store(time.Now().UnixMilli())
			sawData.Store(true)
			Emit(ctx, out, e)
		} else {
			EmitBlocking(ctx, out, e)
		}
	}
	scanErr := sc.Err()

	close(stopWatch)
	errDrained.Wait()
	waitErr := cmd.Wait()

	switch {
	case ctx.Err() != nil:
		return sawData.Load(), nil
	case runCtx.Err() != nil:
		// The watchdog cancelled it; the exit status is ours, not the child's.
		return sawData.Load(), fmt.Errorf("went silent")
	case scanErr != nil:
		return sawData.Load(), fmt.Errorf("stdout read failed: %w", scanErr)
	case waitErr != nil:
		return sawData.Load(), waitErr
	}
	return sawData.Load(), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func isExecNotFound(err error) bool {
	if err == nil {
		return false
	}
	if execErr, ok := err.(*exec.Error); ok {
		return execErr.Err == exec.ErrNotFound || os.IsNotExist(execErr.Err)
	}
	return false
}

// classifyRestart reduces a restart to one of a handful of causes.
//
// A metric label must come from a CLOSED set. The error text it is derived from
// is not one — a broker can word a failure any way it likes, and every distinct
// phrasing would become a permanent time series. Three buckets is enough to
// answer the question these are read for: did the child die on its own, did the
// watchdog kill it for going quiet, or did it never work at all.
func classifyRestart(err error, gotData bool) string {
	switch {
	case err == nil:
		return "exited"
	case strings.Contains(err.Error(), "went silent"):
		return "silent"
	case !gotData:
		return "never_started"
	default:
		return "crashed"
	}
}
