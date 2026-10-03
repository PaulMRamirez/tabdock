// Sliding-window limiter for pairing attempts, calls and sign-ins (S3, S9).
// Only allowed attempts are recorded, so a caller who keeps hammering stays
// blocked for exactly one window after their last accepted try and no longer.
//
// Every limit runs on the one event loop that also serves /mcp, /pair and the
// page link, so no record() may walk all the keys. Keys live in two
// generations: each record moves its key into the current one, and at most
// once a window the current one becomes the previous one and the old previous
// one is dropped whole. A key left out of two turns has had no hit for a full
// window, so nothing still counting is lost, and each call costs the same
// however many keys there are. Past maxKeys keys in one generation it turns
// early, dropping the keys recorded longest ago even inside their window.
// That bounds memory whoever chooses the keys, but could reset a count, so
// callers key only by trusted, bounded sets (users, pages, attachments, live
// tickets, the relay itself) that stay far below the cap.

/** Far above any trusted set the relay keys by, at its default capacities. */
const DEFAULT_MAX_KEYS = 100_000;

export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  /** Each key's hits, oldest first; a key is in one generation or neither. */
  #current = new Map<string, number[]>();
  #previous = new Map<string, number[]>();
  #turnedAt = Number.NEGATIVE_INFINITY;

  constructor(limit: number, windowMs: number, maxKeys = DEFAULT_MAX_KEYS) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#maxKeys = maxKeys;
  }

  /** Keys held, in both generations, for tests and to show the bound holds. */
  get size(): number {
    return this.#current.size + this.#previous.size;
  }

  allows(key: string, now: number): boolean {
    this.#turnIfDue(now);
    return this.#recent(key, now).length < this.#limit;
  }

  record(key: string, now: number): void {
    this.#turnIfDue(now);
    const recent = this.#recent(key, now);
    recent.push(now);
    // allows() looks only at the newest `limit` hits, so older ones change nothing.
    if (recent.length > this.#limit) recent.splice(0, recent.length - this.#limit);
    this.#previous.delete(key);
    if (!this.#current.has(key) && this.#current.size >= this.#maxKeys) this.#turn(now);
    this.#current.set(key, recent);
  }

  /** The key's hits still inside the window, as a fresh array. */
  #recent(key: string, now: number): number[] {
    const since = now - this.#windowMs;
    const hits = this.#current.get(key) ?? this.#previous.get(key) ?? [];
    return hits.filter((at) => at > since);
  }

  #turnIfDue(now: number): void {
    if (now - this.#turnedAt >= this.#windowMs) this.#turn(now);
  }

  #turn(now: number): void {
    this.#previous = this.#current;
    this.#current = new Map();
    this.#turnedAt = now;
  }
}
