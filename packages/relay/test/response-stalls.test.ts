// An /mcp response a client leaves unread (S9, ADRs 0030 and 0032). Node's
// server timeout is 0 and the MCP Node adapter waits for 'drain' without
// limit, so a client that stopped reading held its response for good. The
// check runs first against stand-in responses under fake timers, then on a
// real Unix socket through the Node adapter as relay.ts writes, where the
// kernel's buffer is small enough for a large answer to wait: one that a
// client reads steadily is never cut, and one it stops reading is. Then its
// wiring in relay.ts: every /mcp answer goes out in slices, and a marked
// request's response made to report bytes waiting and none sent is cut.
// Beside the stall rule, a user may have only a few responses with bytes
// waiting, and a response queued behind another on a connection that closes
// goes with it (ADR 0030's notes from the A5.6 review): each on stand-ins,
// on a real socket and through the relay.

import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type NodeIncomingMessageLike, toNodeHandler } from '@modelcontextprotocol/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenAuth } from '../src/index.ts';
import { createLogger } from '../src/log.ts';
import { createRepeatedLog } from '../src/repeated-lines.ts';
import {
  inSlices,
  RESPONSE_CAP_LINE,
  RESPONSE_CHECK_MS,
  RESPONSE_CUT_LINE,
  RESPONSE_SLICE_BYTES,
  RESPONSE_STALL_CHECKS,
  ResponseStalls,
  RESPONSES_WAITING_PER_INVITEE,
  RESPONSES_WAITING_PER_USER,
  responsesWaitingFor,
  type WatchedSocket,
} from '../src/response-stalls.ts';
import { connectPage, type TestPage, TOOLS } from './helpers/page-client.ts';
import { openListen, type OpenStream } from './helpers/raw-mcp.ts';
import {
  ALICE,
  BOB,
  connectClient,
  pairAndApprove,
  startRelay,
  type TestRelay,
} from './helpers/relay.ts';

/**
 * A response and its socket as node reports them: bytes handed over wait
 * until the kernel takes them, and only then count as sent, as a write is
 * freed only once the kernel has taken all of it.
 */
class StandIn extends EventEmitter {
  /** Bytes handed to the socket and not yet taken by the kernel. */
  queued = 0;
  /** Bytes the kernel has taken. */
  sent = 0;
  destroyed = false;
  /** False for a response still waiting behind another on its connection. */
  connected = true;

  get writableLength(): number {
    return this.queued;
  }

  get socket(): WatchedSocket | null {
    if (!this.connected) return null;
    return { bytesWritten: this.sent + this.queued, writableLength: this.queued };
  }

  /** The adapter hands the socket `bytes` more. */
  write(bytes: number): void {
    this.queued += bytes;
  }

  /** The kernel takes `bytes` of what waits, as the client's reading makes room. */
  take(bytes: number): void {
    const taken = Math.min(bytes, this.queued);
    this.queued -= taken;
    this.sent += taken;
  }

  /**
   * As node's: a response with its socket closes with it, while one still
   * queued behind another on its connection only marks itself destroyed.
   */
  destroy(): void {
    this.destroyed = true;
    if (this.connected) this.emit('close');
  }
}

