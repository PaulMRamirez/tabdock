// /mcp responses a client leaves unread (S9, ADRs 0030 and 0032). Node 22's
// server.timeout is 0, the MCP Node adapter waits for 'drain' without limit,
// and the hub releases a call's charge before its response is written, so a
// client that stopped reading left its response held, uncharged and with no
// end: a probe left 262,153 bytes queued with writableNeedDrain true for
// good. So relay.ts hands each /mcp response it passes to either leg here,
// with its user, until it finishes or closes, and a check every 10 s looks at
// it. A response that has bytes waiting and has sent none since the last
// check counts a stall; three in a row after the one that first saw it
// waiting, 30 to 40 s without progress, and it is destroyed and logged within
// the /mcp line budget.
//
// Progress is what the kernel has taken: the socket's bytes whose writes have
// finished (bytesWritten less writableLength), a count that only grows. What
// waits to be sent is no measure of it. Node frees a write only once the
// kernel has taken all of it, and the SDK builds a JSON answer as one chunk
// that the Node adapter passes to one res.write, so a client reading a large
// result steadily showed no progress until its last byte went out, and was
// cut. So relay.ts hands the adapter every response in slices (inSlices),
// and the adapter waits for 'drain' between them; with them, what waits stays
// near the high-water mark while bytes keep going out, so only the finished
// count moves. The kernel takes more of a response only once its reader has
// freed a good part of the socket's buffer (about 200 to 260 KB at a time on
// a Linux Unix socket), so a client keeps any response it reads faster than
// that much in 30 s, and a held stream's 13-byte keep-alives every 15 s cost
// it nothing until its buffer is full. A response small enough for the
// kernel's buffers never waits here at all, and costs only those buffers.

import type { RepeatedLog } from './repeated-lines.ts';

/** How often the responses are looked at. */
export const RESPONSE_CHECK_MS = 10_000;

/** Checks in a row, after the one that first saw bytes waiting, that find none sent before the response is cut off. */
export const RESPONSE_STALL_CHECKS = 3;

/** The line a cut-off writes, once a window and counted after (repeated-lines.ts). */
export const RESPONSE_CUT_LINE = 'mcp response cut off: its client read none of it for 30 s';

/**
 * The largest write the Node adapter makes of an /mcp response. Node's
 * high-water mark is 64 KiB, so a few slices fill it and the adapter waits
 * for 'drain' between them, and each finished write shows as progress.
 */
export const RESPONSE_SLICE_BYTES = 16_384;

/**
 * The same response, its body cut into slices of at most RESPONSE_SLICE_BYTES.
 * The slices are views of the chunk they came from, so nothing is copied, and
 * a client that goes cancels the source through the pipe as before.
 */
export function inSlices(response: Response): Response {
  if (response.body === null) return response;
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength <= RESPONSE_SLICE_BYTES) {
          controller.enqueue(chunk);
          return;
        }
        for (let at = 0; at < chunk.byteLength; at += RESPONSE_SLICE_BYTES) {
          controller.enqueue(chunk.subarray(at, at + RESPONSE_SLICE_BYTES));
        }
      },
    }),
  );
  return new Response(body, response);
}

/** What the check needs of a response's connection; node's net.Socket has it. */
export interface WatchedSocket {
  /** Bytes handed to the socket so far, written or not; undefined once destroyed. */
  readonly bytesWritten: number | undefined;
  /** Bytes handed to the socket whose writes have not finished. */
  readonly writableLength: number;
}

/** What the check needs of a response; node's ServerResponse has all of it. */
export interface WatchedResponse {
  /** Bytes of this response not yet taken by the kernel. */
  readonly writableLength: number;
  /** Its connection, or null while a response ahead of it on the same connection is still being written. */
  readonly socket: WatchedSocket | null;
  destroy(): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

interface Watched {
  userId: string;
  /** The socket's finished bytes at the last check that saw bytes waiting, or null when none did. */
  sent: number | null;
  /** Checks in a row since then that found no more sent. */
  stalls: number;
}

export interface ResponseStallOptions {
  lines: RepeatedLog;
  /** Left out: RESPONSE_CHECK_MS. */
  checkMs?: number;
}

/** Bytes whose writes have finished on the socket, or null when it says nothing. */
function finishedBytes(socket: WatchedSocket | null): number | null {
  if (socket === null || socket.bytesWritten === undefined) return null;
  return socket.bytesWritten - socket.writableLength;
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
    this.#watched.set(response, { userId, sent: null, stalls: 0 });
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
   * Looks at every response once: one with nothing waiting starts over, as
   * does one whose socket finished more bytes since the last check; one
   * seen waiting for the first time is noted; and one waiting with no more
   * sent counts a stall. At RESPONSE_STALL_CHECKS stalls the response goes.
   */
  check(): void {
    for (const [response, watched] of this.#watched) {
      const sent = finishedBytes(response.socket);
      // A response with no socket waits on the one ahead of it, which is watched itself.
      if (response.writableLength <= 0 || sent === null) {
        watched.sent = null;
        watched.stalls = 0;
        continue;
      }
      if (watched.sent === null || sent > watched.sent) {
        watched.sent = sent;
        watched.stalls = 0;
        continue;
      }
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
