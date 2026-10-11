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
import type { AuthInfo } from '@modelcontextprotocol/server';
import { MAX_RESULT_CHARS } from '@tabdock/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MIN_RESPONSE_BYTES } from '../src/config.ts';
import {
  type AttachmentRecord,
  createDevTokenAuth,
  createMemoryStore,
  type DevTokenUser,
} from '../src/index.ts';
import { createLogger } from '../src/log.ts';
import { createRepeatedLog } from '../src/repeated-lines.ts';
import {
  inSlices,
  RESPONSE_CAP_LINE,
  RESPONSE_CEILING_LINE,
  RESPONSE_CEILING_MEMBERS_LINE,
  RESPONSE_CHECK_MS,
  RESPONSE_CUT_LINE,
  RESPONSE_SLICE_BYTES,
  RESPONSE_STALL_CHECKS,
  ResponseStalls,
  RESPONSES_WAITING_PER_INVITEE,
  RESPONSES_WAITING_PER_USER,
  responsesWaitingFor,
  type ResponseStallOptions,
  type WatchedSocket,
} from '../src/response-stalls.ts';
import { GUEST, MEMBER, STRANGER, type TierRank } from '../src/sessions.ts';
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
  /** The connection trackOn watched it on. */
  connection: Connection | null = null;

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
   * As node's: a response with its socket destroys that socket, and so its
   * connection, and closes with it, while one still queued behind another on
   * its connection only marks itself destroyed.
   */
  destroy(): void {
    this.destroyed = true;
    if (!this.connected) return;
    this.emit('close');
    this.connection?.destroy();
  }
}

/** A response's connection as node's net.Socket reports it: destroyed, it closes. */
class Connection extends EventEmitter {
  destroyed = false;

  /** Whether 'close' comes a tick after destroy(), as a real socket's does. */
  readonly closesLater: boolean;

  constructor(closesLater = false) {
    super();
    this.closesLater = closesLater;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.closesLater) {
      process.nextTick(() => {
        this.emit('close');
      });
      return;
    }
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
  response.connection = on;
  stalls.track(response, userId, on);
  return on;
}

/**
 * An answer's body as the SDK makes one: chunks enqueued as they come,
 * whether anyone reads them or not, and a cancel that is heard.
 */
class FakeBody {
  readonly cancelled: unknown[] = [];
  readonly stream: ReadableStream<Uint8Array>;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;

  constructor() {
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      cancel: (reason) => {
        this.cancelled.push(reason);
      },
    });
  }

  /** Enqueues a chunk of `bytes`, and returns it. */
  push(bytes: number): Uint8Array {
    const chunk = new Uint8Array(bytes);
    this.#controller?.enqueue(chunk);
    return chunk;
  }

  end(): void {
    this.#controller?.close();
  }

  fail(error: Error): void {
    this.#controller?.error(error);
  }
}

/** Lets the slicer's reads of what was pushed run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

/** A megabyte, as the ceiling tests count. */
const MB = 1_000_000;

/** Where the ceiling tests' users stand: by the start of their names. */
function rankByName(userId: string): TierRank {
  if (userId.startsWith('stranger')) return STRANGER;
  if (userId.startsWith('guest')) return GUEST;
  return MEMBER;
}

