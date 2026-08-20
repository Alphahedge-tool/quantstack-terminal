// Package feed owns the live end of the wire: opening a market data
// subscription, keeping it open, noticing when it has quietly stopped working,
// and moving to another one when it has.
//
// ── The contract every source implements ──
//
// A Source is anything that can be asked for a Spec and will push Events until
// its context is cancelled. That is deliberately the whole interface. A broker
// that speaks a binary WebSocket and a broker that only exists behind a Python
// SDK look identical from the outside, which is what lets the failover router
// treat them as interchangeable.
//
// ── Why "quietly stopped working" is the hard case ──
//
// A socket that errors is easy: the read fails and the source restarts. The
// failure that actually costs money is the one where the connection is fine,
// the broker acknowledges the subscription, and no tick ever arrives — a
// subscription that silently did not take, a session token that expired into a
// no-op, a Python SDK that imported and then sat there. Every source here is
// therefore judged on DATA, not on liveness: silence past a deadline is a
// failure, whatever the process or the socket claims about itself.
package feed

import (
	"context"
	"strings"
	"sync"
	"time"
)

// Channel names the stream an event came off. These are the bridge's own names
// (see BridgeEvent in backend/feeds/adapters/nubra/liveBridge.ts) because a
// second broker's channels get mapped ONTO these rather than added alongside —
// a consumer switching on a broker-specific channel name is the leak the whole
// adapter boundary exists to prevent.
type Channel string

const (
	ChanOption    Channel = "option"    // a whole chain snapshot
	ChanOrderbook Channel = "orderbook" // per-contract depth
	ChanGreeks    Channel = "greeks"    // per-contract iv + sensitivities
	ChanOHLCV     Channel = "ohlcv"     // underlying bar
	ChanIndex     Channel = "index"     // underlying tick
	ChanStatus    Channel = "status"
	ChanError     Channel = "error"
	ChanLog       Channel = "log"
)

// IsData reports whether this channel carries market data. Only these reset the
// staleness watchdog — a source that emits nothing but status frames is a
// source that is not working, however chatty it is about it.
func (c Channel) IsData() bool {
	switch c {
	case ChanOption, ChanOrderbook, ChanGreeks, ChanOHLCV, ChanIndex:
		return true
	}
	return false
}

// Event is one frame from a source, normalised only as far as the envelope.
//
// Data stays as decoded JSON rather than a struct: the readers in package tick
// are what turn it into numbers, and binding it here would mean every new field
// name a broker invents needs a struct change in a package that should not care.
type Event struct {
	Feed       string  `json:"feed"`
	Channel    Channel `json:"event"`
	ReceivedMs int64   `json:"received_at_ms,omitempty"`
	Data       any     `json:"data,omitempty"`
	Status     string  `json:"status,omitempty"`
	Message    string  `json:"message,omitempty"`
}

// Spec is what to subscribe to. One Spec is one contract's worth of streams —
// a chain around a symbol/expiry, or a named list of contracts.
type Spec struct {
	// Environment and the credentials to open with. Node mints these; this
	// process never logs in, never stores a credential and never refreshes a
	// token. That split is not an accident of the port — it keeps every secret
	// in the half of the system that already has a vault for them.
	Environment string `json:"environment"`
	Token       string `json:"token"`
	DeviceID    string `json:"deviceId"`

	Exchange   string `json:"exchange"`
	Symbol     string `json:"symbol"`
	SpotSymbol string `json:"spotSymbol,omitempty"`
	Expiry     string `json:"expiry,omitempty"` // compact YYYYMMDD
	Interval   string `json:"interval,omitempty"`

	// Mode picks the subscription shape: "straddle" for one chain (option +
	// ohlcv + orderbook + greeks), "quotes" for named contracts.
	Mode string `json:"mode,omitempty"`

	RefIDs       []string `json:"refIds,omitempty"`
	IndexSymbols []string `json:"indexSymbols,omitempty"`

	// PostMarket asks for the static end-of-day snapshot instead of live ticks.
	// Outside market hours every channel is silent, and a subscription that
	// succeeds and then never publishes is indistinguishable downstream from a
	// broken feed. Never set during market hours: the data does not update.
	PostMarket bool `json:"postMarket,omitempty"`
}

