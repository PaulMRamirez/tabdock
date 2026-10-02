// The adapter core (SPEC.md sections 6 and 8): one page's link to the relay.
// It touches no DOM or browser global, so the browser entry and the Node sim
// page run exactly this code; the socket, the WebMCP runtime, storage, locks,
// timers and the operator's prompts all arrive through CoreOptions.

import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  PageFrameSchema,
  parseRelayFrame,
  PolicySchema,
  PROTOCOL_VERSION,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  RoleSchema,
  SUBPROTOCOL,
  TOOL_POLL_MS,
  truncate,
  type AttachmentView,
  type Caller,
  type ClientInfo,
  type PageErrorCode,
  type PageFrameInput,
  type PageTool,
  type Pairing,
  type PolicyInput,
  type RelayFrame,
  type Role,
  type User,
} from '@tabdock/protocol';
import {
  isConsequential,
  needsHintNotice,
  normaliseTools,
  type RuntimeTool,
  type ToolSnapshot,
} from './tools.ts';

export type { HintSupport, RuntimeTool } from './tools.ts';

// Ports: everything the core needs from its environment.

/** The slice of document.modelContext the adapter uses. It never registers tools. */
export interface ModelContextLike {
  getTools(): Promise<readonly RuntimeTool[]>;
  executeTool?(
    tool: RuntimeTool,
    input: unknown,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
  addEventListener(type: 'toolchange', listener: () => void): void;
  removeEventListener(type: 'toolchange', listener: () => void): void;
}

/**
 * Handlers are declared through a method type so that a browser WebSocket and a
 * `ws` client, whose events carry more than this, are both assignable.
 */
type Handler<E> = { bivarianceHack(event: E): void }['bivarianceHack'];

export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
}

export type SocketFactory = (url: string, protocols: readonly string[]) => SocketLike;

