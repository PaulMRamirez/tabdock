// The sim page's default tools: one of each kind a test needs. get_value is
// read-only, set_value mutating, wipe consequential; echo, slow and fail are
// read-only helpers for arguments, cancellation and handler errors. Handlers
// check their own input, because no runtime validates it (baseline.md).

import type { FakeToolDefinition, FakeToolExecuteOptions } from './fake-model-context.ts';

/** Page state the default tools act on. It lives in the sim page, so it survives reload(). */
export interface SimStore {
  value: string | null;
  /** Each handler run, newest last, so tests can see what reached the page. */
  calls: { tool: string; input: unknown }[];
}

export function createSimStore(): SimStore {
  return { value: null, calls: [] };
}

const READ_ONLY = { readOnlyHint: true };
const MUTATING = { readOnlyHint: false };
const NO_ARGUMENTS = { type: 'object', properties: {}, additionalProperties: false };

function field(input: unknown, key: string): unknown {
  return typeof input === 'object' && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

/** Waits for ms, or rejects at once when a runtime passes a signal and it aborts. */
function wait(ms: number, options: FakeToolExecuteOptions | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function createDefaultTools(store: SimStore): FakeToolDefinition[] {
  const record = (tool: string, input: unknown): void => {
    store.calls.push({ tool, input });
  };
  return [
    {
      name: 'get_value',
      title: 'Get value',
      description: 'Return the current value.',
      inputSchema: NO_ARGUMENTS,
      annotations: READ_ONLY,
      execute: (input) => {
        record('get_value', input);
        return { value: store.value };
      },
    },
    {
      name: 'set_value',
      title: 'Set value',
      description: 'Replace the value with the given text.',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string', maxLength: 1000 } },
        required: ['value'],
        additionalProperties: false,
      },
      annotations: MUTATING,
      execute: (input) => {
        record('set_value', input);
        const value = field(input, 'value');
        if (typeof value !== 'string') throw new Error('value must be a string');
        store.value = value;
        return { value };
      },
    },
    {
      name: 'wipe',
      title: 'Wipe',
      description: 'Clear the value. This cannot be undone.',
      inputSchema: NO_ARGUMENTS,
      annotations: { ...MUTATING, consequentialHint: true },
      execute: (input) => {
        record('wipe', input);
        store.value = null;
        return { wiped: true };
      },
    },
    {
      name: 'echo',
      title: 'Echo',
      description: 'Return the arguments it was given.',
      inputSchema: { type: 'object' },
      annotations: { ...READ_ONLY, untrustedContentHint: true },
      execute: (input) => {
        record('echo', input);
        return input;
      },
    },
    {
      name: 'slow',
      title: 'Slow',
      description:
        'Wait ms milliseconds (default 1000), or until cancelled where the runtime allows.',
      inputSchema: {
        type: 'object',
        properties: { ms: { type: 'integer', minimum: 0, maximum: 600_000 } },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      execute: async (input, options) => {
        record('slow', input);
        const ms = field(input, 'ms');
        const waitMs = typeof ms === 'number' && ms >= 0 ? ms : 1000;
        await wait(waitMs, options);
        return { waitedMs: waitMs };
      },
    },
    {
      name: 'fail',
      title: 'Fail',
      description: 'Throw an error with the given message.',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        additionalProperties: false,
      },
      annotations: READ_ONLY,
      execute: (input) => {
        record('fail', input);
        const message = field(input, 'message');
        throw new Error(typeof message === 'string' ? message : 'fail was asked to fail');
      },
    },
  ];
}
