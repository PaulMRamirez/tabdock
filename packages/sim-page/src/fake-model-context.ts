// A stand-in for document.modelContext that behaves like one of the runtimes
// measured in docs/notes/baseline.md (raw files beside it), so relay and
// adapter tests can play each of them in Node. Where the baseline measured a
// behaviour, this copies it exactly, error names and messages included; the
// few unmeasured corners follow the MCP-B polyfill 5.1 source and say so.

/**
 * 'polyfill-5.1' is MCP-B's @mcp-b/webmcp-polyfill 5.1.0, 'chrome-154' native
 * WebMCP in Chrome 153 and 154, 'chrome-156' native WebMCP in Chrome 155 and 156.
 */
export type RuntimeProfile = 'polyfill-5.1' | 'chrome-154' | 'chrome-156';

export const RUNTIME_PROFILES: readonly RuntimeProfile[] = [
  'polyfill-5.1',
  'chrome-154',
  'chrome-156',
];

export interface FakeToolExecuteOptions {
  signal: AbortSignal;
}

/** What a page passes to registerTool(). */
export interface FakeToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema?: object;
  annotations?: Record<string, unknown>;
  /** Chrome passes { signal }; the polyfill passes nothing, so a handler there cannot see cancellation. */
  execute: (input: unknown, options?: FakeToolExecuteOptions) => unknown;
}

export interface FakeRegisterOptions {
  signal?: AbortSignal;
  /**
   * Test hook, not part of WebMCP: register as if from another same-origin
   * frame. Chrome lists such tools in the top page's getTools() with that
   * frame's window, which is why the adapter filters by its own window.
   */
  fromWindow?: object;
}

/** One getTools() entry. Field order follows the profile, as measured. */
export interface FakeRegisteredTool {
  name: string;
  title: string;
  description: string;
  /** A JSON string on chrome-154, an object otherwise. */
  inputSchema?: Record<string, unknown> | string;
  origin: string;
  window: object;
  annotations?: Record<string, boolean>;
}

export interface FakeModelContextOptions {
  profile?: RuntimeProfile;
  /** The page origin getTools() reports; defaults to the sim page's default. */
  origin?: string;
  /** The page's window; any object works, as only identity matters. */
  window?: object;
}

interface Entry {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string;
  /** Kept as JSON, like the polyfill, so each getTools() hands out a fresh copy. */
  readonly schemaJson: string | undefined;
  readonly annotations: Record<string, boolean> | undefined;
  readonly execute: FakeToolDefinition['execute'];
}

const NAME_RULE = /^[A-Za-z0-9_.-]{1,128}$/;

/** Native Chrome hides the handler's message behind this; the polyfill appends it after a colon. */
export const HANDLER_FAILED_TEXT =
  'Tool was executed but the invocation failed. For example, the script function threw an error';

const CHROME_PREFIX = "Failed to execute 'executeTool' on 'ModelContext': ";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownError(message: string): DOMException {
  return new DOMException(message, 'UnknownError');
}

function nextTask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** The string-input runtimes parse with JSON.parse and accept only objects and arrays. */
function parseStringInput(input: unknown): unknown {
  try {
    const value: unknown = JSON.parse(String(input));
    if (typeof value === 'object' && value !== null) return value;
  } catch {
    // Reported below with the runtime's own text.
  }
  throw unknownError('Failed to parse input arguments');
}

/** Every runtime returns a string: JSON for objects, String() for the rest (measured). */
function encodeResult(value: unknown): string {
  if ((typeof value === 'object' && value !== null) || typeof value === 'function') {
    try {
      const json = JSON.stringify(value) as string | undefined;
      if (json) return json;
    } catch {
      // Falls through, as the polyfill does.
    }
  }
  return String(value) || 'Operation succeeded';
}

