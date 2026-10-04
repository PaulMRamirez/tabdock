// A tools frame costs main-thread time: parsing it, and walking and hashing
// the schemas in it for listing (S10) and for the argument check (ADR 0008,
// ADR 0010). One address may hold 20 page sockets, so a budget per socket alone
// let one address keep the relay's main loop busy for seconds on end. Here
// twenty sockets from one address flood the relay with 1 MB tools frames, each
// socket within its own budget, while the main loop and /healthz are timed. The
// same flood in frames of a type the relay ignores, which it only parses and
// logs, is the yardstick: tools frames must cost about what any frame of their
// size costs, never several times as much. The yardstick's relay lifts the
// budget for frames that change nothing (ADR 0023), so it does the same work
// on every run: every frame parsed and logged, no line held back.

import { afterEach, describe, expect, it } from 'vitest';
import type { RelayOptions } from '../src/index.ts';
import { connectPage, type TestPage } from './helpers/page-client.ts';
import { delay, startRelay, type TestRelay } from './helpers/relay.ts';

let current: TestRelay | undefined;
const pages: TestPage[] = [];

async function closeAll(): Promise<void> {
  for (const opened of pages.splice(0)) opened.ws.terminate();
  await current?.close();
  current = undefined;
}

afterEach(closeAll);

const SOCKETS = 20;
/** Within the default budget of 10 tools frames per socket. */
const FRAMES_PER_SOCKET = 5;
/**
 * Each measure of the tools flood is bounded by the same measure of the
 * yardstick from the same run, since load from other test files or processes
 * slows both, and by a ceiling. On a 4-core box, at the relay's defaults, the
 * tools flood stayed within 1.7 times the yardstick on every measure, idle or
 * beside three to six busy processes, and never passed 5.6 s stalled, a 3.5 s
 * gap or 5.2 s for /healthz. Without the cap on schema nodes walked per frame,
 * its worst gap was 6 times the yardstick's and /healthz waited 4 times as
 * long; with neither that cap nor the per-address budget the loop stalled for
 * 15 to 24 s, gaps reached 10 s and /healthz waited 14 s, 7 times as long.
 */
const YARDSTICK_FACTOR = 2;
/** Absorbs timer noise when the yardstick itself is short. */
const YARDSTICK_SLACK_MS = 1000;
/** About twice what a loaded run measured at the defaults, and below each figure of the old stall. */
const MAX_STALLED_MS = 12_000;
const MAX_GAP_MS = 8000;
const MAX_HEALTH_MS = 10_000;

/**
 * 128 tools, each an anyOf of empty schemas beside a patternProperties, in
 * just under 1 MB: about 333,000 schema nodes, the costliest shape per byte
 * the M2 review found. Each salt gives other tool names, so no frame repeats.
 */
function floodFrame(type: string, salt: number): string {
  const anyOf = Array.from({ length: 2600 }, () => '{}').join(',');
  const tools = Array.from(
    { length: 128 },
    (_, index) =>
      `{"name":"f${String(salt)}_t${String(index)}","description":"d","inputSchema":{"type":"object","patternProperties":{"a":{}},"anyOf":[${anyOf}]},"annotations":{"readOnlyHint":true}}`,
  );
  return `{"t":"${type}","tools":[${tools.join(',')}]}`;
}

/** Time the main loop spent away from a 5 ms interval: the worst gap, and the sum of gaps over 20 ms. */
function watchLoop(): { stop: () => { worst: number; stalled: number } } {
  let last = performance.now();
  let worst = 0;
  let stalled = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    worst = Math.max(worst, gap);
    if (gap > 20) stalled += gap;
    last = now;
  }, 5);
  return {
    stop: () => {
      clearInterval(timer);
      return { worst, stalled };
    },
  };
}

/** Asks /healthz over and over until stopped; each answer's latency. */
function sampleHealth(url: string): { stop: () => Promise<number[]> } {
  const latencies: number[] = [];
  const state = { running: true };
  const sampling = (async () => {
    while (state.running) {
      const started = performance.now();
      // A stalled server can drop a kept-alive connection; that answer counts as slow as it was.
      await fetch(`${url}/healthz`).then(
        (response) => response.text(),
        () => undefined,
      );
      latencies.push(performance.now() - started);
      await delay(50);
    }
  })();
  return {
    stop: async () => {
      state.running = false;
      await sampling;
      return latencies;
    },
  };
}

