/**
 * TypedArray Ring Buffer — HFT-grade fixed-memory circular buffer.
 *
 * Uses Float64Array so no heap allocation on each tick — the buffer is
 * pre-allocated once and written with pointer arithmetic. The GC never
 * sees individual tick objects, eliminating GC pauses during market hours.
 *
 * Design:
 *   - Fixed capacity (default 8192 ticks — covers a full day at 1s intervals)
 *   - Overwrites oldest data when full (circular)
 *   - toArray() exports current window in chronological order
 *   - All operations O(1) except toArray() which is O(n)
 */

export interface TickRecord {
  time:            number;   // epoch ms
  spot:            number;
  atmStrike:       number;
  syntheticFuture: number;   // K + CE - PE
  callLtp:         number;
  putLtp:          number;
  straddlePrice:   number;   // CE + PE
  isRollEvent:     number;   // 1 = roll happened this tick, 0 = no roll
}

// Column indices in the flat Float64Array
const COL = {
  time:            0,
  spot:            1,
  atmStrike:       2,
  syntheticFuture: 3,
  callLtp:         4,
  putLtp:          5,
  straddlePrice:   6,
  isRollEvent:     7,
} as const;

const N_COLS = 8;

export class RingBuffer {
  private readonly buf:  Float64Array;
  private readonly cap:  number;
  private          head: number = 0;   // next write position
  private          size: number = 0;   // number of valid entries

  constructor(capacity = 8_192) {
    this.cap = capacity;
    this.buf = new Float64Array(capacity * N_COLS);
  }

  /** Write a tick record. O(1), zero allocation. */
  push(record: TickRecord): void {
    const base = (this.head % this.cap) * N_COLS;
    this.buf[base + COL.time]            = record.time;
    this.buf[base + COL.spot]            = record.spot;
    this.buf[base + COL.atmStrike]       = record.atmStrike;
    this.buf[base + COL.syntheticFuture] = record.syntheticFuture;
    this.buf[base + COL.callLtp]         = record.callLtp;
    this.buf[base + COL.putLtp]          = record.putLtp;
    this.buf[base + COL.straddlePrice]   = record.straddlePrice;
    this.buf[base + COL.isRollEvent]     = record.isRollEvent ? 1 : 0;
    this.head++;
    if (this.size < this.cap) this.size++;
  }

  /** Most recent tick, or null if empty. O(1). */
  last(): TickRecord | null {
    if (this.size === 0) return null;
    return this.readAt((this.head - 1 + this.cap) % this.cap);
  }

  /** Number of ticks stored. */
  get length(): number { return this.size; }

  /** Export all ticks as an array in chronological order. O(n). */
  toArray(): TickRecord[] {
    const out: TickRecord[] = [];
    const start = this.size < this.cap ? 0 : this.head % this.cap;
    for (let i = 0; i < this.size; i++) {
      out.push(this.readAt((start + i) % this.cap));
    }
    return out;
  }

  /** Export ticks after a given epoch ms (inclusive). For incremental updates. */
  since(afterMs: number): TickRecord[] {
    return this.toArray().filter((r) => r.time > afterMs);
  }

  /** Clear the buffer. */
  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  private readAt(pos: number): TickRecord {
    const base = pos * N_COLS;
    return {
      time:            this.buf[base + COL.time],
      spot:            this.buf[base + COL.spot],
      atmStrike:       this.buf[base + COL.atmStrike],
      syntheticFuture: this.buf[base + COL.syntheticFuture],
      callLtp:         this.buf[base + COL.callLtp],
      putLtp:          this.buf[base + COL.putLtp],
      straddlePrice:   this.buf[base + COL.straddlePrice],
      isRollEvent:     this.buf[base + COL.isRollEvent],
    };
  }
}
