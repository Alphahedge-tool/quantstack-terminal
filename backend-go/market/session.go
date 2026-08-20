// Package market answers one question the whole engine keys off: is this
// exchange trading right now, and if not, what is it doing instead.
//
// The window table is a port of SESSION_IST in backend/engine/rollingStraddle.ts
// and MUST stay identical to it. The historical engine clips its walk to that
// range; if the live engine used a wider one it would append points the history
// could never contain, and the chart would show a live tail that no reload
// could ever reproduce.
package market

import (
	"os"
	"strings"
	"sync"
	"time"
)

// IST has no DST and never has had, so a fixed zone is exact rather than a
// simplification — and it removes a tzdata dependency from a Windows build,
// where the zone database is not present unless the binary embeds it.
var IST = time.FixedZone("IST", 5*60*60+30*60)

type window struct{ openH, openM, closeH, closeM int }

// Per-exchange trading windows, IST. Anything not listed uses the equity
// window, which is what DEFAULT_SESSION_IST does on the TypeScript side.
var sessions = map[string]window{
	"MCX": {9, 0, 23, 55},
}

var defaultSession = window{9, 15, 15, 30}

// Pre-open is the equity call auction. MCX has no equivalent, so the pre-open
// span is zero there and the state goes straight from Closed to Open.
const preOpenMinutes = 15

func windowFor(exchange string) window {
	if w, ok := sessions[strings.ToUpper(strings.TrimSpace(exchange))]; ok {
		return w
	}
	return defaultSession
}

// Range is the trading window for one IST calendar date, in epoch ms.
//
// Deliberately not holiday-aware: a holiday calendar that is a year stale is
// worse than none, because it reports Closed on a day the market is trading and
// the engine would refuse to start. Absence of ticks is the honest signal, and
// every consumer already handles it.
func Range(day time.Time, exchange string) (startMs, endMs int64) {
	w := windowFor(exchange)
	d := day.In(IST)
	open := time.Date(d.Year(), d.Month(), d.Day(), w.openH, w.openM, 0, 0, IST)
	shut := time.Date(d.Year(), d.Month(), d.Day(), w.closeH, w.closeM, 0, 0, IST)
	return open.UnixMilli(), shut.UnixMilli()
}

// State is what the engine reports upstream and what the UI badges.
type State string

const (
	Closed  State = "closed"  // outside the window, or a weekend
	PreOpen State = "preopen" // call auction: quotes move, trades do not
	Open    State = "open"
	Closing State = "closing" // inside the window, under ClosingMs from the bell
	Post    State = "post"    // after the bell, same calendar day
)

// How long before the close the state flips to Closing.
//
// Consumers use it to stop re-arming subscriptions they will not get value from
// — a depth re-arm 30 seconds before the bell costs a broker round trip and
// buys nothing. Not a trading signal.
const ClosingMs int64 = 5 * 60 * 1000

// Snapshot is the full answer, so a caller makes one call rather than four and
// cannot observe the state and the countdown from two different instants.
type Snapshot struct {
	Exchange string `json:"exchange"`
	State    State  `json:"state"`
	Open     bool   `json:"open"`
	Date     string `json:"date"` // IST trading date, YYYY-MM-DD
	StartMs  int64  `json:"startMs"`
	EndMs    int64  `json:"endMs"`
	NowMs    int64  `json:"nowMs"`
	UntilMs  int64  `json:"untilMs"` // ms to the next transition; 0 when none
	Weekend  bool   `json:"weekend"`
}

// Today is the IST trading date, which is the key refdata is stored under.
func Today(now time.Time) string { return now.In(IST).Format("2006-01-02") }

func isWeekend(t time.Time) bool {
	switch t.In(IST).Weekday() {
	case time.Saturday, time.Sunday:
		return true
	}
	return false
}

// At classifies an instant. Weekends short-circuit to Closed with no window,
// because Saturday's 09:15 is not a session.
func At(exchange string, now time.Time) Snapshot {
	nowMs := now.UnixMilli()
	start, end := Range(now, exchange)
	snap := Snapshot{
		Exchange: strings.ToUpper(exchange),
		Date:     Today(now),
		StartMs:  start,
		EndMs:    end,
		NowMs:    nowMs,
		Weekend:  isWeekend(now),
	}

	if snap.Weekend {
		snap.State = Closed
		return snap
	}

	preOpen := start - int64(preOpenMinutes)*60*1000
	switch {
	case nowMs < preOpen:
		snap.State = Closed
		snap.UntilMs = preOpen - nowMs
	case nowMs < start:
		snap.State = PreOpen
		snap.UntilMs = start - nowMs
	case nowMs <= end:
		snap.Open = true
		snap.State = Open
		snap.UntilMs = end - nowMs
		if snap.UntilMs <= ClosingMs {
			snap.State = Closing
		}
	default:
		snap.State = Post
	}
	return snap
}

// IsOpen is the direct port of isMarketOpen() in engine/liveStraddle.ts —
// inclusive of both bounds, and indifferent to pre-open.
func IsOpen(exchange string, now time.Time) bool {
	if isWeekend(now) {
		return false
	}
	start, end := Range(now, exchange)
	ms := now.UnixMilli()
	return ms >= start && ms <= end
}

// MsUntilClose can go negative after the bell; callers that schedule on it must
// treat a non-positive value as "already closed" rather than sleeping on it.
func MsUntilClose(exchange string, now time.Time) int64 {
	_, end := Range(now, exchange)
	return end - now.UnixMilli()
}

// ── Override, for after-hours work ───────────────────────────────────────────
//
// Every one of these paths is silent outside the window, which makes "the feed
// is broken" and "the market is shut" look the same from a desk at 8pm. The
// TypeScript side has the same escape hatch on the bridge (postMarket), and
// this is its engine-side twin: QT_MARKET_ALWAYS_OPEN=1 makes the state machine
// report Open so a session can be exercised against static data.

var (
	forceOnce sync.Once
	forced    bool
)

// Forced reports whether the always-open override is set. It is read, not
// obeyed, by At() — a caller that overrides the clock should still be able to
// see the real state, and the engine reports both.
func Forced() bool {
	forceOnce.Do(func() {
		v := strings.ToLower(strings.TrimSpace(os.Getenv("QT_MARKET_ALWAYS_OPEN")))
		forced = v == "1" || v == "true" || v == "yes"
	})
	return forced
}

// Tradeable is what the engine actually gates on: the real state, unless the
// operator has explicitly overridden it.
func Tradeable(exchange string, now time.Time) bool {
	return Forced() || IsOpen(exchange, now)
}
