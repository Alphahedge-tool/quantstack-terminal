// Package agg turns a stream of ticks into the shapes a chart and an alert can
// read: bars at a fixed interval, deltas out of cumulative counters, and a
// fixed-memory window of recent history.
//
// ── Why aggregation belongs on this side of the wire ──
//
// A 40-strike chain publishes hundreds of ticks a second. Everything downstream
// — the chart, the assistant's monitor, the OI alerts — reads at human rates:
// a bar a minute, a point every few hundred ms. Aggregating at the edge means
// the socket to the browser carries what the browser can use, instead of the
// browser throwing away 99% of what it decoded.
//
// ── Why bars close on the clock, not on the tick ──
//
// A bar that closes when the NEXT tick arrives never closes on a contract that
// goes quiet, which is precisely the contract you most want the last bar of.
// Every aggregator here is driven by a Flush(now) the caller pumps on a ticker,
// so a silent instrument produces a closed bar and then nothing, rather than an
// open bar that hangs forever.
package agg

import (
	"math"
	"sort"
)

// ── Bars ─────────────────────────────────────────────────────────────────────

// Bar mirrors Candle in backend/feeds/types.ts, so a bar computed live and a
// bar loaded from history are the same object to every consumer.
//
// Vol and OI are pointers because "no volume published" and "no volume traded"
// are different facts, and a chart that plots the first as a zero prints a gap
// in the volume histogram that the market never had.
type Bar struct {
	TsMs int64    `json:"ts"`
	O    float64  `json:"o"`
	H    float64  `json:"h"`
	L    float64  `json:"l"`
	C    float64  `json:"c"`
	Vol  *float64 `json:"vol,omitempty"`
	OI   *float64 `json:"oi,omitempty"`
	// N is how many ticks went into this bar. Not a market quantity — it is how
	// a thin bar (one print, carried) is told apart from a real one when the two
	// look identical on the chart.
	N int `json:"n,omitempty"`
}

// Aggregator folds ticks for ONE series into fixed-interval bars.
//
// Not safe for concurrent use: one aggregator belongs to one instrument, and
// one instrument's ticks are processed on one goroutine. Sharing it would need
// a mutex per instrument on the hottest path in the process, to serialise
// writes that never actually race.
type Aggregator struct {
	intervalMs int64
	open       *Bar
	// cumVol and cumOI hold the last cumulative figures seen, because feeds
	// publish running totals and a bar wants the increment.
	lastVol   float64
	haveVol   bool
	lastOI    float64
	haveOI    bool
	barVolume float64
	barHasVol bool
}

// NewAggregator builds one for a bar width in ms. A non-positive interval is
// clamped to one second rather than rejected: the caller is usually passing a
// parsed config value, and a division by zero on the hot path is a worse
// failure than a bar width that is merely not what was asked for.
func NewAggregator(intervalMs int64) *Aggregator {
	if intervalMs <= 0 {
		intervalMs = 1000
	}
	return &Aggregator{intervalMs: intervalMs}
}

// bucket is the start of the bar an instant belongs to. Floor division on epoch
// ms, so buckets align to the wall clock and two instruments' 1-minute bars
// share edges — which is what makes them comparable at all.
func (a *Aggregator) bucket(tsMs int64) int64 {
	return tsMs - mod(tsMs, a.intervalMs)
}

func mod(a, b int64) int64 {
	m := a % b
	if m < 0 {
		m += b
	}
	return m
}

// Sample is one observation: a price, and optionally the cumulative counters
// that arrived with it.
type Sample struct {
	TsMs      int64
	Price     float64
	CumVolume *float64
	CumOI     *float64
}

