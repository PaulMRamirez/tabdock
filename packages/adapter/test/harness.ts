// Test doubles for the adapter core: an in-memory socket the test plays the
// relay through, a manual clock, and a small WebMCP runtime whose input form
// and abort behaviour can be switched to match the measured runtimes.

import {
  ATTACH_REQUEST_TTL_MS,
  IDLE_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  PING_INTERVAL_MS,
  RESUME_WINDOW_MS,
  encodeFrame,
  parsePageFrame,
  type PageFrame,
  type RelayFrame,
  type Role,
} from '@tabdock/protocol';
import {
  createAdapterCore,
  type AdapterCore,
  type CoreOptions,
  type Dock,
  type ModelContextLike,
  type RuntimeTool,
  type SocketLike,
  type StorageLike,
  type Timers,
} from '../src/core.ts';

export const RELAY_URL = 'ws://relay.test/page';
export const RESUME_KEY = `tabdock:resume:${RELAY_URL}`;
export const GRANTS_KEY = `tabdock:grants:${RELAY_URL}`;
export const PAGE_WINDOW = { label: 'page window' };
export const FRAME_WINDOW = { label: 'iframe window' };
export const HANDLER_FAILED =
  'Tool was executed but the invocation failed. For example, the script function threw an error';

/** Lets every pending promise chain settle. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly url: string;
  readonly protocols: readonly string[];
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;
  /** Browsers refuse close codes other than 1000 and 3000 to 4999 from page code. */
  readonly browserCloseRules: boolean;

  constructor(url: string, protocols: readonly string[], browserCloseRules = false) {
    this.url = url;
    this.protocols = protocols;
    this.browserCloseRules = browserCloseRules;
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    if (this.browserCloseRules && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('The close code is not allowed', 'InvalidAccessError');
    }
    if (this.readyState >= 2) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  // The relay's side.

  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(frame: RelayFrame | string): void {
    this.onmessage?.({ data: typeof frame === 'string' ? frame : encodeFrame(frame) });
  }

  drop(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  frames(): PageFrame[] {
    return this.sent.map((text) => {
      const parsed = parsePageFrame(text);
      if (parsed.kind !== 'ok') throw new Error(`the adapter sent a ${parsed.kind} frame`);
      return parsed.frame;
    });
  }

  framesOf<T extends PageFrame['t']>(type: T): Extract<PageFrame, { t: T }>[] {
    return this.frames().filter((frame): frame is Extract<PageFrame, { t: T }> => frame.t === type);
  }

  last(): PageFrame | undefined {
    return this.frames().at(-1);
  }
}

export class ManualClock {
  now = Date.UTC(2026, 9, 2, 12, 0, 0);
  readonly #pending = new Map<number, { at: number; callback: () => void }>();
  #nextId = 1;

  readonly clock = (): number => this.now;

  readonly timers: Timers = {
    setTimeout: (callback, ms) => {
      const id = this.#nextId++;
      this.#pending.set(id, { at: this.now + Math.max(0, ms), callback });
      return id;
    },
    clearTimeout: (handle) => {
      if (typeof handle === 'number') this.#pending.delete(handle);
    },
  };

  /** Moves time forward, firing due timers in order and letting promises settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await flush();
    for (;;) {
      let due: { id: number; at: number; callback: () => void } | null = null;
      for (const [id, timer] of this.#pending) {
        if (timer.at <= end && (due === null || timer.at < due.at)) due = { id, ...timer };
      }
      if (due === null) break;
      this.#pending.delete(due.id);
      this.now = Math.max(this.now, due.at);
      due.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

export class MapStorage implements StorageLike {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

type Handler = (input: unknown, signal: AbortSignal) => unknown;

/**
 * A WebMCP runtime for the core. inputForm 'string' plays the polyfill 5.1 and
 * Chrome 153 and 154, 'object' Chrome 155 and later, with their rejection texts.
 */
export class TestContext implements ModelContextLike {
  tools: RuntimeTool[];
  inputForm: 'object' | 'string' = 'object';
  /** When false, executeTool ignores the caller's signal, like a runtime that never settles early. */
  honoursAbort = true;
  readonly handlers = new Map<string, Handler>();
  /** Every executeTool attempt, including ones the runtime rejected for their input form. */
  readonly attempts: { tool: string; input: unknown }[] = [];
  /** Handler runs only. */
  readonly runs: { tool: string; args: unknown; signal: AbortSignal }[] = [];
  readonly #listeners = new Set<() => void>();

  constructor(tools: RuntimeTool[]) {
    this.tools = tools;
  }

  getTools(): Promise<readonly RuntimeTool[]> {
    return Promise.resolve(this.tools.map((tool) => ({ ...tool })));
  }

  async executeTool(
    tool: RuntimeTool,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<unknown> {
    await Promise.resolve();
    this.attempts.push({ tool: tool.name, input });
    if (this.inputForm === 'string' && typeof input !== 'string') {
      throw new DOMException('Failed to parse input arguments', 'UnknownError');
    }
    if (this.inputForm === 'object' && (typeof input !== 'object' || input === null)) {
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': invalid input object: value is not an object",
      );
    }
    const args: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    const handler: Handler = this.handlers.get(tool.name) ?? ((value) => value);
    this.runs.push({ tool: tool.name, args, signal: options.signal });
    const run = Promise.resolve()
      .then(() => handler(args, options.signal))
      .then(
        (value) =>
          typeof value === 'string'
            ? value
            : ((JSON.stringify(value) as string | undefined) ?? String(value)),
        (error: unknown) => {
          // Like the polyfill: a fixed text with the handler's message appended.
          throw new DOMException(
            error instanceof Error ? `${HANDLER_FAILED}: ${error.message}` : HANDLER_FAILED,
            'UnknownError',
          );
        },
      );
    if (!this.honoursAbort) return run;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(new DOMException('signal is aborted without reason', 'AbortError'));
      });
      run.then(resolve, reject);
    });
  }

  addEventListener(_type: 'toolchange', listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: 'toolchange', listener: () => void): void {
    this.#listeners.delete(listener);
  }

  fireToolChange(): void {
    for (const listener of this.#listeners) listener();
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}

/** A getTools() entry as Chrome 156 shapes it, unless annotations say otherwise. */
export function runtimeTool(
  name: string,
  annotations?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): RuntimeTool {
  return {
    annotations,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    name,
    origin: 'http://127.0.0.1:5173',
    title: '',
    window: PAGE_WINDOW,
    ...extra,
  };
}

/** Chrome 154 and later report every hint. */
export function chromeTools(): RuntimeTool[] {
  const hints = (readOnly: boolean, consequential: boolean) => ({
    consequentialHint: consequential,
    readOnlyHint: readOnly,
    untrustedContentHint: false,
  });
  return [
    runtimeTool('get_value', hints(true, false)),
    runtimeTool('set_value', hints(false, false)),
    runtimeTool('wipe', hints(false, true)),
  ];
}

/** The polyfill 5.1 and Chrome 153 keep readOnlyHint and untrustedContentHint only (ADR 0002). */
export function polyfillTools(): RuntimeTool[] {
  const hints = (readOnly: boolean) => ({ readOnlyHint: readOnly, untrustedContentHint: false });
  return [
    runtimeTool('get_value', hints(true)),
    runtimeTool('set_value', hints(false)),
    runtimeTool('wipe', hints(false)),
  ];
}

export interface Harness {
  readonly core: AdapterCore;
  readonly dock: Dock;
  readonly clock: ManualClock;
  readonly context: TestContext;
  readonly storage: MapStorage;
  readonly sockets: FakeSocket[];
  readonly logs: string[];
  /** The newest socket. */
  socket(): FakeSocket;
}

export function setup(
  options: {
    tools?: RuntimeTool[];
    core?: Partial<CoreOptions>;
    browserCloseRules?: boolean;
    /** sessionStorage shared with an earlier harness, to play a page reload. */
    storage?: MapStorage;
  } = {},
): Harness {
  const clock = new ManualClock();
  const context = new TestContext(options.tools ?? chromeTools());
  const storage = options.storage ?? new MapStorage();
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const core = createAdapterCore({
    relayUrl: RELAY_URL,
    modelContext: context,
    socketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols, options.browserCloseRules);
      sockets.push(socket);
      return socket;
    },
    storage,
    pageInfo: () => ({ title: 'Test page', url: 'http://127.0.0.1:5173/board' }),
    ownWindow: PAGE_WINDOW,
    adapterVersion: '0.0.0-test',
    logger: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
      error: (message) => logs.push(`error ${message}`),
    },
    clock: clock.clock,
    timers: clock.timers,
    random: () => 0.5,
    ...options.core,
  });
  return {
    core,
    dock: core.dock,
    clock,
    context,
    storage,
    sockets,
    logs,
    socket() {
      const socket = sockets.at(-1);
      if (!socket) throw new Error('no socket yet');
      return socket;
    },
  };
}

