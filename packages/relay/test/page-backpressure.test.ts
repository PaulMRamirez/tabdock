// What a page that stops reading costs the relay (S9, ADR 0024). /page takes
// no credential, and the relay answers some frames with frames of its own: a
// ping with a pong, a revoke or an invite frame with a roster and the page's
// invites, rotate_pairing with a pairing, and ws answered every WebSocket
// ping control frame with a pong by itself. A socket that paused its own
// reading while it flooded such frames left every answer queued in the
// relay's memory: a million pings held 80 to 140 MiB of heap, a million
// revokes of everyone about 360 MiB, and a million WebSocket pings 275 MiB
// and 125 MiB of buffers, past a 512 MB host from one socket and no account.
// Now what the relay has queued for a page past what the kernel took is
// capped, and past the cap the socket is closed with 1008 and cut off soon
// after. hub.test.ts pins the cap's edges exactly.
//
// Calls are held to the same bound without closing anything (ADR 0024's
// notes). Their invokes went out with no check at all: a page that stopped
// reading held every one a member sent it, 56 MiB for 60 calls of 1 MB, and a
// page that read everything over a phone's link was closed as not reading by
// the next small frame once a burst of large invokes filled its queue, which
// let an observer end the operator's page. Now an invoke that would fill the
// queue waits for room, and only frames the page itself is not taking count
// toward closing it.

import { type ChildProcess, fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  encodeFrame,
  IDLE_TIMEOUT_MS,
  type PageFrameInput,
  type PageTool,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MAX_UNREAD_BYTES } from '../src/hub.ts';
import type { RelayOptions } from '../src/index.ts';
import { connectPage, PAGE_ORIGIN, type TestPage } from './helpers/page-client.ts';
import { pairAndApprove } from './helpers/relay.ts';

const RELAY = resolve(import.meta.dirname, 'fixtures/page-flood-relay.ts');
const MIB = 1024 * 1024;
/**
 * How long a page floods before it stops waiting for the relay to close it.
 * The kernel's socket buffers take a page's unread answers before any reach
 * the relay's own queue, and Linux packs small segments together, so they
 * take more answers than their nominal size: a ping flood here was closed
 * once the relay had sent 316,000 to 681,000 pongs, as tcp_rmem's ceiling
 * and the timing allowed, and a host tuned for bulk transfer holds more.
 * Capped at a million frames, a ping flood ended in up to 7 runs of 25 here
 * with about half a million pings still in kernel buffers on their way in,
 * before the relay had answered enough to fill the way out, and the case
 * saw no close.
 * The relay closes within seconds of the buffers filling, so this bounds
 * only a relay that never closes, the failure this file is for.
 */
const FLOOD_MS = 60_000;
/**
 * Frames a flood sends before it lets this process's event loop turn. The
 * relay's close reaches the flood only as events (the fixture's IPC line,
 * the socket's close or error), which a run of sends never lets in, and
 * bufferedAmount stays under MIB for as long as the relay reads as fast as
 * the page writes: always once it has closed the socket, since it then
 * discards what follows, and whenever load gives it more of the CPU than
 * this process. Such a run went on to the million frames a flood was then
 * capped at. Each ws.send corks and uncorks the socket and so schedules a
 * callback of its own, about 1.2 KiB held until the run yields, and once
 * the relay cuts the socket off every send fails into the same queue
 * without ever filling bufferedAmount. Beside two full suites a flood of
 * invite_cancel sent all its million frames in one run of 45 s, the relay
 * having closed after 93,000, and on a busier machine one took 138 s and
 * failed on the 120 s timeout. Yielding every BATCH frames, a flood sees
 * the close within a batch of its arrival and holds about a megabyte at a
 * time: against a reader that reset the socket it sent under 300 frames
 * past the reset, where one run sent 930,000 and held 1.1 GiB.
 */
const BATCH = 1000;
/**
 * How long a flood waits with its queue full and no close before it fails.
 * A relay that runs either reads what the page sends, which drains
 * bufferedAmount and lets the flood go on, or reads nothing and so closes
 * the page as silent IDLE_TIMEOUT_MS after the last frame it read. A flood
 * stuck past that and a margin for load means the fixture relay's process
 * stopped running its loop. Once on CI a case waited out its whole 120 s
 * timeout and said nothing more, as one does here whose fixture is stopped
 * with SIGSTOP mid-flood; one whose fixture is killed also fails on its
 * closed IPC channel.
 */