/** Resolves once the relay has dealt with everything sent before: closed the socket, or answered a ping. */
async function settled(opened: TestPage): Promise<void> {
  opened.send({ t: 'ping' });
  const pong = opened.next('pong', 120_000).then(
    () => undefined,
    () => undefined,
  );
  await Promise.race([opened.closed, pong]);
}

interface FloodCost {
  stalled: number;
  worst: number;
  slowestHealth: number;
  closedForBudget: number;
  /** Sockets the relay closed for any reason. */
  closed: number;
  /** Frames of unknown type the relay parsed and logged. */
  ignoredLines: number;
}

/**
 * A fresh relay at its defaults, twenty sockets from one address, and the
 * flood; rateLimits over the defaults, for the yardstick.
 */
async function flood(
  type: string,
  rateLimits: RelayOptions['rateLimits'] = {},
): Promise<FloodCost> {
  current = await startRelay({
    timings: { idleTimeoutMs: 600_000, pingIntervalMs: 600_000 },
    rateLimits,
  });
  for (let index = 0; index < SOCKETS; index += 1) {
    pages.push(await connectPage(current.relay.pageUrl));
  }
  const frames = Array.from({ length: FRAMES_PER_SOCKET }, (_, index) => floodFrame(type, index));
  expect(frames[0]?.length).toBeGreaterThan(1_000_000);

  const loop = watchLoop();
  const health = sampleHealth(current.relay.url);
  for (const opened of pages) for (const text of frames) opened.sendRaw(text);
  await Promise.all(pages.map((opened) => settled(opened)));
  const { worst, stalled } = loop.stop();
  const latencies = await health.stop();
  const cost = {
    stalled,
    worst,
    slowestHealth: Math.max(...latencies),
    closedForBudget: current.lines.filter((line) => line.includes('too many tools frames')).length,
    closed: pages.filter((opened) => opened.ws.readyState !== opened.ws.OPEN).length,
    ignoredLines: current.lines.filter((line) => line.includes('ignored a frame of unknown type'))
      .length,
  };
  process.stderr.write(
    `${type} flood: loop stalled ${stalled.toFixed(0)} ms, worst gap ${worst.toFixed(0)} ms, /healthz slowest ${cost.slowestHealth.toFixed(0)} ms, sockets closed for budget ${String(cost.closedForBudget)}, closed ${String(cost.closed)}\n`,
  );
  await closeAll();
  return cost;
}

/** The most a measure of the tools flood may reach, given the yardstick's. */
function bound(yardstick: number, ceiling: number): number {
  return Math.min(yardstick * YARDSTICK_FACTOR + YARDSTICK_SLACK_MS, ceiling);
}

describe('tools frames from one address (S9, ADR 0010)', () => {
  it('twenty sockets flooding 1 MB tools frames cannot hold up the main loop or /healthz', async () => {
    const ignored = await flood('not_a_frame_type', {
      ignoredFramesPerSocket: 10_000,
      ignoredFramesPerAddress: 10_000,
    });
    // The yardstick did all its work: every frame parsed and logged, every socket open.
    expect(ignored.ignoredLines).toBe(SOCKETS * FRAMES_PER_SOCKET);
    expect(ignored.closed).toBe(0);
    const tools = await flood('tools');

    expect(tools.stalled).toBeLessThan(bound(ignored.stalled, MAX_STALLED_MS));
    expect(tools.worst).toBeLessThan(bound(ignored.worst, MAX_GAP_MS));
    expect(tools.slowestHealth).toBeLessThan(bound(ignored.slowestHealth, MAX_HEALTH_MS));
    // The address ran out of budget, and its sockets were closed for it.
    expect(tools.closedForBudget).toBeGreaterThan(0);
    expect(ignored.closedForBudget).toBe(0);
  }, 180_000);
});
