// The tool list budget against the heap it stands for (S9, ADR 0018). A page
// needs no account to list tools, so the budget, not a frame's size, is what
// keeps pages from filling the heap: a small frame of empty objects holds
// twenty times its size in the copies the relay keeps. First, for every shape
// of tools that holds the most per byte or per tool, the relay charges a page
// at least the heap its tools really hold, measured in a process that can
// collect garbage on demand. Then main.ts, started as the image starts it
// (hosted mode, the Dockerfile's own heap cap, every limit at its hosted
// default), has every page slot filled from many client addresses with those
// shapes: it must refuse the frames past its budget with 1008, and go on
// serving, rather than run out of heap.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeFrame, SUBPROTOCOL } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { HOSTED_LIMITS } from '../src/index.ts';
import { type MainProcess, startMain } from './helpers/main-process.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { rawRequest } from './helpers/tunnel.ts';
import { framesFor, HEAP_SHAPES, type HeapShape } from './helpers/tool-shapes.ts';

const PROBE = resolve(import.meta.dirname, 'fixtures/tool-heap-probe.ts');
const DOCKERFILE = resolve(import.meta.dirname, '../../../Dockerfile');
const PUBLIC_HOST = 'relay.heap.test';
const PAGE_ORIGIN = 'https://demo.heap.test';

let main: MainProcess | undefined;
let provider: TestProvider | undefined;
const scratches: string[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  main?.child.kill('SIGKILL');
  main = undefined;
  await provider?.stop();
  provider = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One run of the probe fixture: the heap a shape's tools hold per page, and what the relay charged. */
function probe(shape: HeapShape): Promise<{ heapPerPage: number; chargedPerPage: number }> {
  return new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', PROBE, shape, '10'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.once('exit', (code) => {
      const line = out.split('\n').find((text) => text.startsWith('{"shape"'));
      if (code !== 0 || line === undefined) reject(new Error(`probe ${shape} failed:\n${out}`));
      else resolveProbe(JSON.parse(line) as { heapPerPage: number; chargedPerPage: number });
    });
  });
}

/** The heap flag the image starts node with, read from the Dockerfile's CMD. */
function imageHeapFlag(): string {
  const cmd = readFileSync(DOCKERFILE, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('CMD '));
  const flag = (JSON.parse(cmd?.slice(4) ?? '[]') as string[]).find((arg) =>
    arg.startsWith('--max-old-space-size='),
  );
  if (flag === undefined) throw new Error('the Dockerfile CMD sets no --max-old-space-size');
  return flag;
}

/** What a page got: its tools listed, a close code, or no answer at all from a relay that is gone. */
type Outcome = 'listed' | 'unreachable' | number;

/**
 * A page through the stand-in edge: hello, then its tools frames, then a ping.
 * 'listed' when the pong comes back, so the relay took every frame; otherwise
 * the close code it was refused with.
 */