type WelcomeFrame = Extract<RelayFrame, { t: 'welcome' }>;
type AttachRequestFrame = Extract<RelayFrame, { t: 'attach_request' }>;

export function welcome(clock: ManualClock, overrides: Partial<WelcomeFrame> = {}): WelcomeFrame {
  return {
    t: 'welcome',
    pageId: 'page-1',
    resumeToken: 'resume-1',
    resumed: false,
    pairing: { code: 'ABCDE-FGHJK', expiresAt: clock.now + 120_000 },
    roster: [],
    limits: {
      maxFrameBytes: MAX_FRAME_BYTES,
      maxResultChars: MAX_RESULT_CHARS,
      maxDescriptionChars: MAX_DESCRIPTION_CHARS,
      pingIntervalMs: PING_INTERVAL_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      resumeWindowMs: RESUME_WINDOW_MS,
      attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
    },
    ...overrides,
  };
}

/**
 * Starts the core, accepts its socket and welcomes it, then has the operator
 * approve each user in `grants` through the Dock, the way a real attachment
 * starts. Alice, the default caller of invoke(), is a driver unless a test
 * says otherwise; pass {} for a page nobody has approved.
 */
export async function link(
  harness: Harness,
  overrides: Partial<WelcomeFrame> = {},
  grants: Record<string, Role> = { alice: 'driver' },
): Promise<FakeSocket> {
  harness.core.start();
  const socket = harness.socket();
  socket.accept();
  socket.deliver(welcome(harness.clock, overrides));
  await flush();
  for (const [userId, role] of Object.entries(grants)) {
    grant(harness, socket, userId, role);
  }
  return socket;
}

