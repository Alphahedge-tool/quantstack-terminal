package book

import (
	"math"
	"testing"

	"quantstack/compute/tick"
)

func payload(bids, asks []any) tick.Dict {
	return tick.Dict{"refId": "X", "bids": bids, "asks": asks}
}

func level(pricePaise, qty float64) any {
	return tick.Dict{"price": pricePaise, "quantity": qty}
}

// Brokers pad short books out to five levels with zeros, and a zero-priced
// level at the top would read as a bid of nothing.
func TestPaddingLevelsAreDropped(t *testing.T) {
	b, ok := Parse(payload(
		[]any{level(10_000, 100), level(0, 0), level(0, 0)},
		[]any{level(10_200, 50), level(0, 0)},
	), 1)
	if !ok {
		t.Fatal("rejected a book with real levels")
	}
	if len(b.Bids) != 1 || len(b.Asks) != 1 {
		t.Fatalf("kept %d bids / %d asks, want 1 / 1", len(b.Bids), len(b.Asks))
	}
	if b.Bids[0].Price != 100 || b.Asks[0].Price != 102 {
		t.Errorf("prices = %v / %v, want 100 / 102 rupees", b.Bids[0].Price, b.Asks[0].Price)
	}
}

// The derived numbers index [0] as "best", so a feed publishing its sides
// unsorted would otherwise make the top of book whichever level arrived first.
func TestSidesAreSortedBestFirst(t *testing.T) {
	b, _ := Parse(payload(
		[]any{level(9_800, 10), level(10_000, 20), level(9_900, 30)},
		[]any{level(10_400, 10), level(10_200, 20)},
	), 1)

	if bid, _ := b.BestBid(); bid != 100 {
		t.Errorf("best bid = %v, want 100 (the highest)", bid)
	}
	if ask, _ := b.BestAsk(); ask != 102 {
		t.Errorf("best ask = %v, want 102 (the lowest)", ask)
	}
}

// A one-sided book is a real market state and must be distinguishable from a
// two-sided book at a price of zero.
func TestOneSidedBookHasNoMidOrSpread(t *testing.T) {
	b, ok := Parse(payload([]any{level(10_000, 100)}, nil), 1)
	if !ok {
		t.Fatal("rejected a one-sided book")
	}
	if b.TwoSided() {
		t.Error("a book with no asks reported itself two-sided")
	}
	if _, ok := b.Mid(); ok {
		t.Error("produced a mid from one side")
	}
	if _, ok := b.Spread(); ok {
		t.Error("produced a spread from one side")
	}
	m := b.Metrics()
	if m.Mid != nil || m.Spread != nil {
		t.Error("Metrics reported a mid or spread as a number rather than null")
	}
	if m.Bid == nil || *m.Bid != 100 {
		t.Errorf("bid = %v, want 100 — the side that IS quoted", m.Bid)
	}
}

// A crossed book means the two sides were published from different instants,
// and clamping the spread to zero would hide the one signal that says so.
func TestCrossedBookReportsANegativeSpread(t *testing.T) {
	b, _ := Parse(payload([]any{level(10_200, 10)}, []any{level(10_000, 10)}), 1)
	spread, ok := b.Spread()
	if !ok {
		t.Fatal("no spread on a two-sided book")
	}
	if spread >= 0 {
		t.Errorf("spread = %v, want negative on a crossed book", spread)
	}
}

// The microprice weights each price by the OPPOSITE side's size: heavy resting
// size on the bid means the next trade is more likely to happen at the ask.
func TestMicropriceLeansTowardTheHeavySide(t *testing.T) {
	b, _ := Parse(payload(
		[]any{level(10_000, 900)}, // 100.00, deep
		[]any{level(10_200, 100)}, // 102.00, thin
	), 1)

	mp, ok := b.Microprice()
	if !ok {
		t.Fatal("no microprice on a two-sided book")
	}
	mid, _ := b.Mid()
	if mp <= mid {
		t.Errorf("microprice %v is not above the mid %v despite a heavy bid", mp, mid)
	}
	// (100·100 + 102·900) / 1000
	if want := 101.8; math.Abs(mp-want) > 1e-9 {
		t.Errorf("microprice = %v, want %v", mp, want)
	}
}

func TestImbalanceUsesTheWholeBook(t *testing.T) {
	b, _ := Parse(payload(
		[]any{level(10_000, 100), level(9_900, 200)},
		[]any{level(10_200, 100)},
	), 1)

	imb, ok := b.Imbalance()
	if !ok {
		t.Fatal("no imbalance")
	}
	// (300 − 100) / 400
	if want := 0.5; math.Abs(imb-want) > 1e-9 {
		t.Errorf("imbalance = %v, want %v", imb, want)
	}
}

// A malformed frame is not evidence that the book emptied, so the caller must
// be told to keep what it had.
func TestPayloadWithNoUsableDepthIsRejected(t *testing.T) {
	if _, ok := Parse(tick.Dict{"refId": "X"}, 1); ok {
		t.Error("accepted a payload with no sides at all")
	}
	if _, ok := Parse(payload([]any{level(0, 0)}, []any{level(0, 0)}), 1); ok {
		t.Error("accepted a payload whose every level was padding")
	}
}