/** The check with a ceiling of `ceilingBytes` and its lines captured, under fake timers. */
function watchCeiling(ceilingBytes: number): ReturnType<typeof watch> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({
    sink: (line) => {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  const repeated = createRepeatedLog(log, 60_000);
  const stalls = new ResponseStalls({ lines: repeated, ceilingBytes, rankOf: rankByName });
  return {
    stalls,
    lines,
    close: () => {
      stalls.close();
      repeated.close();
    },
  };
}

/** A response of `userId`'s whose slicer holds `bytes` of its answer, which the test may change. */
function holding(
  stalls: ResponseStalls,
  userId: string,
  bytes: number,
  on?: Connection,
): { response: StandIn; held: { bytes: number } } {
  const response = new StandIn();
  const held = { bytes };
  trackOn(stalls, response, userId, on);
  stalls.measure(response, () => held.bytes);
  return { response, held };
}

/** The users named in the lines with `msg`, in order. */
function named(lines: Record<string, unknown>[], msg: string): unknown[] {
  return lines.filter((line) => line.msg === msg).map((line) => line.userId);
}

describe('the relay-wide ceiling on what responses hold (S9, ADR 0044)', () => {
  it("cuts a guest's older response once all held passes the ceiling, and never a member's", () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    const guest = holding(stalls, 'guest-1', 4 * MB);
    const member = holding(stalls, 'alice', 6 * MB);
    // At the ceiling, not past it.
    stalls.answering('alice');
    expect([guest.response.destroyed, member.response.destroyed]).toEqual([false, false]);
    const newer = holding(stalls, 'alice', 1 * MB);
    stalls.answering('alice');
    expect(guest.response.destroyed).toBe(true);
    expect([member.response.destroyed, newer.response.destroyed]).toEqual([false, false]);
    expect(stalls.size).toBe(2);
    close();
    expect(lines.filter((line) => line.msg === RESPONSE_CEILING_LINE)).toEqual([
      expect.objectContaining({ level: 'warn', userId: 'guest-1' }),
    ]);
    expect(named(lines, RESPONSE_CEILING_MEMBERS_LINE)).toEqual([]);
  });

  it("cuts strangers' first, though newer, then guests', each oldest first, and stops once the rest fit", () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    const olderGuest = holding(stalls, 'guest-1', 3 * MB);
    const newerGuest = holding(stalls, 'guest-2', 3 * MB);
    const olderStranger = holding(stalls, 'stranger-1', 2 * MB);
    const newerStranger = holding(stalls, 'stranger-2', 2 * MB);
    const member = holding(stalls, 'alice', 3 * MB);
    stalls.answering('alice');
    // 13 MB: both strangers go, and at 9 MB the guests fit.
    expect(
      [olderGuest, newerGuest, olderStranger, newerStranger, member].map(
        ({ response }) => response.destroyed,
      ),
    ).toEqual([false, false, true, true, false]);
    holding(stalls, 'bob', 3 * MB);
    stalls.answering('bob');
    // 12 MB and no stranger left: the older guest goes, and the newer fits.
    expect([olderGuest.response.destroyed, newerGuest.response.destroyed]).toEqual([true, false]);
    close();
    // One line a window, naming the first user cut; the rest counted.
    expect(named(lines, RESPONSE_CEILING_LINE)).toEqual(['stranger-1']);
    expect(lines.filter((line) => line.msg === `${RESPONSE_CEILING_LINE}, repeated`)).toEqual([
      expect.objectContaining({ repeated: 2 }),
    ]);
  });

  it('counts what Node holds of a response unsent beside what its slicer holds', () => {
    const { stalls, close } = watchCeiling(10 * MB);
    const guest = holding(stalls, 'guest-1', 0);
    guest.response.write(6 * MB);
    holding(stalls, 'alice', 3 * MB);
    stalls.answering('alice');
    expect(guest.response.destroyed).toBe(false);
    guest.held.bytes = 2 * MB;
    stalls.answering('alice');
    expect(guest.response.destroyed).toBe(true);
    close();
  });

  it("never cuts a member's response, nor an invited account's that holds nothing, and says once a window that members alone pass it", () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    const idle = holding(stalls, 'guest-1', 0);
    const members = [holding(stalls, 'alice', 6 * MB), holding(stalls, 'bob', 6 * MB)];
    for (let n = 0; n < 3; n += 1) stalls.chunkQueued();
    // A check called, not timed: a faked timer would also end the lines' window early.
    stalls.check();
    expect([idle, ...members].some(({ response }) => response.destroyed)).toBe(false);
    close();
    // No user named: the line is about the relay, not anyone in it.
    expect(named(lines, RESPONSE_CEILING_MEMBERS_LINE)).toEqual([undefined]);
    expect(
      lines.filter((line) => line.msg === `${RESPONSE_CEILING_MEMBERS_LINE}, repeated`),
    ).toEqual([expect.objectContaining({ repeated: 3 })]);
    expect(named(lines, RESPONSE_CEILING_LINE)).toEqual([]);
  });

  it("never cuts an older invited stream for what is being written to its client, and cuts a newer guest's unread answer instead", () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    // A watcher's stream, the oldest response, read as fast as it comes: a
    // keep-alive just queued, and Node at its high-water mark from the last
    // push, as with any response being written.
    const reading = holding(stalls, 'guest-1', 13);
    reading.response.write(65_536 + RESPONSE_SLICE_BYTES + 16);
    const unread = [holding(stalls, 'guest-2', 4 * MB), holding(stalls, 'guest-3', 4 * MB)];
    holding(stalls, 'alice', 2.09 * MB);
    stalls.chunkQueued();
    // 10.17 MB: the older unread answer goes, and the rest fit.
    expect(reading.response.destroyed).toBe(false);
    expect(unread.map(({ response }) => response.destroyed)).toEqual([true, false]);
    close();
    expect(named(lines, RESPONSE_CEILING_LINE)).toEqual(['guest-2']);
  });

  it("cuts an invited account's small response past the ceiling once a check finds its client took none of it", () => {
    const { stalls, close } = watchCeiling(10 * MB);
    const small = holding(stalls, 'guest-1', 0);
    small.response.write(50_000);
    holding(stalls, 'alice', 9.99 * MB);
    stalls.chunkQueued();
    // In transit as far as anyone can tell yet, and then first seen waiting.
    stalls.check();
    expect(small.response.destroyed).toBe(false);
    // No more sent since: its client is not reading.
    stalls.check();
    expect(small.response.destroyed).toBe(true);
    close();
  });

  it("cuts no invited account's response while members' alone pass the ceiling, since that could not bring them under", () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    const older = holding(stalls, 'guest-1', 3 * MB);
    holding(stalls, 'alice', 6 * MB);
    const bob = holding(stalls, 'bob', 5 * MB);
    // A stranger's answer and a guest's arrive, each read into its slicer.
    const arriving = [holding(stalls, 'stranger-1', 720_000), holding(stalls, 'guest-2', 2000)];
    stalls.chunkQueued();
    stalls.check();
    expect([older, ...arriving].some(({ response }) => response.destroyed)).toBe(false);
    // Once members' fit again, invited accounts give way as before.
    bob.response.emit('finish');
    holding(stalls, 'carol', 0.9 * MB);
    stalls.answering('carol');
    // 10.62 MB with members at 6.9 MB: the stranger's goes, and the rest fit.
    expect(arriving.map(({ response }) => response.destroyed)).toEqual([true, false]);
    expect(older.response.destroyed).toBe(false);
    close();
    expect(named(lines, RESPONSE_CEILING_MEMBERS_LINE)).toEqual([undefined]);
    expect(named(lines, RESPONSE_CEILING_LINE)).toEqual(['stranger-1']);
  });

  it('holds the ceiling as a slicer queues a chunk and at every check, before any answer is handed over', () => {
    const { stalls, close } = watchCeiling(10 * MB);
    const first = holding(stalls, 'guest-1', 5 * MB);
    holding(stalls, 'alice', 4 * MB);
    stalls.chunkQueued();
    expect(first.response.destroyed).toBe(false);
    // Its answer grows as the SDK hands the slicer more of it.
    first.held.bytes = 7 * MB;
    stalls.chunkQueued();
    expect(first.response.destroyed).toBe(true);
    const second = holding(stalls, 'guest-2', 5 * MB);
    second.held.bytes = 7 * MB;
    expect(second.response.destroyed).toBe(false);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    expect(second.response.destroyed).toBe(true);
    close();
  });

  it('cuts a response queued behind another with its connection, and counts all queued there as let go', async () => {
    const { stalls, close } = watchCeiling(10 * MB);
    // Its 'close' comes a tick later, as a socket's does, so the other
    // response queued there is still watched when the ceiling counts again.
    const connection = new Connection(true);
    // A stream its client reads, with two guests' answers pipelined behind
    // it, and between them in age a guest's on a connection of its own.
    holding(stalls, 'alice', 0, connection);
    const first = holding(stalls, 'guest-1', 4 * MB, connection);
    const elsewhere = holding(stalls, 'guest-2', 3 * MB);
    const queued = [first, holding(stalls, 'guest-3', 4 * MB, connection)];
    for (const { response } of queued) response.connected = false;
    holding(stalls, 'bob', 5 * MB);
    stalls.answering('bob');
    // 16 MB: the oldest guest's goes, taking its connection and the other
    // queued there, and 8 MB is left, so the guest on its own connection,
    // older than the one queued, stays.
    expect(connection.destroyed).toBe(true);
    expect(elsewhere.response.destroyed).toBe(false);
    await new Promise((resolve) => {
      process.nextTick(resolve);
    });
    expect(queued.every(({ response }) => response.destroyed)).toBe(true);
    expect(elsewhere.response.destroyed).toBe(false);
    close();
  });

  it('counts all queued behind a response it cuts as let go, since cutting that one ends their connection too', async () => {
    const { stalls, lines, close } = watchCeiling(10 * MB);
    // Node destroys a response's socket with it; the socket's 'close' comes a tick later.
    const connection = new Connection(true);
    const head = holding(stalls, 'guest-a', 1 * MB, connection);
    const behind = holding(stalls, 'guest-a', 4 * MB, connection);
    behind.response.connected = false;
    const elsewhere = holding(stalls, 'guest-b', 3 * MB);
    const member = holding(stalls, 'alice', 3.5 * MB);
    stalls.answering('alice');
    // 11.5 MB: the oldest guest's goes and takes its connection, so the 4 MB
    // queued behind it goes too and 6.5 MB is left; the newer guest stays.
    expect([head.response.destroyed, connection.destroyed]).toEqual([true, true]);
    expect([elsewhere.response.destroyed, member.response.destroyed]).toEqual([false, false]);
    await new Promise((resolve) => {
      process.nextTick(resolve);
    });
    expect(behind.response.destroyed).toBe(true);
    expect(elsewhere.response.destroyed).toBe(false);
    close();
    expect(named(lines, RESPONSE_CEILING_LINE)).toEqual(['guest-a']);
    expect(lines.filter((line) => line.msg === `${RESPONSE_CEILING_LINE}, repeated`)).toEqual([]);
  });

  it('cuts nothing when given no ceiling', () => {
    const { stalls, close } = watch();
    const guest = new StandIn();
    trackOn(stalls, guest, 'guest-1');
    stalls.measure(guest, () => 500 * MB);
    stalls.chunkQueued();
    stalls.answering('guest-1');
    expect(guest.destroyed).toBe(false);
    close();
  });
});