// Add folds one sample in, returning a bar if this sample opened a new bucket
// and thereby closed the previous one.
//
// A sample that is OLDER than the open bar is dropped rather than folded in.
// Out-of-order ticks are real (two channels, two arrival paths), and letting a
// late tick reopen a closed bar would mutate a bar the client has already
// drawn.
func (a *Aggregator) Add(s Sample) (closed *Bar) {
	if !(s.Price > 0) || math.IsNaN(s.Price) || math.IsInf(s.Price, 0) {
		return nil
	}
	b := a.bucket(s.TsMs)

	if a.open != nil && b < a.open.TsMs {
		return nil
	}
	if a.open != nil && b > a.open.TsMs {
		closed = a.seal()
	}
	if a.open == nil {
		a.open = &Bar{TsMs: b, O: s.Price, H: s.Price, L: s.Price, C: s.Price}
		a.barVolume, a.barHasVol = 0, false
	}

	a.open.C = s.Price
	a.open.H = math.Max(a.open.H, s.Price)
	a.open.L = math.Min(a.open.L, s.Price)
	a.open.N++

	if s.CumVolume != nil {
		v := *s.CumVolume
		if a.haveVol {
			// A cumulative counter that went DOWN is a session reset (or a feed
			// reconnect that restarted the day's tally). Treating the drop as a
			// negative increment would print a bar with impossible volume, so the
			// increment is taken as the new total instead.
			if delta := v - a.lastVol; delta >= 0 {
				a.barVolume += delta
			} else {
				a.barVolume += v
			}
		}
		a.lastVol, a.haveVol, a.barHasVol = v, true, true
	}
	if s.CumOI != nil {
		// OI is a LEVEL, not a flow: the bar carries the latest outstanding
		// interest, not the sum of the changes within it.
		a.lastOI, a.haveOI = *s.CumOI, true
	}
	return closed
}

// seal finishes the open bar and stamps the counters onto it.
func (a *Aggregator) seal() *Bar {
	bar := a.open
	a.open = nil
	if bar == nil {
		return nil
	}
	if a.barHasVol {
		v := a.barVolume
		bar.Vol = &v
	}
	if a.haveOI {
		oi := a.lastOI
		bar.OI = &oi
	}
	a.barVolume, a.barHasVol = 0, false
	return bar
}

// Flush closes the open bar if the clock has moved past its bucket. Pump this
// on a ticker so a contract that stops printing still yields its last bar.
func (a *Aggregator) Flush(nowMs int64) *Bar {
	if a.open == nil || a.bucket(nowMs) <= a.open.TsMs {
		return nil
	}
	return a.seal()
}

// Open is a read-only view of the bar in progress, for a client that wants the
// forming candle rather than waiting a minute to see anything.
func (a *Aggregator) Open() *Bar {
	if a.open == nil {
		return nil
	}
	snapshot := *a.open
	if a.barHasVol {
		v := a.barVolume
		snapshot.Vol = &v
	}
	if a.haveOI {
		oi := a.lastOI
		snapshot.OI = &oi
	}
	return &snapshot
}

// ── Cumulative counters ──────────────────────────────────────────────────────

// Counter differences a cumulative feed field — open interest, traded volume —
// into the change a human reads.
//
// OI is the field this exists for. "OI up 12% since the open" is the sentence
// the alert engine speaks, and it cannot be said from the level alone: it needs
// the day's base, the last value, and the value some interval ago.
type Counter struct {
	base    float64 // first value of the session
	last    float64
	haveAny bool
	history []stamp // ring of recent (ts, value) for windowed change
	cap     int
}

type stamp struct {
	ts int64
	v  float64
}

// NewCounter retains up to `capacity` samples for windowed lookbacks. At one
// sample a second, 3600 is an hour, which covers every window the alerting
// engine asks about.
func NewCounter(capacity int) *Counter {
	if capacity <= 0 {
		capacity = 3600
	}
	return &Counter{cap: capacity, history: make([]stamp, 0, capacity)}
}

// Observe records a new cumulative reading.
//
// A reading that falls below the session base is treated as a NEW session
// rather than as negative interest — that is what a reconnect across the
// midnight rollover looks like, and carrying the old base would report a change
// of minus the whole day.
func (c *Counter) Observe(tsMs int64, value float64) {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return
	}
	if !c.haveAny || value < c.base {
		c.base, c.haveAny = value, true
		c.history = c.history[:0]
	}
	c.last = value
	c.history = append(c.history, stamp{tsMs, value})
	if len(c.history) > c.cap {
		// Drop the oldest tenth at a time, so the cap costs one copy per
		// capacity/10 samples instead of one per sample.
		drop := max(1, c.cap/10)
		c.history = append(c.history[:0], c.history[drop:]...)
	}
}

