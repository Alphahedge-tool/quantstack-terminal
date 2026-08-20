package market

import (
	"testing"
	"time"
)

func at(y int, m time.Month, d, hh, mm int) time.Time {
	return time.Date(y, m, d, hh, mm, 0, 0, IST)
}

// The window table must stay identical to SESSION_IST in
// backend/engine/rollingStraddle.ts: the historical engine clips its walk to
// that range, and a wider live window appends points no reload can reproduce.
func TestEquityAndCommodityWindows(t *testing.T) {
	// A Wednesday.
	day := at(2026, time.August, 19, 12, 0)

	start, end := Range(day, "NSE")
	if got := time.UnixMilli(start).In(IST).Format("15:04"); got != "09:15" {
		t.Errorf("NSE open = %s, want 09:15", got)
	}
	if got := time.UnixMilli(end).In(IST).Format("15:04"); got != "15:30" {
		t.Errorf("NSE close = %s, want 15:30", got)
	}

	start, end = Range(day, "MCX")
	if got := time.UnixMilli(start).In(IST).Format("15:04"); got != "09:00" {
		t.Errorf("MCX open = %s, want 09:00", got)
	}
	if got := time.UnixMilli(end).In(IST).Format("15:04"); got != "23:55" {
		t.Errorf("MCX close = %s, want 23:55", got)
	}

	// An unlisted exchange falls back to the equity window rather than refusing.
	nseStart, _ := Range(day, "NSE")
	bseStart, _ := Range(day, "BSE")
	if nseStart != bseStart {
		t.Error("an unlisted exchange did not fall back to the equity window")
	}
}

func TestStateMachineAcrossAnEquityDay(t *testing.T) {
	cases := []struct {
		hh, mm int
		want   State
	}{
		{8, 30, Closed},
		{9, 5, PreOpen},
		{10, 0, Open},
		{15, 28, Closing},
		{16, 0, Post},
	}
	for _, c := range cases {
		got := At("NSE", at(2026, time.August, 19, c.hh, c.mm))
		if got.State != c.want {
			t.Errorf("%02d:%02d → %s, want %s", c.hh, c.mm, got.State, c.want)
		}
		if (got.State == Open || got.State == Closing) != got.Open {
			t.Errorf("%02d:%02d: Open flag %v disagrees with state %s", c.hh, c.mm, got.Open, got.State)
		}
	}
}

// Saturday's 09:15 is not a session.
func TestWeekendsAreClosedRegardlessOfTheClock(t *testing.T) {
	sat := at(2026, time.August, 22, 11, 0)
	snap := At("NSE", sat)
	if snap.State != Closed || snap.Open {
		t.Errorf("Saturday 11:00 → %s (open=%v), want closed", snap.State, snap.Open)
	}
	if !snap.Weekend {
		t.Error("weekend flag not set on a Saturday")
	}
	if IsOpen("MCX", sat) {
		t.Error("MCX reported open on a Saturday")
	}
}

// Closing exists so consumers can stop re-arming subscriptions they will not
// get value from — it is not a trading signal.
func TestClosingWindowIsTheLastFiveMinutes(t *testing.T) {
	justInside := At("NSE", at(2026, time.August, 19, 15, 26))
	if justInside.State != Closing {
		t.Errorf("15:26 → %s, want closing", justInside.State)
	}
	earlier := At("NSE", at(2026, time.August, 19, 15, 20))
	if earlier.State != Open {
		t.Errorf("15:20 → %s, want open", earlier.State)
	}
	if justInside.UntilMs > ClosingMs {
		t.Errorf("untilMs = %d, want no more than %d inside the closing window",
			justInside.UntilMs, ClosingMs)
	}
}

func TestMsUntilCloseGoesNegativeAfterTheBell(t *testing.T) {
	if ms := MsUntilClose("NSE", at(2026, time.August, 19, 16, 0)); ms >= 0 {
		t.Errorf("msUntilClose after the bell = %d, want negative", ms)
	}
	if ms := MsUntilClose("NSE", at(2026, time.August, 19, 15, 0)); ms <= 0 {
		t.Errorf("msUntilClose mid-session = %d, want positive", ms)
	}
}

func TestTodayIsTheISTTradingDate(t *testing.T) {
	// 00:30 IST on the 20th is 19:00 UTC on the 19th — the IST date is what
	// refdata is keyed by, and taking the UTC one would look up the wrong day.
	if got := Today(at(2026, time.August, 20, 0, 30)); got != "2026-08-20" {
		t.Errorf("Today = %q, want 2026-08-20", got)
	}
}
