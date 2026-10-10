// Puts a page on the MCP-B 6.0.0 polyfill (ADR 0047, after M5 decision D4
// and ADR 0031) for the Playwright leg in specs/mcpb6.spec.ts and the
// baseline's 6 run. An init script runs before any of the page's own
// scripts and does what an npm page does with 6.0.0: it loads the ESM entry,
// which installs nothing on import, then calls installWebMCP() itself. The
// demo's 5.1.0 initializeWebMCPPolyfill() then finds a context and steps
// aside, as it does for native WebMCP, so the demo, its tools and the adapter
// it bundles run on 6 unchanged. 6.0.0 is reached through @tabdock/mcpb6's
// paths alone (ADR 0032), never a bare package name that could resolve to
// 5.1.0.

import type { Page } from '@playwright/test';
import { mcpb6ModuleScript } from '@tabdock/mcpb6';

/** The name the init script binds the polyfill's exports to, inside its own function. */
export const MCPB6_BINDING = 'mcpb6Polyfill';

/** What the init script saw, read back with page.evaluate(() => window.__mcpb6). */
export interface Mcpb6Probe {
  /** A context was there before the polyfill ran, so it kept that one and this page is not on 6. */
  hadContextBefore: boolean;
  /** A context was there once the module loaded and before installWebMCP() ran. */
  installedOnImport: boolean;
  /** installWebMCP() left document.modelContext in place. */
  installed: boolean;
  /**
   * Every executeTool call the page's code made, in order: the input's type
   * and how the call settled. Recorded only when the leg asks for it.
   */
  calls: { input: string; outcome: 'pending' | 'resolved' | 'rejected' }[];
}

declare global {
  interface Window {
    __mcpb6?: Mcpb6Probe;
  }
}

const polyfill = mcpb6ModuleScript(MCPB6_BINDING).script;

/**
 * The init script's text. With recordCalls, executeTool is wrapped on the
 * context itself so the leg can show that the adapter's first input form, an
 * object, was taken: a pass-through that records each call's input type and
 * settles exactly as the runtime does. The baseline runs without it, so it
 * measures the runtime and nothing else.
 */
export function mcpb6InitScript(options: { recordCalls: boolean }): string {
  const recorder = `
  const original = context.executeTool;
  Object.defineProperty(context, 'executeTool', {
    configurable: true,
    writable: true,
    value: function executeTool(tool, input, options) {
      const entry = { input: typeof input, outcome: 'pending' };
      probe.calls.push(entry);
      const result = Reflect.apply(original, this, [tool, input, options]);
      result.then(
        () => { entry.outcome = 'resolved'; },
        () => { entry.outcome = 'rejected'; },
      );
      return result;
    },
  });`;
  return `(() => {
  const probe = {
    hadContextBefore: 'modelContext' in document,
    installedOnImport: false,
    installed: false,
    calls: [],
  };
  window.__mcpb6 = probe;
${polyfill}
  probe.installedOnImport = 'modelContext' in document;
  ${MCPB6_BINDING}.installWebMCP();
  const context = document.modelContext;
  probe.installed = Boolean(context);
  if (!context) return;${options.recordCalls ? recorder : ''}
})();`;
}

/** Loads the 6.0.0 polyfill into every document this page opens from now on. */
export async function useMcpb6(page: Page, options: { recordCalls: boolean }): Promise<void> {
  await page.addInitScript({ content: mcpb6InitScript(options) });
}

/** What makes a context 6.0.0's rather than 5.1.0's or a native one. */
export interface Mcpb6Runtime {
  hadContextBefore: boolean;
  /** 6.0.0's module installs nothing as it loads; only installWebMCP() does. */
  installedOnImport: boolean;
  installed: boolean;
  /** 5.1.0 sets __isWebMCPPolyfill on its context; 6 and native Chrome set nothing. */
  marker: unknown;
  /** 5.1.0 also installs the deprecated navigator.modelContext alias; 6 does not. */
  navigatorAlias: boolean;
  /** 6 refuses a JSON string with its own TypeError, where 5.1.0 takes one. */
  stringInput: string;
}

/** Reads the runtime facts the leg asserts before it trusts any result. */
export async function mcpb6Runtime(page: Page): Promise<Mcpb6Runtime> {
  return page.evaluate(async () => {
    const probe = window.__mcpb6;
    const context = (
      document as unknown as {
        modelContext?: {
          getTools(): Promise<{ name: string }[]>;
          executeTool(tool: object, input: unknown): Promise<unknown>;
        };
      }
    ).modelContext;
    let stringInput = 'no context';
    const tool = (await context?.getTools())?.find((t) => t.name === 'get_view');
    if (context && tool) {
      // The original method, so the recorded calls hold the adapter's alone.
      const execute = Object.getPrototypeOf(context) as typeof context;
      try {
        await execute.executeTool.call(context, tool, '{}');
        stringInput = 'accepted';
      } catch (error) {
        stringInput = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }
    const marker: unknown = context ? Reflect.get(context, '__isWebMCPPolyfill') : null;
    return {
      hadContextBefore: probe?.hadContextBefore ?? true,
      installedOnImport: probe?.installedOnImport ?? true,
      installed: probe?.installed ?? false,
      marker,
      navigatorAlias: 'modelContext' in navigator,
      stringInput,
    };
  });
}
