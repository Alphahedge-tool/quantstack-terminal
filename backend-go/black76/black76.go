// Package black76 is a line-for-line port of backend/analytics/black76.ts.
//
// ── Why this is a PORT and not a rewrite ──
//
// The TypeScript original is the specification. Every constant, every branch
// and every NaN in here exists because the same one exists there, including
// the ones that look like they could be simplified — MIN_VEGA, the step-based
// convergence test, the refusal to clamp. Each was arrived at by a verification
// run against real quotes, and the comments in the original record which
// failure produced which line.
//
// So the rule for this file is: if the algebra here disagrees with the
// TypeScript, the TypeScript wins and this file is wrong. `scripts/verifyGo.ts`
// enforces that by running both over the same inputs and diffing to 1e-12.
//
// The one deliberate difference is language, not maths: Go's math.Log/Exp/Sqrt
// are the same IEEE-754 doubles V8 uses, so agreement to the last few ulps is
// achievable rather than aspirational.
package black76

import (
	"math"
	"strings"
	"time"
)

// ── Normal distribution ─────────────────────────────────────────────────────

// NormalCdf is Hart's rational approximation for the standard normal CDF.
//
// Near double precision out to ~7 sigma, degrading to ~9e-9 relative in the
// continued-fraction branch beyond it — where the probability itself is below
// 1e-15 and nothing downstream can tell. Chosen over Abramowitz-Stegun 7.1.26,
// whose ~7e-8 ABSOLUTE error swamps the price of a deep-OTM wing outright and
// leaves the inverter chasing noise.
func NormalCdf(x float64) float64 {
	ax := math.Abs(x)
	var p float64

	if ax > 37 {
		p = 0
	} else {
		e := math.Exp(-ax * ax / 2)
		if ax < 7.07106781186547 {
			num := 3.52624965998911e-2*ax + 0.700383064443688
			num = num*ax + 6.37396220353165
			num = num*ax + 33.912866078383
			num = num*ax + 112.079291497871
			num = num*ax + 221.213596169931
			num = num*ax + 220.206867912376

			den := 8.83883476483184e-2*ax + 1.75566716318264
			den = den*ax + 16.064177579207
			den = den*ax + 86.7807322029461
			den = den*ax + 296.564248779674
			den = den*ax + 637.333633378831
			den = den*ax + 793.826512519948
			den = den*ax + 440.413735824752

			p = e * num / den
		} else {
			// Continued fraction — the polynomial above loses accuracy past ~7 sigma.
			cf := ax + 0.65
			cf = ax + 4/cf
			cf = ax + 3/cf
			cf = ax + 2/cf
			cf = ax + 1/cf
			p = e / cf / 2.506628274631
		}
	}

	if x > 0 {
		return 1 - p
	}
	return p
}

const invSqrt2Pi = 0.3989422804014327

func NormalPdf(x float64) float64 {
	return invSqrt2Pi * math.Exp(-x*x/2)
}

// ── Time to expiry ──────────────────────────────────────────────────────────

// IST is UTC+5:30, so a 15:30 IST close is 10:00 UTC.
const expiryUTCHour = 10

const daysPerYear = 365.0

// YearsToExpiry gives years from a timestamp (epoch ms) to expiry.
//
// Calendar time, not trading time: theta accrues over a weekend, and a
// trading-day count makes Friday and Monday look identical when they are not.
//
// Intraday precision is not optional. On expiry day a whole-day count reads T
// as either one day or zero for the entire session, and IV computed from it is
// wrong by a factor that grows without bound as 15:30 approaches.
//
// Returns NaN for an unparseable expiry, matching the TypeScript, so a bad
// contract string fails the `T > 0` guard downstream instead of silently
// pricing at some default.
func YearsToExpiry(tsMs float64, expiry string) float64 {
	raw := strings.ReplaceAll(expiry, "-", "")
	if len(raw) != 8 {
		return math.NaN()
	}
	t, err := time.Parse("20060102", raw)
	if err != nil {
		return math.NaN()
	}
	expiryMs := float64(t.UTC().Unix()+expiryUTCHour*3600) * 1000
	return (expiryMs - tsMs) / (daysPerYear * 86_400_000)
}

// ── Pricing ─────────────────────────────────────────────────────────────────

type Side string

const (
	Call Side = "CE"
	Put  Side = "PE"
)

func ds(f, k, t, sigma float64) (d1, d2, sqrtT float64) {
	sqrtT = math.Sqrt(t)
	v := sigma * sqrtT
	d1 = (math.Log(f/k) + v*v/2) / v
	return d1, d1 - v, sqrtT
}

