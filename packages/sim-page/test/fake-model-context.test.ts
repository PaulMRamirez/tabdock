// Fidelity of FakeModelContext against the M0 measurements. Each profile runs
// the same probes as tests/e2e/src/measure-page.ts and is compared with the
// raw files in docs/notes, so a profile cannot drift from what was measured.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FakeModelContext, type RuntimeProfile } from '../src/index.ts';

interface Probe {
  label: string;
  ok: boolean;
  kind: string;
  value: unknown;
}

interface RawBaseline {
  page: {
    getTools: { names: string[]; sample: Record<string, unknown> };
    registration: {
      eventBeforeResolve: boolean;
      burstOfFiveEvents: number;
      duplicateName: Probe;
      annotationsRoundTrip: Record<string, boolean>;
    };
    inputMode: 'string' | 'object';
    execute: Probe[];
    abort: {
      rejection: Probe;
      handlerSawAbort: boolean;
      handlerSignalReason: string;
      handlerSecondArg: string;
    };
  };
}

function readRaw(file: string): RawBaseline {
  const url = new URL(`../../../docs/notes/${file}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as RawBaseline;
}

/** Which raw files each profile stands for: getTools shapes from the first, executeTool from all. */
const PROFILES: { profile: RuntimeProfile; files: string[] }[] = [
  { profile: 'polyfill-5.1', files: ['baseline.raw.json'] },
  {
    profile: 'chrome-154',
    files: ['baseline.raw.chrome154.json', 'baseline.raw.chrome153.json'],
  },
  {
    profile: 'chrome-156',
    files: ['baseline.raw.chrome156.json', 'baseline.raw.chrome155.json'],
  },
];

const DEMO_TOOLS = [
  'get_view',
  'list_items',
  'add_item',
  'move_view',
  'highlight_item',
  'clear_board',
];

async function settle(label: string, run: () => Promise<unknown>): Promise<Probe> {
  try {
    const value = await run();
    return { label, ok: true, kind: typeof value, value };
  } catch (error) {
    return {
      label,
      ok: false,
      kind: error instanceof Error ? error.name : typeof error,
      value: error instanceof Error ? error.message : String(error),
    };
  }
}

async function find(mc: FakeModelContext, name: string) {
  const tool = (await mc.getTools()).find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool;
}

/** The demo's six tools, registered as apps/demo does, with highlight_item throwing as in the probe. */
async function registerDemoTools(mc: FakeModelContext): Promise<void> {
  for (const name of DEMO_TOOLS) {
    await mc.registerTool({
      name,
      ...(name === 'clear_board' ? { title: 'Clear board' } : {}),
      description:
        name === 'clear_board'
          ? 'Remove every item from the board. This cannot be undone.'
          : `Demo tool ${name}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations:
        name === 'clear_board'
          ? { readOnlyHint: false, consequentialHint: true }
          : { readOnlyHint: name === 'get_view' || name === 'list_items' },
      execute: () => {
        if (name === 'highlight_item') throw new Error('No item with id item-999');
        return {};
      },
    });
  }
}

