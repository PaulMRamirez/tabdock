// The room measurement's own parts (ADR 0044, A6.22), which pnpm measure:room
// runs by hand: an unread answer is found cut or whole by the client that
// left it, a member's cut can fail the bars and so can a run that never
// held one, a phase never claims a CPU quota it could not set, the probe
// reports the loop's delay rather than its sampling interval, and the probe
// stops its relay once the harness is gone.

import { type ChildProcess, fork } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { barsOf, type ScoredPhase } from '../src/measure-room/bars.ts';
import { applyQuota, type Confinement } from '../src/measure-room/confine.ts';
import { holdAnswer } from '../src/measure-room/held.ts';
import { narrowSocketBuffers } from '../src/measure-room/sockets.ts';

const PROBE = resolve(import.meta.dirname, '../src/measure-room/probe.ts');

const servers: Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.closeAllConnections();
          server.close(() => {
            done();
          });
        }),
    ),
  );
});

/** A stand-in /mcp that answers each POST as `answer` says. */
async function serve(answer: (res: ServerResponse) => void): Promise<URL> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      answer(res);
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const where = server.address();
  if (where === null || typeof where === 'string') throw new Error('no port');
  return new URL(`http://127.0.0.1:${String(where.port)}/mcp`);
}

/** An SSE answer's start, as the relay writes it, then a large body. */
const START = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"';
const LARGE = 'x'.repeat(4 * 1024 * 1024);

function hold(url: URL) {
  return holdAnswer({ url, headers: {}, body: '{}', mode: 'stall' });
}

describe('an answer left unread (held.ts)', () => {
  it('is found cut when its connection ends before the answer does, though the client never read', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(START);
      res.write(LARGE);
      // The relay's cut: the response destroyed part way through.
      setTimeout(() => res.destroy(), 200);
    });
    const answer = hold(url);
    await new Promise((done) => setTimeout(done, 600));
    expect(answer.outcome).toBe('held');
    expect(await answer.settle(5000)).toBe('cut');
  });

  it('is found whole when the rest of it arrives once drained', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(START);
      res.end(`${LARGE}"}]}}\n\n`);
    });
    const answer = hold(url);
    await new Promise((done) => setTimeout(done, 300));
    expect(answer.outcome).toBe('held');
    expect(await answer.settle(5000)).toBe('whole');
  });

  it("takes a refusal's code from its first bytes", async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        'event: message\ndata: {"result":{"content":[{"type":"text","text":"rate_limited: wait"}],"isError":true}}\n\n',
      );
    });
    expect(await hold(url).done).toBe('rate_limited');
  });

  it('is open when it neither ends nor breaks while settling', async () => {
    const url = await serve((res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(START);
    });
    const answer = hold(url);
    await new Promise((done) => setTimeout(done, 200));
    expect(await answer.settle(300)).toBe('open');
  });
});

function phase(over: Partial<ScoredPhase> = {}): ScoredPhase {
  return {
    quotaUs: 80_000,
    peaks: { vmHwmMiB: 200, vmRssMiB: 200 },
    heapAfterGcUnderLoadMiB: 40,
    eventLoopMs: { p99: 5 },
    calls: { 'teacher set_view': { latency: { p95: 50 }, outcomes: { ok: 10 } } },
    statuses: { 'http 200': 100 },
    oomKills: 0,
    memberHeld: { asked: 0, outcomes: {} },
    ...over,
  };
}

function memberBar(phases: ScoredPhase[]) {
  return barsOf({ join: { sessionRefusals: 0 }, phases }).find((bar) =>
    bar.name.startsWith('no member cut'),
  );
}

describe('the bars (bars.ts)', () => {
  it("fail on a teacher's answer cut, and on a run that held none of the teacher's", () => {
    const held = phase({ memberHeld: { asked: 4, outcomes: { whole: 4 } } });
    expect(memberBar([phase(), held])?.pass).toBe(true);
    const cut = phase({ memberHeld: { asked: 4, outcomes: { whole: 3, cut: 1 } } });
    expect(memberBar([phase(), cut])?.pass).toBe(false);
    expect(memberBar([phase(), phase()])?.pass).toBe(false);
  });

  it('read the heap from the collection taken under load', () => {
    const bars = barsOf({
      join: { sessionRefusals: 0 },
      phases: [phase({ heapAfterGcUnderLoadMiB: 151 })],
    });
    expect(bars.find((bar) => bar.name.startsWith('heap'))?.pass).toBe(false);
  });
});

describe('a phase quota (confine.ts)', () => {
  const stub = (sets: boolean): Confinement => ({
    kind: 'none',
    notes: [],
    cpu: null,
    wrap: (argv) => ({ command: argv[0] ?? '', args: argv.slice(1) }),
    setQuota: () => sets,
    killAll: () => undefined,
    resetPeak: () => undefined,
    stats: () => null,
    close: () => Promise.resolve(),
  });

  it('is recorded only where the confinement set it', () => {
    expect(applyQuota(stub(true), 5000)).toBe(5000);
    expect(applyQuota(stub(false), 5000)).toBeNull();
  });
});

describe('TCP buffers (sockets.ts)', () => {
  it('are left alone without a namespace of its own or --narrow-host-tcp', () => {
    const narrowed = narrowSocketBuffers('none');
    expect(narrowed.applied).toBe(false);
    expect(narrowed.note).toContain('--narrow-host-tcp');
  });
});

describe('the probe (probe.ts)', () => {
  function ask(child: ChildProcess, id: number, t: string): Promise<Record<string, unknown>> {
    return new Promise((done) => {
      const heard = (message: unknown): void => {
        const answer = message as Record<string, unknown>;
        if (answer.id !== id) return;
        child.off('message', heard);
        done(answer);
      };
      child.on('message', heard);
      child.send({ id, t });
    });
  }

  it("reports an idle loop's delay without its 10 ms sampling interval, and stops its process once the harness goes", async () => {
    const child = fork('-e', ['setInterval(() => {}, 1000);'], {
      execArgv: ['--expose-gc', '--import', pathToFileURL(PROBE).href],
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    children.push(child);
    await ask(child, 1, 'mark');
    await new Promise((done) => setTimeout(done, 1500));
    const read = await ask(child, 2, 'read');
    const loop = read.eventLoop as Record<string, number>;
    expect(loop.resolutionMs).toBe(10);
    expect(loop.count).toBeGreaterThan(50);
    // Idle, Node records about 10.2 ms a sample; the delay is the 0.2 past the interval.
    expect(loop.p50).toBeLessThan(5);
    expect((read.memory as Record<string, number>).responsesHeld).toBe(0);
    const gone = new Promise<string>((done) => {
      child.once('exit', (code, signal) => {
        done(signal ?? String(code));
      });
    });
    child.disconnect();
    expect(await gone).toBe('SIGTERM');
  });
});