// Price is the undiscounted Black-76 price (r = 0).
//
// At T <= 0 or sigma <= 0 this is intrinsic value, which is the correct limit
// and keeps the inverter's bracket endpoints well defined.
func Price(f, k, t, sigma float64, side Side) float64 {
	if !(t > 0) || !(sigma > 0) || !(f > 0) || !(k > 0) {
		if side == Call {
			return math.Max(f-k, 0)
		}
		return math.Max(k-f, 0)
	}
	d1, d2, _ := ds(f, k, t, sigma)
	if side == Call {
		return f*NormalCdf(d1) - k*NormalCdf(d2)
	}
	return k*NormalCdf(-d2) - f*NormalCdf(-d1)
}

// Straddle is call + put at one strike. Monotone in sigma, which the inverter
// relies on.
func Straddle(f, k, t, sigma float64) float64 {
	return Price(f, k, t, sigma, Call) + Price(f, k, t, sigma, Put)
}

// Vega is dPrice/dSigma. Identical for calls and puts; doubled for a straddle.
func Vega(f, k, t, sigma float64) float64 {
	if !(t > 0) || !(sigma > 0) || !(f > 0) || !(k > 0) {
		return 0
	}
	d1, _, sqrtT := ds(f, k, t, sigma)
	return f * NormalPdf(d1) * sqrtT
}

// ── Implied volatility ──────────────────────────────────────────────────────

const (
	sigmaMin = 1e-4 // 0.01%
	sigmaMax = 5.0  // 500% — far past anything NIFTY has printed
	sigmaTol = 1e-10
	maxIter  = 128

	// NSE quotes options in 5-paise steps, so this is the finest real price signal.
	tick = 0.05

	// Reject an inversion when one tick of price moves vol by more than this.
	//
	// Not a numerical guard — an identifiability one. An option far enough OTM,
	// or close enough to expiry, has a straddle price that IS its intrinsic
	// value to within a rounding error, and no volatility can be recovered from
	// it. Requiring vega >= tick/maxVolUncertainty makes those return NaN, which
	// is the honest answer.
	maxVolUncertainty = 0.01 // 1 vol point
	minVega           = tick / maxVolUncertainty
)

// ApproxStraddleVol is Brenner-Subrahmanyam: the closed-form ATM straddle vol.
//
// Only used as the inverter's starting guess, where being within a few percent
// saves iterations. It assumes F = K exactly, and an ATM strike snapped to a
// 50-point grid can sit 25 points off a 350-point straddle.
func ApproxStraddleVol(straddle, f, t float64) float64 {
	if !(t > 0) || !(f > 0) || !(straddle > 0) {
		return math.NaN()
	}
	return 1.2533141373155003 * straddle / (f * math.Sqrt(t))
}

// invert solves price(sigma) = target by safeguarded Newton (Numerical Recipes
// rtsafe).
//
// Plain Newton on vega fails exactly where this data is worst: vega collapses
// toward zero deep OTM and on expiry afternoon, so the step explodes and the
// iterate leaves any sensible range. Carrying a bracket and bisecting whenever
// Newton proposes a point outside it — or is converging too slowly — makes the
// routine unconditionally convergent while still taking the quadratic step
// through the well-behaved middle.
//
// Convergence is tested on the STEP, not on |price − target|. Where vega is
// small a whole range of volatilities reprice to within 1e-8 of each other, so
// a price-converged iterate can still be vol-points wrong. That was a real
// defect in the original, caught at 6.2e-2 vol.
func invert(target float64, priceAt, vegaAt func(float64) float64, guess float64) float64 {
	// Typed explicitly: sigmaMax is an untyped integer constant, and `hi := sigmaMax`
	// would make the whole bracket integer arithmetic.
	lo := float64(sigmaMin)
	hi := float64(sigmaMax)

	fLo := priceAt(lo) - target
	fHi := priceAt(hi) - target
	if fLo > 0 || fHi < 0 {
		return math.NaN()
	}
	if fLo == 0 {
		return lo
	}
	if fHi == 0 {
		return hi
	}

	sigma := (lo + hi) / 2
	if !math.IsNaN(guess) && !math.IsInf(guess, 0) && guess > lo && guess < hi {
		sigma = guess
	}

	dxPrev := hi - lo
	dx := dxPrev
	f := priceAt(sigma) - target
	df := vegaAt(sigma)

	for i := 0; i < maxIter; i++ {
		// Bisect when the Newton step would leave the bracket, or when it is not
		// at least halving the interval. A zero vega lands here too, since the
		// second test is then trivially true.
		outside := ((sigma-hi)*df-f)*((sigma-lo)*df-f) > 0

		if outside || math.Abs(2*f) > math.Abs(dxPrev*df) {
			dxPrev = dx
			dx = (hi - lo) / 2
			next := lo + dx
			if next == lo {
				return sigma // bracket collapsed to adjacent floats
			}
			sigma = next
		} else {
			dxPrev = dx
			dx = f / df
			prev := sigma
			sigma -= dx
			if prev == sigma {
				return sigma
			}
		}

		if math.Abs(dx) < sigmaTol {
			return sigma
		}

		f = priceAt(sigma) - target
		df = vegaAt(sigma)
		if f < 0 {
			lo = sigma
		} else {
			hi = sigma
		}
	}
	return sigma
}

