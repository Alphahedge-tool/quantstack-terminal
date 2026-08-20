// Package tick turns a broker's realtime payload into numbers the engine can
// trust, and refuses everything it cannot.
//
// This is a port of the "tick field readers" block in
// backend/engine/liveStraddle.ts, and it exists for the reason stated there:
// Nubra's realtime payloads are not its REST payloads. Field names vary by
// stream and by SDK version, prices are paise, IV is sometimes a fraction and
// sometimes a percentage, and a greek stream sends 0 for a contract it has not
// populated yet.
//
// So every read goes through a function here, and every function has the same
// contract: it returns (value, true) only for a number the engine would be
// willing to plot. A renamed upstream field degrades to "no quote" — which the
// selection rule already handles by skipping the strike — instead of to a
// plausible wrong number that gets drawn as a real observation.
package tick

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
)

// Dict is one decoded JSON object. The engine never binds these payloads to
// structs: a struct with the wrong tag reads as a zero, and a zero here is
// indistinguishable from a real price of zero.
type Dict = map[string]any

// AsDict narrows an `any` to an object, or reports that it was not one.
func AsDict(v any) (Dict, bool) {
	d, ok := v.(Dict)
	return d, ok
}

// Get returns the first present key, so a caller lists the aliases once.
func Get(d Dict, keys ...string) (any, bool) {
	if d == nil {
		return nil, false
	}
	for _, k := range keys {
		if v, ok := d[k]; ok && v != nil {
			return v, true
		}
	}
	return nil, false
}

// Num coerces the shapes JSON actually delivers — float64 from a plain number,
// json.Number when a decoder is set to preserve precision, and string, because
// several of Nubra's fields are quoted.
//
// Booleans are NOT coerced. `true` becoming 1 would let a flag field satisfy a
// price lookup, which is exactly the silent-wrong-number failure this package
// exists to prevent.
func Num(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, isReal(n)
	case float32:
		return float64(n), isReal(float64(n))
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil && isReal(f)
	case string:
		s := strings.TrimSpace(n)
		if s == "" {
			return 0, false
		}
		f, err := strconv.ParseFloat(s, 64)
		return f, err == nil && isReal(f)
	}
	return 0, false
}

