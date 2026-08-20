// Package book holds the live order book for one contract and derives the
// handful of microstructure numbers the terminal actually reads off it.
//
// ── Why the engine keeps a book at all ──
//
// The straddle rule prices candidates off depth, not off last-traded price, and
// the reason is in engine/liveStraddle.ts: "Depth is the honest quote". An LTP
// is a print from the past — possibly minutes back on an outer strike — while
// the top of book is a price someone is offering right now. Selecting the
// cheapest straddle in a band on stale prints picks whichever leg went quietest,
// which is the opposite of what the rule intends.
//
// ── What is derived here and not upstream ──
//
// Spread, imbalance and microprice are all functions of the same two sides, and
// computing them where the sides live means they are always consistent with
// each other and with the quote that produced them. Computed at the consumer,
// they would each read the book at a slightly different instant.
package book

import (
	"math"
	"sort"

	"quantstack/compute/tick"
)

// MaxLevels is what brokers publish and what the engine retains. Nubra, Angel
// and Zerodha all send five a side; retaining more would mean inventing levels,
// and retaining fewer would drop depth the imbalance calculation uses.
const MaxLevels = 5

// Level is one price step of the book.
type Level struct {
	Price float64 `json:"price"`
	Qty   float64 `json:"qty"`
	// Orders is how many resting orders make up Qty. Published by some feeds and
	// not others; zero means "not published", which is why it is not used in any
	// derived number below — a metric that silently changed meaning between two
	// brokers would be worse than not having it.
	Orders float64 `json:"orders,omitempty"`
}

// Book is one contract's two-sided depth at one instant.
//
// Bids descend and asks ascend, always — the derived numbers below index [0] as
// "best" and a feed that publishes its sides unsorted would otherwise make the
// top of book whichever level happened to arrive first.
type Book struct {
	Bids  []Level `json:"bids"`
	Asks  []Level `json:"asks"`
	TsMs  int64   `json:"ts"`
	RefID string  `json:"refId,omitempty"`
}

// ── Parsing ──────────────────────────────────────────────────────────────────

var (
	priceKeys = []string{"price", "px", "rate", "p"}
	qtyKeys   = []string{"quantity", "qty", "size", "q", "volume"}
	orderKeys = []string{"orders", "num_orders", "numOrders", "no_of_orders"}
	bidKeys   = []string{"bids", "bid", "buy", "buyLevels", "bid_levels"}
	askKeys   = []string{"asks", "ask", "sell", "sellLevels", "ask_levels"}
)

// parseSide reads one side of a depth payload.
//
// A level with a zero price or a zero quantity is DROPPED rather than kept as
// an empty rung. Brokers pad short books out to five levels with zeros, and a
// zero-priced level at the top would read as a bid of nothing — the cheapest
// straddle in the band, every time.
func parseSide(raw any, descending bool) []Level {
	arr, ok := raw.([]any)
	if !ok {
		return nil
	}
	out := make([]Level, 0, MaxLevels)
	for _, item := range arr {
		d, ok := tick.AsDict(item)
		if !ok {
			continue
		}
		pRaw, hasP := tick.Get(d, priceKeys...)
		qRaw, hasQ := tick.Get(d, qtyKeys...)
		if !hasP || !hasQ {
			continue
		}
		price, okP := tick.Rupees(pRaw)
		qty, okQ := tick.Num(qRaw)
		if !okP || !okQ || !(qty > 0) {
			continue
		}
		lvl := Level{Price: price, Qty: qty}
		if oRaw, ok := tick.Get(d, orderKeys...); ok {
			if n, ok := tick.Num(oRaw); ok && n > 0 {
				lvl.Orders = n
			}
		}
		out = append(out, lvl)
		if len(out) >= MaxLevels {
			break
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if descending {
			return out[i].Price > out[j].Price
		}
		return out[i].Price < out[j].Price
	})
	return out
}

// Parse reads a depth payload into a Book, or reports that it carried no
// usable depth. The caller keeps its previous book in that case: a malformed
// frame is not evidence that the book emptied.
func Parse(payload tick.Dict, tsMs int64) (Book, bool) {
	bidRaw, hasBid := tick.Get(payload, bidKeys...)
	askRaw, hasAsk := tick.Get(payload, askKeys...)
	if !hasBid && !hasAsk {
		return Book{}, false
	}
	b := Book{
		Bids:  parseSide(bidRaw, true),
		Asks:  parseSide(askRaw, false),
		TsMs:  tsMs,
		RefID: tick.RefID(payload),
	}
	if len(b.Bids) == 0 && len(b.Asks) == 0 {
		return Book{}, false
	}
	return b, true
}

// ── Reads ────────────────────────────────────────────────────────────────────

// BestBid, BestAsk report the top of each side. The bool is the whole point:
// a one-sided book is a real market state (the wings go one-sided constantly)
// and must be distinguishable from a two-sided book at a price of zero.
func (b Book) BestBid() (float64, bool) {
	if len(b.Bids) == 0 {
		return 0, false
	}
	return b.Bids[0].Price, true
}

