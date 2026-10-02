// In-page measurements of the WebMCP runtime for docs/notes/baseline.md (A0.3).
// measurePage runs inside the browser through page.evaluate, so it must be
// self-contained: no imports, no closures over Node values.

export interface Probe {
  label: string;
  ok: boolean;
  /** typeof the resolved value, or the error's name. */
  kind: string;
  value: unknown;
  ms: number;
}

export interface PageMeasurements {
  runtime: {
    documentModelContext: boolean;
    navigatorAliasIsSame: boolean;
    executeToolPresent: boolean;
    contextConstructor: string;
  };
  getTools: { ms: number; names: string[]; sample: unknown };
  registration: {
    registerResolvedMs: number;
    toolchangeAfterRegisterMs: number | null;
    eventBeforeResolve: boolean;
    eventType: string;
    eventDetail: unknown;
    unregisterToolchangeMs: number | null;
    burstOfFiveEvents: number;
    duplicateName: Probe;
    annotationsRoundTrip: unknown;
  };
  /** How this runtime wants executeTool arguments: a JSON string (Chrome 153 and 154, MCP-B polyfill 5.1) or an object (Chrome 155+). */
  inputMode: 'string' | 'object' | 'unknown';
  execute: Probe[];
  abort: {
    rejection: Probe;
    handlerSawAbort: boolean;
    handlerSignalReason: string;
    /** What the handler received as its second argument. */
    handlerSecondArg: string;
  };
}

