// Package straddle is the live rolling-ATM straddle engine.
//
// It is a port of backend/engine/liveStraddle.ts, and the selection rule is
// deliberately identical to the historical engine's: ATM from spot, candidates
// at ATM ± BAND, cheapest mid wins, a confirmed change of strike is a roll.
// That identity is the product. A live point and a historical point are the
// same object, so the chart appends one to the other without knowing which is
// which — and the reference implementation that recomputes the rule in the
// browser is exactly why its live line does not reconcile with its own history.
//
// What this adds over the TypeScript engine, and why it is here rather than
// there:
//
//   - The IV is SOLVED when the feed does not publish one, instead of the point
//     going out without a vol. That is a Black-76 inversion per bar, which is
//     the work the compute sidecar was split out for in the first place.
//   - Open interest, traded volume and depth microstructure ride along on the
//     same point, from the same instant. Computed anywhere else they would be
//     read off a book that had already moved.
//   - Aggregation into bars happens here, so the socket to the browser carries
//     what a chart can draw rather than what a decoder produced.
package straddle

// Point is one computed observation of the rolling straddle.
//
// The JSON tags match StraddlePoint in backend/analytics/syntheticFuture.ts
// field for field, because the frontend already consumes that shape and a live
// point must be indistinguishable from a historical one. New fields are added
// as optional extras below the ported ones — additive, so an older client
// simply ignores them.
type Point struct {
	Time            int64   `json:"time"`
	Spot            float64 `json:"spot"`
	AtmStrike       float64 `json:"atmStrike"`
	SyntheticFuture float64 `json:"syntheticFuture"`
	CallLtp         float64 `json:"callLtp"`
	PutLtp          float64 `json:"putLtp"`
	StraddlePrice   float64 `json:"straddlePrice"`

	StraddleBid *float64 `json:"straddleBid,omitempty"`
	StraddleAsk *float64 `json:"straddleAsk,omitempty"`

	// IV in PERCENTAGE POINTS, and IVSource says where it came from. The feed
	// only carries IV for recent contracts, so a session legitimately mixes both
	// — and a spliced series that does not say which is which is impossible to
	// audit when the two disagree.
	IV       *float64 `json:"iv,omitempty"`
	IVSource string   `json:"ivSource,omitempty"` // "feed" | "black76"

	// Greeks of the straddle actually held at this point — CE + PE at the
	// SELECTED strike, so they roll with it. Vega per vol point, theta per
	// calendar day, both per one unit of the underlying rather than per lot,
	// matching the convention every other price on this object uses.
	//
	// Absent, not zero, when neither leg published a greek and no vol was
	// recoverable to derive one.
	Vega        *float64 `json:"vega,omitempty"`
	Theta       *float64 `json:"theta,omitempty"`
	Delta       *float64 `json:"delta,omitempty"`
	Gamma       *float64 `json:"gamma,omitempty"`
	GreekSource string   `json:"greekSource,omitempty"` // "feed" | "black76"

	IsRollEvent bool `json:"isRollEvent"`

	// ── Additive: what the Go engine can carry and the TypeScript one could not
	//
	// Nested rather than flattened so the ported fields above stay exactly the
	// shape the existing chart binds to, and a client that has never heard of
	// microstructure drops one key instead of nine.
	Micro *Micro `json:"micro,omitempty"`
}

// Micro is the state of the market around the straddle at the same instant the
// point was computed.
//
// One instant is the whole reason it lives on the point. Open interest read a
// second later is a different number from the one that priced this straddle,
// and an alert that fires on "OI jumped while the straddle was at X" is only
// meaningful if the two were observed together.
type Micro struct {
	// Depth-derived, summed across the two legs where summing is meaningful.
	// Spread is CE spread + PE spread, because that is what it costs to get out
	// of the position; imbalance is the size-weighted mean of the legs, because
	// summing a ratio is meaningless.
	SpreadRs   *float64 `json:"spreadRs,omitempty"`
	SpreadBps  *float64 `json:"spreadBps,omitempty"`
	Imbalance  *float64 `json:"imbalance,omitempty"`
	Microprice *float64 `json:"microprice,omitempty"`

	// Open interest at the held strike: the two legs, their total, and how far
	// that total has moved since the session's first reading.
	CallOI      *float64 `json:"callOi,omitempty"`
	PutOI       *float64 `json:"putOi,omitempty"`
	TotalOI     *float64 `json:"totalOi,omitempty"`
	OIChange    *float64 `json:"oiChange,omitempty"`
	OIChangePct *float64 `json:"oiChangePct,omitempty"`

	// PCR is put OI over call OI at the held strike — the one-strike version of
	// the chain-wide ratio, and the only one that can be stated honestly from a
	// band this narrow.
	PCR *float64 `json:"pcr,omitempty"`

	// Cumulative traded volume of the two legs for the session.
	CallVolume *float64 `json:"callVolume,omitempty"`
	PutVolume  *float64 `json:"putVolume,omitempty"`

	// Both legs quoted two-sided at selection time. False means the mid came off
	// an LTP fallback for at least one leg, which is worth knowing before
	// trusting a spread.
	Firm bool `json:"firm"`
}

// Roll is what a change of held strike did to the position.
//
// Mirrors RollEvent in backend/engine/rollingStraddle.ts. VegaJump and
// ThetaJump are the greek analogue of the roll cost: rolling into a nearer-the-
// money strike re-buys vega and re-buys negative theta, and both are costs the
// straddle price alone hides.
type Roll struct {
	Time          int64    `json:"time"`
	FromStrike    float64  `json:"fromStrike"`
	ToStrike      float64  `json:"toStrike"`
	SynFuture     float64  `json:"synFuture"`
	StraddlePrice float64  `json:"straddlePrice"`
	VegaJump      *float64 `json:"vegaJump"`
	ThetaJump     *float64 `json:"thetaJump"`
}

// Event is what the engine publishes.
//
// The names match the wire protocol /ws/live/straddle already speaks (see
// backend/live/wsStraddle.ts), so an existing client needs no changes to read
// from the Go engine.
type Event struct {
	Event string `json:"event"` // status | point | error | bar | state

	Point *Point `json:"point,omitempty"`
	Roll  *Roll  `json:"roll,omitempty"`

	Status  string `json:"status,omitempty"`
	Message string `json:"message,omitempty"`

	// Bar is a closed OHLC bar of the straddle mid, emitted on the interval
	// boundary. A client that wants candles no longer has to build them out of
	// the point stream and get a different answer than the history endpoint.
	Bar any `json:"bar,omitempty"`

	// State is the market clock, on `state` events. Its own field rather than
	// riding in Bar: two unrelated payloads sharing one key is how a consumer
	// ends up switching on the event name to know what it just parsed.
	State any `json:"state,omitempty"`

	// Feed is which source produced the data behind this event, so a failover is
	// visible in the stream rather than only in a log.
	Feed string `json:"feed,omitempty"`
}

// Replay is what a reconnecting client missed.
type Replay struct {
	Points []Point `json:"points"`
	Rolls  []Roll  `json:"rolls"`
	// Complete is true when the replay actually starts where the client left
	// off. False means the retained window no longer reaches back that far, so a
	// hole remains and the client must refill it from history.
	Complete bool `json:"complete"`
}

func f64(v float64) *float64 { return &v }
