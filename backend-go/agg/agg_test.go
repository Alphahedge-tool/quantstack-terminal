package agg

import "testing"

func TestBarsAlignToTheWallClock(t *testing.T) {
	a := NewAggregator(60_000)
	// 10:00:37 and 10:00:59 belong to the same minute; 10:01:02 opens the next.
	base := int64(1_700_000_000_000)
	base -= base % 60_000

	if closed := a.Add(Sample{TsMs: base + 37_000, Price: 100}); closed != nil {
		t.Fatal("first sample closed a bar")
	}
	a.Add(Sample{TsMs: base + 59_000, Price: 110})
	closed := a.Add(Sample{TsMs: base + 62_000, Price: 90})
	if closed == nil {
		t.Fatal("crossing a minute boundary did not close the bar")
	}
	if closed.TsMs != base {
		t.Errorf("bar stamped %d, want the bucket start %d", closed.TsMs, base)
	}
	if closed.O != 100 || closed.H != 110 || closed.L != 100 || closed.C != 110 {
		t.Errorf("OHLC = %v/%v/%v/%v, want 100/110/100/110", closed.O, closed.H, closed.L, closed.C)
	}
	if closed.N != 2 {
		t.Errorf("bar counted %d ticks, want 2", closed.N)
	}
}

// A bar that only closes on the next tick never closes on a contract that goes
// quiet — which is exactly the bar you most want.
func TestFlushClosesABarOnASilentContract(t *testing.T) {
	a := NewAggregator(60_000)
	base := int64(1_700_000_000_000)
	base -= base % 60_000

	a.Add(Sample{TsMs: base + 10_000, Price: 100})
	if a.Flush(base+30_000) != nil {
		t.Fatal("flushed a bar that is still open")
	}
	closed := a.Flush(base + 61_000)
	if closed == nil {
		t.Fatal("flush past the boundary did not close the bar")
	}
	if closed.C != 100 {
		t.Errorf("close = %v, want 100", closed.C)
	}
}

// A late tick must not reopen a bar the client has already drawn.
func TestOutOfOrderTicksAreDropped(t *testing.T) {
	a := NewAggregator(60_000)
	base := int64(1_700_000_000_000)
	base -= base % 60_000

	a.Add(Sample{TsMs: base + 61_000, Price: 100})
	if closed := a.Add(Sample{TsMs: base + 10_000, Price: 5}); closed != nil {
		t.Fatal("a late tick closed a bar")
	}
	open := a.Open()
	if open == nil || open.L != 100 {
		t.Errorf("late tick leaked into the open bar: %+v", open)
	}
}

// Volume is a flow and is differenced; OI is a level and is carried.
func TestVolumeIsDifferencedAndOIIsCarried(t *testing.T) {
	a := NewAggregator(60_000)
	base := int64(1_700_000_000_000)
	base -= base % 60_000

	v1, v2, v3 := 1_000.0, 1_250.0, 1_400.0
	oi1, oi2 := 40_000.0, 41_000.0

	a.Add(Sample{TsMs: base + 1_000, Price: 100, CumVolume: &v1, CumOI: &oi1})
	a.Add(Sample{TsMs: base + 2_000, Price: 101, CumVolume: &v2, CumOI: &oi2})
	a.Add(Sample{TsMs: base + 3_000, Price: 102, CumVolume: &v3})
	closed := a.Flush(base + 61_000)

	if closed == nil {
		t.Fatal("no bar")
	}
	// The first reading only establishes the baseline, so the bar carries the
	// 250 + 150 that happened inside it.
	if closed.Vol == nil || *closed.Vol != 400 {
		t.Errorf("bar volume = %v, want 400", closed.Vol)
	}
	if closed.OI == nil || *closed.OI != 41_000 {
		t.Errorf("bar OI = %v, want the latest level 41000", closed.OI)
	}
}

// A cumulative counter that goes down is a session reset, not negative volume.
func TestCounterResetsRatherThanReportingNegativeChange(t *testing.T) {
	c := NewCounter(100)
	c.Observe(1_000, 50_000)
	c.Observe(2_000, 52_000)
	// Reconnect across a rollover: the day's tally restarts.
	c.Observe(3_000, 400)
	c.Observe(4_000, 900)

	abs, pct, ok := c.SinceOpen()
	if !ok {
		t.Fatal("no reading")
	}
	if abs != 500 {
		t.Errorf("change since open = %v, want 500 measured from the new base", abs)
	}
	if pct == nil || *pct != 125 {
		t.Errorf("pct = %v, want 125", pct)
	}
}

// A window the retained history cannot cover must be refused, not answered with
// the change since the start of the data — it is a move of the reported size
// that fires an alert.
func TestWindowedChangeRefusesToAnswerBeyondItsHistory(t *testing.T) {
	c := NewCounter(100)
	c.Observe(10_000, 1_000)
	c.Observe(11_000, 1_100)
	c.Observe(12_000, 1_300)

	if _, _, ok := c.Change(12_000, 60_000); ok {
		t.Error("answered a 60s window from 2s of history")
	}
	abs, pct, ok := c.Change(12_000, 2_000)
	if !ok {
		t.Fatal("refused a window the history covers")
	}
	if abs != 300 {
		t.Errorf("change = %v, want 300", abs)
	}
	if pct == nil || *pct != 30 {
		t.Errorf("pct = %v, want 30", pct)
	}
}

func TestRingOverwritesOldestAndReadsChronologically(t *testing.T) {
	r := NewRing(3, 2)
	for i := 1; i <= 5; i++ {
		if !r.Push([]float64{float64(i), float64(i * 10)}) {
			t.Fatalf("push %d rejected", i)
		}
	}
	if r.Len() != 3 {
		t.Fatalf("len = %d, want 3", r.Len())
	}
	rows := r.Rows()
	want := [][2]float64{{3, 30}, {4, 40}, {5, 50}}
	for i, w := range want {
		if rows[i][0] != w[0] || rows[i][1] != w[1] {
			t.Errorf("row %d = %v, want %v", i, rows[i], w)
		}
	}
	// A row of the wrong width would shift every column after the gap while
	// still looking plausible, so it is rejected outright.
	if r.Push([]float64{1}) {
		t.Error("accepted a row of the wrong width")
	}
}
