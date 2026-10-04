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

import { type ChildProcess, fork } from 'node:child_process';
import { resolve } from 'node:path';
import { encodeFrame, type PageFrameInput, SUBPROTOCOL } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PAGE_ORIGIN } from './helpers/page-client.ts';

const RELAY = resolve(import.meta.dirname, 'fixtures/page-flood-relay.ts');
const MIB = 1024 * 1024;
/** Frames each flood sends at most; the page stops sooner if it sees the relay cut it off. */
const FLOOD = 1_000_000;

interface Report {
  heapUsed: number;
  arrayBuffers: number;
  rss: number;
  closes: string[];
  lines: number;
}

let child: ChildProcess | undefined;
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  child?.kill('SIGKILL');
  child = undefined;
});

interface Fixture {
  url: string;
  /** Its memory after collecting garbage, and the closes it logged since the last report. */
  report: () => Promise<Report>;
  /** Whether it has closed a page socket yet. */
  closed: () => boolean;
}

/** The fixture relay in its own process. */
async function startRelay(): Promise<Fixture> {
  const started = fork(RELAY, [], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  child = started;
  let closed = false;
  let waiting: ((report: Report) => void) | null = null;
  started.on('message', (message: Report | { closing: string }) => {
    if ('closing' in message) closed = true;
    else waiting?.(message);
  });
  const url = await new Promise<string>((resolveUrl, reject) => {
    started.stdout?.once('data', (chunk: Buffer) => {
      resolveUrl(chunk.toString('utf8').trim());
    });
    started.once('exit', (code) => {
      reject(new Error(`the fixture relay exited with ${String(code)}`));
    });
  });
  const report = (): Promise<Report> =>
    new Promise((resolveReport) => {
      waiting = resolveReport;
      started.send('measure');
    });
  return { url, report, closed: () => closed };
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
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => {
      resolveOpen();
    });
    ws.once('unexpected-response', () => {
      reject(new Error('upgrade refused'));
    });
  });
  const welcomed = new Promise<void>((resolveWelcome) => {
    ws.once('message', () => {
      resolveWelcome();
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
 * Sends a frame up to FLOOD times, never holding more than a little of it in
 * this process, and stops once the relay has closed the socket; how many
 * went out. A page that went on would only be cut off a moment later.
 */
async function flood(ws: WebSocket, sendOne: () => void, relay: Fixture): Promise<number> {
  let sent = 0;
  const going = (): boolean => sent < FLOOD && ws.readyState === WebSocket.OPEN && !relay.closed();
  while (going()) {
    while (ws.bufferedAmount < MIB && going()) {
      sendOne();
      sent += 1;
    }
    await new Promise((resolveTick) => setImmediate(resolveTick));
  }
  return sent;
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