// Last is the newest reading.
func (c *Counter) Last() (float64, bool) { return c.last, c.haveAny }

// SinceOpen is the change from the first reading of the session, absolute and
// as a percentage. The percentage is undefined when the session opened at zero
// — a strike listed with no open interest, which then gets its first contract,
// has an infinite percentage change and a perfectly readable absolute one.
func (c *Counter) SinceOpen() (abs float64, pct *float64, ok bool) {
	if !c.haveAny {
		return 0, nil, false
	}
	abs = c.last - c.base
	if c.base > 0 {
		p := abs / c.base * 100
		pct = &p
	}
	return abs, pct, true
}

// Change is the movement over the last `windowMs`, measured against the oldest
// retained reading at or before the cutoff.
//
// Reports ok=false when the retained history does not reach back that far. A
// window the data cannot cover must not be answered with the change since the
// start of the data — that silently reports a 20-minute move as a 5-minute one,
// and it is a move of the reported size that fires an alert.
func (c *Counter) Change(nowMs, windowMs int64) (abs float64, pct *float64, ok bool) {
	if !c.haveAny || len(c.history) == 0 || windowMs <= 0 {
		return 0, nil, false
	}
	cutoff := nowMs - windowMs
	if c.history[0].ts > cutoff {
		return 0, nil, false
	}
	// Binary search: history is append-only in time order.
	i := sort.Search(len(c.history), func(i int) bool { return c.history[i].ts > cutoff })
	if i == 0 {
		return 0, nil, false
	}
	ref := c.history[i-1].v
	abs = c.last - ref
	if ref > 0 {
		p := abs / ref * 100
		pct = &p
	}
	return abs, pct, true
}

// ── Fixed-memory history ─────────────────────────────────────────────────────

// Ring is a fixed-capacity circular buffer of float64 rows, and is the Go twin
// of backend/engine/ringBuffer.ts.
//
// The reason is the same one that file gives: the buffer is allocated once and
// written with index arithmetic, so a day of ticks produces no per-tick garbage
// and the collector never has to walk a million short-lived points during
// market hours. Go's GC is not V8's, but a live engine holding several chains
// still benefits from the hot path allocating nothing at all.
type Ring struct {
	buf  []float64
	cols int
	cap  int
	head int // next write row
	size int
}

// NewRing allocates capacity×cols float64s up front.
func NewRing(capacity, cols int) *Ring {
	if capacity <= 0 {
		capacity = 8192
	}
	if cols <= 0 {
		cols = 1
	}
	return &Ring{buf: make([]float64, capacity*cols), cols: cols, cap: capacity}
}

// Push writes one row, overwriting the oldest when full. A row of the wrong
// width is rejected rather than padded: a short row would shift every column
// after the gap, and the values would still look plausible.
func (r *Ring) Push(row []float64) bool {
	if len(row) != r.cols {
		return false
	}
	copy(r.buf[r.head*r.cols:], row)
	r.head = (r.head + 1) % r.cap
	if r.size < r.cap {
		r.size++
	}
	return true
}

// Len is how many rows are live.
func (r *Ring) Len() int { return r.size }

// At returns row i in chronological order, oldest first. The slice aliases the
// buffer and is only valid until the next Push — copy it if it must outlive
// the call.
func (r *Ring) At(i int) []float64 {
	if i < 0 || i >= r.size {
		return nil
	}
	start := (r.head - r.size + i + r.cap) % r.cap
	return r.buf[start*r.cols : start*r.cols+r.cols]
}

// Rows copies the whole window out in chronological order. O(n), and meant for
// a snapshot on subscribe — not for the tick path.
func (r *Ring) Rows() [][]float64 {
	out := make([][]float64, r.size)
	for i := 0; i < r.size; i++ {
		row := make([]float64, r.cols)
		copy(row, r.At(i))
		out[i] = row
	}
	return out
}