func isReal(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

// ── Identity ─────────────────────────────────────────────────────────────────

var refKeys = []string{"refId", "ref_id", "refid", "refID", "instrument_id"}

// RefID is the broker's contract handle, as a string regardless of whether it
// arrived as one. Numeric refIds that round-trip through float64 would gain a
// ".0" under naive formatting and stop matching the contract table, so integral
// floats are printed as integers.
func RefID(v any) string {
	d, ok := AsDict(v)
	if !ok {
		return ""
	}
	raw, ok := Get(d, refKeys...)
	if !ok {
		return ""
	}
	switch s := raw.(type) {
	case string:
		return strings.TrimSpace(s)
	case json.Number:
		return s.String()
	}
	if f, ok := Num(raw); ok {
		if f == math.Trunc(f) && math.Abs(f) < 1e15 {
			return strconv.FormatInt(int64(f), 10)
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	}
	return ""
}

// ── Prices ───────────────────────────────────────────────────────────────────

// Rupees converts a paise figure and rejects anything that is not a positive
// price. The > 0 gate is load-bearing: an unquoted leg comes through as 0, and
// treating that as a price of zero is what drags a synthetic forward toward the
// strike and a straddle mid toward the floor.
func Rupees(v any) (float64, bool) {
	f, ok := Num(v)
	if !ok || !(f > 0) {
		return 0, false
	}
	return f / 100, true
}

var ltpKeys = []string{"last_traded_price", "ltp", "lastPrice", "close"}

// LTP is the last traded price in rupees.
func LTP(v any) (float64, bool) {
	d, ok := AsDict(v)
	if !ok {
		return 0, false
	}
	raw, ok := Get(d, ltpKeys...)
	if !ok {
		return 0, false
	}
	return Rupees(raw)
}

// ── Implied vol ──────────────────────────────────────────────────────────────

var ivKeys = []string{
	"iv", "IV", "iv_mid", "ivMid", "iv_percent", "ivPercent",
	"implied_volatility", "impliedVolatility", "volatility",
}

// normIV puts a vol in PERCENTAGE POINTS (18.4), because that is what
// StraddlePoint.iv carries and what the chart plots.
//
// The <= 1 branch is a heuristic and is known to be one: feeds send 0.184 and
// 18.4 for the same number, and there is no field that says which. It misreads
// a genuine 0.9% vol as 90%, which no listed option has ever printed, so the
// trade is worth making — but it is the reason a vol should be read here and
// nowhere else.
func normIV(raw any) (float64, bool) {
	n, ok := Num(raw)
	if !ok || !(n > 0) {
		return 0, false
	}
	if n <= 1 {
		return n * 100, true
	}
	return n, true
}

// IV reads a vol off a payload, falling back to the midpoint of a two-sided
// quote when no single mid field is published.
func IV(v any) (float64, bool) {
	d, ok := AsDict(v)
	if !ok {
		return 0, false
	}
	for _, k := range ivKeys {
		if raw, present := d[k]; present {
			if iv, ok := normIV(raw); ok {
				return iv, true
			}
		}
	}
	bidRaw, _ := Get(d, "iv_bid", "ivBid", "bid_iv", "bidIv")
	askRaw, _ := Get(d, "iv_ask", "ivAsk", "ask_iv", "askIv")
	bid, hasBid := normIV(bidRaw)
	ask, hasAsk := normIV(askRaw)
	switch {
	case hasBid && hasAsk:
		return (bid + ask) / 2, true
	case hasBid:
		return bid, true
	case hasAsk:
		return ask, true
	}
	return 0, false
}

// ── Greeks ───────────────────────────────────────────────────────────────────

var greekKeys = map[string][]string{
	"delta": {"delta", "delta_value", "deltaValue"},
	"gamma": {"gamma", "gamma_value", "gammaValue"},
	"vega":  {"vega", "vega_value", "vegaValue"},
	"theta": {"theta", "theta_value", "thetaValue"},
}

// Greek reads one sensitivity. Never through Rupees: a greek is a sensitivity,
// not a premium, and the paise convention does not apply to it.
//
// Zero is rejected for every greek except delta. A greek stream that has not
// populated a contract yet sends 0 far more often than a real ATM straddle
// prints a true zero vega, and accepting those drags the line to the floor.
// Delta is exempt because a straddle's delta legitimately sits near zero — that
// is the whole point of holding one.
func Greek(v any, name string) (float64, bool) {
	d, ok := AsDict(v)
	if !ok {
		return 0, false
	}
	for _, k := range greekKeys[name] {
		raw, present := d[k]
		if !present {
			continue
		}
		n, ok := Num(raw)
		if !ok {
			continue
		}
		if n == 0 && name != "delta" {
			continue
		}
		return n, true
	}
	return 0, false
}

// ── Open interest and volume ─────────────────────────────────────────────────

var oiKeys = []string{
	"oi", "OI", "open_interest", "openInterest", "cumulative_oi", "cumulativeOi", "opnInterest",
}

var volumeKeys = []string{
	"volume", "vol", "traded_volume", "tradedVolume", "volume_traded", "totalTradedVolume", "ttv",
}

// Contracts is a count — OI and volume are integers of lots, not prices, so
// they must never go through Rupees. Divided by 100, an OI of 4,275,000 would
// be reported as 42,750 and a wall would vanish from the chart.
//
// Zero is ACCEPTED here, unlike everywhere else in this file: a strike with
// genuinely no open interest is a real and interesting observation, and it is
// what the far wings actually print.
func Contracts(v any, keys []string) (float64, bool) {
	d, ok := AsDict(v)
	if !ok {
		return 0, false
	}
	raw, ok := Get(d, keys...)
	if !ok {
		return 0, false
	}
	n, ok := Num(raw)
	if !ok || n < 0 {
		return 0, false
	}
	return n, true
}

// OI is cumulative open interest, in contracts.
func OI(v any) (float64, bool) { return Contracts(v, oiKeys) }

// Volume is the day's cumulative traded volume, in contracts. Cumulative, not
// per-tick — every consumer that wants a rate differences it themselves.
func Volume(v any) (float64, bool) { return Contracts(v, volumeKeys) }

// ── Payload walking ──────────────────────────────────────────────────────────

// Each visits every object in a payload that arrives variously as an object, an
// array, or an object wrapping one of data/values/items — all three of which
// the bridge emits depending on the channel.
//
// Depth is bounded because a self-referential payload would otherwise hang the
// ingest goroutine, and nothing legitimate nests more than three deep.
func Each(payload any, visit func(Dict)) { each(payload, visit, 0) }

const maxWalkDepth = 8

func each(payload any, visit func(Dict), depth int) {
	if payload == nil || depth > maxWalkDepth {
		return
	}
	if arr, ok := payload.([]any); ok {
		for _, item := range arr {
			each(item, visit, depth+1)
		}
		return
	}
	d, ok := AsDict(payload)
	if !ok {
		return
	}
	for _, key := range []string{"data", "values", "items"} {
		if nested, ok := d[key].([]any); ok {
			each(nested, visit, depth+1)
		}
	}
	visit(d)
}

// Merge folds an update into a retained payload rather than replacing it.
//
// Replacement loses fields: a greeks frame carrying only delta and gamma would
// wipe a vega published two frames ago, and the leg would go from "has greeks"
// to "has half its greeks" for no reason the market did anything about. Nil
// values do not overwrite, for the same reason.
func Merge(into, from Dict) Dict {
	if into == nil {
		into = make(Dict, len(from))
	}
	for k, v := range from {
		if v == nil {
			continue
		}
		into[k] = v
	}
	return into
}
