// Sliding-window limiter for pairing attempts (S3). Only allowed attempts are
// recorded, so a caller who keeps hammering stays blocked for exactly one
// window after their last accepted try and no longer.

const SWEEP_THRESHOLD = 10_000;

export class SlidingWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  allows(key: string, now: number): boolean {
    return this.#recent(key, now).length < this.#limit;
  }

  record(key: string, now: number): void {
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#hits.set(key, recent);
    if (this.#hits.size > SWEEP_THRESHOLD) this.#sweep(now);
  }

  #recent(key: string, now: number): number[] {
    const since = now - this.#windowMs;
    const recent = (this.#hits.get(key) ?? []).filter((at) => at > since);
    if (recent.length === 0) this.#hits.delete(key);
    else this.#hits.set(key, recent);
    return recent;
  }

  #sweep(now: number): void {
    for (const key of [...this.#hits.keys()]) this.#recent(key, now);
  }
}