/** A response's connection as node's net.Socket reports it: destroyed, it closes. */
class Connection extends EventEmitter {
  destroyed = false;

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

/** Tracks `response` for `userId` on a connection of its own, or on `on`. */
function trackOn(
  stalls: ResponseStalls,
  response: StandIn,
  userId: string,
  on: Connection = new Connection(),
): Connection {
  stalls.track(response, userId, on);
  return on;
}

let relay: TestRelay | undefined;
const streams: OpenStream[] = [];
const pages: TestPage[] = [];
let restore: (() => void) | null = null;

afterEach(async () => {
  vi.useRealTimers();
  restore?.();
  restore = null;
  for (const stream of streams.splice(0)) stream.close();
  for (const page of pages.splice(0)) page.ws.terminate();
  await relay?.close();
  relay = undefined;
});

/** The check with its lines captured, under fake timers. */
function watch(): { stalls: ResponseStalls; lines: Record<string, unknown>[]; close: () => void } {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const repeated = createRepeatedLog(log, 60_000);
  const stalls = new ResponseStalls({ lines: repeated });
  return {
    stalls,
    lines,
    close: () => {
      stalls.close();
      repeated.close();
    },
  };
}

describe('the check (ADRs 0030 and 0032)', () => {
  it('cuts off a response whose client takes no more of it, 30 to 40 s after it stopped, with one line naming the user', () => {
    const { stalls, lines, close } = watch();
    const response = new StandIn();
    trackOn(stalls, response, 'alice');
    // It stops moving just after a check: the next check notes it.
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    response.write(262_153);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * RESPONSE_STALL_CHECKS);
    expect(response.destroyed).toBe(false);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    // 40 s after it stopped; one that stopped just before a check goes 30 s after.
    expect(response.destroyed).toBe(true);
    expect(stalls.size).toBe(0);
    expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([
      expect.objectContaining({ level: 'warn', userId: 'alice' }),
    ]);
    close();
  });

  it('never cuts off a client whose reading lets the kernel take more, though what waits never shrinks, or one whose queue empties', () => {
    const { stalls, close } = watch();
    const sliced = new StandIn();
    const bursty = new StandIn();
    trackOn(stalls, sliced, 'alice');
    trackOn(stalls, bursty, 'bob');
    // The adapter keeps the socket at its high-water mark, four slices and
    // their chunk headers, and writes another slice each time one is taken.
    sliced.write(65_568);
    for (let check = 0; check < 60; check += 1) {
      // Ten minutes of checks: the client's reading lets one slice through between each.
      sliced.take(16_392);
      sliced.write(16_392);
      // The other waits two checks, then the kernel takes all, and it waits again.
      if (check % 3 === 2) bursty.take(bursty.queued);
      else bursty.write(5000);
      vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    }
    expect(sliced.writableLength).toBe(65_568);
    expect(sliced.destroyed).toBe(false);
    expect(bursty.destroyed).toBe(false);
    close();
  });

  it('cuts off one large write the kernel cannot finish, however long it has been waiting, and keeps it while the kernel takes slices', () => {
    // What waits shrinks only once a whole write is taken, so a result
    // written whole showed no progress while its client read steadily;
    // relay.ts writes in slices (inSlices) so each one taken shows.
    const { stalls, close } = watch();
    const whole = new StandIn();
    trackOn(stalls, whole, 'alice');
    whole.write(1_000_188);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 1));
    expect(whole.destroyed).toBe(true);
    close();
  });

  it('counts a queue that grows while nothing is sent, as a held stream whose keep-alives nobody reads', () => {
    const { stalls, close } = watch();
    const response = new StandIn();
    trackOn(stalls, response, 'alice');
    for (let check = 1; check <= RESPONSE_STALL_CHECKS + 1; check += 1) {
      response.write(13);
      vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    }
    expect(response.destroyed).toBe(true);
    close();
  });

  it('counts no stall for a response that has no socket yet, behind another on its connection', () => {
    const { stalls, close } = watch();
    const behind = new StandIn();
    behind.connected = false;
    behind.write(4096);
    trackOn(stalls, behind, 'alice');
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 2));
    expect(behind.destroyed).toBe(false);
    close();
  });

  it('forgets a response once it finishes or closes, and stops checking when none is left', () => {
    const { stalls, close } = watch();
    const finished = new StandIn();
    const closed = new StandIn();
    trackOn(stalls, finished, 'alice');
    trackOn(stalls, closed, 'alice');
    finished.write(100);
    closed.write(100);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    finished.emit('finish');
    closed.emit('close');
    expect(stalls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * 10);
    expect(finished.destroyed).toBe(false);
    expect(closed.destroyed).toBe(false);
    close();
  });

  it('writes one line a window for any number of cut-offs and counts the rest', () => {
    const { stalls, lines, close } = watch();
    const responses = Array.from({ length: 50 }, () => new StandIn());
    responses.forEach((response, n) => {
      trackOn(stalls, response, `user-${String(n)}`);
      response.write(1000);
    });
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 1));
    expect(responses.every((response) => response.destroyed)).toBe(true);
    close();
    expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toHaveLength(1);
    expect(lines.filter((line) => line.msg === `${RESPONSE_CUT_LINE}, repeated`)).toEqual([
      expect.objectContaining({ repeated: 49 }),
    ]);
  });
});