// ImpliedVol inverts a single leg, as a decimal (0.13 = 13%). NaN if unsolvable.
func ImpliedVol(premium, f, k, t float64, side Side) float64 {
	if !(premium > 0) || !(t > 0) || !(f > 0) || !(k > 0) {
		return math.NaN()
	}

	intrinsic := math.Max(f-k, 0)
	maximum := f
	if side == Put {
		intrinsic = math.Max(k-f, 0)
		maximum = k
	}
	if premium <= intrinsic || premium >= maximum {
		return math.NaN()
	}

	sigma := invert(
		premium,
		func(s float64) float64 { return Price(f, k, t, s, side) },
		func(s float64) float64 { return Vega(f, k, t, s) },
		ApproxStraddleVol(premium*2, f, t),
	)
	if math.IsNaN(sigma) || math.IsInf(sigma, 0) {
		return math.NaN()
	}
	if Vega(f, k, t, sigma) >= minVega {
		return sigma
	}
	return math.NaN()
}

// ImpliedVolStraddle inverts the straddle as a whole — the number this terminal
// wants.
//
// Inverting the SUM rather than averaging two per-leg inversions is deliberate:
// vega doubles, so the problem is the best-conditioned inversion available, and
// a single illiquid leg degrades the answer instead of destroying it.
//
// NaN, never a clamp, in the two cases where no answer exists. Stale quotes
// routinely print a straddle below |F − K|, which is an arbitrage and has no
// implied vol at all. And a straddle whose extrinsic value has decayed below
// the tick has no RECOVERABLE vol, whatever the algebra says — see minVega.
func ImpliedVolStraddle(straddle, f, k, t float64) float64 {
	if !(straddle > 0) || !(t > 0) || !(f > 0) || !(k > 0) {
		return math.NaN()
	}
	if straddle <= math.Abs(f-k) || straddle >= f+k {
		return math.NaN()
	}

	sigma := invert(
		straddle,
		func(s float64) float64 { return Straddle(f, k, t, s) },
		func(s float64) float64 { return 2 * Vega(f, k, t, s) },
		ApproxStraddleVol(straddle, f, t),
	)
	if math.IsNaN(sigma) || math.IsInf(sigma, 0) {
		return math.NaN()
	}
	if 2*Vega(f, k, t, sigma) >= minVega {
		return sigma
	}
	return math.NaN()
}

// ── Greeks ──────────────────────────────────────────────────────────────────

// Greeks are the raw derivatives: vega per 1.00 of vol, theta per year.
type Greeks struct {
	Delta float64 `json:"delta"`
	Gamma float64 `json:"gamma"`
	Vega  float64 `json:"vega"`
	Theta float64 `json:"theta"`
}

// LegGreeks are the closed-form greeks, free once sigma is known.
//
// r = 0 simplifies theta considerably: the carry and discount terms vanish and
// only the variance term survives, which is also why call and put theta are
// equal here — parity gives C − P = F − K, with no T in it.
func LegGreeks(f, k, t, sigma float64, side Side) Greeks {
	if !(t > 0) || !(sigma > 0) || !(f > 0) || !(k > 0) {
		return Greeks{}
	}
	d1, _, sqrtT := ds(f, k, t, sigma)
	pdf := NormalPdf(d1)

	delta := NormalCdf(d1)
	if side == Put {
		delta = delta - 1
	}
	return Greeks{
		Delta: delta,
		Gamma: pdf / (f * sigma * sqrtT),
		Vega:  f * pdf * sqrtT,
		Theta: -f * pdf * sigma / (2 * sqrtT),
	}
}

// A vol expressed in points (18.4) rather than as a decimal (0.184).
const volPoint = 100

// StraddleGreeksOf gives the greeks of a straddle — both legs at one strike —
// rescaled to FEED units: vega per vol point, theta per calendar day.
//
// The two rescalings are what make a derived greek comparable to a fed one.
// Black-76 vega is per 1.00 of vol and theta is per year, while every broker
// greek stream quotes vega per vol point and theta per day. Mixing the
// conventions in one series would put a 100x step at the splice.
//
// ok is false where no greeks exist, mirroring the TypeScript's `null` — the
// caller must not read the zero value as a greek of zero.
func StraddleGreeksOf(f, k, t, sigma float64) (Greeks, bool) {
	if !(t > 0) || !(sigma > 0) || !(f > 0) || !(k > 0) {
		return Greeks{}, false
	}
	ce := LegGreeks(f, k, t, sigma, Call)
	pe := LegGreeks(f, k, t, sigma, Put)

	return Greeks{
		Delta: ce.Delta + pe.Delta,
		Gamma: ce.Gamma + pe.Gamma,
		Vega:  (ce.Vega + pe.Vega) / volPoint,
		Theta: (ce.Theta + pe.Theta) / daysPerYear,
	}, true
}