/** sessionStorage fits; it keeps the resume token across a reload but not into a copied tab's future. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** navigator.locks fits. Holding a lock keeps Chrome from freezing the tab while it is linked. */
export interface LocksLike {
  request(name: string, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PageInfo {
  title: string;
  /** Origin plus path only: queries and fragments can carry secrets. */
  url: string;
}

export type AttachAnswer = Role | 'deny';

/**
 * An optional operator that answers prompts in code (a scripted test operator,
 * or a host UI). Returning undefined, or never settling, leaves the prompt to
 * the Dock handle; silence until the deadline denies either way. The signal
 * aborts once the prompt is settled elsewhere or expires.
 */
export interface UiPort {
  askAttach?(
    request: PendingRequest,
    signal: AbortSignal,
  ): AttachAnswer | undefined | Promise<AttachAnswer | undefined>;
  askConfirm?(
    confirm: PendingConfirm,
    signal: AbortSignal,
  ): boolean | undefined | Promise<boolean | undefined>;
}

export interface CoreOptions {
  /** The relay's page endpoint, for example ws://127.0.0.1:8787/page. */
  relayUrl: string;
  policy?: PolicyInput | undefined;
  /** document.modelContext; without it the core logs how to add a polyfill and stays idle. */
  modelContext?: ModelContextLike | undefined;
  socketFactory: SocketFactory;
  storage?: StorageLike | undefined;
  ui?: UiPort | undefined;
  pageInfo: () => PageInfo;
  /** When getTools() entries carry a window, only those whose window is this one are shared. */
  ownWindow?: unknown;
  locks?: LocksLike | undefined;
  adapterVersion: string;
  logger?: Logger | undefined;
  /** Epoch milliseconds; injectable with timers and random so tests control time. */
  clock?: (() => number) | undefined;
  timers?: Timers | undefined;
  random?: (() => number) | undefined;
}

// What the page sees.

export type LinkState = 'idle' | 'connecting' | 'linked' | 'reconnecting' | 'closed';

export interface PendingRequest {
  readonly requestId: string;
  readonly user: User;
  readonly via: 'code' | 'qr';
  readonly client: ClientInfo | null;
  /** Local epoch milliseconds at which silence becomes a denial. */
  readonly expiresAt: number;
}

export interface PendingConfirm {
  readonly callId: string;
  readonly tool: string;
  readonly caller: Caller;
  /** Local epoch milliseconds at which silence becomes a denial (the call's deadline). */
  readonly expiresAt: number;
}

export interface DockState {
  readonly link: LinkState;
  readonly pageId: string | null;
  readonly pairing: Pairing | null;
  readonly roster: readonly AttachmentView[];
  readonly pendingRequests: readonly PendingRequest[];
  readonly pendingConfirms: readonly PendingConfirm[];
  /** Advice for the page author, such as the consequentialHint fallback (ADR 0002). */
  readonly notice: string | null;
  /** Why the link is not working, when it is not. */
  readonly error: string | null;
}

/** The only control handle. Each method returns false when there was nothing to act on. */
export interface Dock {
  readonly state: DockState;
  on(event: 'state', listener: (state: DockState) => void): () => void;
  approve(requestId: string, role: Role): boolean;
  deny(requestId: string): boolean;
  confirm(callId: string, allow: boolean): boolean;
  rotatePairing(): boolean;
  close(): void;
}

/**
 * 'detach' is a deliberate goodbye: pending prompts are denied, the socket
 * closes with 1000 and the resume token is forgotten. 'unload' is what a page
 * reload looks like to the relay: the socket goes away (1001) and the token
 * stays, so the next page load resumes.
 */
export type CloseMode = 'detach' | 'unload';

export interface AdapterCore {
  readonly dock: Dock;
  start(): void;
  close(mode?: CloseMode): void;
}

// Behaviour constants local to the adapter.

const OPEN = 1;

/** toolchange fires once per registration, so a page registering six tools at once should cost one frame. */
const TOOLCHANGE_DEBOUNCE_MS = 25;

/** A link that hears nothing for the relay's idle timeout plus this grace is treated as dead. */
const SILENCE_GRACE_MS = 5000;

/** Results are cut this far under the cap so the truncation marker fits under it too. */
const MARKER_ROOM = 100;

/** The protocol caps result error messages at this length. */
const MAX_ERROR_CHARS = 2000;

/** The smallest frame limit honoured from a relay, so a truncated result always fits. */
const MIN_FRAME_BYTES = 4096;

const RESUME_KEY_PREFIX = 'tabdock:resume:';
const LOCK_PREFIX = 'tabdock:';

const POLYFILL_HINT =
  'document.modelContext is missing, so Tabdock stays idle. Load a WebMCP polyfill first ' +
  "(for example @mcp-b/webmcp-polyfill's initializeWebMCPPolyfill()) or use a browser with WebMCP enabled.";

const HINT_NOTICE =
  "This browser's WebMCP does not report consequentialHint, so every tool that is not read-only " +
  'is treated as consequential. List the consequential tools in policy.consequentialTools to fix this.';

/** Close code the relay uses when a newer connection took over this page. */
const CLOSE_REPLACED = 4001;
const CLOSE_INVALID_FRAME = 1008;
/** Browsers refuse to send 1008 from page code, so they send this instead. */
const CLOSE_INVALID_FRAME_BROWSER = 4008;
const CLOSE_SILENT = 4000;

type InvokeFrame = Extract<RelayFrame, { t: 'invoke' }>;
type WelcomeFrame = Extract<RelayFrame, { t: 'welcome' }>;
type AttachRequestFrame = Extract<RelayFrame, { t: 'attach_request' }>;

type Outcome = { ok: true; content: string } | { ok: false; code: PageErrorCode; message: string };

interface CallRecord {
  readonly frame: InvokeFrame;
  /** Local epoch milliseconds of the call's deadline. */
  readonly deadlineAt: number;
  readonly controller: AbortController;
  finished: boolean;
  deadline: unknown;
  /** Set while the call waits for the operator's confirmation. */
  confirm: { readonly resolve: (allow: boolean) => void; readonly port: AbortController } | null;
}

interface RequestRecord {
  readonly request: PendingRequest;
  readonly timer: unknown;
  readonly port: AbortController;
}

const consoleLogger: Logger = {
  info: (message) => {
    console.info(`[tabdock] ${message}`);
  },
  warn: (message) => {
    console.warn(`[tabdock] ${message}`);
  },
  error: (message) => {
    console.error(`[tabdock] ${message}`);
  },
};

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function errorParts(error: unknown): { name: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return {
      name: typeof name === 'string' ? name : 'Error',
      message: typeof message === 'string' ? message : '',
    };
  }
  return { name: typeof error, message: String(error) };
}

/** For logs about the adapter's own plumbing only; tool errors are never logged, as they can echo arguments. */
function describe(error: unknown): string {
  const { name, message } = errorParts(error);
  return `${name}: ${message}`.slice(0, 200);
}

/**
 * Exponential backoff with jitter, kept inside RECONNECT_MIN_MS and
 * RECONNECT_MAX_MS: attempt n waits between half and all of min * 2^n.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const ceiling = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(attempt, 16));
  const delay = ceiling / 2 + random() * (ceiling / 2);
  return Math.round(Math.min(RECONNECT_MAX_MS, Math.max(RECONNECT_MIN_MS, delay)));
}

/** Runtimes hand back strings; anything else is stringified the way they would. */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    try {
      const json = JSON.stringify(value) as string | undefined;
      if (json !== undefined) return json;
    } catch {
      // Falls through to String, as the runtimes do for unserialisable values.
    }
  }
  return String(value);
}