const STALL_MS = IDLE_TIMEOUT_MS + 15_000;
/**
 * How long the fixture relay may take to print its URLs or answer a report,
 * about a second together beside a full suite, before the case fails saying
 * what its process was doing.
 */
const ANSWER_MS = 45_000;

interface Report {
  heapUsed: number;
  arrayBuffers: number;
  rss: number;
  closes: string[];
  lines: number;
  /** The most any page socket had queued past what the kernel took, since the last report. */
  maxQueued: number;
}

let child: ChildProcess | undefined;
const sockets: WebSocket[] = [];
const pages: TestPage[] = [];
const clients: Client[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const page of pages.splice(0)) page.ws.terminate();
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const server of servers.splice(0)) server.close();
  child?.kill('SIGKILL');
  child = undefined;
});

interface Fixture {
  url: string;
  mcpUrl: string;
  /** Its memory after collecting garbage, and the closes it logged since the last report. */
  report: () => Promise<Report>;
  /** Whether it has closed a page socket yet. */
  closed: () => boolean;
  /** How its process ended, or null while it runs. */
  ended: () => string | null;
  /** Its process's scheduler state and CPU time so far (processState). */
  state: () => string;
  /** Its last RECENT_LINES log messages, oldest first. */
  lines: () => readonly string[];
}

/** Log messages a fixture keeps for a failure to quote. */
const RECENT_LINES = 20;

/**
 * A process's scheduler state (R running, S sleeping, D waiting on a device,
 * T stopped, Z gone), the kernel function it sleeps in, and the CPU ticks it
 * has used, from /proc where there is one: two a second apart tell a relay
 * spinning on its main thread from one blocked in a call (a pipe write, say)
 * or idle in its event loop (ep_poll), which still runs its timers.
 */
function processState(pid: number | undefined): string {
  if (pid === undefined) return 'no pid';
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8');
    // The command name may hold spaces, so fields count from its closing parenthesis:
    // state first, then utime and stime twelfth and thirteenth.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    let wchan = '?';
    try {
      wchan = readFileSync(`/proc/${String(pid)}/wchan`, 'utf8') || '0';
    } catch {
      // Some kernels hide it; the state and ticks still say a good deal.
    }
    return `state ${fields[0] ?? '?'} in ${wchan}, ${String(Number(fields[11]) + Number(fields[12]))} CPU ticks`;
  } catch {
    return 'no /proc entry';
  }
}

/** /proc/net/tcp's states and timers, by their codes there. */
const TCP_STATES: Record<string, string> = {
  '01': 'ESTABLISHED',
  '04': 'FIN_WAIT1',
  '05': 'FIN_WAIT2',
  '06': 'TIME_WAIT',
  '07': 'CLOSE',
  '08': 'CLOSE_WAIT',
  '09': 'LAST_ACK',
  '0A': 'LISTEN',
  '0B': 'CLOSING',
};
const TCP_TIMERS = ['none', 'retransmit', 'keepalive', 'time-wait', 'zero-window probe'];

/**
 * The kernel's view of every TCP socket to or from this port, where /proc
 * shows one: each end's state, what sits unsent and unread in its queues, and
 * which timer runs. A page whose sends stop while the relay idles reads here
 * as either a relay that stopped reading (its receive queue full) or a
 * connection that stopped moving (a zero-window probe timer, both queues
 * waiting on the other end).
 */
function tcpState(port: number): string[] {
  let table: string;
  try {
    table = readFileSync('/proc/net/tcp', 'utf8');
  } catch {
    return ['no /proc/net/tcp'];
  }
  const portOf = (address: string): number => Number.parseInt(address.split(':')[1] ?? '', 16);
  return table
    .split('\n')
    .slice(1)
    .map((row) => row.trim().split(/\s+/))
    .filter(
      (fields) =>
        fields.length > 6 && (portOf(fields[1] ?? '') === port || portOf(fields[2] ?? '') === port),
    )
    .map((fields) => {
      const [txQueue = '0', rxQueue = '0'] = (fields[4] ?? '').split(':');
      const timer = TCP_TIMERS[Number.parseInt((fields[5] ?? '').split(':')[0] ?? '', 16)] ?? '?';
      return `${String(portOf(fields[1] ?? ''))}>${String(portOf(fields[2] ?? ''))} ${TCP_STATES[fields[3] ?? ''] ?? fields[3] ?? '?'} unsent ${String(Number.parseInt(txQueue, 16))} unread ${String(Number.parseInt(rxQueue, 16))} timer ${timer} retransmits ${String(Number.parseInt(fields[6] ?? '', 16))}`;
    });
}