async function fillPage(
  port: number,
  address: string,
  frames: readonly string[],
): Promise<Outcome> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/page`, [SUBPROTOCOL], {
    origin: PAGE_ORIGIN,
    headers: { Host: PUBLIC_HOST, 'Fly-Client-IP': address },
  });
  sockets.push(ws);
  const closed = new Promise<number>((resolveClose) => {
    ws.once('close', (code) => {
      resolveClose(code);
    });
  });
  const opened = await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => {
      resolveOpen();
    });
    ws.once('error', reject);
  }).catch(() => 'unreachable' as const);
  if (opened === 'unreachable') return opened;
  const ponged = new Promise<'listed'>((resolvePong) => {
    ws.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      if (text.includes('"t":"ping"')) ws.send(encodeFrame({ t: 'pong' }));
      if (text.includes('"t":"pong"')) resolvePong('listed');
    });
  });
  ws.send(
    encodeFrame({
      t: 'hello',
      v: 1,
      title: 'Heap test',
      url: `${PAGE_ORIGIN}/`,
      adapterVersion: 'test',
      policy: {},
    }),
  );
  for (const frame of frames) ws.send(frame);
  ws.send(encodeFrame({ t: 'ping' }));
  return Promise.race([ponged, closed]);
}

describe('the tool list budget and the heap (S9, ADR 0018)', () => {
  it('charges a page at least the heap its tools hold, whatever their shape', async () => {
    const shapes = Object.keys(HEAP_SHAPES) as HeapShape[];
    const measured = await Promise.all(shapes.map((shape) => probe(shape)));
    for (const [index, shape] of shapes.entries()) {
      const { heapPerPage, chargedPerPage } = measured[index] ?? {
        heapPerPage: 0,
        chargedPerPage: 0,
      };
      expect(heapPerPage, shape).toBeGreaterThan(0);
      expect(chargedPerPage, `${shape}: ${String(heapPerPage)} held`).toBeGreaterThan(heapPerPage);
    }
  }, 60_000);

  it('refuses tools past the budget, and keeps serving, with every hosted page slot filled under the image heap cap', async () => {
    provider = await startProvider();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-tool-heap-')));
    scratches.push(scratch);
    main = startMain(
      {
        NODE_ENV: 'production',
        TABDOCK_ENV: 'production',
        TABDOCK_HOST: '0.0.0.0',
        TABDOCK_PUBLIC_URL: `https://${PUBLIC_HOST}`,
        TABDOCK_OAUTH_ISSUER: provider.issuer,
        TABDOCK_OAUTH_USERS: 'sub-heap=heap:Heap',
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
    const port = await main.port;
    const running = main;
    // Node-dense pages (twice listed, so each holds more than one frame's walk)
    // and two-byte text pages, the shapes that hold the most per byte and per tool.
    const nodeDense = framesFor('relisted');
    const frames = {
      nodes: Array.from({ length: nodeDense }, () =>
        encodeFrame({ t: 'tools', tools: HEAP_SHAPES.relisted() }),
      ),
      text: [encodeFrame({ t: 'tools', tools: HEAP_SHAPES.twoByteText() })],
    };
    const slots = HOSTED_LIMITS.pageSessions ?? 0;
    const perAddress = HOSTED_LIMITS.pageSessionsPerAddress ?? 1;
    const outcomes: Outcome[] = [];
    for (let first = 0; first < slots; first += 20) {
      outcomes.push(
        ...(await Promise.all(
          Array.from({ length: Math.min(20, slots - first) }, (_, offset) => {
            const slot = first + offset;
            const address = `198.51.100.${String(Math.floor(slot / perAddress) + 1)}`;
            return fillPage(port, address, slot % 2 === 0 ? frames.nodes : frames.text);
          }),
        )),
      );
    }
    const report = (): string =>
      `${JSON.stringify({
        listed: outcomes.filter((outcome) => outcome === 'listed').length,
        closes: outcomes.filter((outcome) => outcome !== 'listed'),
      })}\n${running
        .output()
        .split('\n')
        .filter((line) => !line.includes('"msg":"page connected"'))
        .slice(-40)
        .join('\n')}`;
    // Still running: a relay out of heap aborts, and V8's last words are in the report.
    expect({ code: running.child.exitCode, signal: running.child.signalCode }, report()).toEqual({
      code: null,
      signal: null,
    });
    expect(outcomes, report()).toHaveLength(slots);
    // Some fit, the rest were refused for the budget, and nothing else happened.
    expect(outcomes.filter((outcome) => outcome === 'listed').length, report()).toBeGreaterThan(0);
    expect(outcomes.filter((outcome) => outcome === 1008).length, report()).toBeGreaterThan(0);
    expect(
      outcomes.every((outcome) => outcome === 'listed' || outcome === 1008),
      report(),
    ).toBe(true);
    expect(running.output()).toContain('its tools would pass what all pages may hold');
    expect(running.output()).not.toMatch(/heap out of memory|FATAL ERROR/);
    expect((await rawRequest(`http://127.0.0.1:${String(port)}`, '/healthz')).status).toBe(200);
    for (const socket of sockets.splice(0)) socket.terminate();
    running.child.kill('SIGTERM');
    expect(await running.exited, report()).toEqual({ code: 0, signal: null });
    main = undefined;
  }, 90_000);
});