/**
 * Which executeTool input form a rejection asks for instead (ADR 0001), or null
 * when the rejection is about something else. Matching the start of the
 * message matters: a handler's own error is appended to a different fixed text
 * on the polyfill and may mention parsing too, and retrying it would run a
 * mutating handler twice.
 */
function otherInputFormat(error: unknown, tried: InputFormat): InputFormat | null {
  const { name, message } = errorParts(error);
  if (tried === 'object' && name === 'UnknownError' && /^Failed to parse input/i.test(message)) {
    return 'string';
  }
  if (tried === 'string' && name === 'TypeError' && /invalid input object/i.test(message)) {
    return 'object';
  }
  return null;
}

type InputFormat = 'object' | 'string';

/** A relay URL the core can dial, or a TypeError: retrying a malformed URL forever helps nobody. */
function checkRelayUrl(relayUrl: string): void {
  let protocol = '';
  try {
    protocol = new URL(relayUrl).protocol;
  } catch {
    // Reported below.
  }
  if (protocol !== 'ws:' && protocol !== 'wss:') {
    throw new TypeError('the relay URL must be a ws: or wss: URL');
  }
}

export function createAdapterCore(options: CoreOptions): AdapterCore {
  checkRelayUrl(options.relayUrl);
  // A bad policy is a page bug; throwing here surfaces it at attach().
  const policy = PolicySchema.parse(options.policy ?? {});
  const pageListedTools = options.policy?.consequentialTools !== undefined;
  const context = options.modelContext;
  const log = options.logger ?? consoleLogger;
  const clock = options.clock ?? (() => Date.now());
  const timers = options.timers ?? defaultTimers;
  const random = options.random ?? Math.random;
  const resumeKey = `${RESUME_KEY_PREFIX}${options.relayUrl}`;

  let state: DockState = Object.freeze({
    link: 'idle',
    pageId: null,
    pairing: null,
    roster: [],
    pendingRequests: [],
    pendingConfirms: [],
    notice: null,
    error: null,
  });
  const listeners = new Set<(state: DockState) => void>();

  let started = false;
  let closed = false;
  let socket: SocketLike | null = null;
  let welcomed = false;
  let attempt = 0;
  let reconnectTimer: unknown = null;
  let watchdogTimer: unknown = null;
  let pollTimer: unknown = null;
  let syncTimer: unknown = null;
  let syncing: Promise<void> | null = null;
  let syncAgain = false;
  let lastToolsKey: string | null = null;
  let lastProblemsKey = '';
  let inputFormat: InputFormat | null = null;
  let frameLimit = MAX_FRAME_BYTES;
  let resultLimit = MAX_RESULT_CHARS;
  let silenceLimit = IDLE_TIMEOUT_MS + SILENCE_GRACE_MS;
  let lock: { release: () => void } | null = null;
  const calls = new Map<string, CallRecord>();
  const requests = new Map<string, RequestRecord>();

  function setState(patch: Partial<DockState>): void {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch (error) {
        log.error(`a state listener threw: ${describe(error)}`);
      }
    }
  }

  // Storage can throw (blocked cookies, sandboxed frames); the link still works without it.
  function readToken(): string | null {
    try {
      return options.storage?.getItem(resumeKey) ?? null;
    } catch {
      return null;
    }
  }

  function writeToken(token: string | null): void {
    try {
      if (token === null) options.storage?.removeItem(resumeKey);
      else options.storage?.setItem(resumeKey, token);
    } catch (error) {
      log.warn(`could not store the resume token: ${describe(error)}`);
    }
  }

  function send(frame: PageFrameInput): boolean {
    const sock = socket;
    if (sock?.readyState !== OPEN) return false;
    const checked = PageFrameSchema.safeParse(frame);
    if (!checked.success) {
      const where = checked.error.issues.map((issue) => issue.path.join('.')).join(', ');
      log.error(`not sending an invalid ${frame.t} frame (${where})`);
      return false;
    }
    const text = encodeFrame(frame);
    const size = byteLength(text);
    if (size > frameLimit) {
      log.error(
        `not sending a ${frame.t} frame of ${size} bytes, over the ${frameLimit} byte limit`,
      );
      return false;
    }
    try {
      sock.send(text);
      return true;
    } catch (error) {
      log.warn(`could not send a ${frame.t} frame: ${describe(error)}`);
      return false;
    }
  }

  function isLinked(): boolean {
    return welcomed && socket !== null && !closed;
  }

  // Connection lifecycle

  function connect(): void {
    reconnectTimer = null;
    if (closed) return;
    if (state.link === 'idle') setState({ link: 'connecting' });
    let sock: SocketLike;
    try {
      sock = options.socketFactory(options.relayUrl, [SUBPROTOCOL]);
    } catch (error) {
      log.warn(`could not open a socket to the relay: ${describe(error)}`);
      scheduleReconnect();
      return;
    }
    socket = sock;
    welcomed = false;
    // Covers a handshake that never completes as well as a relay that goes quiet.
    armWatchdog();
    sock.onopen = () => {
      if (sock === socket) onOpen();
    };
    sock.onmessage = (event) => {
      if (sock === socket) onMessage(event.data);
    };
    sock.onclose = (event) => {
      if (sock === socket) onClose(event.code, event.reason);
    };
    // Errors are always followed by close, which is where reconnecting happens.
    sock.onerror = () => undefined;
  }

  function detach(sock: SocketLike): void {
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    // Stays a function: a `ws` client with no error listener crashes Node on a late error.
    sock.onerror = () => undefined;
  }

  function closeSocket(sock: SocketLike, code: number, reason: string): void {
    detach(sock);
    try {
      sock.close(code, reason);
      return;
    } catch {
      // Browsers only let page code send 1000 or 3000 to 4999.
    }
    try {
      sock.close(code === CLOSE_INVALID_FRAME ? CLOSE_INVALID_FRAME_BROWSER : 1000, reason);
    } catch {
      // Already closing.
    }
  }

  function onOpen(): void {
    const token = readToken();
    const page = options.pageInfo();
    armWatchdog();
    send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      ...(token === null ? {} : { resumeToken: token }),
      title: page.title.slice(0, 300),
      url: page.url.slice(0, 2048),
      adapterVersion: options.adapterVersion.slice(0, 50),
      policy,
    });
  }

  function onMessage(data: unknown): void {
    armWatchdog();
    if (typeof data !== 'string') {
      protocolError('a binary frame');
      return;
    }
    if (data.length > MAX_FRAME_BYTES) {
      protocolError('an oversized frame');
      return;
    }
    const parsed = parseRelayFrame(data);
    if (parsed.kind === 'unknown') {
      log.info(`ignored a relay frame of unknown type ${JSON.stringify(parsed.type)}`);
      return;
    }
    if (parsed.kind === 'invalid') {
      protocolError(parsed.reason);
      return;
    }
    onFrame(parsed.frame);
  }

  function protocolError(reason: string): void {
    log.warn(`the relay sent ${reason}; reconnecting`);
    dropLink(CLOSE_INVALID_FRAME, 'invalid frame');
  }

  function onFrame(frame: RelayFrame): void {
    if (frame.t === 'ping') {
      send({ t: 'pong' });
      return;
    }
    if (frame.t === 'pong') return;
    if (frame.t === 'welcome') {
      onWelcome(frame);
      return;
    }
    if (!welcomed) {
      log.warn(`ignored a ${frame.t} frame that arrived before welcome`);
      return;
    }
    switch (frame.t) {
      case 'attach_request':
        onAttachRequest(frame);
        return;
      case 'roster':
        setState({ roster: frame.attachments });
        return;
      case 'pairing':
        setState({
          pairing: {
            code: frame.code,
            expiresAt: frame.expiresAt,
            ...(frame.url === undefined ? {} : { url: frame.url }),
          },
        });
        return;
      case 'invoke':
        onInvoke(frame);
        return;
      case 'cancel':
        onCancel(frame.callId);
        return;
    }
  }

  function onWelcome(frame: WelcomeFrame): void {
    if (welcomed) {
      log.warn('ignored a second welcome on the same link');
      return;
    }
    welcomed = true;
    attempt = 0;
    writeToken(frame.resumeToken);
    frameLimit = Math.max(MIN_FRAME_BYTES, Math.min(MAX_FRAME_BYTES, frame.limits.maxFrameBytes));
    resultLimit = Math.max(
      MARKER_ROOM * 2,
      Math.min(MAX_RESULT_CHARS, frame.limits.maxResultChars),
    );
    // Never shorter than the protocol's own: a tiny value would turn the watchdog into a reconnect loop.
    silenceLimit = Math.max(IDLE_TIMEOUT_MS, frame.limits.idleTimeoutMs) + SILENCE_GRACE_MS;
    armWatchdog();
    setState({
      link: 'linked',
      pageId: frame.pageId,
      pairing: frame.pairing,
      roster: frame.roster,
      error: null,
    });
    log.info(frame.resumed ? `resumed page ${frame.pageId}` : `linked as page ${frame.pageId}`);
    takeLock(frame.pageId);
    lastToolsKey = null;
    void syncTools();
    schedulePoll();
  }

  function onClose(code: number, reason: string): void {
    const sock = socket;
    if (sock) detach(sock);
    socket = null;
    tearDownLink();
    if (closed) return;
    if (code === CLOSE_REPLACED) {
      stopForGood('Another connection took over this page (close code 4001), so this tab stopped.');
      log.warn('the relay replaced this link with a newer one; not reconnecting');
      return;
    }
    log.info(`the relay link closed (${code}${reason ? ` ${reason.slice(0, 100)}` : ''})`);
    scheduleReconnect();
  }

  /** Ends the current link from this side and tries again later. */
  function dropLink(code: number, reason: string): void {
    const sock = socket;
    if (!sock) return;
    socket = null;
    closeSocket(sock, code, reason);
    tearDownLink();
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (closed || reconnectTimer !== null) return;
    const delay = backoffDelay(attempt, random);
    attempt += 1;
    if (state.link !== 'reconnecting') setState({ link: 'reconnecting' });
    reconnectTimer = timers.setTimeout(connect, delay);
  }

  function armWatchdog(): void {
    timers.clearTimeout(watchdogTimer);
    watchdogTimer = timers.setTimeout(() => {
      watchdogTimer = null;
      log.warn('heard nothing from the relay for too long; reconnecting');
      dropLink(CLOSE_SILENT, 'relay silent');
    }, silenceLimit);
  }

  /** Everything tied to one socket ends with it; the relay answers waiting callers itself. */
  function tearDownLink(): void {
    welcomed = false;
    for (const handle of [watchdogTimer, pollTimer, syncTimer]) timers.clearTimeout(handle);
    watchdogTimer = null;
    pollTimer = null;
    syncTimer = null;
    releaseLock();
    for (const call of calls.values()) {
      call.finished = true;
      timers.clearTimeout(call.deadline);
      call.controller.abort();
      settleConfirmPromise(call, false);
    }
    calls.clear();
    for (const record of requests.values()) {
      timers.clearTimeout(record.timer);
      record.port.abort();
    }
    requests.clear();
    setState({ pairing: null, pendingRequests: [], pendingConfirms: [] });
  }

  function stopForGood(error: string | null): void {
    closed = true;
    timers.clearTimeout(reconnectTimer);
    reconnectTimer = null;
    context?.removeEventListener('toolchange', onToolChange);
    setState({ link: 'closed', error });
  }

  // Web Lock: held while linked.

  function takeLock(pageId: string): void {
    const locks = options.locks;
    if (!locks || lock) return;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    lock = { release };
    locks
      .request(`${LOCK_PREFIX}${pageId}`, () => held)
      .catch((error: unknown) => {
        log.warn(`could not hold a Web Lock: ${describe(error)}`);
      });
  }

  function releaseLock(): void {
    lock?.release();
    lock = null;
  }

  // Tool sync

  function onToolChange(): void {
    if (syncTimer !== null) return;
    syncTimer = timers.setTimeout(() => {
      syncTimer = null;
      void syncTools();
    }, TOOLCHANGE_DEBOUNCE_MS);
  }

  function schedulePoll(): void {
    pollTimer = timers.setTimeout(() => {
      pollTimer = null;
      if (!isLinked()) return;
      void syncTools();
      schedulePoll();
    }, TOOL_POLL_MS);
  }

  // A function, not an inline test: the flag changes while syncOnce awaits.
  function shouldSyncAgain(): boolean {
    return syncAgain && !closed;
  }

  /** One sync at a time; a request during a sync runs one more afterwards. */
  function syncTools(): Promise<void> {
    if (syncing) {
      syncAgain = true;
      return syncing;
    }
    syncing = (async () => {
      do {
        syncAgain = false;
        await syncOnce();
      } while (shouldSyncAgain());
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }

  async function readTools(): Promise<ToolSnapshot | null> {
    if (!context) return null;
    let list: readonly RuntimeTool[];
    try {
      const value = await context.getTools();
      list = Array.isArray(value) ? value : [];
    } catch (error) {
      log.warn(`getTools() failed: ${describe(error)}`);
      return null;
    }
    const snapshot = normaliseTools(list, options.ownWindow);
    const problemsKey = snapshot.problems.join('\n');
    if (problemsKey !== lastProblemsKey) {
      lastProblemsKey = problemsKey;
      for (const problem of snapshot.problems) log.warn(problem);
    }
    const notice = needsHintNotice(snapshot.hintSupport, policy, pageListedTools)
      ? HINT_NOTICE
      : null;
    if (notice !== state.notice) setState({ notice });
    return snapshot;
  }

  async function syncOnce(): Promise<void> {
    if (!isLinked()) return;
    const snapshot = await readTools();
    if (!snapshot || !isLinked()) return;
    const tools = fitTools(snapshot.tools.map((tool) => tool.page));
    const key = JSON.stringify(tools);
    if (key === lastToolsKey) return;
    if (send({ t: 'tools', tools })) lastToolsKey = key;
  }

  /** Drops tools from the end until the frame fits; only a page with huge schemas gets here. */
  function fitTools(tools: PageTool[]): PageTool[] {
    let fitted = tools;
    while (
      fitted.length > 0 &&
      byteLength(encodeFrame({ t: 'tools', tools: fitted })) > frameLimit
    ) {
      fitted = fitted.slice(0, -1);
    }
    if (fitted.length < tools.length) {
      log.warn(`shared ${fitted.length} of ${tools.length} tools to stay under the frame limit`);
    }
    return fitted;
  }

  // Calls

  function onInvoke(frame: InvokeFrame): void {
    if (calls.has(frame.callId)) {
      log.warn(`ignored a repeated invoke for call ${frame.callId}`);
      return;
    }
    const call: CallRecord = {
      frame,
      deadlineAt: clock() + frame.deadlineMs,
      controller: new AbortController(),
      finished: false,
      deadline: null,
      confirm: null,
    };
    calls.set(frame.callId, call);
    call.deadline = timers.setTimeout(() => {
      onDeadline(call);
    }, frame.deadlineMs);
    void runCall(call);
  }

  function onDeadline(call: CallRecord): void {
    if (call.finished) return;
    if (call.confirm) {
      // S6: an unanswered confirmation is a denial, not a timeout.
      finish(call, {
        ok: false,
        code: 'denied_by_operator',
        message: 'the operator did not confirm in time',
      });
      return;
    }
    call.controller.abort();
    finish(call, { ok: false, code: 'timeout', message: 'the page did not answer in time' });
  }

  function onCancel(callId: string): void {
    const call = calls.get(callId);
    if (!call) return;
    call.controller.abort();
    finish(call, { ok: false, code: 'cancelled', message: 'the call was cancelled' });
  }

  function finish(call: CallRecord, outcome: Outcome): void {
    if (call.finished) return;
    call.finished = true;
    timers.clearTimeout(call.deadline);
    calls.delete(call.frame.callId);
    settleConfirmPromise(call, false);
    const { caller, tool, callId } = call.frame;
    // S7 attribution; never the arguments, the result or the error text.
    log.info(
      `call ${callId} ${tool} by ${caller.displayName} (${caller.role}): ${outcome.ok ? 'ok' : outcome.code}`,
    );
    if (outcome.ok) {
      send(resultFrame(callId, outcome.content));
    } else {
      send({
        t: 'result',
        callId,
        ok: false,
        error: { code: outcome.code, message: outcome.message.slice(0, MAX_ERROR_CHARS) },
      });
    }
  }

  /** Cuts the text to the result limit, then further if JSON escaping or UTF-8 still overflow the frame. */
  function resultFrame(callId: string, content: string): PageFrameInput {
    let max = content.length > resultLimit ? resultLimit - MARKER_ROOM : content.length;
    for (;;) {
      const text = max >= content.length ? content : truncate(content, max).text;
      const frame = { t: 'result', callId, ok: true, content: text } as const;
      const size = byteLength(encodeFrame(frame));
      if (size <= frameLimit || max === 0) return frame;
      max = Math.floor(Math.min(max, content.length) * (frameLimit / size) * 0.9);
    }
  }

  // A function, not an inline test: a cancel or deadline can finish the call while runCall awaits.
  function isDone(call: CallRecord): boolean {
    return call.finished;
  }

  async function runCall(call: CallRecord): Promise<void> {
    const { frame } = call;
    const snapshot = await readTools();
    if (isDone(call)) return;
    if (!snapshot) {
      finish(call, { ok: false, code: 'tool_error', message: 'the page could not list its tools' });
      return;
    }
    const tool = snapshot.byName.get(frame.tool);
    if (!tool) {
      finish(call, { ok: false, code: 'tool_not_found', message: `no tool named ${frame.tool}` });
      return;
    }
    // S5, second check: the relay already enforced the role; a crafted invoke must still fail
    // here. The stricter of the claimed role and the roster's wins.
    const listed = state.roster.find((attachment) => attachment.userId === frame.caller.userId);
    const observer = frame.caller.role === 'observer' || listed?.role === 'observer';
    if (observer && tool.page.annotations?.readOnlyHint !== true) {
      finish(call, {
        ok: false,
        code: 'role_denied',
        message: 'observers may only run read-only tools',
      });
      return;
    }
    if (isConsequential(tool.page, snapshot.hintSupport, policy, pageListedTools)) {
      if (policy.consequential === 'deny') {
        finish(call, {
          ok: false,
          code: 'denied_by_operator',
          message: 'this page does not run consequential tools',
        });
        return;
      }
      if (policy.consequential === 'confirm') {
        const allowed = await askConfirm(call);
        if (isDone(call)) return;
        if (!allowed) {
          finish(call, {
            ok: false,
            code: 'denied_by_operator',
            message: 'the operator denied this call',
          });
          return;
        }
      }
    }
    let value: unknown;
    try {
      value = await execute(tool.runtime, frame.arguments, call.controller.signal);
    } catch (error) {
      // A cancel or deadline already answered; whatever the runtime says now is dropped.
      if (isDone(call)) return;
      finish(call, { ok: false, code: 'tool_error', message: errorParts(error).message });
      return;
    }
    if (isDone(call)) return;
    finish(call, { ok: true, content: resultText(value) });
  }

  /**
   * ADR 0001: the input form flipped between Chrome 154 and 155, and the
   * polyfill 5.1 takes a string. Try the remembered form (an object at first)
   * and switch once when the runtime rejects it for its form; such a rejection
   * comes before the handler runs, so the retry cannot run it twice.
   */
  async function execute(
    tool: RuntimeTool,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!context?.executeTool) throw new Error('this WebMCP runtime has no executeTool');
    const run = (format: InputFormat): Promise<unknown> =>
      context.executeTool
        ? context.executeTool(tool, format === 'string' ? JSON.stringify(args) : args, {
            signal,
          })
        : Promise.reject(new Error('this WebMCP runtime has no executeTool'));
    const first = inputFormat ?? 'object';
    try {
      const value = await run(first);
      inputFormat ??= first;
      return value;
    } catch (error) {
      const other = signal.aborted ? null : otherInputFormat(error, first);
      if (other === null) throw error;
      inputFormat = other;
      log.info(
        `this runtime takes executeTool input as ${other === 'string' ? 'a JSON string' : 'an object'}`,
      );
      return run(other);
    }
  }

  function askConfirm(call: CallRecord): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const { callId, tool, caller } = call.frame;
      const pending: PendingConfirm = Object.freeze({
        callId,
        tool,
        caller,
        expiresAt: call.deadlineAt,
      });
      const port = new AbortController();
      call.confirm = { resolve, port };
      setState({ pendingConfirms: [...state.pendingConfirms, pending] });
      const ui = options.ui;
      if (!ui?.askConfirm) return;
      Promise.resolve()
        .then(() => ui.askConfirm?.(pending, port.signal))
        .then(
          (answer) => {
            if (typeof answer === 'boolean') confirmCall(callId, answer);
          },
          (error: unknown) => {
            log.warn(`the UI port failed to ask for a confirmation: ${describe(error)}`);
          },
        );
    });
  }

  function settleConfirmPromise(call: CallRecord, allow: boolean): void {
    const confirm = call.confirm;
    if (!confirm) return;
    call.confirm = null;
    confirm.port.abort();
    setState({
      pendingConfirms: state.pendingConfirms.filter((item) => item.callId !== call.frame.callId),
    });
    confirm.resolve(allow);
  }

  function confirmCall(callId: string, allow: boolean): boolean {
    const call = calls.get(callId);
    if (!call?.confirm || call.finished) return false;
    settleConfirmPromise(call, allow);
    return true;
  }

  // Attach requests

  function onAttachRequest(frame: AttachRequestFrame): void {
    if (requests.has(frame.requestId)) return;
    const now = clock();
    // The relay's clock may differ from this one; never wait longer than a request can live.
    const expiresAt = Math.min(frame.expiresAt, now + ATTACH_REQUEST_TTL_MS);
    const request: PendingRequest = Object.freeze({
      requestId: frame.requestId,
      user: frame.user,
      via: frame.via,
      client: frame.client,
      expiresAt,
    });
    const port = new AbortController();
    const timer = timers.setTimeout(
      () => {
        decide(frame.requestId, false);
      },
      Math.max(0, expiresAt - now),
    );
    requests.set(frame.requestId, { request, timer, port });
    setState({ pendingRequests: [...state.pendingRequests, request] });
    log.info(`attach request from ${frame.user.displayName} via ${frame.via}`);
    const ui = options.ui;
    if (!ui?.askAttach) return;
    Promise.resolve()
      .then(() => ui.askAttach?.(request, port.signal))
      .then(
        (answer) => {
          if (answer === 'deny') decide(frame.requestId, false);
          else if (answer !== undefined) decide(frame.requestId, true, answer);
        },
        (error: unknown) => {
          log.warn(`the UI port failed to ask about an attach request: ${describe(error)}`);
        },
      );
  }

  function decide(requestId: string, allow: boolean, role?: Role): boolean {
    const record = requests.get(requestId);
    if (!record) return false;
    if (allow && !RoleSchema.safeParse(role).success) {
      log.warn('ignored an approval without a valid role');
      return false;
    }
    requests.delete(requestId);
    timers.clearTimeout(record.timer);
    record.port.abort();
    setState({
      pendingRequests: state.pendingRequests.filter((item) => item.requestId !== requestId),
    });
    const who = record.request.user.displayName;
    log.info(allow ? `allowed ${who} as ${String(role)}` : `denied ${who}`);
    return send({
      t: 'attach_decision',
      requestId,
      allow,
      ...(allow && role !== undefined ? { role } : {}),
    });
  }

  // Public surface

  function start(): void {
    if (started || closed) return;
    started = true;
    if (!context) {
      log.error(POLYFILL_HINT);
      setState({ error: POLYFILL_HINT });
      return;
    }
    context.addEventListener('toolchange', onToolChange);
    connect();
  }

  function close(mode: CloseMode = 'detach'): void {
    if (closed) return;
    if (mode === 'detach' && isLinked()) {
      for (const requestId of [...requests.keys()]) decide(requestId, false);
      for (const call of [...calls.values()]) {
        if (call.confirm) {
          finish(call, {
            ok: false,
            code: 'denied_by_operator',
            message: 'the page detached',
          });
        } else {
          call.controller.abort();
          finish(call, { ok: false, code: 'cancelled', message: 'the page detached' });
        }
      }
    }
    const sock = socket;
    socket = null;
    if (sock) {
      closeSocket(sock, mode === 'detach' ? 1000 : 1001, mode === 'detach' ? 'detached' : 'unload');
    }
    tearDownLink();
    if (mode === 'detach') writeToken(null);
    stopForGood(null);
  }

  const dock: Dock = Object.freeze({
    get state() {
      return state;
    },
    on(event: 'state', listener: (state: DockState) => void) {
      if ((event as string) !== 'state') throw new TypeError('a Dock only emits state events');
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    approve: (requestId: string, role: Role) => decide(requestId, true, role),
    deny: (requestId: string) => decide(requestId, false),
    // Strictly true: a script passing the string 'false' must not allow a consequential call.
    confirm: (callId: string, allow: boolean) => confirmCall(callId, (allow as unknown) === true),
    rotatePairing: () => isLinked() && send({ t: 'rotate_pairing' }),
    close: () => {
      close('detach');
    },
  });

  return Object.freeze({ dock, start, close });
}
