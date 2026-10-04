// What listen streams hold in memory (S9, A4.3 second pass). A stranger needs
// only a signed-up account to open a 2026-07-28 listen, and a stream lives as
// long as its client keeps it, so whatever a stream pins stays pinned. The
// relay read each listen's body through a clone and handed the SDK the parsed
// value, so nothing read the request's own copy, which kept the whole body
// queued for the stream's life beside the parsed one: fifty strangers, the
// invitee pool, pinned about 300 MiB of RSS on a 512 MB host with bodies
// padded to the 2 MiB cap. Now a listen's body is read once, and one over a
// few kB, far past any real listen, is refused before it opens anything.

import { type ChildProcess, fork } from 'node:child_process';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../src/index.ts';

const RELAY = resolve(import.meta.dirname, 'fixtures/listen-heap-relay.ts');
const MIB = 1024 * 1024;

interface Memory {
  heapUsed: number;
  arrayBuffers: number;
  rss: number;
}

let child: ChildProcess | undefined;
const aborts: AbortController[] = [];

afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  child?.kill('SIGKILL');
  child = undefined;
});

/** The fixture relay, its /mcp URL, and a way to read its memory after collecting garbage. */
async function startRelay(): Promise<{ url: string; memory: () => Promise<Memory> }> {
  const started = fork(RELAY, [], {
    execArgv: ['--expose-gc'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
  });
  child = started;
  const url = await new Promise<string>((resolveUrl, reject) => {
    started.stdout?.once('data', (chunk: Buffer) => {
      resolveUrl(chunk.toString('utf8').trim());
    });
    started.once('exit', (code) => {
      reject(new Error(`the fixture relay exited with ${String(code)}`));
    });
  });
  const memory = (): Promise<Memory> =>
    new Promise((resolveMemory) => {
      started.once('message', (message) => {
        resolveMemory(message as Memory);
      });
      started.send('measure');
    });
  return { url, memory };
}

/** One stranger's listen, its body padded by this many bytes; whether it streams, held open if so. */
async function listen(
  url: string,
  n: number,
  pad: number,
): Promise<{ status: number; streaming: boolean }> {
  const abort = new AbortController();
  aborts.push(abort);
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: `heap:${String(n)}`,
    method: 'subscriptions/listen',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'heap', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
      notifications: { toolsListChanged: true },
    },
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer invitee-${String(n)}-dev-token-5a8c1e7f2b9d4063`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'subscriptions/listen',
      'Mcp-Protocol-Version': '2026-07-28',
    },
    body: `${body.slice(0, -1)}${' '.repeat(pad)}}`,
    signal: abort.signal,
  });
  const streaming = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
  if (!streaming) {
    await response.text();
    return { status: response.status, streaming };
  }
  const reader = response.body?.getReader();
  void (async () => {
    try {
      while (reader !== undefined && !(await reader.read()).done) {
        // Keep-alive comments only.
      }
    } catch {
      // Aborted at the end of the test.
    }
  })();
  return { status: response.status, streaming };
}

describe('listen streams and the heap (S9, A4.3)', () => {
  it('holds a full invitee pool of listens in little memory, refusing bodies padded toward the cap', async () => {
    const relay = await startRelay();
    const pool = DEFAULT_LIMITS.inviteeSessions;
    const base = await relay.memory();
    const grownSince = (now: Memory): Record<keyof Memory, number> => ({
      heapUsed: Math.round((now.heapUsed - base.heapUsed) / MIB),
      arrayBuffers: Math.round((now.arrayBuffers - base.arrayBuffers) / MIB),
      rss: Math.round((now.rss - base.rss) / MIB),
    });
    // Each stranger in the pool sends a listen padded to just under the 2 MiB body cap.
    const padded = [];
    for (let n = 0; n < pool; n += 1) padded.push(await listen(relay.url, n, 2 * MIB - 1024));
    const afterPadded = grownSince(await relay.memory());
    const report = JSON.stringify({
      afterPadded,
      streaming: padded.filter((each) => each.streaming).length,
    });
    // Before, every one streamed and the pool held about 100 MiB of heap and 100 of buffers.
    expect(afterPadded.heapUsed + afterPadded.arrayBuffers, report).toBeLessThan(16);
    expect(
      padded.map((each) => each.status),
      report,
    ).toEqual(Array(pool).fill(413));
    // Then each holds an ordinary listen, padded a little but within the listen cap.
    const held = [];
    for (let n = 0; n < pool; n += 1) held.push(await listen(relay.url, n, 8 * 1024));
    const afterHeld = grownSince(await relay.memory());
    expect(held.every((each) => each.streaming)).toBe(true);
    expect(afterHeld.heapUsed + afterHeld.arrayBuffers, JSON.stringify(afterHeld)).toBeLessThan(16);
  }, 120_000);
});