type Annotations = Record<string, boolean>;
interface RegisteredTool {
  name: string;
  annotations?: Annotations;
  [key: string]: unknown;
}
interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: Annotations;
  execute: (input: unknown, options?: { signal?: AbortSignal }) => unknown;
}
interface Ctx extends EventTarget {
  registerTool(tool: ToolDef, options?: { signal?: AbortSignal }): Promise<void>;
  getTools(): Promise<RegisteredTool[]>;
  executeTool?: (
    tool: RegisteredTool,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

export async function measurePage(): Promise<PageMeasurements> {
  const doc = document as unknown as { modelContext?: Ctx };
  const nav = navigator as unknown as { modelContext?: Ctx };
  const mc = doc.modelContext;
  if (!mc) throw new Error('document.modelContext is missing');
  const now = () => performance.now();
  const round = (n: number) => Math.round(n * 100) / 100;
  const errorKind = (e: unknown) => (e instanceof Error ? e.name : typeof e);
  const errorValue = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const runtime = {
    documentModelContext: true,
    navigatorAliasIsSame: nav.modelContext === mc,
    executeToolPresent: typeof mc.executeTool === 'function',
    contextConstructor: (mc as object).constructor.name,
  };

  let t = now();
  const tools = await mc.getTools();
  const getTools = {
    ms: round(now() - t),
    names: tools.map((x) => x.name),
    sample: (() => {
      const first = tools.find((x) => x.name === 'clear_board') ?? tools[0];
      if (!first) return null;
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(first)) copy[k] = k === 'window' ? '[Window]' : v;
      return copy;
    })(),
  };

  // toolchange timing: one registration, one removal, then a burst of five.
  const events: { type: string; at: number; detail: unknown }[] = [];
  // Order is recorded separately: the timestamps often tie at clock resolution.
  const order: string[] = [];
  const onChange = (event: Event) => {
    order.push('event');
    events.push({ type: event.type, at: now(), detail: (event as CustomEvent).detail ?? null });
  };
  mc.addEventListener('toolchange', onChange);

  const reg = new AbortController();
  t = now();
  let resolvedAt = 0;
  await mc
    .registerTool(
      {
        name: 'baseline_probe',
        description: 'Temporary tool used by the baseline measurement',
        inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] },
        annotations: {
          readOnlyHint: true,
          consequentialHint: true,
          untrustedContentHint: true,
          destructiveHint: true,
        },
        execute: (input) => input,
      },
      { signal: reg.signal },
    )
    .then(() => {
      order.push('resolved');
      resolvedAt = now();
    });
  await new Promise((r) => setTimeout(r, 50));
  const firstEvent = events[0];
  const registration = {
    registerResolvedMs: round(resolvedAt - t),
    toolchangeAfterRegisterMs: firstEvent ? round(firstEvent.at - t) : null,
    eventBeforeResolve:
      order.includes('event') && order.indexOf('event') < order.indexOf('resolved'),
    eventType: firstEvent ? firstEvent.type : 'none',
    eventDetail: firstEvent ? firstEvent.detail : null,
    unregisterToolchangeMs: null as number | null,
    burstOfFiveEvents: 0,
    duplicateName: null as unknown as Probe,
    annotationsRoundTrip:
      (await mc.getTools()).find((x) => x.name === 'baseline_probe')?.annotations ?? null,
  };

  t = now();
  try {
    await mc.registerTool({
      name: 'baseline_probe',
      description: 'duplicate',
      inputSchema: { type: 'object' },
      execute: () => null,
    });
    registration.duplicateName = {
      label: 'duplicate name',
      ok: true,
      kind: 'undefined',
      value: null,
      ms: round(now() - t),
    };
  } catch (e) {
    registration.duplicateName = {
      label: 'duplicate name',
      ok: false,
      kind: errorKind(e),
      value: errorValue(e),
      ms: round(now() - t),
    };
  }

  // Execute probes against the temporary tool and the demo's own tools.
  const probeTool = (await mc.getTools()).find((x) => x.name === 'baseline_probe');
  const highlight = (await mc.getTools()).find((x) => x.name === 'highlight_item');
  const execute: Probe[] = [];
  const run = async (label: string, fn: () => Promise<unknown>) => {
    const start = now();
    try {
      const value = await fn();
      execute.push({ label, ok: true, kind: typeof value, value, ms: round(now() - start) });
    } catch (e) {
      execute.push({
        label,
        ok: false,
        kind: errorKind(e),
        value: errorValue(e),
        ms: round(now() - start),
      });
    }
  };
  const exec = mc.executeTool?.bind(mc);
  let inputMode: 'string' | 'object' | 'unknown' = 'unknown';
  if (exec && probeTool) {
    try {
      await exec(probeTool, { n: 1 });
      inputMode = 'object';
    } catch {
      try {
        await exec(probeTool, JSON.stringify({ n: 1 }));
        inputMode = 'string';
      } catch {
        inputMode = 'unknown';
      }
    }
  }
  // Every probe below except the two explicit format probes uses the detected mode.
  const encode = (args: object) => (inputMode === 'string' ? JSON.stringify(args) : args);
  if (exec && probeTool && highlight) {
    await run('args as JSON string', () => exec(probeTool, JSON.stringify({ n: 1 })));
    await run('args as object', () => exec(probeTool, { n: 1 }));
    await run('args omitted', () => exec(probeTool));
    await run('args violate inputSchema (n is a string)', () =>
      exec(probeTool, encode({ n: 'one' })),
    );
    await run('tool passed by name only', () => exec({ name: 'baseline_probe' }, encode({ n: 1 })));
    await run('handler throws (highlight unknown id)', () =>
      exec(highlight, encode({ id: 'item-999' })),
    );
  }

  // Return-value encodings: what executeTool hands back for non-object results.
  const shapes: [string, () => unknown][] = [
    ['returns string', () => 'plain text'],
    ['returns number', () => 42],
    ['returns undefined', () => undefined],
    ['returns MCP CallToolResult', () => ({ content: [{ type: 'text', text: 'hi' }] })],
  ];
  for (const [label, fn] of shapes) {
    const ctl = new AbortController();
    const name = `baseline_${label.replace(/\W+/g, '_')}`;
    await mc.registerTool(
      { name, description: label, inputSchema: { type: 'object' }, execute: fn },
      { signal: ctl.signal },
    );
    const tool = (await mc.getTools()).find((x) => x.name === name);
    if (exec && tool) await run(label, () => exec(tool, encode({})));
    ctl.abort();
  }

  // Abort during a slow call: does executeTool reject, and does the handler's signal fire?
  let handlerSawAbort = false;
  let handlerSignalReason = 'none';
  let handlerSecondArg = 'not called';
  const slowCtl = new AbortController();
  await mc.registerTool(
    {
      name: 'baseline_slow',
      description: 'Waits until aborted or 2 s pass',
      inputSchema: { type: 'object' },
      execute: (_input, options) =>
        new Promise((resolve) => {
          handlerSecondArg =
            options === undefined
              ? 'undefined'
              : `${typeof options} with keys [${Object.keys(options).join(', ')}], signal ${
                  options.signal instanceof AbortSignal ? 'is an AbortSignal' : 'absent'
                }`;
          const timer = setTimeout(() => {
            resolve('finished');
          }, 2000);
          options?.signal?.addEventListener('abort', () => {
            handlerSawAbort = true;
            handlerSignalReason = String(options.signal?.reason);
            clearTimeout(timer);
            resolve('aborted');
          });
        }),
    },
    { signal: slowCtl.signal },
  );
  const slow = (await mc.getTools()).find((x) => x.name === 'baseline_slow');
  let rejection: Probe = {
    label: 'abort after 100 ms',
    ok: true,
    kind: 'skipped',
    value: null,
    ms: 0,
  };
  if (exec && slow) {
    const callCtl = new AbortController();
    const start = now();
    setTimeout(() => {
      callCtl.abort();
    }, 100);
    try {
      const value = await exec(slow, encode({}), { signal: callCtl.signal });
      rejection = {
        label: 'abort after 100 ms',
        ok: true,
        kind: typeof value,
        value,
        ms: round(now() - start),
      };
    } catch (e) {
      rejection = {
        label: 'abort after 100 ms',
        ok: false,
        kind: errorKind(e),
        value: errorValue(e),
        ms: round(now() - start),
      };
    }
  }
  slowCtl.abort();

  // Removal and a burst of registrations.
  await new Promise((r) => setTimeout(r, 50));
  events.length = 0;
  t = now();
  reg.abort();
  await new Promise((r) => setTimeout(r, 100));
  const removal = events[0];
  registration.unregisterToolchangeMs = removal ? round(removal.at - t) : null;

  events.length = 0;
  const burst = new AbortController();
  await Promise.all(
    [1, 2, 3, 4, 5].map((i) =>
      mc.registerTool(
        {
          name: `baseline_burst_${i}`,
          description: 'burst',
          inputSchema: { type: 'object' },
          execute: () => i,
        },
        { signal: burst.signal },
      ),
    ),
  );
  await new Promise((r) => setTimeout(r, 100));
  registration.burstOfFiveEvents = events.length;
  burst.abort();
  mc.removeEventListener('toolchange', onChange);

  return {
    runtime,
    getTools,
    registration,
    inputMode,
    execute,
    abort: { rejection, handlerSawAbort, handlerSignalReason, handlerSecondArg },
  };
}