func (b Book) BestAsk() (float64, bool) {
	if len(b.Asks) == 0 {
		return 0, false
	}
	return b.Asks[0].Price, true
}

// TwoSided is the gate the straddle rule uses. A leg without both sides cannot
// be priced honestly and the strike is skipped.
func (b Book) TwoSided() bool {
	return len(b.Bids) > 0 && len(b.Asks) > 0
}

// Mid is the arithmetic midpoint, undefined on a one-sided book.
func (b Book) Mid() (float64, bool) {
	bid, okB := b.BestBid()
	ask, okA := b.BestAsk()
	if !okB || !okA {
		return 0, false
	}
	return (bid + ask) / 2, true
}

// Spread is ask − bid in rupees.
//
// It can come back NEGATIVE, and that is reported rather than clamped: a
// crossed book means the two sides were published from different instants, and
// a consumer that sees the crossing can distrust the quote. Clamping to zero
// would hide the one signal that says the depth is not simultaneous.
func (b Book) Spread() (float64, bool) {
	bid, okB := b.BestBid()
	ask, okA := b.BestAsk()
	if !okB || !okA {
		return 0, false
	}
	return ask - bid, true
}

// SpreadBps is the spread relative to the mid, in basis points — the form that
// is comparable across a 12-rupee wing and a 400-rupee ATM.
func (b Book) SpreadBps() (float64, bool) {
	spread, ok := b.Spread()
	if !ok {
		return 0, false
	}
	mid, ok := b.Mid()
	if !ok || !(mid > 0) {
		return 0, false
	}
	return spread / mid * 10_000, true
}

// Imbalance is (bidQty − askQty) / (bidQty + askQty) over the whole retained
// book, in [−1, +1]: +1 is all bid, −1 is all offer.
//
// Full depth rather than top-of-book only, because top-of-book imbalance is
// dominated by whichever side most recently refreshed, while the shape of five
// levels moves on the timescale a human reads it at.
func (b Book) Imbalance() (float64, bool) {
	bidQty, askQty := b.BidQty(), b.AskQty()
	total := bidQty + askQty
	if !(total > 0) {
		return 0, false
	}
	return (bidQty - askQty) / total, true
}

// BidQty and AskQty total the retained levels on each side.
func (b Book) BidQty() float64 { return totalQty(b.Bids) }
func (b Book) AskQty() float64 { return totalQty(b.Asks) }

func totalQty(levels []Level) float64 {
	var sum float64
	for _, l := range levels {
		sum += l.Qty
	}
	return sum
}

// Microprice is the size-weighted midpoint:
//
//	(bid·askQty + ask·bidQty) / (bidQty + askQty)
//
// The weights are crossed on purpose. Heavy resting size on the bid means the
// next trade is more likely to happen at the ASK, so the fair value sits nearer
// the ask — weighting each price by the OPPOSITE side's size is what encodes
// that. Weighted the intuitive way round, the number leans the wrong way in
// exactly the situations it exists to describe.
//
// Top-of-book only here, unlike Imbalance: the microprice is a statement about
// the next trade, and the next trade happens against level one.
func (b Book) Microprice() (float64, bool) {
	if !b.TwoSided() {
		return 0, false
	}
	bid, ask := b.Bids[0], b.Asks[0]
	total := bid.Qty + ask.Qty
	if !(total > 0) {
		return 0, false
	}
	return (bid.Price*ask.Qty + ask.Price*bid.Qty) / total, true
}

// Metrics is every derived number at once, as a snapshot.
//
// Bundled rather than called one at a time so a consumer cannot mix a spread
// from one book revision with an imbalance from the next — the whole struct
// comes off a single instant of depth.
type Metrics struct {
	Bid        *float64 `json:"bid"`
	Ask        *float64 `json:"ask"`
	Mid        *float64 `json:"mid"`
	Spread     *float64 `json:"spread"`
	SpreadBps  *float64 `json:"spreadBps"`
	Microprice *float64 `json:"microprice"`
	Imbalance  *float64 `json:"imbalance"`
	BidQty     float64  `json:"bidQty"`
	AskQty     float64  `json:"askQty"`
	Levels     int      `json:"levels"`
	TsMs       int64    `json:"ts"`
}

func opt(v float64, ok bool) *float64 {
	if !ok || math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

// Metrics derives everything from one book. Absent numbers are null, never
// zero — the same discipline the straddle point follows for iv and the greeks.
func (b Book) Metrics() Metrics {
	return Metrics{
		Bid:        opt(b.BestBid()),
		Ask:        opt(b.BestAsk()),
		Mid:        opt(b.Mid()),
		Spread:     opt(b.Spread()),
		SpreadBps:  opt(b.SpreadBps()),
		Microprice: opt(b.Microprice()),
		Imbalance:  opt(b.Imbalance()),
		BidQty:     b.BidQty(),
		AskQty:     b.AskQty(),
		Levels:     max(len(b.Bids), len(b.Asks)),
		TsMs:       b.TsMs,
	}
}
