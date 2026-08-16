/**
 * Generic LRU (Least Recently Used) cache with per-entry TTL.
 *
 * Uses JS Map insertion-order to track LRU order — O(1) get/set/evict.
 * Thread-safe for Node.js (single-threaded event loop).
 *
 * Designed to cache full computed straddle results (23,400-point arrays)
 * so repeat loads of the same symbol+date never hit the Nubra API again.
 */

export interface CacheMeta {
  key:       string;
  cachedAt:  number;   // epoch ms
  expiresIn: number;   // ms remaining
  ttlMs:     number;
}

interface Entry<T> {
  data:  T;
  at:    number;
  ttl:   number;
}

export class LRUCache<T> {
  private readonly store = new Map<string, Entry<T>>();
  private readonly cap:   number;

  constructor(capacity = 100) {
    this.cap = capacity;
  }

  /** Get a cached value. Returns null if missing or expired. */
  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // TTL check
    if (Date.now() - entry.at > entry.ttl) {
      this.store.delete(key);
      return null;
    }

    // Promote to tail (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.data;
  }

  /** Store a value. Evicts the oldest entry if at capacity. */
  set(key: string, data: T, ttlMs: number): void {
    // Remove existing to re-insert at tail
    this.store.delete(key);

    // Evict LRU (head of Map) if full
    if (this.store.size >= this.cap) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }

    this.store.set(key, { data, at: Date.now(), ttl: ttlMs });
  }

  /** True if key exists and has not expired. */
  has(key: string): boolean {
    return this.get(key) !== null;
  }

  /** Delete a specific key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Flush everything. */
  clear(): void {
    this.store.clear();
  }

  /** Number of valid (non-expired) entries. */
  get size(): number {
    return this.store.size;
  }

  /** Metadata for all cached entries (for /api/straddle/cache-status). */
  entries(): CacheMeta[] {
    const now = Date.now();
    return [...this.store.entries()].map(([key, e]) => ({
      key,
      cachedAt:  e.at,
      ttlMs:     e.ttl,
      expiresIn: Math.max(0, e.ttl - (now - e.at)),
    }));
  }
}
