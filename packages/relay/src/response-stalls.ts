// /mcp responses a client leaves unread (S9, ADRs 0030 and 0032). Node 22's
// server.timeout is 0, the MCP Node adapter waits for 'drain' without limit,
// and the hub releases a call's charge before its response is written, so a
// client that stopped reading left its response held, uncharged and with no
// end: a probe left 262,153 bytes queued with writableNeedDrain true for
// good. So relay.ts hands each /mcp response it passes to either leg here,
// with its user and its connection, until it finishes or closes, and a check
// every 10 s looks at it. A response that has bytes waiting and has sent
// none since the last check counts a stall; three in a row after the one
// that first saw it waiting, 30 to 40 s without progress, and it is
// destroyed and logged within the /mcp line budget.
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
// that much in 30 s, and a held stream's 13-byte keep-alives cost it nothing
// until its buffer is full. A response small enough for the kernel's buffers
// never waits here at all, and costs only those buffers.
//
// The stall rule bounds how long a response that makes no progress lives,
// not how many a user holds: any progress starts it over, so a reader that
// let the kernel take a batch every 20 s kept a large answer for minutes,
// and a member may open 240 a minute, each holding its whole body in memory
// no budget counts. So a user may have only a few responses with bytes
// waiting at once (RESPONSES_WAITING_PER_USER, a quarter of that for an
// invitee): as each answer of theirs is handed to the adapter, and at every
// check, their oldest responses past that are cut off, logged within the
// same budget (ADR 0030's notes from the A5.6 review).
//
// A response queued behind another on its connection, as an HTTP/1.1 client
// that pipelines leaves it, has no socket until the one ahead finishes. Node
// never closes such a response when the connection closes (it aborts the
// requests only), and the Node adapter lets go of a body only on its
// response's 'close', so 40 answers pipelined through the relay held 25.3 MB,
// and through the adapter alone 38 of 40 stayed held after their connection
// went. So when a watched connection closes, every response still queued on
// it is destroyed and closed here, as Node closes the one it was writing,
// and cutting a queued response ends its connection.

import { InviteeIdSchema } from '@tabdock/protocol';
import type { RepeatedLog } from './repeated-lines.ts';

/** How often the responses are looked at. */
export const RESPONSE_CHECK_MS = 10_000;

/** Checks in a row, after the one that first saw bytes waiting, that find none sent before the response is cut off. */
export const RESPONSE_STALL_CHECKS = 3;

/** The line a cut-off writes, once a window and counted after (repeated-lines.ts). */
export const RESPONSE_CUT_LINE = 'mcp response cut off: its client read none of it for 30 s';

/**
 * Responses with bytes waiting that one member may have at once. Past it the
 * oldest are cut off: with answers of at most about 0.72 MB (MAX_RESULT_CHARS
 * characters that JSON writes in six bytes each), a member's unread answers
 * hold about 6.5 MB however fast they are opened or slowly read, nine of
 * them for the moment an answer is handed over.
 */
export const RESPONSES_WAITING_PER_USER = 8;

/** The same for an invitee: a quarter, as an invitee's request budget is a quarter of a member's. */
export const RESPONSES_WAITING_PER_INVITEE = 2;

/** The line a cut past a user's responses waiting writes, once a window and counted after. */
export const RESPONSE_CAP_LINE =
  'mcp response cut off: its user has more responses waiting to be read than one user may';

/** How many responses with bytes waiting this user may have: invitees a quarter of a member's. */
export function responsesWaitingFor(userId: string): number {
  return InviteeIdSchema.safeParse(userId).success
    ? RESPONSES_WAITING_PER_INVITEE
    : RESPONSES_WAITING_PER_USER;
}

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

/** The connection a response came on, held from its request; node's net.Socket has it. */
export interface WatchedConnection {
  /** True from the moment it is destroyed, before its 'close'. */
  readonly destroyed: boolean;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
  destroy(): unknown;
}

/** What the check needs of a response; node's ServerResponse has all of it. */
export interface WatchedResponse {
  /** Bytes of this response not yet taken by the kernel, or held while it waits for its socket. */
  readonly writableLength: number;
  /** Its connection, or null while a response ahead of it on the same connection is still being written. */
  readonly socket: WatchedSocket | null;
  /** True once destroyed, and once node has closed it with its connection. */
  readonly destroyed: boolean;
  destroy(): unknown;
  emit(event: 'close'): unknown;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

interface Watched {
  userId: string;
  connection: WatchedConnection;
  /** The socket's finished bytes at the last check that saw bytes waiting, or null when none did. */
  sent: number | null;
  /** Checks in a row since then that found no more sent. */
  stalls: number;
}

/** The responses watched on one connection, and the listener that hears it close. */
interface OnConnection {
  responses: Set<WatchedResponse>;
  closed: () => void;
}

export interface ResponseStallOptions {
  lines: RepeatedLog;
  /** Left out: RESPONSE_CHECK_MS. */
  checkMs?: number;
  /** Responses with bytes waiting each user may have; left out, responsesWaitingFor. */
  waitingCapOf?: (userId: string) => number;
}

/** Bytes whose writes have finished on the socket, or null when it says nothing. */
function finishedBytes(socket: WatchedSocket | null): number | null {
  if (socket === null || socket.bytesWritten === undefined) return null;
  return socket.bytesWritten - socket.writableLength;
}

export class ResponseStalls {
  readonly #lines: RepeatedLog;
  readonly #checkMs: number;
  readonly #waitingCapOf: (userId: string) => number;
  /** Every response watched, oldest first. */
  readonly #watched = new Map<WatchedResponse, Watched>();
  /** The same by user, oldest first, for the cap on responses waiting. */
  readonly #byUser = new Map<string, Set<WatchedResponse>>();
  readonly #byConnection = new Map<WatchedConnection, OnConnection>();
  #timer: NodeJS.Timeout | null = null;

