package tick

import "testing"

// The paise convention, and the > 0 gate that keeps an unquoted leg from being
// read as a price of zero.
func TestRupeesRejectsAnythingThatIsNotAPrice(t *testing.T) {
	if v, ok := Rupees(11_050.0); !ok || v != 110.5 {
		t.Errorf("Rupees(11050) = %v, %v; want 110.5, true", v, ok)
	}
	if v, ok := Rupees("11050"); !ok || v != 110.5 {
		t.Errorf("quoted paise not accepted: %v, %v", v, ok)
	}
	for _, bad := range []any{0.0, -1.0, nil, "", "abc", true, map[string]any{}} {
		if _, ok := Rupees(bad); ok {
			t.Errorf("Rupees(%v) accepted", bad)
		}
	}
}

// Feeds send 0.184 and 18.4 for the same number, and there is no field that
// says which.
func TestIVIsNormalisedToPercentagePoints(t *testing.T) {
	cases := []struct {
		payload Dict
		want    float64
	}{
		{Dict{"iv": 18.4}, 18.4},
		{Dict{"iv": 0.184}, 18.4},
		{Dict{"implied_volatility": "22.5"}, 22.5},
		// No mid published: fall back to the midpoint of the two-sided quote.
		{Dict{"iv_bid": 17.0, "iv_ask": 19.0}, 18.0},
		// One side only is still the best estimate available.
		{Dict{"ivBid": 17.0}, 17.0},
	}
	for _, c := range cases {
		got, ok := IV(c.payload)
		if !ok || got != c.want {
			t.Errorf("IV(%v) = %v, %v; want %v", c.payload, got, ok, c.want)
		}
	}
	for _, bad := range []Dict{{}, {"iv": 0}, {"iv": -1}, {"iv": "n/a"}} {
		if _, ok := IV(bad); ok {
			t.Errorf("IV(%v) accepted", bad)
		}
	}
}

// A greek stream sends 0 for a contract it has not populated far more often
// than a real ATM straddle prints a true zero vega — except for delta, which
// legitimately sits near zero.
func TestZeroGreeksAreRejectedExceptDelta(t *testing.T) {
	if _, ok := Greek(Dict{"vega": 0}, "vega"); ok {
		t.Error("accepted a zero vega")
	}
	if _, ok := Greek(Dict{"theta": 0}, "theta"); ok {
		t.Error("accepted a zero theta")
	}
	if v, ok := Greek(Dict{"delta": 0}, "delta"); !ok || v != 0 {
		t.Errorf("Greek(delta 0) = %v, %v; want 0, true", v, ok)
	}
	if v, ok := Greek(Dict{"vega_value": 12.5}, "vega"); !ok || v != 12.5 {
		t.Errorf("alias vega_value not read: %v, %v", v, ok)
	}
	// A greek is a sensitivity, not a premium — never divided by 100.
	if v, _ := Greek(Dict{"vega": 12.5}, "vega"); v != 12.5 {
		t.Errorf("vega = %v; the paise convention must not apply to greeks", v)
	}
}

// OI and volume are counts, not prices, and zero is a real observation.
func TestOpenInterestIsACountAndZeroIsReal(t *testing.T) {
	if v, ok := OI(Dict{"cumulative_oi": 4_275_000.0}); !ok || v != 4_275_000 {
		t.Errorf("OI = %v, %v; want 4275000 undivided", v, ok)
	}
	if v, ok := OI(Dict{"oi": 0.0}); !ok || v != 0 {
		t.Errorf("OI(0) = %v, %v; a strike with no open interest is a real reading", v, ok)
	}
	if _, ok := OI(Dict{"oi": -5.0}); ok {
		t.Error("accepted negative open interest")
	}
	if v, ok := Volume(Dict{"totalTradedVolume": 1_234.0}); !ok || v != 1_234 {
		t.Errorf("Volume = %v, %v; want 1234", v, ok)
	}
}

// A numeric refId that round-trips through float64 must not gain a ".0" and
// stop matching the contract table.
func TestRefIDKeepsIntegersIntegral(t *testing.T) {
	cases := map[any]string{
		"NSE_12345":      "NSE_12345",
		float64(1234567): "1234567",
		"  padded  ":     "padded",
	}
	for raw, want := range cases {
		if got := RefID(Dict{"refId": raw}); got != want {
			t.Errorf("RefID(%v) = %q, want %q", raw, got, want)
		}
	}
	if got := RefID(Dict{"instrument_id": "abc"}); got != "abc" {
		t.Errorf("alias instrument_id not read: %q", got)
	}
	if got := RefID(Dict{"nothing": 1}); got != "" {
		t.Errorf("RefID with no handle = %q, want empty", got)
	}
}

// Payloads arrive as an object, an array, or an object wrapping one of
// data/values/items — all three from the same bridge.
func TestEachWalksEveryPayloadShape(t *testing.T) {
	count := func(payload any) int {
		n := 0
		Each(payload, func(Dict) { n++ })
		return n
	}
	if got := count(Dict{"refId": "a"}); got != 1 {
		t.Errorf("bare object visited %d times, want 1", got)
	}
	if got := count([]any{Dict{"refId": "a"}, Dict{"refId": "b"}}); got != 2 {
		t.Errorf("array visited %d times, want 2", got)
	}
	// The wrapper itself is visited too, which is deliberate: some builds put
	// the refId on the wrapper and the values underneath.
	wrapped := Dict{"data": []any{Dict{"refId": "a"}, Dict{"refId": "b"}}}
	if got := count(wrapped); got != 3 {
		t.Errorf("wrapped payload visited %d times, want 3", got)
	}
}

// Replacement loses fields: a frame carrying only delta would wipe a vega
// published two frames ago.
func TestMergeKeepsFieldsAnUpdateOmits(t *testing.T) {
	into := Dict{"vega": 12.0, "theta": -4.0}
	out := Merge(into, Dict{"delta": 0.5, "theta": nil})
	if out["vega"] != 12.0 {
		t.Error("merge dropped a field the update did not mention")
	}
	if out["theta"] != -4.0 {
		t.Error("a nil value overwrote a real one")
	}
	if out["delta"] != 0.5 {
		t.Error("merge did not apply the update")
	}
}