/** The fixture relay in its own process, with these timings and limits. */
async function startRelay(
  options: Pick<RelayOptions, 'timings' | 'limits'> = {},
): Promise<Fixture> {
  const started = fork(RELAY, [], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
    env: { ...process.env, PAGE_FLOOD_OPTIONS: JSON.stringify(options) },
  });
  child = started;
  let closed = false;
  let ended: string | null = null;
  let waiting: { resolve: (report: Report) => void; reject: (error: Error) => void } | null = null;
  const recent: string[] = [];
  started.on('message', (message: Report | { closing: string } | { line: string }) => {
    if ('line' in message) {
      recent.push(message.line);
      if (recent.length > RECENT_LINES) recent.shift();
      return;
    }
    if ('closing' in message) {
      closed = true;
      return;
    }
    const answered = waiting;
    waiting = null;
    answered?.resolve(message);
  });
  // A report asked of a relay that has gone would otherwise wait out the case's timeout.
  started.once('exit', (code, signal) => {
    ended = signal === null ? `exited with ${String(code)}` : `was killed by ${signal}`;
    waiting?.reject(new Error(`the fixture relay ${ended} before it answered`));
    waiting = null;
  });
  /** The fixture's answer, or a failure naming its process's state once ANSWER_MS has passed. */
  const within = <T>(answer: Promise<T>, what: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `the fixture relay did not ${what} within ${String(ANSWER_MS)} ms: ${processState(started.pid)}`,
          ),
        );
      }, ANSWER_MS);
    });
    return Promise.race([answer, late]).finally(() => {
      clearTimeout(timer);
    });
  };
  const [url = '', mcpUrl = ''] = await within(
    new Promise<string[]>((resolveUrls, reject) => {
      started.stdout?.once('data', (chunk: Buffer) => {
        resolveUrls(chunk.toString('utf8').trim().split(' '));
      });
      started.once('exit', (code) => {
        reject(new Error(`the fixture relay exited with ${String(code)}`));
      });
    }),
    'print its URLs',
  );
  const report = (): Promise<Report> =>
    within(
      new Promise<Report>((resolveReport, reject) => {
        if (ended !== null) {
          reject(new Error(`the fixture relay ${ended}`));
          return;
        }
        waiting = { resolve: resolveReport, reject };
        started.send('measure');
      }),
      'answer a report',
    );
  return {
    url,
    mcpUrl,
    report,
    closed: () => closed,
    ended: () => ended,
    state: () => processState(started.pid),
    lines: () => [...recent],
  };
}

/** A page that says hello and takes its welcome, then, if deaf, stops reading anything the relay sends. */
async function openPage(
  url: string,
  deaf: boolean,
): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(url, [SUBPROTOCOL], { origin: PAGE_ORIGIN });
  sockets.push(ws);
  const closed = new Promise<number>((resolveClosed) => {
    ws.once('close', (code) => {
      resolveClosed(code);
    });
  });
  ws.on('error', () => {
    // A write after the relay cut the socket off; the close follows.
  });
  // A socket that cannot connect, or that the relay closes before its welcome,
  // only closes; without these the case would wait out its timeout.
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => {
      resolveOpen();
    });
    ws.once('unexpected-response', () => {
      reject(new Error('upgrade refused'));
    });
    void closed.then((code) => {
      reject(new Error(`the page socket closed with ${String(code)} before it opened`));
    });
  });
  const welcomed = new Promise<void>((resolveWelcome, reject) => {
    ws.once('message', () => {
      resolveWelcome();
    });
    void closed.then((code) => {
      reject(new Error(`the relay closed the page socket with ${String(code)} before its welcome`));
    });
  });
  ws.send(
    encodeFrame({
      t: 'hello',
      v: 1,
      title: 'Deaf page',
      url: `${PAGE_ORIGIN}/`,
      adapterVersion: 'test',
      policy: {},
    }),
  );
  await welcomed;
  if (deaf) ws.pause();
  return { ws, closed };
}