/** Settles with the promise, or rejects with the signal's reason once it aborts. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise
      .finally(() => {
        signal.removeEventListener('abort', onAbort);
      })
      .then(resolve, reject);
  });
}

export class FakeModelContext extends EventTarget {
  readonly profile: RuntimeProfile;
  readonly origin: string;
  readonly window: object;
  /** Registrations per window, so a frame may reuse a name the top page has. */
  readonly #registry = new Map<object, Map<string, Entry>>();

  constructor(options: FakeModelContextOptions = {}) {
    super();
    this.profile = options.profile ?? 'chrome-156';
    this.origin = options.origin ?? 'http://127.0.0.1:5173';
    this.window = options.window ?? { label: 'sim page window' };
  }

  #tools(window: object): Map<string, Entry> {
    let tools = this.#registry.get(window);
    if (!tools) {
      tools = new Map();
      this.#registry.set(window, tools);
    }
    return tools;
  }

  /** The event fires a task later and before registerTool resolves, as on every measured runtime. */
  async #announce(): Promise<void> {
    await nextTask();
    this.dispatchEvent(new Event('toolchange'));
  }

  #annotations(given: unknown): Record<string, boolean> {
    const hints = isPlainObject(given) ? given : {};
    const readOnlyHint = Boolean(hints.readOnlyHint);
    const untrustedContentHint = Boolean(hints.untrustedContentHint);
    const consequentialHint = Boolean(hints.consequentialHint);
    switch (this.profile) {
      // The polyfill 5.1 drops consequentialHint (ADR 0002).
      case 'polyfill-5.1':
        return { readOnlyHint, untrustedContentHint };
      // Chrome converts a dictionary: every member present, keys in alphabetical order.
      case 'chrome-154':
        return { consequentialHint, readOnlyHint, untrustedContentHint };
      case 'chrome-156':
        return {
          consequentialHint,
          debugging: Boolean(hints.debugging),
          readOnlyHint,
          untrustedContentHint,
        };
    }
  }

  async registerTool(tool: FakeToolDefinition, options: FakeRegisterOptions = {}): Promise<void> {
    const { signal } = options;
    signal?.throwIfAborted();
    // Checks follow the polyfill 5.1 source; the baseline measured only the duplicate case.
    if (typeof tool.name !== 'string' || !NAME_RULE.test(tool.name)) {
      throw new DOMException(
        'Tool "name" must be 1 to 128 characters of ASCII letters, digits, underscore, hyphen or period',
        'InvalidStateError',
      );
    }
    if (typeof tool.description !== 'string' || tool.description === '') {
      throw new DOMException('Tool "description" must be a non-empty string', 'InvalidStateError');
    }
    if (typeof tool.execute !== 'function')
      throw new TypeError('Tool "execute" must be a function');
    const tools = this.#tools(options.fromWindow ?? this.window);
    if (tools.has(tool.name)) {
      throw new DOMException(
        this.profile === 'polyfill-5.1'
          ? `Tool already registered: ${tool.name}`
          : 'Duplicate tool name',
        'InvalidStateError',
      );
    }
    let schemaJson: string | undefined;
    if (tool.inputSchema !== undefined) {
      // Typed as an object, but pages are JavaScript; the runtimes check.
      const schema = tool.inputSchema as unknown;
      if (typeof schema !== 'object' || schema === null) {
        throw new TypeError('inputSchema must be an object');
      }
      schemaJson = JSON.stringify(tool.inputSchema);
    }
    const entry: Entry = {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      schemaJson,
      annotations: tool.annotations === undefined ? undefined : this.#annotations(tool.annotations),
      execute: tool.execute,
    };
    tools.set(tool.name, entry);
    // Aborting the registration signal is how WebMCP unregisters a tool.
    signal?.addEventListener(
      'abort',
      () => {
        if (tools.get(entry.name) !== entry) return;
        tools.delete(entry.name);
        void this.#announce();
      },
      { once: true },
    );
    await this.#announce();
    signal?.throwIfAborted();
  }

  #entryShape(entry: Entry, window: object): FakeRegisteredTool {
    const title = entry.title ?? '';
    const annotations = entry.annotations ? { annotations: { ...entry.annotations } } : {};
    if (this.profile === 'polyfill-5.1') {
      const schema: unknown =
        entry.schemaJson === undefined ? undefined : JSON.parse(entry.schemaJson);
      return {
        name: entry.name,
        title,
        description: entry.description,
        ...(isPlainObject(schema) ? { inputSchema: schema } : {}),
        origin: this.origin,
        window,
        ...annotations,
      };
    }
    let inputSchema: Record<string, unknown> | string | undefined = entry.schemaJson;
    if (this.profile === 'chrome-156' && entry.schemaJson !== undefined) {
      inputSchema = JSON.parse(entry.schemaJson) as Record<string, unknown>;
    }
    return {
      ...annotations,
      description: entry.description,
      ...(inputSchema === undefined ? {} : { inputSchema }),
      name: entry.name,
      origin: this.origin,
      title,
      window,
    };
  }

  /** Sorted by name, not registration order, and asynchronous, as measured. */
  async getTools(): Promise<FakeRegisteredTool[]> {
    const list: FakeRegisteredTool[] = [];
    for (const [window, tools] of this.#registry) {
      for (const entry of tools.values()) list.push(this.#entryShape(entry, window));
    }
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    await nextTask();
    return list;
  }

  /**
   * The input argument is a rest element so that "omitted" can be told apart
   * from undefined: Chrome 154 rejects the former outright.
   */
  executeTool(
    tool: unknown,
    ...rest: [input?: unknown, options?: { signal?: AbortSignal }]
  ): Promise<string> {
    // Promise-returning WebIDL operations report every failure as a rejection.
    return Promise.resolve().then(() =>
      this.profile === 'polyfill-5.1'
        ? this.#executePolyfill(tool, rest[0], rest[1]?.signal)
        : this.#executeChrome(tool, rest.length === 0, rest[0], rest[1]?.signal),
    );
  }

  async #executePolyfill(
    tool: unknown,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (typeof tool !== 'object' || tool === null) {
      throw new TypeError('RegisteredTool must be an object');
    }
    for (const key of ['name', 'description', 'window', 'origin']) {
      if (!(key in tool)) throw new TypeError(`RegisteredTool.${key} is required`);
    }
    const { name, window, origin } = tool as { name: unknown; window: unknown; origin: unknown };
    if (window !== this.window || origin !== this.origin) {
      throw unknownError(`Tool not found: ${String(name)}`);
    }
    signal?.throwIfAborted();
    const entry = this.#tools(this.window).get(String(name));
    if (!entry) throw unknownError(`Tool not found: ${String(name)}`);
    const args = parseStringInput(input);
    signal?.throwIfAborted();
    try {
      // One argument only: the polyfill never hands the handler a signal.
      const value = await raceAbort(
        Promise.resolve().then(() => entry.execute(args)),
        signal,
      );
      return encodeResult(value);
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      throw unknownError(
        error instanceof Error ? `${HANDLER_FAILED_TEXT}: ${error.message}` : HANDLER_FAILED_TEXT,
      );
    }
  }

  async #executeChrome(
    tool: unknown,
    omitted: boolean,
    input: unknown,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    if (omitted && this.profile === 'chrome-154') {
      throw new TypeError(`${CHROME_PREFIX}2 arguments required, but only 1 present.`);
    }
    if (typeof tool !== 'object' || tool === null) {
      throw new TypeError(`${CHROME_PREFIX}parameter 1 is not of type 'RegisteredTool'.`);
    }
    // Dictionary members are read in alphabetical order; the first missing one is reported.
    const record = tool as Record<string, unknown>;
    for (const key of ['description', 'name', 'origin', 'window']) {
      if (record[key] === undefined) {
        throw new TypeError(
          `${CHROME_PREFIX}Failed to read the '${key}' property from 'RegisteredTool': Required member is undefined.`,
        );
      }
    }
    let args: unknown;
    if (this.profile === 'chrome-156') {
      if (input === undefined) args = {};
      else if (typeof input !== 'object' || input === null) {
        throw new TypeError(`${CHROME_PREFIX}invalid input object: value is not an object`);
      } else args = JSON.parse(JSON.stringify(input));
    } else {
      args = parseStringInput(input);
    }
    signal?.throwIfAborted();
    const window = record.window;
    const entry =
      typeof window === 'object' && window !== null
        ? this.#registry.get(window)?.get(String(record.name))
        : undefined;
    if (!entry) throw unknownError(`Tool not found: ${String(record.name)}`);
    // The handler gets its own signal that follows the caller's.
    const handler = new AbortController();
    const forward = (): void => {
      handler.abort(signal?.reason);
    };
    signal?.addEventListener('abort', forward, { once: true });
    try {
      const value = await raceAbort(
        Promise.resolve().then(() => entry.execute(args, { signal: handler.signal })),
        signal,
      );
      return encodeResult(value);
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      // Native Chrome never exposes the handler's message.
      throw unknownError(HANDLER_FAILED_TEXT);
    } finally {
      signal?.removeEventListener('abort', forward);
    }
  }
}
