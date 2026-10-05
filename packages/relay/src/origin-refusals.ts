// The lines of /mcp's Origin refusal (ADR 0027, S12). Anyone can make the
// relay refuse an Origin, before signing in, so the lines need a budget of
// their own; but the line is how the owner reads hosted Claude's origin off
// the reference deployment, to copy it into TABDOCK_MCP_ALLOWED_ORIGINS, so
// one refused origin must never hide another. Keyed by the fixed message, as
// they were through the shared /mcp lines, a trickle of refusals at the
// start of each window named only its first origin and counted the rest
// with no names at all. Here each window names its first
// MAX_NAMED_REFUSED_ORIGINS distinct origins in full, each with the address
// it first came from, and counts the repeats of each by origin; the rest are
// counted together, and their summary names the few origins seen most often
// among them. A window writes at most twice the named origins plus one
// line, apart from the shared /mcp lines, whose kinds it never crowds.

import type { Logger } from './log.ts';

/** Distinct refused origins one window names in full. */
export const MAX_NAMED_REFUSED_ORIGINS = 8;
/** Origins past the named ones counted apart, so the summary can name the most seen. */
const MAX_COUNTED_ORIGINS = 32;
/** How many of those the summary names. */
export const MOST_SEEN_REFUSED_ORIGINS = 3;
/** The most of a refused origin a line keeps, as /page's refusal keeps. */
export const MAX_REFUSED_ORIGIN_CHARS = 200;

export class OriginRefusals {
  readonly #log: Logger;
  readonly #windowMs: number;
  #window = Number.NEGATIVE_INFINITY;
  /** Each origin named this window, and how many refusals of it came after its line. */
  #named = new Map<string, number>();
  /** Origins past the named ones, each with about how often it was refused. */
  #counted = new Map<string, number>();
  /** Refusals of origins past the named ones. */
  #others = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(log: Logger, windowMs: number) {
    this.#log = log;
    this.#windowMs = windowMs;
  }

  refused(origin: string, address: string, now = Date.now()): void {
    const current = Math.floor(now / this.#windowMs);
    if (current !== this.#window) {
      this.flush();
      this.#window = current;
    }
    const key = origin.slice(0, MAX_REFUSED_ORIGIN_CHARS);
    const repeats = this.#named.get(key);
    if (repeats !== undefined) {
      this.#named.set(key, repeats + 1);
      this.#arm(now);
      return;
    }
    if (this.#named.size < MAX_NAMED_REFUSED_ORIGINS) {
      this.#named.set(key, 0);
      this.#log.info('mcp request refused: origin not allowed', { origin: key, address });
      return;
    }
    this.#others += 1;
    this.#count(key);
    this.#arm(now);
  }

  /** Writes what the window held back and starts afresh; the relay calls it as it closes. */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const [origin, repeated] of this.#named) {
      if (repeated > 0) {
        this.#log.info('mcp request refused: origin not allowed, repeated', { origin, repeated });
      }
    }
    if (this.#others > 0) {
      const mostSeen = [...this.#counted]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MOST_SEEN_REFUSED_ORIGINS)
        .map(([origin, refusedAtMost]) => ({ origin, refusedAtMost }));
      this.#log.info('mcp request refused: origin not allowed, more origins than named', {
        repeated: this.#others,
        mostSeen,
      });
    }
    this.#named = new Map();
    this.#counted = new Map();
    this.#others = 0;
  }

  close(): void {
    this.flush();
  }

  /**
   * Counts an origin past the named ones in a bounded table: when the table
   * is full, the least counted gives way and the new origin takes its count
   * plus one (the space-saving count), so an origin refused more often than
   * the table's share of the window stays in it however many others come.
   * The counts are upper bounds, which the summary names as such.
   */
  #count(origin: string): void {
    const seen = this.#counted.get(origin);
    if (seen !== undefined) {
      this.#counted.set(origin, seen + 1);
      return;
    }
    if (this.#counted.size < MAX_COUNTED_ORIGINS) {
      this.#counted.set(origin, 1);
      return;
    }
    let least: string | null = null;
    let fewest = Number.POSITIVE_INFINITY;
    for (const [key, count] of this.#counted) {
      if (count < fewest) {
        least = key;
        fewest = count;
      }
    }
    if (least !== null) this.#counted.delete(least);
    this.#counted.set(origin, fewest + 1);
  }

  /** The counts go out when their window ends, even if no refusal comes after them. */
  #arm(now: number): void {
    if (this.#timer !== null) return;
    const ends = (this.#window + 1) * this.#windowMs;
    this.#timer = setTimeout(
      () => {
        this.flush();
      },
      Math.max(0, ends - now),
    );
    this.#timer.unref();
  }
}
