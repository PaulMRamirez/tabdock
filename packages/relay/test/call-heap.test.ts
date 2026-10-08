// What requests waiting on a page hold, against the heap they stand for (S9,
// ADR 0018's notes). A call keeps its body and what was parsed from it until
// its page answers, and the request budget alone let one member hold 237 MiB
// with 120 calls of 1 MB, which crashed a relay under the image's 192 MiB
// heap. First, for every body shape that holds the most per byte, on both MCP
// legs, the relay charges a waiting call at least the heap it really holds,
// measured in a process that can collect garbage on demand. Then main.ts,
// started as the image starts it (hosted mode, the Dockerfile's own heap cap,
// every limit at its default) with every page slot filled to the tool
// budget, takes members' calls of those shapes on a page that reads every
// invoke and answers none: it must refuse those past what waiting requests
// may hold, and go on serving, rather than run out of heap.

import { type ChildProcess, fork } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Client,
  type FetchLike,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { encodeFrame, SUBPROTOCOL } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HOSTED_LIMITS } from '../src/index.ts';
import { requestHeapBytes } from '../src/request-heap.ts';
import { CALL_SHAPES, type CallShapeName, SEARCH, shapedFetch } from './helpers/call-shapes.ts';
import { type FillOutcome, fillPage, imageHeapFlag } from './helpers/hosted-heap.ts';
import { type MainProcess, startMain } from './helpers/main-process.ts';
import { HEAP_SHAPES } from './helpers/tool-shapes.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, rawRequest, tunnelFetch } from './helpers/tunnel.ts';

const PROBE = resolve(import.meta.dirname, 'fixtures/call-heap-probe.ts');
const PROBE_TOKEN = 'call-heap-probe-token-5d1e8b3a7c2f4096';
/** Waiting calls measured per shape and leg, after one that warms the relay up. */
const COUNT = 8;
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).host;
const PAGE_ORIGIN = 'https://demo.callheap.test';

const children: ChildProcess[] = [];
const clients: Client[] = [];
const sockets: WebSocket[] = [];
const scratches: string[] = [];
let main: MainProcess | undefined;
let provider: TestProvider | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const socket of sockets.splice(0)) socket.terminate();
  main?.child.kill('SIGKILL');
  main = undefined;
  await provider?.stop();
  provider = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface ProbeReport {
  heapUsed: number;
  /** Invokes the page had received before the first collection. */
  invokes: number;
  /** Calls the relay had ended by the last reading of the heap. */
  ended: number;
}

/** One run of the probe relay: the heap each waiting call of a shape holds, and what the relay charged it. */
async function probe(
  shape: CallShapeName,
  modern: boolean,
): Promise<{ heapPerCall: number; chargedPerCall: number }> {
  const child = fork(PROBE, [], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  children.push(child);
  let waiting: ((report: ProbeReport) => void) | null = null;
  child.on('message', (report: ProbeReport) => {
    waiting?.(report);
  });
  const report = (): Promise<ProbeReport> =>
    new Promise((resolveReport) => {
      waiting = resolveReport;
      child.send('measure');
    });
  const [mcpUrl = '', pageId = '', code = ''] = await new Promise<string[]>((resolveLine) => {
    child.stdout?.once('data', (chunk: Buffer) => {
      resolveLine(chunk.toString('utf8').trim().split(' '));
    });
  });
  let charged = 0;
  const client = new Client(
    { name: 'call-heap', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${PROBE_TOKEN}` } },
      fetch: shapedFetch(
        shape,
        () => pageId,
        fetch,
        (body) => {
          charged = requestHeapBytes(new TextEncoder().encode(body));
        },
      ),
    }),
  );
  clients.push(client);
  const paired = await client.callTool({ name: 'pair_page', arguments: { code } });
  expect(paired.isError ?? false).toBe(false);
  /**
   * Sends calls that wait for good, and returns the first measure begun once
   * the page had received `total` invokes, so that every reading in it found
   * all of them waiting.
   */
  const waitingCalls = async (count: number, total: number): Promise<ProbeReport> => {
    for (let n = 0; n < count; n += 1) {
      void client
        .callTool(
          { name: 'call_page_tool', arguments: { page: pageId, tool: 'search' } },
          { timeout: 600_000 },
        )
        .catch(() => undefined);
    }
    for (;;) {
      const now = await report();
      if (now.invokes >= total) {
        expect(now.ended, 'a call stopped waiting while its heap was measured').toBe(0);
        return now;
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    }
  };
  // One call first, so what every call costs once (code, maps, caches) is in the baseline.
  const before = await waitingCalls(1, 1);
  const after = await waitingCalls(COUNT, 1 + COUNT);
  await client.close();
  child.kill('SIGKILL');
  return {
    heapPerCall: Math.round((after.heapUsed - before.heapUsed) / COUNT),
    chargedPerCall: charged,
  };
}

describe('what requests waiting on a page hold, and the heap (S9, ADR 0018 notes)', () => {
  const cases = (Object.keys(CALL_SHAPES) as CallShapeName[]).flatMap((shape) => [
    [shape, 'legacy'] as const,
    [shape, 'modern'] as const,
  ]);

  it.each(cases)(
    'charges a waiting call of %s on the %s leg at least the heap it holds',
    async (shape, leg) => {
      const { heapPerCall, chargedPerCall } = await probe(shape, leg === 'modern');
      const report = JSON.stringify({ shape, leg, heapPerCall, chargedPerCall });
      expect(heapPerCall, report).toBeGreaterThan(0);
      expect(chargedPerCall, report).toBeGreaterThan(heapPerCall);
    },
    120_000,
  );
});

/**
 * A page through the stand-in edge that lists SEARCH, approves every attach
 * request as a driver, reads every invoke and answers none, so each call
 * waits; it keeps no frame, only the newest pairing code and a count.
 */
async function holdingPage(
  port: number,
  address: string,
): Promise<{ pageId: string; code: () => string; invokes: () => number }> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/page`, [SUBPROTOCOL], {
    origin: PAGE_ORIGIN,
    headers: { Host: PUBLIC_HOST, 'Fly-Client-IP': address },
  });
  sockets.push(ws);
  let code = '';
  let invokes = 0;
  const welcomed = new Promise<string>((resolveWelcome) => {
    ws.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      if (text.startsWith('{"t":"invoke"')) {
        invokes += 1;
        return;
      }
      const frame = JSON.parse(text) as {
        t: string;
        pageId?: string;
        code?: string;
        requestId?: string;
        pairing?: { code: string };
      };
      if (frame.t === 'welcome' && frame.pageId !== undefined && frame.pairing !== undefined) {
        code = frame.pairing.code;
        resolveWelcome(frame.pageId);
      }
      if (frame.t === 'pairing' && frame.code !== undefined) code = frame.code;
      if (frame.t === 'ping') ws.send(encodeFrame({ t: 'pong' }));
      if (frame.t === 'attach_request' && frame.requestId !== undefined) {
        ws.send(
          encodeFrame({
            t: 'attach_decision',
            requestId: frame.requestId,
            allow: true,
            role: 'driver',
          }),
        );
      }
    });
  });
  await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => {
      resolveOpen();
    });
    ws.once('error', reject);
  });
  ws.send(
    encodeFrame({
      t: 'hello',
      v: 1,
      title: 'Holding page',
      url: `${PAGE_ORIGIN}/`,
      adapterVersion: 'test',
      policy: {},
    }),
  );
  const pageId = await welcomed;
  ws.send(encodeFrame({ t: 'tools', tools: [SEARCH] }));
  return { pageId, code: () => code, invokes: () => invokes };
}

