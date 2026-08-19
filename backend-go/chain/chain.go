// Package chain ports the pure chain arithmetic from
// backend/analytics/syntheticFuture.ts: strike selection and the synthetic
// forward.
//
// Only the STATELESS half is here. `advanceQuote` and its cursor stay in
// TypeScript for now — they walk broker series that Node owns, and moving a
// cursor across a process boundary would mean shipping the whole series with it.
// That is stage 2's problem, and stage 2 moves the series too.
package chain

import "math"

// Median of a copy — the caller's slice is not reordered, because the samples
// are reported back alongside the median they produced.
func Median(values []float64) float64 {
	if len(values) == 0 {
		return 0
	}
	sorted := append([]float64(nil), values...)
	// Insertion sort: these slices are 5 elements (ATM ± 2), where the constant
	// factor beats sort.Float64s and there is no allocation for the interface.
	for i := 1; i < len(sorted); i++ {
		v := sorted[i]
		j := i - 1
		for j >= 0 && sorted[j] > v {
			sorted[j+1] = sorted[j]
			j--
		}
		sorted[j+1] = v
	}
	mid := len(sorted) >> 1
	if len(sorted)%2 == 1 {
		return sorted[mid]
	}
	return (sorted[mid-1] + sorted[mid]) / 2
}

// InferStep is the smallest positive gap between adjacent strikes — the grid
// the exchange lists on. Falls back to 50 (the NIFTY grid) when a chain has no
// two distinct strikes to measure between.
func InferStep(strikes []float64) float64 {
	step := math.Inf(1)
	for i := 1; i < len(strikes); i++ {
		if diff := strikes[i] - strikes[i-1]; diff > 0 {
			step = math.Min(step, diff)
		}
	}
	if math.IsInf(step, 0) {
		return 50
	}
	return step
}

// NearestStrike snaps a price to the grid, then picks the listed strike closest
// to that. Two steps rather than one: snapping first is what makes the choice
// stable when a price sits almost exactly between two listed strikes.
func NearestStrike(price float64, strikes []float64, step float64) float64 {
	if len(strikes) == 0 {
		return price
	}
	target := price
	if step > 0 {
		target = math.Round(price/step) * step
	}
	best := strikes[0]
	for _, s := range strikes {
		if math.Abs(s-target) < math.Abs(best-target) {
			best = s
		}
	}
	return best
}

// CandidateStrikes is ATM ± band, de-duplicated and in order.
func CandidateStrikes(atm float64, strikes []float64, step float64, band int) []float64 {
	out := make([]float64, 0, 2*band+1)
	seen := make(map[float64]struct{}, 2*band+1)
	for offset := -band; offset <= band; offset++ {
		s := NearestStrike(atm+float64(offset)*step, strikes, step)
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}

// Slice is one chain snapshot: strikes with their call and put marks.
type Slice struct {
	Strikes []float64 `json:"strikes"`
	CallLtp []float64 `json:"callLtp"`
	PutLtp  []float64 `json:"putLtp"`
	Spot    float64   `json:"spot"`
	Atm     float64   `json:"atm,omitempty"`
	Depth   int       `json:"depth,omitempty"`
}

// Sample is one strike's implied forward, kept so a caller can see the spread
// the median came out of rather than only its middle.
type Sample struct {
	Strike  float64 `json:"strike"`
	Forward float64 `json:"forward"`
}

// Synthetic is the result of one snapshot.
type Synthetic struct {
	OK          bool     `json:"status"`
	Message     string   `json:"message,omitempty"`
	Spot        float64  `json:"spot"`
	AtmStrike   float64  `json:"atmStrike"`
	AtmCall     float64  `json:"atmCall"`
	AtmPut      float64  `json:"atmPut"`
	AtmForward  float64  `json:"atmForward"`
	Forward     float64  `json:"forward"`
	Basis       float64  `json:"basis"`
	BasisPct    float64  `json:"basisPct"`
	StrikesUsed int      `json:"strikesUsed"`
	Samples     []Sample `json:"samples"`
}

func nearestIndex(strikes []float64, target float64) int {
	best := -1
	bestGap := math.Inf(1)
	for i, s := range strikes {
		if gap := math.Abs(s - target); gap < bestGap {
			bestGap = gap
			best = i
		}
	}
	return best
}

// SyntheticFuture derives the market's own implied forward from a chain
// snapshot by put-call parity: F = K + CE − PE.
//
// The reported forward is the MEDIAN across ATM ± depth, not the ATM strike's
// own figure. One strike's parity is only as good as its two marks, and a
// single stale leg throws it by the size of the staleness; the median of five
// is unmoved by one bad quote. The ATM's own value is returned alongside as
// AtmForward so the two can be compared when they disagree.
//
// A strike with a zero on either leg is UNQUOTED and skipped, never treated as
// a price of zero — that would drag the forward toward the strike itself.
func SyntheticFuture(c Slice) Synthetic {
	depth := c.Depth
	if depth <= 0 {
		depth = 2
	}
	if len(c.Strikes) == 0 || !(c.Spot > 0) {
		return Synthetic{Message: "Chain has no strikes or spot"}
	}

	atm := c.Spot
	if c.Atm > 0 {
		atm = c.Atm
	}
	atmIndex := nearestIndex(c.Strikes, atm)
	if atmIndex < 0 {
		return Synthetic{Message: "Could not locate ATM strike"}
	}

	lo := max(0, atmIndex-depth)
	hi := min(len(c.Strikes)-1, atmIndex+depth)

	type full struct {
		strike, forward, call, put float64
	}
	samples := make([]full, 0, hi-lo+1)
	for i := lo; i <= hi; i++ {
		if i >= len(c.CallLtp) || i >= len(c.PutLtp) {
			continue
		}
		call, put := c.CallLtp[i], c.PutLtp[i]
		if !(call > 0) || !(put > 0) {
			continue // zero = unquoted, skip
		}
		samples = append(samples, full{c.Strikes[i], c.Strikes[i] + call - put, call, put})
	}
	if len(samples) == 0 {
		return Synthetic{Message: "No strike near ATM has both a call and a put quote"}
	}

	atmSample := samples[0]
	for _, s := range samples {
		if s.strike == c.Strikes[atmIndex] {
			atmSample = s
			break
		}
	}

	forwards := make([]float64, len(samples))
	out := make([]Sample, len(samples))
	for i, s := range samples {
		forwards[i] = s.forward
		out[i] = Sample{Strike: s.strike, Forward: s.forward}
	}

	forward := Median(forwards)
	basis := forward - c.Spot

	return Synthetic{
		OK:          true,
		Spot:        c.Spot,
		AtmStrike:   c.Strikes[atmIndex],
		AtmCall:     atmSample.call,
		AtmPut:      atmSample.put,
		AtmForward:  atmSample.forward,
		Forward:     forward,
		Basis:       basis,
		BasisPct:    basis / c.Spot * 100,
		StrikesUsed: len(samples),
		Samples:     out,
	}
}
