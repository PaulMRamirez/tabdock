// Counting for the room measurement (ADR 0044, A6.22): latencies kept whole
// and read as percentiles, and outcomes counted by name, so a phase's figures
// are what happened rather than a running average that hides the tail.

/** The pth percentile (0 to 100) of `values` by nearest rank, or null when there are none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function summarize(values: readonly number[]): LatencySummary {
  return {
    count: values.length,
    p50: round(percentile(values, 50)),
    p95: round(percentile(values, 95)),
    p99: round(percentile(values, 99)),
    max: round(values.length === 0 ? null : Math.max(...values)),
  };
}

export function round(value: number | null, places = 1): number | null {
  if (value === null) return null;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}

export const MIB = 1024 * 1024;

/** Bytes as MiB to one place, the unit every memory bar is written in. */
export function mib(bytes: number | null): number | null {
  return bytes === null ? null : round(bytes / MIB);
}

/** Outcomes counted by name: a call's error code, an HTTP status, a log line. */
export class Tally {
  readonly #counts = new Map<string, number>();

  add(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.#counts.get(name) ?? 0;
  }

  /** Every name with its count, largest first, then by name. */
  entries(): [string, number][] {
    return [...this.#counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries(this.entries());
  }
}

/** One kind of call's latencies and outcomes over a phase. */
export class CallLog {
  readonly latencies: number[] = [];
  readonly outcomes = new Tally();

  record(outcome: string, ms: number): void {
    this.outcomes.add(outcome);
    if (outcome === 'ok') this.latencies.push(ms);
  }

  toJSON(): { latency: LatencySummary; outcomes: Record<string, number> } {
    return { latency: summarize(this.latencies), outcomes: this.outcomes.toJSON() };
  }
}

/** Calls by kind for one phase, created as each kind is first seen. */
export class CallBook {
  readonly #kinds = new Map<string, CallLog>();

  of(kind: string): CallLog {
    let log = this.#kinds.get(kind);
    if (log === undefined) {
      log = new CallLog();
      this.#kinds.set(kind, log);
    }
    return log;
  }

  /** Every call of every kind whose outcome was `outcome`. */
  count(outcome: string): number {
    let total = 0;
    for (const log of this.#kinds.values()) total += log.outcomes.get(outcome);
    return total;
  }

  total(): number {
    let total = 0;
    for (const log of this.#kinds.values()) {
      for (const [, count] of log.outcomes.entries()) total += count;
    }
    return total;
  }

  toJSON(): Record<string, ReturnType<CallLog['toJSON']>> {
    return Object.fromEntries([...this.#kinds].map(([kind, log]) => [kind, log.toJSON()]));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
