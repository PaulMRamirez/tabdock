// An /mcp response a client leaves unread (S9, ADR 0030). Node's server
// timeout is 0 and the MCP Node adapter waits for 'drain' without limit, so a
// client that stopped reading held its response for good. The check runs
// first against stand-in responses under fake timers: on loopback the
// kernel absorbed about 3.5 MiB, more than any one result, so a real socket
// shows nothing waiting. Then its wiring in relay.ts, with one marked
// request's response made to report bytes waiting.

import { EventEmitter } from 'node:events';
import { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevTokenAuth } from '../src/index.ts';
import { createLogger } from '../src/log.ts';
import { createRepeatedLog } from '../src/repeated-lines.ts';
import {
  RESPONSE_CHECK_MS,
  RESPONSE_CUT_LINE,
  RESPONSE_STALL_CHECKS,
  ResponseStalls,
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

/** A response whose queue the test sets, as a client reading or not would leave it. */
class StandIn extends EventEmitter {
  writableLength = 0;
  destroyed = false;

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

describe('the check (ADR 0030)', () => {
  it('cuts off a response whose queue stops moving, 30 to 40 s after it stopped, with one line naming the user', () => {
    const { stalls, lines, close } = watch();
    const response = new StandIn();
    stalls.track(response, 'alice');
    // It stops moving just after a check: the next check notes it.
    vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    response.writableLength = 262_153;
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

  it('never cuts off a client that keeps reading, however slowly, or one whose queue empties', () => {
    const { stalls, close } = watch();
    const slow = new StandIn();
    const bursty = new StandIn();
    stalls.track(slow, 'alice');
    stalls.track(bursty, 'bob');
    slow.writableLength = 1_000_000;
    for (let check = 0; check < 60; check += 1) {
      // Ten minutes of checks: the slow reader takes a byte between each.
      slow.writableLength -= 1;
      // The other waits two checks, then reads all, and stalls again.
      bursty.writableLength = check % 3 === 2 ? 0 : 5000;
      vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    }
    expect(slow.destroyed).toBe(false);
    expect(bursty.destroyed).toBe(false);
    close();
  });

  it('counts a queue that grows, as a held stream whose keep-alives nobody reads', () => {
    const { stalls, close } = watch();
    const response = new StandIn();
    stalls.track(response, 'alice');
    for (let check = 1; check <= RESPONSE_STALL_CHECKS + 1; check += 1) {
      response.writableLength += 13;
      vi.advanceTimersByTime(RESPONSE_CHECK_MS);
    }
    expect(response.destroyed).toBe(true);
    close();
  });

  it('forgets a response once it finishes or closes, and stops checking when none is left', () => {
    const { stalls, close } = watch();
    const finished = new StandIn();
    const closed = new StandIn();
    stalls.track(finished, 'alice');
    stalls.track(closed, 'alice');
    finished.writableLength = 100;
    closed.writableLength = 100;
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
      response.writableLength = 1000;
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

/**
 * Makes the response to every request carrying the stall header report bytes
 * waiting that never shrink, as one whose client stopped reading would; every
 * other response reports what it really holds.
 */
function stallMarked(): void {
  const real = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(ServerResponse.prototype) as object,
    'writableLength',
  );
  Object.defineProperty(ServerResponse.prototype, 'writableLength', {
    configurable: true,
    get(this: ServerResponse): number {
      if (this.req.headers['x-test-stall'] === '1') return 4096;
      return (real?.get?.call(this) as number | undefined) ?? 0;
    },
  });
  restore = () => {
    Reflect.deleteProperty(ServerResponse.prototype, 'writableLength');
  };
}

describe('the cut-off on /mcp (ADR 0030)', () => {
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