// Redacted is the Spec as it is safe to log. The token is the only field worth
// hiding and it is the one most likely to end up in a log line describing a
// failed subscription, which is exactly when someone pastes the log somewhere.
func (s Spec) Redacted() Spec {
	c := s
	if c.Token != "" {
		c.Token = "***"
	}
	return c
}

// Source is one broker's live subscription.
//
// Run BLOCKS until the context is cancelled or the source gives up, and returns
// the reason. It owns its own reconnects internally; returning is a statement
// that this source cannot serve this Spec at all, which is what promotes the
// next feed in the failover order.
type Source interface {
	ID() string
	Run(ctx context.Context, spec Spec, out chan<- Event) error
}

// ── Emission helpers ─────────────────────────────────────────────────────────

// Emit sends without blocking forever on a stalled consumer.
//
// A source that blocks on a full channel stops reading its socket, the kernel
// buffer fills, and the broker starts dropping the subscription — so a slow
// consumer downstream turns into a broken feed upstream. Dropping the frame
// keeps the socket draining; the consumer sees a gap, which the next snapshot
// closes.
func Emit(ctx context.Context, out chan<- Event, e Event) bool {
	if e.ReceivedMs == 0 {
		e.ReceivedMs = time.Now().UnixMilli()
	}
	select {
	case out <- e:
		return true
	case <-ctx.Done():
		return false
	default:
		return false
	}
}

// EmitBlocking is for status and error frames, which are rare, ordered and
// worth waiting a moment for — a dropped "auth failed" is the one message whose
// absence leaves an operator with no explanation at all.
func EmitBlocking(ctx context.Context, out chan<- Event, e Event) bool {
	if e.ReceivedMs == 0 {
		e.ReceivedMs = time.Now().UnixMilli()
	}
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case out <- e:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}

// ── Backoff ──────────────────────────────────────────────────────────────────

// Backoff is the reconnect schedule shared by every source.
//
// Exponential with a cap and full jitter. The jitter is not cosmetic: several
// contracts subscribed at the same moment fail at the same moment when a token
// expires, and without jitter they all retry in lockstep and hit the broker as
// one burst — which is how a recoverable blip becomes a rate-limit ban.
type Backoff struct {
	Min, Max time.Duration
	attempt  int
	mu       sync.Mutex
	rand     func() float64
}

// NewBackoff seeds a schedule. The randomness comes from the caller only in
// tests; production uses the runtime's own generator via jitter().
func NewBackoff(min, max time.Duration) *Backoff {
	if min <= 0 {
		min = 500 * time.Millisecond
	}
	if max < min {
		max = 30 * time.Second
	}
	return &Backoff{Min: min, Max: max}
}

// Next is the delay before the next attempt, and advances the schedule.
func (b *Backoff) Next() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	d := b.Min << min(b.attempt, 16)
	if d > b.Max || d <= 0 {
		d = b.Max
	}
	b.attempt++
	r := jitter()
	if b.rand != nil {
		r = b.rand()
	}
	// Full jitter over [Min, d]: never below Min, because a zero-delay retry
	// against a broker that just refused is a tight loop with a network hop in
	// it.
	span := float64(d - b.Min)
	return b.Min + time.Duration(span*r)
}

// Reset is called after a source produces DATA, not after it connects.
//
// Connecting successfully and then receiving nothing is the failure mode this
// package is most concerned with, and resetting on connect would let a source
// that connects-and-stalls retry every Min forever.
func (b *Backoff) Reset() {
	b.mu.Lock()
	b.attempt = 0
	b.mu.Unlock()
}

// Attempt reports how many failures have accumulated, for status messages.
func (b *Backoff) Attempt() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.attempt
}

// Sleep waits out the next delay, or returns false if the context ends first.
func (b *Backoff) Sleep(ctx context.Context) bool {
	t := time.NewTimer(b.Next())
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

// ── Small helpers ────────────────────────────────────────────────────────────

// Compact strips the dashes from an ISO expiry. Nubra's option subscription and
// the refdata table both key on YYYYMMDD, and a single mismatched form resolves
// to an empty contract table — which reads downstream as "this expiry does not
// exist" rather than as a formatting bug.
func Compact(expiry string) string {
	return strings.ReplaceAll(strings.TrimSpace(expiry), "-", "")
}

// Upper trims and uppercases a symbol or exchange, which every lookup assumes.
func Upper(s string) string { return strings.ToUpper(strings.TrimSpace(s)) }