  constructor(options: ResponseStallOptions) {
    this.#lines = options.lines;
    this.#checkMs = options.checkMs ?? RESPONSE_CHECK_MS;
    this.#waitingCapOf = options.waitingCapOf ?? responsesWaitingFor;
  }

  /** Responses being watched now. */
  get size(): number {
    return this.#watched.size;
  }

  /** Watches a response for `userId`, on `connection`, until it finishes or closes. */
  track(response: WatchedResponse, userId: string, connection: WatchedConnection): void {
    if (this.#watched.has(response)) return;
    // Its client went while the request was being signed in: node has closed
    // a response it was writing already, and its 'close' will not come again;
    // one queued behind another it never closes, so it is ended here.
    if (response.destroyed) return;
    if (connection.destroyed) {
      if (response.socket === null) this.#release(response);
      return;
    }
    this.#watched.set(response, { userId, connection, sent: null, stalls: 0 });
    let mine = this.#byUser.get(userId);
    if (mine === undefined) {
      mine = new Set();
      this.#byUser.set(userId, mine);
    }
    mine.add(response);
    let on = this.#byConnection.get(connection);
    if (on === undefined) {
      // One listener a connection, however many responses a client pipelines on it.
      const closed = (): void => {
        this.#connectionClosed(connection);
      };
      on = { responses: new Set(), closed };
      connection.once('close', closed);
      this.#byConnection.set(connection, on);
    }
    on.responses.add(response);
    const forget = (): void => {
      this.#forget(response);
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
   * An answer for `userId` is about to be written: their oldest responses
   * with bytes waiting past their cap go now, so answers that arrive between
   * two checks cannot pile up until the next.
   */
  answering(userId: string): void {
    this.#trim(userId);
    this.#idle();
  }

  /**
   * Looks at every response once: one with nothing waiting starts over, as
   * does one whose socket finished more bytes since the last check; one
   * seen waiting for the first time is noted; and one waiting with no more
   * sent counts a stall. At RESPONSE_STALL_CHECKS stalls the response goes.
   * Then each user's oldest responses waiting past their cap go.
   */
  check(): void {
    for (const [response, watched] of this.#watched) {
      const sent = finishedBytes(response.socket);
      // A response with no socket waits on the one ahead of it, which is
      // watched itself; when that one goes, so does their connection, and
      // with it this one (#connectionClosed).
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
      this.#cut(response, RESPONSE_CUT_LINE);
    }
    for (const userId of [...this.#byUser.keys()]) this.#trim(userId);
    this.#idle();
  }

  /** Stops watching; the relay calls it as it closes. */
  close(): void {
    for (const [connection, on] of this.#byConnection) connection.off('close', on.closed);
    this.#byConnection.clear();
    this.#byUser.clear();
    this.#watched.clear();
    this.#idle();
  }

  /** Cuts off `userId`'s oldest responses with bytes waiting past their cap. */
  #trim(userId: string): void {
    const mine = this.#byUser.get(userId);
    if (mine === undefined) return;
    const waiting = [...mine].filter((response) => response.writableLength > 0);
    const over = waiting.length - this.#waitingCapOf(userId);
    if (over <= 0) return;
    for (const response of waiting.slice(0, over)) this.#cut(response, RESPONSE_CAP_LINE);
  }

  #cut(response: WatchedResponse, line: string): void {
    const watched = this.#watched.get(response);
    if (watched === undefined) return;
    this.#forget(response);
    // The user only: never a token, a session id or anything the response held.
    this.#lines.write('warn', line, { userId: watched.userId });
    if (response.socket === null) {
      // Queued behind another response, it would go out only once that one
      // finishes, so the connection goes, and the rest queued on it with it.
      this.#release(response);
      watched.connection.destroy();
      return;
    }
    // What it held is freed, and the Node adapter aborts its request, so a
    // call still waiting on it is cancelled as when its client goes.
    response.destroy();
  }

  /** Every response still queued on a connection that closed goes too. */
  #connectionClosed(connection: WatchedConnection): void {
    const on = this.#byConnection.get(connection);
    if (on === undefined) return;
    for (const response of [...on.responses]) {
      this.#forget(response);
      // Node closes the response it was writing; one with no socket yet it never does.
      if (response.socket === null) this.#release(response);
    }
    this.#idle();
  }

  /**
   * Ends a response queued behind another as Node ends the one it was
   * writing when the connection closes: destroyed, then 'close', on which the
   * Node adapter aborts its request and cancels the body it was writing.
   */
  #release(response: WatchedResponse): void {
    response.destroy();
    response.emit('close');
  }

  #forget(response: WatchedResponse): void {
    const watched = this.#watched.get(response);
    if (watched === undefined) return;
    this.#watched.delete(response);
    const mine = this.#byUser.get(watched.userId);
    mine?.delete(response);
    if (mine?.size === 0) this.#byUser.delete(watched.userId);
    const on = this.#byConnection.get(watched.connection);
    if (on === undefined) return;
    on.responses.delete(response);
    if (on.responses.size > 0) return;
    watched.connection.off('close', on.closed);
    this.#byConnection.delete(watched.connection);
  }

  #idle(): void {
    if (this.#watched.size > 0 || this.#timer === null) return;
    clearInterval(this.#timer);
    this.#timer = null;
  }
}
