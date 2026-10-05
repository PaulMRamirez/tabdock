// /mcp responses a client leaves unread (S9, ADR 0030). Node 22's
// server.timeout is 0, the MCP Node adapter waits for 'drain' without limit,
// and the hub releases a call's charge before its response is written, so a
// client that stopped reading left its response held, uncharged and with no
// end: a probe left 262,153 bytes queued with writableNeedDrain true for
// good. So relay.ts hands each /mcp response it passes to either leg here,
// with its user, until it finishes or closes, and a check every 10 s looks at
// what waits to be sent. A response whose queue has not shrunk for three
// checks after the one that first saw it waiting is destroyed, 30 to 40 s
// after it stopped moving, and logged within the /mcp line budget. As ADR
// 0024 rules for pages, a client that keeps reading is never cut, since each
// read shrinks the queue; only on a held stream, where the SDK adds a 13-byte
// keep-alive every 15 s, must it read faster than about a byte a second. A
// response small enough for the kernel's socket buffers never waits here at
// all, and costs only those buffers.

import type { RepeatedLog } from './repeated-lines.ts';

/** How often the responses are looked at. */
export const RESPONSE_CHECK_MS = 10_000;

/** Checks in a row, after the one that first saw a queue, that find it no shorter before the response is cut off. */
export const RESPONSE_STALL_CHECKS = 3;

/** The line a cut-off writes, once a window and counted after (repeated-lines.ts). */
export const RESPONSE_CUT_LINE = 'mcp response cut off: its client read none of it for 30 s';

/** What the check needs of a response; node's ServerResponse has all of it. */
export interface WatchedResponse {
  /** Bytes queued for the client and not yet taken by the kernel. */
  readonly writableLength: number;
  destroy(): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

interface Watched {
  userId: string;
  /** What waited at the last check, or null when nothing did. */
  waiting: number | null;
  /** Checks in a row since then that found no less waiting. */
  stalls: number;
}

export interface ResponseStallOptions {
  lines: RepeatedLog;
  /** Left out: RESPONSE_CHECK_MS. */
  checkMs?: number;
}

export class ResponseStalls {
  readonly #lines: RepeatedLog;
  readonly #checkMs: number;
  readonly #watched = new Map<WatchedResponse, Watched>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ResponseStallOptions) {
    this.#lines = options.lines;
    this.#checkMs = options.checkMs ?? RESPONSE_CHECK_MS;
  }

  /** Responses being watched now. */
  get size(): number {
    return this.#watched.size;
  }

  /** Watches a response for `userId` until it finishes or closes. */
  track(response: WatchedResponse, userId: string): void {
    if (this.#watched.has(response)) return;
    this.#watched.set(response, { userId, waiting: null, stalls: 0 });
    const forget = (): void => {
      this.#watched.delete(response);
      this.#idle();
    };
    response.once('finish', forget);
    response.once('close', forget);
    if (this.#timer === null) {
      this.#timer = setInterval(() => {
        this.check();
      }, this.#checkMs);
      // A relay that serves nobody may exit; close() stops it otherwise.
      this.#timer.unref();
    }
  }

  /**
   * Looks at every response once: a queue seen for the first time is noted,
   * one no shorter than at the last check counts a stall, and one shorter or
   * empty starts over. At RESPONSE_STALL_CHECKS stalls the response goes.
   */
  check(): void {
    for (const [response, watched] of this.#watched) {
      const waiting = response.writableLength;
      if (waiting <= 0) {
        watched.waiting = null;
        watched.stalls = 0;
        continue;
      }
      if (watched.waiting === null || waiting < watched.waiting) {
        watched.waiting = waiting;
        watched.stalls = 0;
        continue;
      }
      watched.waiting = waiting;
      watched.stalls += 1;
      if (watched.stalls < RESPONSE_STALL_CHECKS) continue;
      this.#watched.delete(response);
      // The user only: never a token, a session id or anything the response held.
      this.#lines.write('warn', RESPONSE_CUT_LINE, { userId: watched.userId });
      // What it held is freed, and the Node adapter aborts its request, so a
      // call still waiting on it is cancelled as when its client goes.
      response.destroy();
    }
    this.#idle();
  }

  /** Stops watching; the relay calls it as it closes. */
  close(): void {
    this.#watched.clear();
    this.#idle();
  }

  #idle(): void {
    if (this.#watched.size > 0 || this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