describe('inSlices', () => {
  it('cuts each chunk into slices of at most RESPONSE_SLICE_BYTES, keeping status, headers and every byte', async () => {
    const source = new Uint8Array(3 * RESPONSE_SLICE_BYTES + 5).map((_, n) => n % 251);
    const original = new Response(source, { status: 202, headers: { 'x-kept': 'yes' } });
    const sliced = inSlices(original).response;
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

  it('leaves a response with no body as it is, holding nothing', () => {
    const empty = new Response(null, { status: 202 });
    const sliced = inSlices(empty);
    expect(sliced.response).toBe(empty);
    expect(sliced.queuedBytes()).toBe(0);
  });

  it('reads the answer as it comes, before anyone asks, and counts each chunk whole until its last slice is taken (ADR 0044)', async () => {
    const source = new FakeBody();
    let heard = 0;
    const sliced = inSlices(new Response(source.stream), () => {
      heard += 1;
    });
    const large = source.push(2 * RESPONSE_SLICE_BYTES + 100);
    const small = source.push(300);
    await settle();
    // Nobody has read a byte, and both chunks are held where they can be counted.
    expect(sliced.queuedBytes()).toBe(2 * RESPONSE_SLICE_BYTES + 400);
    expect(heard).toBe(2);
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      sliced.response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const taken: Uint8Array[] = [];
    const left: number[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      taken.push(next.value);
      left.push(sliced.queuedBytes());
      // The last slice is taken only once the source has ended.
      if (left.length === 4) source.end();
    }
    expect(taken.map((slice) => slice.byteLength)).toEqual([
      RESPONSE_SLICE_BYTES,
      RESPONSE_SLICE_BYTES,
      100,
      300,
    ]);
    // A chunk lives while any slice of it does, so it counts whole until its last is taken.
    expect(left).toEqual([2 * RESPONSE_SLICE_BYTES + 400, 2 * RESPONSE_SLICE_BYTES + 400, 300, 0]);
    // Its slices are copies, so what Node holds of them unsent keeps none of it alive.
    expect(taken.slice(0, 3).some((slice) => slice.buffer === large.buffer)).toBe(false);
    // One no larger than a slice goes on as it came.
    expect(taken[3]?.buffer).toBe(small.buffer);
  });

  it('cancels the answer underneath as its client goes, and lets go of what it held', async () => {
    const source = new FakeBody();
    const sliced = inSlices(new Response(source.stream));
    source.push(5 * RESPONSE_SLICE_BYTES);
    await settle();
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      sliced.response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    expect((await reader.read()).value?.byteLength).toBe(RESPONSE_SLICE_BYTES);
    await reader.cancel('gone');
    expect(source.cancelled).toEqual(['gone']);
    expect(sliced.queuedBytes()).toBe(0);
  });

  it('fails the body its client reads as the answer underneath fails, holding nothing after', async () => {
    const source = new FakeBody();
    const sliced = inSlices(new Response(source.stream));
    source.push(1000);
    source.fail(new Error('the SDK went'));
    await settle();
    expect(sliced.queuedBytes()).toBe(0);
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      sliced.response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    await expect(reader.read()).rejects.toThrow('the SDK went');
  });

  it('waits for more of a stream that has not ended, rather than ending it', async () => {
    const source = new FakeBody();
    const sliced = inSlices(new Response(source.stream));
    const reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
      sliced.response.body?.getReader();
    if (reader === undefined) throw new Error('no body');
    const first = reader.read();
    await settle();
    source.push(13);
    expect((await first).value?.byteLength).toBe(13);
    const second = reader.read();
    source.end();
    expect((await second).done).toBe(true);
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
  /** Answers handed to the adapter so far. */
  answered: () => number;
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
  // As relay.ts keys each request's Node response by its auth object.
  const answeredOn = new WeakMap<AuthInfo, ServerResponse>();
  let answered = 0;
  const handler = toNodeHandler({
    fetch: async (_request, options) => {
      if (answerAfterMs > 0) await new Promise((resolve) => setTimeout(resolve, answerAfterMs));
      const auth = options?.authInfo;
      stalls.answering(auth?.clientId ?? 'alice');
      const slices = inSlices(Response.json(RESULT), () => {
        stalls.chunkQueued();
      });
      const written = auth === undefined ? undefined : answeredOn.get(auth);
      if (written !== undefined) stalls.measure(written, slices.queuedBytes);
      answered += 1;
      return slices.response;
    },
  });
  const outcomes: Promise<'finished' | 'closed'>[] = [];
  const server = createServer((request: IncomingMessage, response) => {
    // The user a request names in its query, alice when it names none.
    const userId = new URL(request.url ?? '/', 'http://relay.invalid').searchParams.get('user');
    const auth: AuthInfo = { token: '', clientId: userId ?? 'alice', scopes: [] };
    answeredOn.set(auth, response);
    (request as IncomingMessage & { auth?: AuthInfo }).auth = auth;
    stalls.track(response, auth.clientId, request.socket);
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
    answered: () => answered,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** One GET for an answer, the connection closed after it. */
const ONE_REQUEST = 'GET /mcp HTTP/1.1\r\nHost: relay.invalid\r\nConnection: close\r\n\r\n';

/** ONE_REQUEST, made as `userId`. */
function requestAs(userId: string): string {
  return ONE_REQUEST.replace('/mcp', `/mcp?user=${userId}`);
}

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
    function realStalls(options: Omit<ResponseStallOptions, 'lines'> = {}): {
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
        ...options,
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
      const { stalls, lines } = realStalls({ waitingCapOf: () => Number.POSITIVE_INFINITY });
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
      const { stalls, lines } = realStalls({ waitingCapOf: () => cap });
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

    /**
     * A guest leaves its 3 MB answer unread, then two members read theirs
     * steadily, under a ceiling of MIN_RESPONSE_BYTES with the stall rule
     * held off. The guest's answer, written as relay.ts writes it, is almost
     * all in its slicer's queue, the kernel holding only its buffer's worth.
     */
    async function guestThenMembers(
      ceilingBytes: number | undefined,
    ): Promise<{ lines: Record<string, unknown>[]; guest: 'finished' | 'closed' | 'open' }> {
      const { stalls, lines } = realStalls({
        checkMs: 60_000,
        rankOf: (userId) => (userId === GUEST_ID ? GUEST : MEMBER),
        ...(ceilingBytes === undefined ? {} : { ceilingBytes }),
      });
      const server = await serveAll(stalls);
      const readers: Reader[] = [];
      try {
        readers.push(readFrom(server.path, 0, 0, requestAs(GUEST_ID)));
        await answersHanded(server, 1);
        for (const [n, member] of ['alice', 'bob'].entries()) {
          readers.push(
            readFrom(server.path, 1_500_000, Number.POSITIVE_INFINITY, requestAs(member)),
          );
          await answersHanded(server, n + 2);
        }
        const [guest, ...members] = server.outcomes;
        expect(await Promise.all(members)).toEqual(['finished', 'finished']);
        const open = new Promise<'open'>((resolve) => setImmediate(resolve, 'open'));
        return { lines, guest: await Promise.race([guest ?? open, open]) };
      } finally {
        stalls.close();
        for (const reader of readers) reader.close();
        await server.close();
      }
    }

    it("cuts an invited account's unread answer once all that waits passes the ceiling, counting what its slicer holds, and never a member's (ADR 0044)", async () => {
      const { lines, guest } = await guestThenMembers(MIN_RESPONSE_BYTES);
      expect(guest).toBe('closed');
      expect(lines.filter((line) => line.msg === RESPONSE_CEILING_LINE)).toEqual([
        expect.objectContaining({ level: 'warn', userId: GUEST_ID }),
      ]);
      // Bob's answer came while Alice still held much of hers: members alone, so only a line.
      expect(named(lines, RESPONSE_CEILING_MEMBERS_LINE)).toEqual([undefined]);
      expect(lines.filter((line) => line.msg === RESPONSE_CUT_LINE)).toEqual([]);
    }, 20_000);

    it("keeps the guest's unread answer whole without a ceiling, as before M6", async () => {
      const { lines, guest } = await guestThenMembers(undefined);
      expect(guest).toBe('open');
      expect(named(lines, RESPONSE_CEILING_LINE)).toEqual([]);
    }, 20_000);
  },
);

/** Polls until `server` has handed `count` answers to the adapter, and their slicers have read them. */
async function answersHanded(server: Answering, count: number): Promise<void> {
  while (server.answered() < count) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await settle();
}

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
    const socket = await callBehindStream(relay, page);
    const invoke = await page.next('invoke');
    socket.destroy();
    // Long before the call's 20 s deadline.
    expect((await page.next('cancel', 2000)).callId).toBe(invoke.callId);
  });

  it("counts what an answer queued in the relay holds toward TABDOCK_MAX_RESPONSE_BYTES, cutting a stranger's response before an older guest's and never the member's (ADR 0044)", async () => {
    // No check runs: the cut comes as the member's answer is read into its slicer.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    heldMarked();
    const store = createMemoryStore();
    relay = await startRelay({
      auth: createDevTokenAuth([ALICE, GUEST_USER, STRANGER_USER]),
      invites: true,
      store,
      limits: { responseBytes: MIN_RESPONSE_BYTES },
      timings: { callDeadlineMs: 20_000 },
    });
    // The largest answer, about 0.72 MB on the wire: JSON writes each character in six bytes.
    const page = await connectPage(relay.relay.pageUrl, {
      tools: TOOLS,
      onInvoke: () => ({ ok: true, content: '\u0001'.repeat(MAX_RESULT_CHARS) }),
    });
    pages.push(page);
    store.attachments.put(guestAttachment(GUEST_USER.userId));
    // Together 3.8 MB of the 4 MiB ceiling, the stranger's the newer.
    const guest = await openListen(relay.relay, GUEST_USER, {
      headers: { 'X-Test-Held': '2000000' },
    });
    const stranger = await openListen(relay.relay, STRANGER_USER, {
      headers: { 'X-Test-Held': '1800000' },
    });
    streams.push(guest, stranger);
    expect([guest.streaming, stranger.streaming]).toEqual([true, true]);
    const client = await connectClient(relay.relay, ALICE, { modern: true });
    await pairAndApprove(client, page);
    await client.close();
    // The member's answer waits behind her stream, all of it in the relay:
    // Node takes only its high-water mark of a response that has no socket.
    const socket = await callBehindStream(relay, page);
    try {
      await page.next('invoke');
      await stranger.ended;
      const ended = new Set<OpenStream>();
      void guest.ended.then(() => {
        ended.add(guest);
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(ended.size).toBe(0);
      expect(socket.destroyed).toBe(false);
      const cut = relay.lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === RESPONSE_CEILING_LINE);
      expect(cut).toEqual([
        expect.objectContaining({ level: 'warn', userId: STRANGER_USER.userId }),
      ]);
      expect(JSON.stringify(cut)).not.toContain(STRANGER_USER.token);
    } finally {
      socket.destroy();
    }
  });
});

/** An invited account holding an attachment, so a guest rather than a stranger (sessions.ts's rankOf). */
const GUEST_USER: DevTokenUser = {
  userId: GUEST_ID,
  displayName: 'ignored',
  token: 'guest-ceiling-dev-token-3c7a91e2',
  kind: 'invitee',
};

/** An invited account holding none. */
const STRANGER_USER: DevTokenUser = {
  userId: `g_${'0b'.repeat(16)}`,
  displayName: 'ignored',
  token: 'stranger-ceiling-dev-token-8e15f4d0',
  kind: 'invitee',
};

/** An attachment as an invite would have made it, to put straight into the store. */
function guestAttachment(userId: string): AttachmentRecord {
  return {
    pageId: 'pg_HELD000000',
    userId,
    displayName: 'unverified account',
    kind: 'invitee',
    role: 'observer',
    grantedAt: Date.now(),
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
    inviteId: 'inv_held',
    endsAt: Date.now() + 60 * 60_000,
    inviteRole: 'observer',
    sponsorId: 'alice',
    emailHash: null,
  };
}

/**
 * Makes the response to every request carrying the held header report that
 * many bytes more waiting to be sent than it really has, as one whose client
 * stopped reading a large answer would.
 */
function heldMarked(): void {
  const real = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(ServerResponse.prototype) as object,
    'writableLength',
  );
  Object.defineProperty(ServerResponse.prototype, 'writableLength', {
    configurable: true,
    get(this: ServerResponse): number {
      const held = Number(this.req.headers['x-test-held'] ?? 0);
      return held + ((real?.get?.call(this) as number | undefined) ?? 0);
    },
  });
  restore = () => {
    Reflect.deleteProperty(ServerResponse.prototype, 'writableLength');
  };
}

/**
 * Alice's listen stream and a call to `page` behind it, written to one new
 * connection in one write, so the relay reads both before it answers either
 * and the call's answer waits behind the stream, which never ends.
 */
async function callBehindStream(test: TestRelay, page: TestPage): Promise<Socket> {
  const url = new URL(test.relay.mcpUrl);
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
  const socket = connect(Number(url.port), url.hostname);
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) => socket.once('connect', resolve));
  socket.write(listen + call);
  return socket;
}
