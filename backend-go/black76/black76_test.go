package black76

import (
	"math"
	"testing"
)

// The property that matters more than any single value: price a straddle at a
// known vol, invert the price, get the vol back. If the pricer and the inverter
// ever disagree, every IV on the chart is wrong and nothing else in the suite
// would notice.
func TestStraddleRoundTrip(t *testing.T) {
	forwards := []float64{100, 5000, 24500, 86050}
	tenors := []float64{1.0 / 365, 3.0 / 365, 7.0 / 365, 30.0 / 365, 90.0 / 365}
	vols := []float64{0.06, 0.12, 0.185, 0.35, 0.80}
	offsets := []float64{-0.04, -0.01, 0, 0.01, 0.04} // as a fraction of F

	worst := 0.0
	checked := 0

	for _, f := range forwards {
		for _, tenor := range tenors {
			for _, sigma := range vols {
				for _, off := range offsets {
					k := f * (1 + off)
					price := Straddle(f, k, tenor, sigma)
					if !(price > 0) {
						continue
					}
					// Skip what the production guard would refuse anyway: with
					// vega under minVega no vol is recoverable, and the function
					// is documented to return NaN there.
					if 2*Vega(f, k, tenor, sigma) < minVega {
						continue
					}
					got := ImpliedVolStraddle(price, f, k, tenor)
					if math.IsNaN(got) {
						t.Fatalf("no solution: F=%g K=%g T=%g sigma=%g price=%g", f, k, tenor, sigma, price)
					}
					checked++
					if e := math.Abs(got - sigma); e > worst {
						worst = e
					}
				}
			}
		}
	}

	if checked < 50 {
		t.Fatalf("only %d cases exercised — the sweep is not covering anything", checked)
	}
	// 1e-8 of vol is 1e-6 of a vol point: far below the 0.05 tick that produced
	// the price in the first place.
	if worst > 1e-8 {
		t.Fatalf("round-trip error %g over %d cases, want <= 1e-8", worst, checked)
	}
}

// The refusals are load-bearing: each one is a case where returning a
// plausible number would be indistinguishable downstream from a real
// observation.
func TestImpliedVolRefusals(t *testing.T) {
	cases := []struct {
		name                string
		straddle, f, k, tee float64
	}{
		{"below intrinsic (stale quote, an arbitrage)", 10, 24500, 24000, 7.0 / 365},
		{"at or above F+K", 49_000, 24500, 24500, 7.0 / 365},
		{"expired", 300, 24500, 24500, 0},
		{"negative time", 300, 24500, 24500, -1.0 / 365},
		{"no premium", 0, 24500, 24500, 7.0 / 365},
	}
	for _, c := range cases {
		if got := ImpliedVolStraddle(c.straddle, c.f, c.k, c.tee); !math.IsNaN(got) {
			t.Errorf("%s: got %g, want NaN", c.name, got)
		}
	}
}

// A straddle whose extrinsic value has decayed below the tick has no
// RECOVERABLE vol however the algebra comes out — the identifiability guard,
// not a numerical one.
func TestUnidentifiableReturnsNaN(t *testing.T) {
	f, k := 24500.0, 24500.0
	tee := 1.0 / (365 * 24 * 3600) // one second to expiry
	price := Straddle(f, k, tee, 0.18)
	if got := ImpliedVolStraddle(price, f, k, tee); !math.IsNaN(got) {
		t.Errorf("one second to expiry: got %g, want NaN (vega %g < %g)",
			got, 2*Vega(f, k, tee, 0.18), minVega)
	}
}

// Put-call parity holds exactly at r = 0, which is the whole reason the engine
// can recover a forward from prices alone: F = K + C − P.
func TestParity(t *testing.T) {
	f, k, tee, sigma := 24500.0, 24300.0, 7.0/365, 0.185
	c := Price(f, k, tee, sigma, Call)
	p := Price(f, k, tee, sigma, Put)
	if e := math.Abs((k + c - p) - f); e > 1e-9 {
		t.Fatalf("parity broken by %g", e)
	}
}

// Feed units, not raw derivatives: vega per vol point and theta per calendar
// day. Getting this wrong puts a 100x step at the splice between a fed greek
// and a modelled one — which is exactly what it would look like on the chart.
func TestStraddleGreekUnits(t *testing.T) {
	f, k, tee, sigma := 24500.0, 24500.0, 7.0/365, 0.185

	g, ok := StraddleGreeksOf(f, k, tee, sigma)
	if !ok {
		t.Fatal("no greeks for a live ATM straddle")
	}
	raw := LegGreeks(f, k, tee, sigma, Call)

	if e := math.Abs(g.Vega - 2*raw.Vega/100); e > 1e-12 {
		t.Errorf("vega not per vol point: off by %g", e)
	}
	if e := math.Abs(g.Theta - 2*raw.Theta/365); e > 1e-12 {
		t.Errorf("theta not per day: off by %g", e)
	}
	if g.Theta >= 0 {
		t.Errorf("long straddle theta should be negative, got %g", g.Theta)
	}
	if g.Vega <= 0 {
		t.Errorf("long straddle vega should be positive, got %g", g.Vega)
	}
	// ATM delta is the residual, not zero — but it must be small.
	if math.Abs(g.Delta) > 0.05 {
		t.Errorf("ATM straddle delta %g is not near zero", g.Delta)
	}
}

// The expiry instant is 15:30 IST = 10:00 UTC, and intraday precision is not
// optional: a whole-day count reads T as one day or zero for the entire expiry
// session.
func TestYearsToExpiry(t *testing.T) {
	// 2026-08-20 09:15 IST == 2026-08-20T03:45:00Z
	ts := float64(1787197500000) // 2026-08-20T03:45:00Z = 09:15 IST
	got := YearsToExpiry(ts, "20260820")
	want := (6*3600 + 15*60) / (365.0 * 86400) // 06:15 remaining
	if math.Abs(got-want) > 1e-12 {
		t.Errorf("intraday T: got %g want %g", got, want)
	}
	if a, b := YearsToExpiry(ts, "2026-08-20"), YearsToExpiry(ts, "20260820"); a != b {
		t.Errorf("dashed and plain expiry disagree: %g vs %g", a, b)
	}
	if got := YearsToExpiry(ts, "not-a-date"); !math.IsNaN(got) {
		t.Errorf("unparseable expiry: got %g, want NaN", got)
	}
}