/**
 * Sends a frame until the relay has closed the socket or FLOOD_MS has
 * passed, never holding more than a little of it in this process; how many
 * went out. A page that went on would only be cut off a moment later. One
 * that can send nothing for STALL_MS and sees no close fails, saying what
 * the page and the relay's process were doing.
 */
async function flood(ws: WebSocket, sendOne: () => void, relay: Fixture): Promise<number> {
  let sent = 0;
  const started = performance.now();
  let lastSent = started;
  const going = (): boolean => ws.readyState === WebSocket.OPEN && !relay.closed();
  while (going()) {
    const now = performance.now();
    if (now - lastSent > STALL_MS) throw new Error(await stalled(ws, relay, sent));
    if (now - started > FLOOD_MS) break;
    const before = sent;
    for (let batch = 0; batch < BATCH && ws.bufferedAmount < MIB && going(); batch += 1) {
      sendOne();
      sent += 1;
    }
    if (sent > before) lastSent = performance.now();
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  return sent;
}

/**
 * Why a flood stopped going anywhere, as far as this process can see: the
 * page's queue and socket, the relay's process a second apart, the kernel's
 * view of the connection, and what the relay last logged, which names a close
 * that is not one for not reading (a silent page's, say).
 */
async function stalled(ws: WebSocket, relay: Fixture, sent: number): Promise<string> {
  const first = relay.state();
  await new Promise((resolveTick) => setTimeout(resolveTick, 1000));
  return `the flood could send nothing for ${String(STALL_MS)} ms and saw no close: ${JSON.stringify(
    {
      sent,
      bufferedAmount: ws.bufferedAmount,
      readyState: ws.readyState,
      relay: relay.ended() ?? 'running',
      // A second apart.
      relayProcess: [first, relay.state()],
      tcp: tcpState(Number(new URL(relay.url).port)),
      relayLines: relay.lines(),
    },
  )}`;
}

const PING_PAYLOAD = Buffer.alloc(125, 0x61);

/** Each frame the relay answers, and how a page sends it. */
const FLOODS: [string, (ws: WebSocket) => void][] = [
  ['ping', frameOf({ t: 'ping' })],
  ['revoke of everyone', frameOf({ t: 'revoke', userId: '*' })],
  ['invite_cancel for no invite', frameOf({ t: 'invite_cancel', inviteId: 'i_nothing' })],
  ['rotate_pairing', frameOf({ t: 'rotate_pairing' })],
  // The WebSocket control frame, which ws used to answer on its own, unbounded;
  // with the most payload a ping may carry, which its pong carries back.
  [
    'WebSocket ping',
    (ws) => {
      ws.ping(PING_PAYLOAD);
    },
  ],
];

function frameOf(frame: PageFrameInput): (ws: WebSocket) => void {
  const text = encodeFrame(frame);
  return (ws) => {
    ws.send(text);
  };
}

describe('a page that stops reading (S9, A4.3)', () => {
  it.each(FLOODS)(
    'closes a socket that floods %s without reading, and holds little memory for it',
    async (_name, sendOne) => {
      const relay = await startRelay();
      const base = await relay.report();
      const page = await openPage(relay.url, true);
      const sent = await flood(
        page.ws,
        () => {
          sendOne(page.ws);
        },
        relay,
      );
      // Measured before the page reads again, so nothing it would read is counted out.
      const after = await relay.report();
      const report = JSON.stringify({
        heapUsed: Math.round((after.heapUsed - base.heapUsed) / MIB),
        arrayBuffers: Math.round((after.arrayBuffers - base.arrayBuffers) / MIB),
        sent,
        closes: after.closes,
        lines: after.lines - base.lines,
      });
      // Before, the socket stayed open for all of them and the answers stayed queued.
      expect(after.closes, report).toEqual(['closing page socket: the page is not reading']);
      expect(
        after.heapUsed + after.arrayBuffers - base.heapUsed - base.arrayBuffers,
        report,
      ).toBeLessThan(16 * MIB);
      // A few lines for the whole flood, not one per frame.
      expect(after.lines - base.lines, report).toBeLessThan(40);
      page.ws.resume();
      expect(await page.closed).not.toBe(1000);
    },
    120_000,
  );

  it('never closes a page that reads, however fast it sends, and answers each WebSocket ping once', async () => {
    const relay = await startRelay();
    const page = await openPage(relay.url, false);
    let pongs = 0;
    let socketPongs = 0;
    page.ws.on('message', (data: Buffer) => {
      if ((JSON.parse(data.toString('utf8')) as { t: string }).t === 'pong') pongs += 1;
    });
    page.ws.on('pong', (data) => {
      expect(data.equals(PING_PAYLOAD)).toBe(true);
      socketPongs += 1;
    });
    const burst = 20_000;
    const ping = encodeFrame({ t: 'ping' });
    for (let i = 0; i < burst; i += 1) page.ws.send(ping);
    for (let i = 0; i < 1000; i += 1) page.ws.ping(PING_PAYLOAD);
    // The relay answers in order, so once this one's pong is back every pong before it is too.
    page.ws.send(ping);
    const deadline = Date.now() + 30_000;
    while (pongs < burst + 1 && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    }
    expect(pongs).toBe(burst + 1);
    expect(socketPongs).toBe(1000);
    expect((await relay.report()).closes).toEqual([]);
    expect(page.ws.readyState).toBe(WebSocket.OPEN);
  }, 60_000);
});

const SEARCH: PageTool = {
  name: 'search',
  description: 'Search the given text.',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  annotations: { readOnlyHint: true },
};
/** An argument as large as one invoke frame can carry. */
const LARGE = 'a'.repeat(1_000_000);
/**
 * Room for every call a test sends: what waiting requests may hold has its
 * own tests (request-bytes.test.ts, call-heap.test.ts), and these are about
 * the page link alone.
 */
const ROOM_FOR_CALLS = { requestBytes: 2 ** 40, requestBytesPerUser: 2 ** 40 };

async function member(relay: Fixture, token: string): Promise<Client> {
  const client = new Client({ name: 'backpressure', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(client);
  return client;
}

/** A call_page_tool call's answer: 'ok', or its error text. */
async function search(
  client: Client,
  pageId: string,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const result = await client.callTool(
      {
        name: 'call_page_tool',
        arguments: { page: pageId, tool: SEARCH.name, arguments: { text } },
      },
      { timeout: 120_000, ...(signal === undefined ? {} : { signal }) },
    );
    if (result.isError !== true) return 'ok';
    return result.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
  } catch (error) {
    return `rejected: ${String(error)}`;
  }
}

/**
 * A TCP proxy in front of the relay whose relay-to-page direction carries
 * `rate` bytes a second, like a phone's link; the page's port.
 */
async function slowLink(relayUrl: string, rate: number): Promise<number> {
  const target = new URL(relayUrl);
  const server = createServer((down: Socket) => {
    const up = connect(Number(target.port), target.hostname);
    down.pipe(up);
    up.on('data', (chunk: Buffer) => {
      up.pause();
      down.write(chunk);
      setTimeout(
        () => {
          up.resume();
        },
        (chunk.length / rate) * 1000,
      );
    });
    up.on('close', () => down.destroy());
    down.on('close', () => up.destroy());
    up.on('error', () => undefined);
    down.on('error', () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the proxy has no port');
  return address.port;
}

describe('calls to a page the relay cannot hand everything at once (S9, ADR 0024 notes)', () => {
  it('holds a burst of large invokes back from a page that stops reading, and never closes it for them', async () => {
    const relay = await startRelay({ timings: { callDeadlineMs: 8000 }, limits: ROOM_FOR_CALLS });
    const page = await connectPage(relay.url, { tools: [SEARCH] });
    pages.push(page);
    const alice = await member(relay, 'page-flood-alice-token-5e2b7c9d1a4f8036');
    await pairAndApprove(alice, page);
    page.ws.pause();
    await relay.report();
    const calls: Promise<string>[] = [];
    for (let n = 0; n < 30; n += 1) {
      calls.push(search(alice, page.pageId, LARGE));
      await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    }
    await new Promise((resolveTick) => setTimeout(resolveTick, 2000));
    const during = await relay.report();
    const outcomes = await Promise.all(calls);
    const report = JSON.stringify({
      maxQueuedMiB: +(during.maxQueued / MIB).toFixed(2),
      closes: during.closes,
      outcomes: outcomes.map((outcome) => outcome.slice(0, 80)),
    });
    // Before, every invoke went onto the socket: about 26 MiB queued for a page that read none.
    expect(during.maxQueued, report).toBeLessThanOrEqual(MAX_UNREAD_BYTES);
    expect(during.closes, report).toEqual([]);
    // The few that fit went out and found no answer; the rest never left the relay.
    for (const outcome of outcomes) expect(outcome, report).toMatch(/^timeout:/);
    expect(
      outcomes.filter((outcome) => outcome.includes('never reached it')).length,
      report,
    ).toBeGreaterThan(20);
    // The page still has its socket once it reads again.
    page.ws.resume();
    await page.sync();
    expect(page.ws.readyState, report).toBe(WebSocket.OPEN);
    expect((await relay.report()).closes, report).toEqual([]);
  }, 60_000);

  it('never closes a page that reads over a slow link, whoever fills its queue with large calls', async () => {
    const relay = await startRelay({
      // The relay's own heartbeat goes out while the burst is on its way, as a pong would.
      timings: { callDeadlineMs: 30_000, pingIntervalMs: 2000, idleTimeoutMs: 60_000 },
      limits: ROOM_FOR_CALLS,
    });
    const port = await slowLink(relay.url, 2 * MIB);
    let answered = 0;
    const page = await connectPage(`ws://127.0.0.1:${String(port)}/page`, {
      tools: [SEARCH],
      // A page that reads every frame and answers every call at once, but one of the operator's.
      onInvoke: (frame) => {
        answered += 1;
        if (frame.arguments.text === 'slow') {
          return new Promise((resolveSlow) => {
            setTimeout(() => {
              resolveSlow({ ok: true, content: 'found' });
            }, 3000);
          });
        }
        return { ok: true, content: 'found' };
      },
    });
    pages.push(page);
    // Alice drives the page; Bob is only an observer, and he sends the burst.
    const alice = await member(relay, 'page-flood-alice-token-5e2b7c9d1a4f8036');
    await pairAndApprove(alice, page);
    const bob = await member(relay, 'page-flood-bob-token-0c6f3a8e2d7b5149');
    await pairAndApprove(bob, page, 'observer');
    await relay.report();
    const own = search(alice, page.pageId, 'slow');
    const leaving = new AbortController();
    // Bob gives up on his fifth call a second in, while its invoke is most
    // likely on its way, so the relay tells the page to stop it.
    const GIVEN_UP = 4;
    const burst = Array.from({ length: 10 }, (_, n) =>
      search(bob, page.pageId, LARGE, n === GIVEN_UP ? leaving.signal : undefined),
    );
    await new Promise((resolveTick) => setTimeout(resolveTick, 1000));
    leaving.abort();
    const outcomes = await Promise.all(burst);
    const after = await relay.report();
    const report = JSON.stringify({
      own: (await own).slice(0, 80),
      answered,
      maxQueuedMiB: +(after.maxQueued / MIB).toFixed(2),
      closes: after.closes,
      outcomes: outcomes.map((outcome) => outcome.slice(0, 80)),
    });
    // Before, the cancel or the heartbeat found the queue past 2 MiB and closed the page,
    // failing Alice's call and most of Bob's with page_asleep.
    expect(after.closes, report).toEqual([]);
    expect(await own, report).toBe('ok');
    // The one he gave up on was answered first or ended for him; every other was answered.
    expect(
      outcomes.filter((_, n) => n !== GIVEN_UP),
      report,
    ).toEqual(Array.from({ length: 9 }, () => 'ok'));
    expect(outcomes[GIVEN_UP], report).toMatch(/^(ok|rejected: .*AbortError)/);
    expect(after.maxQueued, report).toBeLessThanOrEqual(MAX_UNREAD_BYTES);
    await page.sync();
    expect(page.ws.readyState, report).toBe(WebSocket.OPEN);
  }, 90_000);
});
