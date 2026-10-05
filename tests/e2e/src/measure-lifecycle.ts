// Lifecycle probes for docs/notes/baseline.md, added in M5 for the MCP-B 6.0
// beta (ADR 0001's notes): what executeTool does when the page unregisters a
// tool while its handler runs, or before the call starts. ADR 0012's hold
// after "Tool unregistered" rests on the first answer. Like measurePage, this
// runs inside the browser through page.evaluate, so it imports nothing and
// closes over no Node value.

import type { Probe } from './measure-page.ts';

export interface LifecycleMeasurements {
  /**
   * The registration is aborted 100 ms into a handler that takes 300 ms. A
   * runtime that races the handler against its registration rejects early
   * while the handler runs on; one that does not settles when it ends.
   */
  unregisterMidRun: Probe & { handlerFinishedFirst: boolean };
  /** executeTool on a descriptor whose tool was unregistered before the call. */
  vanishedTool: Probe;
}

interface Ctx {
  registerTool(tool: object, options?: { signal?: AbortSignal }): Promise<void>;
  getTools(): Promise<{ name: string }[]>;
  executeTool?: (
    tool: object,
    input?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>;
}

/** inputMode is measurePage's answer, so each call uses the form this runtime takes. */
export async function measureLifecycle(
  inputMode: 'string' | 'object' | 'unknown',
): Promise<LifecycleMeasurements> {
  const mc = (document as unknown as { modelContext?: Ctx }).modelContext;
  if (!mc?.executeTool) throw new Error('document.modelContext.executeTool is missing');
  const exec = mc.executeTool.bind(mc);
  const now = () => performance.now();
  const round = (n: number) => Math.round(n * 100) / 100;
  const input = inputMode === 'string' ? '{}' : {};
  const settle = async (label: string, run: () => Promise<unknown>): Promise<Probe> => {
    const start = now();
    try {
      const value = await run();
      return { label, ok: true, kind: typeof value, value, ms: round(now() - start) };
    } catch (e) {
      return {
        label,
        ok: false,
        kind: e instanceof Error ? e.name : typeof e,
        value: e instanceof Error ? e.message : String(e),
        ms: round(now() - start),
      };
    }
  };
  const find = async (name: string) => {
    const tool = (await mc.getTools()).find((x) => x.name === name);
    if (!tool) throw new Error(`${name} was not listed`);
    return tool;
  };

  let handlerFinished = false;
  const midRun = new AbortController();
  await mc.registerTool(
    {
      name: 'baseline_unregister_mid_run',
      description: 'Takes 300 ms while its registration is aborted at 100 ms',
      inputSchema: { type: 'object' },
      execute: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            handlerFinished = true;
            resolve('finished');
          }, 300);
        }),
    },
    { signal: midRun.signal },
  );
  const midRunTool = await find('baseline_unregister_mid_run');
  setTimeout(() => {
    midRun.abort();
  }, 100);
  const midRunProbe = await settle('unregister 100 ms into a 300 ms handler', () =>
    exec(midRunTool, input),
  );
  const unregisterMidRun = { ...midRunProbe, handlerFinishedFirst: handlerFinished };
  // Let a handler the runtime left running end before the next probe.
  await new Promise((resolve) => setTimeout(resolve, 300));

  const gone = new AbortController();
  await mc.registerTool(
    {
      name: 'baseline_vanished',
      description: 'Unregistered before it is called',
      inputSchema: { type: 'object' },
      execute: () => 'should not run',
    },
    { signal: gone.signal },
  );
  const goneTool = await find('baseline_vanished');
  gone.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const vanishedTool = await settle('tool unregistered before the call', () =>
    exec(goneTool, input),
  );

  return { unregisterMidRun, vanishedTool };
}
