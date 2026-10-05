// Lines someone can make the relay write at will, one per request or frame,
// with no budget of theirs spent: a signed-in account's refused requests on
// /mcp, and a page's frames that change nothing on /page, which needs no
// credential at all. Written one for one, they flood stderr, the copy that
// carries the audit checkpoints and, while the audit disk fails, the records
// themselves (ADR 0019). So each key (a fixed phrase, or a client address) may
// write a few lines in full each window, and the rest are counted, by reason,
// into one summary line when the window ends: the pattern auth-log.ts follows
// for repeated 401s (ADR 0020). The window is the clock's own, so the bound
// holds however the lines arrive, and the keys tracked in one window are
// capped, past which the rest write nothing and share one count.

import type { LogFields, Logger, LogLevel } from './log.ts';

/** What one key held back in a window. */
export interface HeldBack {
  /** Lines held back. */
  repeated: number;
  /** Of those, how many for each reason, each a fixed phrase. */
  reasons: Record<string, number>;
}

export interface RepeatedLinesOptions<T> {
  /** Lines one key may write in full per window; past it they are counted. */
  linesPerKey: number;
  windowMs: number;
  /** Keys tracked in one window; past it, new keys write nothing and share one count. */
  maxKeys: number;
  /**
   * Writes what one key held back, as its window ends, with what the key's
   * first line in the window was given; key and data are null for the count
   * of keys past maxKeys.
   */
  summary: (key: string | null, held: HeldBack, data: T | null) => void;
}

interface Tracked<T> {
  written: number;
  held: HeldBack | null;
  data: T;
}

function counted(held: HeldBack | null, reason: string): HeldBack {
  const next = held ?? { repeated: 0, reasons: {} };
  next.repeated += 1;
  next.reasons[reason] = (next.reasons[reason] ?? 0) + 1;
  return next;
}

export class RepeatedLines<T = undefined> {
  readonly #options: RepeatedLinesOptions<T>;
  #window = Number.NEGATIVE_INFINITY;
  #keys = new Map<string, Tracked<T>>();
  /** Lines under keys past maxKeys in this window, all counted together. */
  #untracked: HeldBack | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: RepeatedLinesOptions<T>) {
    this.#options = options;
  }

  /**
   * Whether a line under this key may be written in full now. One that may
   * not is counted under its reason, for the key's summary line.
   */
  take(key: string, reason: string, data: T, now = Date.now()): boolean {
    const tracked = this.#track(key, data, now);
    if (tracked === null) {
      this.#untracked = counted(this.#untracked, reason);
      this.#arm(now);
      return false;
    }
    if (tracked.written < this.#options.linesPerKey) {
      tracked.written += 1;
      return true;
    }
    tracked.held = counted(tracked.held, reason);
    this.#arm(now);
    return false;
  }

  /** Counts a line under this key that some other bound held back, such as one socket's own. */
  hold(key: string, reason: string, data: T, now = Date.now()): void {
    const tracked = this.#track(key, data, now);
    if (tracked === null) this.#untracked = counted(this.#untracked, reason);
    else tracked.held = counted(tracked.held, reason);
    this.#arm(now);
  }

  /** Writes every summary still held and starts afresh; the relay calls it as it closes. */
  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const [key, tracked] of this.#keys) {
      if (tracked.held !== null) this.#options.summary(key, tracked.held, tracked.data);
    }
    if (this.#untracked !== null) this.#options.summary(null, this.#untracked, null);
    this.#keys = new Map();
    this.#untracked = null;
  }

  /** The key's state in the current window, or null when it is past maxKeys. */
  #track(key: string, data: T, now: number): Tracked<T> | null {
    const current = Math.floor(now / this.#options.windowMs);
    if (current !== this.#window) {
      this.flush();
      this.#window = current;
    }
    const tracked = this.#keys.get(key);
    if (tracked !== undefined) return tracked;
    if (this.#keys.size >= this.#options.maxKeys) return null;
    const fresh: Tracked<T> = { written: 0, held: null, data };
    this.#keys.set(key, fresh);
    return fresh;
  }

  /** The counts go out when their window ends, even if no line comes after them. */
  #arm(now: number): void {
    if (this.#timer !== null) return;
    const ends = (this.#window + 1) * this.#options.windowMs;
    this.#timer = setTimeout(
      () => {
        this.flush();
      },
      Math.max(0, ends - now),
    );
    this.#timer.unref();
  }
}

/**
 * A Logger's lines under that budget: the first line with a given message and
 * detail in a window is written in full, and the rest are counted into a line
 * `<message> (<detail>), repeated` carrying `repeated` when the window ends.
 * The message must be a fixed phrase; the detail, if any, a short one.
 */
export interface RepeatedLog {
  write(level: LogLevel, message: string, fields?: LogFields, detail?: string): void;
  /** Writes the counts still held; the relay calls it as it closes. */
  close(): void;
}

/**
 * Message and detail pairs tracked in one window. The phrases are fixed, but
 * a detail drawn from a library's error (errorKind) is not, so its count is
 * capped like any key the caller can choose.
 */
export const MAX_REPEATED_KINDS = 256;

export function createRepeatedLog(log: Logger, windowMs: number): RepeatedLog {
  const lines = new RepeatedLines<{ level: LogLevel }>({
    linesPerKey: 1,
    windowMs,
    maxKeys: MAX_REPEATED_KINDS,
    summary: (key, held, data) => {
      log[data?.level ?? 'warn'](`${key ?? 'lines of more kinds than tracked'}, repeated`, {
        repeated: held.repeated,
      });
    },
  });
  return {
    write(level, message, fields, detail) {
      const key = detail === undefined ? message : `${message} (${detail})`;
      if (lines.take(key, key, { level })) log[level](message, fields);
    },
    close() {
      lines.flush();
    },
  };
}

/** The most of an error's message a kind keeps. */
const MAX_KIND_CHARS = 48;

/**
 * A short, mostly fixed name for what kind of error this is, to count its
 * repeats by: its class and the start of its message, up to the first colon
 * or parenthesis, past which a library's messages quote what a request sent
 * (the SDK's "Rejected inbound request (<cell>): ...", say).
 */
export function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const head = error.message.split(/[:(]/, 1)[0]?.trim().slice(0, MAX_KIND_CHARS) ?? '';
  return head.length === 0 ? error.name : `${error.name}: ${head}`;
}
