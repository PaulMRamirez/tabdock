// An /mcp response a client leaves unread (S9, ADRs 0030 and 0032). Node's
// server timeout is 0 and the MCP Node adapter waits for 'drain' without
// limit, so a client that stopped reading held its response for good. The
// check runs first against stand-in responses under fake timers, then on a
// real Unix socket through the Node adapter as relay.ts writes, where the
// kernel's buffer is small enough for a large answer to wait: one that a
// client reads steadily is never cut, and one it stops reading is. Then its
// wiring in relay.ts: every /mcp answer goes out in slices, and a marked
// request's response made to report bytes waiting and none sent is cut.

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
  RESPONSE_CHECK_MS,
  RESPONSE_CUT_LINE,
  RESPONSE_SLICE_BYTES,
  RESPONSE_STALL_CHECKS,
  ResponseStalls,
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

  destroy(): void {
    this.destroyed = true;
    this.emit('close');
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
    stalls.track(response, 'alice');
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
    stalls.track(sliced, 'alice');
    stalls.track(bursty, 'bob');
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
    stalls.track(whole, 'alice');
    whole.write(1_000_188);
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 1));
    expect(whole.destroyed).toBe(true);
    close();
  });

  it('counts a queue that grows while nothing is sent, as a held stream whose keep-alives nobody reads', () => {
    const { stalls, close } = watch();
    const response = new StandIn();
    stalls.track(response, 'alice');
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
    stalls.track(behind, 'alice');
    vi.advanceTimersByTime(RESPONSE_CHECK_MS * (RESPONSE_STALL_CHECKS + 2));
    expect(behind.destroyed).toBe(false);
    close();
  });

  it('forgets a response once it finishes or closes, and stops checking when none is left', () => {
    const { stalls, close } = watch();
    const finished = new StandIn();
    const closed = new StandIn();
    stalls.track(finished, 'alice');
    stalls.track(closed, 'alice');
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
      stalls.track(response, `user-${String(n)}`);
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

interface Served {
  /** How the response ended: written out in full, or closed before that. */
  outcome: Promise<'finished' | 'closed'>;
  /** Settles once the client's connection has closed, all it was sent read or not. */
  ended: Promise<void>;
  read: () => number;
  close: () => Promise<void>;
}

let socketCount = 0;

/**
 * One answer served on a Unix socket, whose kernel buffer (about 208 KB on
 * Linux) stands in for a slow link's, the way relay.ts writes it: through
 * inSlices and the MCP Node adapter, its response watched by `stalls`. A
 * client reads it at `rate` bytes a second, 50 ms at a time, until it has
 * read `stopAfter` bytes, then reads no more.
 */
async function serveOne(
  stalls: ResponseStalls,
  rate: number,
  stopAfter = Number.POSITIVE_INFINITY,
): Promise<Served> {
  const handler = toNodeHandler({
    fetch: () => Promise.resolve(inSlices(Response.json(RESULT))),
  });
  let settle: (outcome: 'finished' | 'closed') => void = () => undefined;
  const outcome = new Promise<'finished' | 'closed'>((resolve) => {
    settle = resolve;
  });
  const server = createServer((request: IncomingMessage, response) => {
    stalls.track(response, 'alice');
    response.once('finish', () => {
      settle('finished');
    });
    response.once('close', () => {
      settle('closed');
    });
    void handler(request as NodeIncomingMessageLike, response);
  });
  socketCount += 1;
  const path = join(tmpdir(), `tabdock-stall-${String(process.pid)}-${String(socketCount)}.sock`);
  await new Promise<void>((resolve) => server.listen(path, resolve));
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
  client.write('GET /mcp HTTP/1.1\r\nHost: relay.invalid\r\nConnection: close\r\n\r\n');
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
    outcome,
    ended,
    read: () => read,
    close: async () => {
      clearInterval(timer);
      client.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe.skipIf(process.platform === 'win32')(
  'on a real socket, written as relay.ts writes it (ADR 0032)',
  () => {
    function realStalls(): { stalls: ResponseStalls; lines: Record<string, unknown>[] } {
      const lines: Record<string, unknown>[] = [];
      const log = createLogger({
        sink: (line) => {
          lines.push(JSON.parse(line) as Record<string, unknown>);
        },
      });
      const stalls = new ResponseStalls({
        lines: createRepeatedLog(log, 60_000),
        checkMs: REAL_CHECK_MS,
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
});