describe.each(PROFILES)('FakeModelContext as $profile', ({ profile, files }) => {
  const [primary, ...others] = files.map(readRaw);
  if (!primary) throw new Error('no raw file');
  const raws = [primary, ...others];

  it('lists tools sorted by name with the measured entry shape', async () => {
    const mc = new FakeModelContext({ profile });
    await registerDemoTools(mc);
    const tools = await mc.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(primary.page.getTools.names);
    const sample = await find(mc, 'clear_board');
    expect(sample.window).toBe(mc.window);
    const shown = { ...sample, window: '[Window]' };
    const expected = { ...primary.page.getTools.sample, origin: mc.origin };
    expect(shown).toEqual(expected);
    // Key order too: Chrome converts a dictionary, so its keys come out alphabetical.
    expect(Object.keys(shown)).toEqual(Object.keys(expected));
    expect(Object.keys(sample.annotations ?? {})).toEqual(
      Object.keys(primary.page.getTools.sample.annotations as object),
    );
  });

  it('reproduces the registration measurements', async () => {
    const mc = new FakeModelContext({ profile });
    const order: string[] = [];
    let events = 0;
    mc.addEventListener('toolchange', () => {
      order.push('event');
      events += 1;
    });
    const registration = new AbortController();
    await mc
      .registerTool(
        {
          name: 'baseline_probe',
          description: 'Temporary tool used by the baseline measurement',
          inputSchema: { type: 'object' },
          annotations: {
            readOnlyHint: true,
            consequentialHint: true,
            untrustedContentHint: true,
            destructiveHint: true,
          },
          execute: (input) => input,
        },
        { signal: registration.signal },
      )
      .then(() => order.push('resolved'));
    expect(order).toEqual(['event', 'resolved']);
    expect(primary.page.registration.eventBeforeResolve).toBe(true);
    const roundTrip = (await find(mc, 'baseline_probe')).annotations;
    expect(roundTrip).toEqual(primary.page.registration.annotationsRoundTrip);

    const duplicate = await settle('duplicate name', () =>
      mc.registerTool({ name: 'baseline_probe', description: 'duplicate', execute: () => null }),
    );
    const { label, ok, kind, value } = primary.page.registration.duplicateName;
    expect(duplicate).toEqual({ label, ok, kind, value });

    // Removal fires toolchange; a burst of five fires five, as nothing coalesces.
    events = 0;
    registration.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toBe(1);
    expect(await mc.getTools()).toEqual([]);
    events = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        mc.registerTool({ name: `burst_${i}`, description: 'burst', execute: () => i }),
      ),
    );
    expect(events).toBe(primary.page.registration.burstOfFiveEvents);
  });

  it('matches every executeTool probe in the baseline table', async () => {
    const mc = new FakeModelContext({ profile });
    await mc.registerTool({
      name: 'baseline_probe',
      description: 'probe',
      inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
      execute: (input) => input,
    });
    await registerDemoTools(mc);
    const probeTool = await find(mc, 'baseline_probe');
    const highlight = await find(mc, 'highlight_item');
    const encode = (args: object) =>
      primary.page.inputMode === 'string' ? JSON.stringify(args) : args;

    const results: Probe[] = [
      await settle('args as JSON string', () =>
        mc.executeTool(probeTool, JSON.stringify({ n: 1 })),
      ),
      await settle('args as object', () => mc.executeTool(probeTool, { n: 1 })),
      await settle('args omitted', () => mc.executeTool(probeTool)),
      await settle('args violate inputSchema (n is a string)', () =>
        mc.executeTool(probeTool, encode({ n: 'one' })),
      ),
      await settle('tool passed by name only', () =>
        mc.executeTool({ name: 'baseline_probe' }, encode({ n: 1 })),
      ),
      await settle('handler throws (highlight unknown id)', () =>
        mc.executeTool(highlight, encode({ id: 'item-999' })),
      ),
    ];
    const shapes: [string, () => unknown][] = [
      ['returns string', () => 'plain text'],
      ['returns number', () => 42],
      ['returns undefined', () => undefined],
      ['returns MCP CallToolResult', () => ({ content: [{ type: 'text', text: 'hi' }] })],
    ];
    for (const [label, run] of shapes) {
      const name = `baseline_${label.replace(/\W+/g, '_')}`;
      await mc.registerTool({
        name,
        description: label,
        inputSchema: { type: 'object' },
        execute: run,
      });
      results.push(
        await settle(label, async () => mc.executeTool(await find(mc, name), encode({}))),
      );
    }

    for (const raw of raws) {
      const measured = raw.page.execute.map(({ label, ok, kind, value }) => ({
        label,
        ok,
        kind,
        value,
      }));
      expect(results).toEqual(measured);
    }
  });

  it('rejects the caller on abort, and tells the handler only where the runtime does', async () => {
    const mc = new FakeModelContext({ profile });
    let sawAbort = false;
    let secondArg = 'not called';
    await mc.registerTool({
      name: 'baseline_slow',
      description: 'Waits until aborted or 300 ms pass',
      inputSchema: { type: 'object' },
      execute: (_input, options) =>
        new Promise((resolve) => {
          secondArg =
            options === undefined
              ? 'undefined'
              : `${typeof options} with keys [${Object.keys(options).join(', ')}], signal ${
                  options.signal instanceof AbortSignal ? 'is an AbortSignal' : 'absent'
                }`;
          const timer = setTimeout(() => {
            resolve('finished');
          }, 300);
          options?.signal.addEventListener('abort', () => {
            sawAbort = true;
            clearTimeout(timer);
            resolve('aborted');
          });
        }),
    });
    const slow = await find(mc, 'baseline_slow');
    const call = new AbortController();
    setTimeout(() => {
      call.abort();
    }, 30);
    const input = primary.page.inputMode === 'string' ? '{}' : {};
    const started = Date.now();
    const rejection = await settle('abort', () =>
      mc.executeTool(slow, input, { signal: call.signal }),
    );
    expect(Date.now() - started).toBeLessThan(1000);
    for (const raw of raws) {
      expect(rejection.kind).toBe(raw.page.abort.rejection.kind);
      expect(sawAbort).toBe(raw.page.abort.handlerSawAbort);
      expect(secondArg).toBe(raw.page.abort.handlerSecondArg);
    }
    // The polyfill's handler keeps running; let it finish so nothing outlives the test.
    await new Promise((resolve) => setTimeout(resolve, profile === 'polyfill-5.1' ? 350 : 0));
  });

  it('keeps a frame tool apart and refuses it where the runtime checks the window', async () => {
    const frame = { label: 'iframe window' };
    const mc = new FakeModelContext({ profile });
    await mc.registerTool({ name: 'shared', description: 'top', execute: () => 'top' });
    await mc.registerTool(
      { name: 'shared', description: 'frame', execute: () => 'frame' },
      { fromWindow: frame },
    );
    const tools = await mc.getTools();
    expect(tools.map((tool) => tool.window)).toEqual(expect.arrayContaining([mc.window, frame]));
    const frameTool = tools.find((tool) => tool.window === frame);
    if (!frameTool) throw new Error('missing frame tool');
    const input = profile === 'chrome-156' ? {} : '{}';
    const outcome = await settle('frame', () => mc.executeTool(frameTool, input));
    if (profile === 'polyfill-5.1') {
      expect(outcome).toMatchObject({
        ok: false,
        kind: 'UnknownError',
        value: 'Tool not found: shared',
      });
    } else {
      expect(outcome).toMatchObject({ ok: true, value: 'frame' });
    }
  });
});