/** A guest's id, as the invitee tier names one (ADR 0016). */
const GUEST_ID = `g_${'0a'.repeat(16)}`;

/** Lets the kernel take some of each response, as a client that reads a little now and then. */
function trickle(responses: StandIn[]): void {
  for (const response of responses) {
    response.take(1);
    response.write(1);
  }
}

describe('responses waiting, a few a user (ADR 0030 notes, A5.6)', () => {
  it('cuts off the oldest responses of a user with bytes waiting past their cap at a check, though each keeps moving, with one line naming the user', () => {
    const { stalls, lines, close } = watch();
    // Held streams being read, with nothing waiting, older than all the rest.
    const reading = Array.from({ length: 3 }, () => new StandIn());
    const waiting = Array.from({ length: RESPONSES_WAITING_PER_USER + 2 }, () => new StandIn());
    const bobs = Array.from({ length: RESPONSES_WAITING_PER_USER }, () => new StandIn());
    for (const response of reading) trackOn(stalls, response, 'alice');
    for (const response of waiting) trackOn(stalls, response, 'alice');
    for (const response of bobs) trackOn(stalls, response, 'bob');
    for (const response of [...waiting, ...bobs]) response.write(700_000);
    // Every response the kernel took some of since the last check: no stall anywhere.
    trickle([...waiting, ...bobs]);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    expect(waiting.map((response) => response.destroyed)).toEqual([
      true,
      true,
      ...Array<boolean>(RESPONSES_WAITING_PER_USER).fill(false),
    ]);
    expect(reading.some((response) => response.destroyed)).toBe(false);
    expect(bobs.some((response) => response.destroyed)).toBe(false);
    expect(stalls.size).toBe(3 + RESPONSES_WAITING_PER_USER * 2);
    // The cap holds however long the rest keep moving.
    for (let check = 0; check < 30; check += 1) {
      trickle([...waiting, ...bobs]);
      vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    }
    expect(waiting.filter((response) => response.destroyed)).toHaveLength(2);
    close();
    const cut = lines.filter((line) => line.msg === RESPONSE_CAP_LINE);
    expect(cut).toEqual([expect.objectContaining({ level: 'warn', userId: 'alice' })]);
    expect(lines.filter((line) => line.msg === `${RESPONSE_CAP_LINE}, repeated`)).toEqual([
      expect.objectContaining({ repeated: 1 }),
    ]);
  });

  it('cuts at once as another answer of the user is handed over, before any check, and never the responses of another user', () => {
    const { stalls, close } = watch();
    const mine = Array.from({ length: RESPONSES_WAITING_PER_USER + 1 }, () => new StandIn());
    for (const response of mine) {
      trackOn(stalls, response, 'alice');
      response.write(700_000);
    }
    stalls.answering('bob');
    expect(mine.some((response) => response.destroyed)).toBe(false);
    stalls.answering('alice');
    expect(mine.map((response) => response.destroyed)).toEqual([
      true,
      ...Array<boolean>(RESPONSES_WAITING_PER_USER).fill(false),
    ]);
    close();
  });

  it('allows an invitee a quarter as many as a member', () => {
    expect(responsesWaitingFor('alice')).toBe(RESPONSES_WAITING_PER_USER);
    expect(responsesWaitingFor(GUEST_ID)).toBe(RESPONSES_WAITING_PER_INVITEE);
    expect(RESPONSES_WAITING_PER_INVITEE * 4).toBe(RESPONSES_WAITING_PER_USER);
    const { stalls, close } = watch();
    const guests = Array.from({ length: RESPONSES_WAITING_PER_INVITEE + 1 }, () => new StandIn());
    for (const response of guests) {
      trackOn(stalls, response, GUEST_ID);
      response.write(700_000);
    }
    stalls.answering(GUEST_ID);
    expect(guests.map((response) => response.destroyed)).toEqual([
      true,
      ...Array<boolean>(RESPONSES_WAITING_PER_INVITEE).fill(false),
    ]);
    close();
  });

  it('ends a response queued behind another as its connection closes: destroyed, closed and forgotten', () => {
    const { stalls, close } = watch();
    const ahead = new StandIn();
    const behind = new StandIn();
    behind.connected = false;
    const connection = trackOn(stalls, ahead, 'alice');
    trackOn(stalls, behind, 'alice', connection);
    ahead.write(262_153);
    behind.write(65_731);
    let closed = 0;
    behind.once('close', () => {
      closed += 1;
    });
    connection.destroy();
    // Node closes the one it was writing; the queued one only the check can.
    expect(ahead.destroyed).toBe(false);
    expect(behind.destroyed).toBe(true);
    expect(closed).toBe(1);
    expect(stalls.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(connection.listenerCount('close')).toBe(0);
    close();
  });

  it('ends the connection of a queued response it cuts, and with it the rest queued there', () => {
    const { stalls, close } = watch();
    // A held stream its client reads, with answers pipelined behind it.
    const stream = new StandIn();
    const connection = trackOn(stalls, stream, 'alice');
    const queued = Array.from({ length: RESPONSES_WAITING_PER_USER + 1 }, () => {
      const response = new StandIn();
      response.connected = false;
      trackOn(stalls, response, 'alice', connection);
      response.write(65_731);
      return response;
    });
    stalls.answering('alice');
    // Only the oldest queued answer was past the cap, but it could go only with its connection.
    expect(connection.destroyed).toBe(true);
    expect(queued.every((response) => response.destroyed)).toBe(true);
    // Node closes the stream it was writing as the connection goes.
    expect(stream.destroyed).toBe(false);
    expect(stalls.size).toBe(0);
    close();
  });

  it('ends a queued response whose connection closed while it was signed in, and never watches one node closed already', () => {
    const { stalls, close } = watch();
    const gone = new Connection();
    gone.destroy();
    const queued = new StandIn();
    queued.connected = false;
    let closed = 0;
    queued.once('close', () => {
      closed += 1;
    });
    trackOn(stalls, queued, 'alice', gone);
    expect(queued.destroyed).toBe(true);
    expect(closed).toBe(1);
    // Node closed the one it was writing as its client went; that 'close' does not come again.
    const written = new StandIn();
    written.destroy();
    trackOn(stalls, written, 'alice');
    expect(stalls.size).toBe(0);
    expect(gone.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    close();
  });

  it('keeps one close listener a connection however many responses are pipelined on it, and none once they are done', () => {
    const { stalls, close } = watch();
    const connection = new Connection();
    const responses = Array.from({ length: 40 }, () => new StandIn());
    for (const response of responses) trackOn(stalls, response, 'alice', connection);
    expect(connection.listenerCount('close')).toBe(1);
    for (const response of responses) response.emit('finish');
    expect(connection.listenerCount('close')).toBe(0);
    expect(stalls.size).toBe(0);
    close();
  });
});

describe('inSlices', () => {
  it('cuts each chunk into views of at most RESPONSE_SLICE_BYTES, keeping status, headers and every byte', async () => {
    const source = new Uint8Array(3 * RESPONSE_SLICE_BYTES + 5).map((_, n) => n % 251);
    const original = new Response(source, { status: 202, headers: { 'x-kept': 'yes' } });
    const sliced = inSlices(original);
    expect(sliced.status).toBe(202);
    expect(sliced.headers.get('x-kept')).toBe('yes');
    const sizes: number[] = [];
    const received: number[] = [];
    if (sliced.body === null) throw new Error('no body');
    await sliced.body.pipeTo(
      new WritableStream<Uint8Array>({
        write(chunk) {
          sizes.push(chunk.byteLength);
          received.push(...chunk);
        },
      }),
    );
    expect(Math.max(...sizes)).toBeLessThanOrEqual(RESPONSE_SLICE_BYTES);
    expect(received).toEqual([...source]);
  });

  it('leaves a response with no body as it is', () => {
    const empty = new Response(null, { status: 202 });
    expect(inSlices(empty)).toBe(empty);
  });
});

/** Settings scaled down from 10 s checks, so a run takes seconds. */
const REAL_CHECK_MS = 200;
/** A result written as one chunk: the SDK builds every JSON answer with Response.json. */
const RESULT = { text: 'x'.repeat(3_000_000) };
/** Requests one client sends on one connection before it reads any answer. */
const PIPELINED = 8;

interface Served {
  /** How the response ended: written out in full, or closed before that. */
  outcome: Promise<'finished' | 'closed'>;
  /** Settles once the client's connection has closed, all it was sent read or not. */
  ended: Promise<void>;
  read: () => number;
  close: () => Promise<void>;
}

let socketCount = 0;

interface Answering {
  path: string;
  /** How each response the server made ended, in the order the requests came. */
  outcomes: Promise<'finished' | 'closed'>[];
  close: () => Promise<void>;
}

/**
 * A server on a Unix socket, whose kernel buffer (about 208 KB on Linux)
 * stands in for a slow link's, answering every request with RESULT the way
 * relay.ts writes it: through inSlices and the MCP Node adapter, each
 * response watched by `stalls` for alice on its connection, and her
 * responses trimmed as each answer is handed over. An answer waits
 * `answerAfterMs` first, as a call waits on its page.
 */
async function serveAll(stalls: ResponseStalls, answerAfterMs = 0): Promise<Answering> {
  const handler = toNodeHandler({
    fetch: async () => {
      if (answerAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
      stalls.answering('alice');
      return inSlices(Response.json(RESULT));
    },
  });
  const outcomes: Promise<'finished' | 'closed'>[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    stalls.track(response, 'alice', request.socket);
    outcomes.push(
      new Promise((resolve) => {
        response.once('finish', () => {
          resolve('finished');
        });
        response.once('close', () => {
          resolve('closed');
        });
      }),
    );
    void handler(request as NodeIncomingMessageLike, response);
  });
  socketCount += 1;
  const path = join(tmpdir(), `tabdock-stall-${String(process.pid)}-${String(socketCount)}.sock`);
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    path,
    outcomes,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** One GET for an answer, the connection closed after it. */
const ONE_REQUEST = 'GET /mcp HTTP/1.1\r\nHost: relay.invalid\r\nConnection: close\r\n\r\n';

interface Reader {
  ended: Promise<void>;
  read: () => number;
  close: () => void;
}

/**
 * A client on `path` that sends `requests` and reads what comes back at
 * `rate` bytes a second, 50 ms at a time, until it has read `stopAfter`
 * bytes, then reads no more.
 */
function readFrom(
  path: string,
  rate: number,
  stopAfter = Number.POSITIVE_INFINITY,
  requests = ONE_REQUEST,
): Reader {
  const client: Socket = connect(path);
  client.on('error', () => {
    // A response cut off resets the connection; the outcome says so.
  });
  client.on('readable', () => undefined);
  const ended = new Promise<void>((resolve) => {
    client.once('close', () => {
      resolve();
    });
  });
  client.write(requests);
  let read = 0;
  const step = 50;
  const timer = setInterval(() => {
    let left = Math.min(Math.round((rate * step) / 1000), stopAfter - read);
    while (left > 0) {
      const chunk = client.read(Math.min(left, client.readableLength || left)) as Buffer | null;
      if (chunk === null) break;
      read += chunk.length;
      left -= chunk.length;
    }
  }, step);
  return {
    ended,
    read: () => read,
    close: () => {
      clearInterval(timer);
      client.destroy();
    },
  };
}

/** Polls until `server` has made `count` responses. */
async function responsesMade(server: Answering, count: number): Promise<void> {
  while (server.outcomes.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * One answer served as serveAll serves it, which a client reads at `rate`
 * bytes a second until it has read `stopAfter` bytes.
 */
async function serveOne(
  stalls: ResponseStalls,
  rate: number,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<Served> {
  const server = await serveAll(stalls);
  const reader = readFrom(server.path, rate, stopAfter);
  await responsesMade(server, 1);
  const [outcome] = server.outcomes;
  if (outcome === undefined) throw new Error('no response');
  return {
    outcome,
    ended: reader.ended,
    read: reader.read,
    close: async () => {
      reader.close();
      await server.close();
    },
  };
}

describe.skipIf(process.platform === 'win32')(
  'on a real socket, written as relay.ts writes it (ADR 0032)',
  () => {
    function realStalls(waitingCapOf?: (userId: string) => number): {
      stalls: ResponseStalls;
      lines: Record<string, unknown>[];
    } {
      const lines: Record<string, unknown>[] = [];
      const log = createLogger({
        sink: (line) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      });
      const stalls = new ResponseStalls({
        lines: createRepeatedLog(log, 60_000),
        checkMs: REAL_CHECK_MS,
        ...(waitingCapOf === undefined ? {} : { waitingCapOf }),
      });
      return { stalls, lines };
    }

    it('never cuts off a client that reads a large result steadily, though reading it all takes many times the cut-off', async () => {
      const { stalls, lines } = realStalls();
      // 1.5 MB a second: about 2 s for the whole, where the cut-off comes
      // after 0.6 to 0.8 s without progress; the kernel takes more about
      // every 0.2 s. Written whole, nothing showed until the last write
      // finished, near the end, and the response was cut.
      const served = await serveOne(stalls, 1_500_000);
      try {
        expect(await served.outcome).toBe('finished');
        await served.ended;
        expect(served.read()).toBeGreaterThan(3_000_000);
        expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([]);
      } finally {
        stalls.close();
        await served.close();
      }
    }, 20_000);

    it('cuts off a client that stops reading partway, with its line', async () => {
      const { stalls, lines } = realStalls();
      const served = await serveOne(stalls, 1_500_000, 500_000);
      try {
        expect(await served.outcome).toBe('closed');
        expect(served.read()).toBeLessThan(3_000_000);
        expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([
          expect.objectContaining({ level: 'warn', userId: 'alice' }),
        ]);
      } finally {
        stalls.close();
        await served.close();
      }
    }, 20_000);

    it('ends every answer pipelined on a connection once the one being written is cut off, freeing what each held', async () => {
      // No cap, so only the stall rule acts: the first answer is cut off and
      // its connection goes. Node closes that one only; the rest, queued
      // behind it with their bodies, stayed held for good.
      const { stalls, lines } = realStalls(() => Number.POSITIVE_INFINITY);
      // The answers wait, as calls wait on a page, so every request is read before any is written.
      const server = await serveAll(stalls, 100);
      const pipelined = 'GET /mcp HTTP/1.1\r\nHost: relay.invalid\r\n\r\n'.repeat(PIPELINED);
      const reader = readFrom(server.path, 0, 0, pipelined);
      try {
        await responsesMade(server, PIPELINED);
        // Before the fix all but the first never ended at all.
        let timer: NodeJS.Timeout | undefined;
        const outcomes = await Promise.race([
          Promise.all(server.outcomes),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => {
              resolve(null);
            }, 10_000);
          }),
        ]);
        clearTimeout(timer);
        expect(outcomes).toEqual(Array<string>(PIPELINED).fill('closed'));
        expect(stalls.size).toBe(0);
        expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([
          expect.objectContaining({ level: 'warn', userId: 'alice' }),
        ]);
      } finally {
        stalls.close();
        reader.close();
        await server.close();
      }
    }, 20_000);

    it('cuts off the oldest of answers a user reads steadily once more wait than they may, and keeps the rest', async () => {
      const cap = 3;
      const { stalls, lines } = realStalls(() => cap);
      const server = await serveAll(stalls);
      // Each read as the reader of the first test reads, never stalling.
      const readers: Reader[] = [];
      try {
        for (let n = 1; n <= cap + 2; n += 1) {
          readers.push(readFrom(server.path, 1_500_000));
          await responsesMade(server, n);
        }
        const outcomes = await Promise.all(server.outcomes);
        expect(outcomes).toEqual(['closed', 'closed', ...Array<string>(cap).fill('finished')]);
        expect(lines.filter((line) => line.msg === RESPONSE_CAP_LINE)).toEqual([
          expect.objectContaining({ level: 'warn', userId: 'alice' }),
        ]);
        expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([]);
      } finally {
        stalls.close();
        for (const reader of readers) reader.close();
        await server.close();
      }
    }, 20_000);
  },
);

/**
 * Makes the response to every request carrying the stall header report bytes
 * waiting and none sent, as one whose client stopped reading would; every
 * other response reports what it really holds.
 */
function stallMarked(): void {
  const real = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(ServerResponse.prototype) as object,
    'writableLength',
  );
  const marked = (response: ServerResponse): boolean =>
    response.req.headers['x-test-stall'] === '1';
  Object.defineProperty(ServerResponse.prototype, 'writableLength', {
    configurable: true,
    get(this: ServerResponse): number {
      if (marked(this)) return 4096;
      return (real?.get?.call(this) as number | undefined) ?? 0;
    },
  });
  // A stream's keep-alives still reach the kernel, so its socket is made to
  // report no write finished from its head on, whatever it really sends.
  const writeHead = Object.getOwnPropertyDescriptor(ServerResponse.prototype, 'writeHead')
    ?.value as (this: ServerResponse, ...args: unknown[]) => ServerResponse;
  ServerResponse.prototype.writeHead = function (
    this: ServerResponse,
    ...args: unknown[]
  ): ServerResponse {
    const socket = this.socket;
    if (marked(this) && socket !== null) {
      const finished = socket.bytesWritten - socket.writableLength;
      Object.defineProperty(socket, 'bytesWritten', {
        configurable: true,
        get(this: Socket): number {
          return finished + this.writableLength;
        },
      });
    }
    return writeHead.apply(this, args);
  } as typeof ServerResponse.prototype.writeHead;
  restore = () => {
    Reflect.deleteProperty(ServerResponse.prototype, 'writableLength');
    ServerResponse.prototype.writeHead = writeHead;
  };
}

describe('the cut-off on /mcp (ADRs 0030 and 0032)', () => {
  it('writes every /mcp answer in slices, so a large result shows progress as each goes out', async () => {
    relay = await startRelay({ auth: createDevTokenAuth([ALICE]) });
    const page = await connectPage(relay.relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: 'y'.repeat(100_000) }),
    });
    pages.push(page);
    const client = await connectClient(relay.relay, ALICE, { modern: true });
    await pairAndApprove(client, page);
    const write = vi.spyOn(ServerResponse.prototype, 'write');
    try {
      const result = await client.callTool({
        name: 'call_page_tool',
        arguments: { page: page.pageId, tool: 'get_view' },
      });
      expect(result.isError).not.toBe(true);
      const sizes = write.mock.calls.flatMap((args, n) => {
        const response = write.mock.contexts[n] as ServerResponse;
        const chunk: unknown = args[0];
        if (response.req.url !== '/mcp') return [];
        if (typeof chunk === 'string') return [Buffer.byteLength(chunk)];
        return chunk instanceof Uint8Array ? [chunk.byteLength] : [];
      });
      // One write of about 100 KB before, slices now.
      expect(sizes.reduce((sum, size) => sum + size, 0)).toBeGreaterThan(100_000);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(RESPONSE_SLICE_BYTES);
    } finally {
      write.mockRestore();
      await client.close().catch(() => undefined);
    }
  });

  it('ends a stream its client stopped reading, and a call still waiting on its response is cancelled as when the client goes', async () => {
    // Only the check's interval is faked; everything else runs in real time.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stallMarked();
    relay = await startRelay({
      auth: createDevTokenAuth([ALICE, BOB]),
      timings: { callDeadlineMs: 20_000 },
    });
    const stalled = await openListen(relay.relay, ALICE, { headers: { 'X-Test-Stall': '1' } });
    const reading = await openListen(relay.relay, BOB);
    streams.push(stalled, reading);
    expect([stalled.streaming, reading.streaming]).toEqual([true, true]);
    // A call whose response stops moving while the page holds it.
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const client = await connectClient(relay.relay, ALICE, {
      modern: true,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers).entries()),
            'x-test-stall': '1',
          },
        }),
    });
    await pairAndApprove(client, page);
    const call = client
      .callTool({ name: 'call_page_tool', arguments: { page: page.pageId, tool: 'get_view' } })
      .then(
        () => 'answered',
        () => 'ended',
      );
    const invoke = await page.next('invoke');
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 1));
    await stalled.ended;
    expect(await call).toBe('ended');
    expect((await page.next('cancel')).callId).toBe(invoke.callId);
    // The client reading its stream keeps it.
    let readingEnded = false;
    void reading.ended.then(() => {
      readingEnded = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(readingEnded).toBe(false);
    const cut = relay.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === RESPONSE_CUT_LINE);
    expect(cut).toEqual([expect.objectContaining({ level: 'warn', userId: 'alice' })]);
    expect(JSON.stringify(cut)).not.toContain(ALICE.token);
    await client.close().catch(() => undefined);
  });

  it('cuts off the oldest response of a member as another answer of theirs is handed over once more wait than they may, before any check', async () => {
    // No check runs: the cut comes as the last stream's answer is handed over.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    stallMarked();
    relay = await startRelay({ auth: createDevTokenAuth([ALICE, BOB]) });
    const marked = { headers: { 'X-Test-Stall': '1' } };
    const mine: OpenStream[] = [];
    for (let n = 0; n < RESPONSES_WAITING_PER_USER; n += 1) {
      const stream = await openListen(relay.relay, ALICE, marked);
      streams.push(stream);
      mine.push(stream);
    }
    // Another member's waiting stream counts toward no cap of alice's.
    const bobs = await openListen(relay.relay, BOB, marked);
    streams.push(bobs);
    const last = await openListen(relay.relay, ALICE, marked);
    streams.push(last);
    const [oldest, ...rest] = mine;
    await oldest?.ended;
    const ended = new Set<OpenStream>();
    for (const stream of [...rest, last, bobs]) {
      void stream.ended.then(() => {
        ended.add(stream);
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(ended.size).toBe(0);
    const cut = relay.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === RESPONSE_CAP_LINE);
    expect(cut).toEqual([expect.objectContaining({ level: 'warn', userId: 'alice' })]);
    expect(JSON.stringify(cut)).not.toContain(ALICE.token);
  });

  it('cancels a call pipelined behind a stream on one connection when the client closes that connection, as when its client goes', async () => {
    relay = await startRelay({
      auth: createDevTokenAuth([ALICE]),
      timings: { callDeadlineMs: 20_000 },
    });
    const page = await connectPage(relay.relay.pageUrl, { tools: TOOLS });
    pages.push(page);
    const client = await connectClient(relay.relay, ALICE, { modern: true });
    await pairAndApprove(client, page);
    await client.close();
    const url = new URL(relay.relay.mcpUrl);
    const envelope = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'pipelining', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    };
    const post = (headers: Record<string, string>, message: unknown): string => {
      const body = JSON.stringify(message);
      const lines = Object.entries({
        Host: url.host,
        Authorization: `Bearer ${ALICE.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Mcp-Protocol-Version': '2026-07-28',
        ...headers,
        'Content-Length': String(Buffer.byteLength(body)),
      }).map(([name, value]) => `${name}: ${value}\r\n`);
      return `POST /mcp HTTP/1.1\r\n${lines.join('')}\r\n${body}`;
    };
    const listen = post(
      { 'Mcp-Method': 'subscriptions/listen' },
      {
        jsonrpc: '2.0',
        id: 'listen',
        method: 'subscriptions/listen',
        params: { _meta: envelope, notifications: { toolsListChanged: true } },
      },
    );
    const call = post(
      { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'call_page_tool' },
      {
        jsonrpc: '2.0',
        id: 'call',
        method: 'tools/call',
        params: {
          name: 'call_page_tool',
          arguments: { page: page.pageId, tool: 'get_view' },
          _meta: envelope,
        },
      },
    );
    // One write, so the relay reads both before it answers either: the
    // call's answer waits behind the stream, which never ends.
    const socket = connect(Number(url.port), url.hostname);
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', resolve));
    socket.write(listen + call);
    const invoke = await page.next('invoke');
    socket.destroy();
    // Long before the call's 20 s deadline.
    expect((await page.next('cancel', 2000)).callId).toBe(invoke.callId);
  });
});