/** An attach request for userId that the operator approves as role through the Dock. */
export function grant(harness: Harness, socket: FakeSocket, userId: string, role: Role): void {
  const requestId = `grant-${userId}`;
  socket.deliver({
    ...attachRequest(harness.clock, requestId),
    user: { userId, displayName: userId.charAt(0).toUpperCase() + userId.slice(1) },
  });
  if (!harness.dock.approve(requestId, role)) throw new Error(`could not approve ${userId}`);
}

/** A roster entry as the relay would send it. */
export function attachment(userId: string, role: Role, grantedAt = 0) {
  return {
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    role,
    grantedAt,
    lastUsedAt: null,
    expiresAt: null,
    clients: [],
  };
}

export function invoke(
  tool: string,
  overrides: Partial<Extract<RelayFrame, { t: 'invoke' }>> = {},
): RelayFrame {
  return {
    t: 'invoke',
    callId: 'call-1',
    tool,
    arguments: {},
    caller: { userId: 'alice', displayName: 'Alice', client: null, role: 'driver' },
    deadlineMs: 45_000,
    ...overrides,
  };
}

export function attachRequest(clock: ManualClock, requestId = 'req-1'): AttachRequestFrame {
  return {
    t: 'attach_request',
    requestId,
    user: { userId: 'bob', displayName: 'Bob' },
    via: 'code',
    client: { name: 'claude-code', version: '2.1.287' },
    expiresAt: clock.now + ATTACH_REQUEST_TTL_MS,
  };
}

/** The result frames a socket carried, in order. */
export function results(socket: FakeSocket) {
  return socket.framesOf('result');
}