/** One member's client through the stand-in edge, its calls shaped. */
async function member(
  port: number,
  token: string,
  shape: CallShapeName,
  pageId: string,
  modern: boolean,
): Promise<Client> {
  const tunnel = tunnelFetch(`http://127.0.0.1:${String(port)}`);
  // The edge names the client on every request; the tunnel already sets the public Host.
  const edge: FetchLike = (input, init) =>
    tunnel(input, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init?.headers).entries()),
        'fly-client-ip': '198.51.100.200',
      },
    });
  const client = new Client(
    { name: 'call-heap', version: '1.0.0' },
    modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: shapedFetch(shape, () => pageId, edge),
    }),
  );
  clients.push(client);
  return client;
}

/** What became of one call so far: still waiting on the page, or its answer's text. */
interface Sent {
  member: number;
  outcome: string | null;
}

describe('the image relay with waiting calls and every page slot filled (S9, ADR 0018 notes)', () => {
  it('refuses calls past what waiting requests may hold, and keeps serving under the image heap cap', async () => {
    provider = await startProvider();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-call-heap-')));
    scratches.push(scratch);
    const members = [0, 1, 2, 3];
    main = startMain(
      {
        NODE_ENV: 'production',
        TABDOCK_ENV: 'production',
        TABDOCK_HOST: '0.0.0.0',
        TABDOCK_PUBLIC_URL: PUBLIC_ORIGIN,
        TABDOCK_OAUTH_ISSUER: provider.issuer,
        TABDOCK_OAUTH_USERS: members.map((n) => `sub-m${String(n)}=m${String(n)}:M`).join(','),
        TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
        TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
        TABDOCK_ALLOWED_ORIGINS: PAGE_ORIGIN,
        TABDOCK_CLIENT_ADDRESS_HEADER: 'fly-client-ip',
        // The stand-in edge is this machine.
        TABDOCK_TRUSTED_PROXY_CIDR: '127.0.0.1/32',
        TABDOCK_AUDIT_DIR: join(scratch, 'audit'),
      },
      [imageHeapFlag()],
    );
    const running = main;
    const port = await running.port;
    const page = await holdingPage(port, '198.51.100.250');
    // Every other slot filled to the tool budget, with the shapes that hold the most.
    const target = { port, publicHost: PUBLIC_HOST, origin: PAGE_ORIGIN };
    const frames = {
      nodes: [0, 1].map(() => encodeFrame({ t: 'tools', tools: HEAP_SHAPES.relisted() })),
      text: [encodeFrame({ t: 'tools', tools: HEAP_SHAPES.twoByteText() })],
    };
    const slots = (HOSTED_LIMITS.pageSessions ?? 0) - 1;
    const perAddress = HOSTED_LIMITS.pageSessionsPerAddress ?? 1;
    const filled: FillOutcome[] = [];
    for (let first = 0; first < slots; first += 20) {
      filled.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(20, slots - first) }, (_, offset) => {
            const slot = first + offset;
            const address = `198.51.100.${String(Math.floor(slot / perAddress) + 1)}`;
            return fillPage(target, address, slot % 2 === 0 ? frames.nodes : frames.text, sockets);
          }),
        )),
      );
    }
    expect(filled.filter((outcome) => outcome === 1008).length, running.output()).toBeGreaterThan(
      0,
    );

    // Member 0 sends what crashed the image's relay: 1 MB strings, 20 ms apart,
    // within a minute's call budget. Members 1 to 3 then send bodies of spaces
    // to the cap, the shape that holds the most of its charge, one on the
    // 2026-07-28 leg, until the relay's total is spent.
    const shapes: CallShapeName[] = ['text', 'spaces', 'spaces', 'spaces'];
    const connected: Client[] = [];
    for (const n of members) {
      const token = await provider.token({ sub: `sub-m${String(n)}`, aud: PUBLIC_MCP_URL });
      const client = await member(port, token, shapes[n] ?? 'tiny', page.pageId, n === 2);
      const paired = await client.callTool({ name: 'pair_page', arguments: { code: page.code() } });
      expect(paired.isError ?? false, JSON.stringify(paired.content)).toBe(false);
      connected.push(client);
    }
    const sent: Sent[] = [];
    const send = (n: number): void => {
      const entry: Sent = { member: n, outcome: null };
      sent.push(entry);
      void connected[n]
        ?.callTool(
          { name: 'call_page_tool', arguments: { page: page.pageId, tool: SEARCH.name } },
          { timeout: 600_000 },
        )
        .then(
          (result) => {
            entry.outcome = result.content
              .map((block) => (block.type === 'text' ? block.text : ''))
              .join('');
          },
          (error: unknown) => {
            entry.outcome = `rejected: ${String(error)}`;
          },
        );
    };
    const pause = (ms: number): Promise<void> =>
      new Promise((resolvePause) => setTimeout(resolvePause, ms));
    for (let n = 0; n < 120 && running.child.exitCode === null; n += 1) {
      send(0);
      await pause(20);
    }
    for (let round = 0; round < 15 && running.child.exitCode === null; round += 1) {
      for (const n of [1, 2, 3]) {
        send(n);
        await pause(20);
      }
    }
    // Every call has either been refused or reached the page by now.
    const deadline = Date.now() + 20_000;
    const waiting = (): Sent[] => sent.filter((entry) => entry.outcome === null);
    while (
      waiting().length !== page.invokes() &&
      running.child.exitCode === null &&
      Date.now() < deadline
    ) {
      await pause(50);
    }
    const refused = (pattern: RegExp, n?: number): number =>
      sent.filter(
        (entry) =>
          (n === undefined || entry.member === n) &&
          entry.outcome !== null &&
          pattern.test(entry.outcome),
      ).length;
    const report = (): string =>
      `${JSON.stringify({
        sent: sent.length,
        waiting: waiting().length,
        invokes: page.invokes(),
        rateLimited: refused(/^rate_limited:/),
        busy: refused(/^page_busy:/),
        other: sent
          .map((entry) => entry.outcome)
          .filter((outcome) => outcome !== null && !/^(rate_limited|page_busy):/.test(outcome))
          .slice(0, 5),
      })}\n${running
        .output()
        .split('\n')
        .filter((line) => !line.includes('"msg":"page connected"'))
        .slice(-30)
        .join('\n')}`;
    // Still running: a relay out of heap aborts, and V8's last words are in the report.
    expect({ code: running.child.exitCode, signal: running.child.signalCode }, report()).toEqual({
      code: null,
      signal: null,
    });
    expect(sent, report()).toHaveLength(120 + 45);
    // Calls of each member wait on the page, the rest of member 0's are refused for its
    // share, and once the total is spent the others' are refused for it.
    for (const n of members) {
      expect(
        sent.filter((entry) => entry.member === n && entry.outcome === null).length,
        report(),
      ).toBeGreaterThan(0);
    }
    expect(refused(/^rate_limited: your requests waiting on pages/, 0), report()).toBeGreaterThan(
      100,
    );
    expect(refused(/^page_busy: requests waiting on pages hold/), report()).toBeGreaterThan(0);
    expect(waiting().length + refused(/^(rate_limited|page_busy):/), report()).toBe(sent.length);
    expect(page.invokes(), report()).toBe(waiting().length);
    expect(running.output()).not.toMatch(/heap out of memory|FATAL ERROR/);
    expect((await rawRequest(`http://127.0.0.1:${String(port)}`, '/healthz')).status).toBe(200);
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    for (const socket of sockets.splice(0)) socket.terminate();
    running.child.kill('SIGTERM');
    expect(await running.exited, report()).toEqual({ code: 0, signal: null });
    main = undefined;
  }, 180_000);
});
