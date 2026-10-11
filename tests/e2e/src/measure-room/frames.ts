// The projected tab under watchers' calls (ADR 0044, decision 12): the
// canvas map page in headless Chromium, linked to a relay on this machine,
// with requestAnimationFrame timed in the page while calls arrive at a fixed
// rate, so a frame later than 33 ms (two missed at 60 Hz) shows the
// projector stuttering. It measures the page, not the relay: the relay here
// is an ordinary one in this process with its per-user call and request
// rates raised for the one member making every call, since only the arrival
// rate matters to the page. Each rate runs as capture_view, which redraws and encodes an
// image within the relay's cap, and as get_view, which only reads; the
// adapter itself starts at most one image call every 250 ms.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Page } from '@playwright/test';
import { startMapPageServer } from '@tabdock/map-page/server';
import { createDevTokenAuth, createRelay } from '@tabdock/relay';
import { launchChromium } from '../harness.ts';
import { connectMapPage, openMapPage, pairMapPage } from '../map-harness.ts';
import { throwawayUser } from '../tabdock-harness.ts';
import { percentile, round, sleep, Tally } from './stats.ts';

export interface FrameRun {
  tool: 'none' | 'capture_view' | 'get_view';
  callsPerSecond: number;
  seconds: number;
  frames: number;
  /** Frames later than 33 ms, and the slowest. */
  late: number;
  p99Ms: number | null;
  maxMs: number | null;
  outcomes: Record<string, number>;
}

/** Frame deltas over this mean at least one frame was missed at 60 Hz. */
export const LATE_FRAME_MS = 33;

async function startFrameClock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const clock = window as unknown as { __frameDeltas: number[]; __frameLast: number };
    clock.__frameDeltas = [];
    clock.__frameLast = performance.now();
    const tick = (at: number): void => {
      clock.__frameDeltas.push(at - clock.__frameLast);
      clock.__frameLast = at;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function takeFrames(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const clock = window as unknown as { __frameDeltas: number[] };
    const taken = clock.__frameDeltas;
    clock.__frameDeltas = [];
    return taken;
  });
}

export async function measureFrames(
  seconds: number,
  say: (line: string) => void,
): Promise<{ runs: FrameRun[]; browser: string }> {
  const alice = throwawayUser('alice', 'Alice');
  const map = await startMapPageServer();
  const relay = await createRelay({
    auth: createDevTokenAuth([alice]),
    port: 0,
    allowMissingOrigin: false,
    logSink: () => undefined,
    // One member makes every call, so neither per-user rate may be what limits the arrival rate.
    rateLimits: { callsPerUserPerPage: 100_000, requestsPerUser: 100_000 },
  });
  const browser = await launchChromium(true);
  const client = new Client({ name: 'frames', version: '1.0.0' });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await openMapPage(page, map.url);
    if (!(await connectMapPage(page, relay.pageUrl)))
      throw new Error('the map page did not connect');
    await client.connect(
      new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${alice.token}` } },
      }),
    );
    const pageId = await pairMapPage(page, client, 'driver');
    await startFrameClock(page);
    const runs: FrameRun[] = [];
    const plan: { tool: FrameRun['tool']; rate: number }[] = [
      { tool: 'none', rate: 0 },
      { tool: 'capture_view', rate: 0.5 },
      { tool: 'capture_view', rate: 1 },
      { tool: 'capture_view', rate: 2 },
      { tool: 'capture_view', rate: 4 },
      { tool: 'get_view', rate: 1 },
      { tool: 'get_view', rate: 2 },
      { tool: 'get_view', rate: 4 },
      { tool: 'get_view', rate: 20 },
    ];
    for (const { tool, rate } of plan) {
      await sleep(2000);
      await takeFrames(page);
      const outcomes = new Tally();
      const calls: Promise<void>[] = [];
      const started = performance.now();
      if (tool !== 'none') {
        let next = started;
        while (performance.now() - started < seconds * 1000) {
          calls.push(
            client
              .callTool({
                name: 'call_page_tool',
                arguments: { page: pageId, tool, arguments: {} },
              })
              .then((result) => {
                const first = result.content[0];
                const text = first?.type === 'text' ? first.text : '';
                outcomes.add(
                  result.isError === true ? (/^([a-z_]+): /.exec(text)?.[1] ?? 'error') : 'ok',
                );
              })
              .catch(() => {
                outcomes.add('thrown');
              }),
          );
          next += 1000 / rate;
          await sleep(Math.max(0, next - performance.now()));
        }
      } else {
        await sleep(seconds * 1000);
      }
      const deltas = await takeFrames(page);
      await Promise.allSettled(calls);
      const run: FrameRun = {
        tool,
        callsPerSecond: rate,
        seconds,
        frames: deltas.length,
        late: deltas.filter((delta) => delta > LATE_FRAME_MS).length,
        p99Ms: round(percentile(deltas, 99)),
        maxMs: round(deltas.length === 0 ? null : Math.max(...deltas)),
        outcomes: outcomes.toJSON(),
      };
      runs.push(run);
      say(
        `  frames, ${tool} at ${String(rate)}/s: ${String(run.late)} of ${String(run.frames)} late, p99 ${String(run.p99Ms)} ms`,
      );
    }
    return { runs, browser: browser.version() };
  } finally {
    await client.close().catch(() => undefined);
    await browser.close();
    await relay.close();
    await map.close();
  }
}
