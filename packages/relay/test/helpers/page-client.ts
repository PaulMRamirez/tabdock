// A minimal page for tests: speaks the page link over `ws` with whatever Origin
// header (or none) a test asks for, records every frame, and can answer
// invokes automatically. It is deliberately not the adapter, so relay tests do
// not depend on adapter behaviour.

import {
  encodeFrame,
  type PageFrameInput,
  type PageTool,
  parseRelayFrame,
  type PolicyInput,
  type RelayFrame,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import WebSocket from 'ws';

export const PAGE_ORIGIN = 'http://localhost:5173';

export type RelayFrameOf<T extends RelayFrame['t']> = Extract<RelayFrame, { t: T }>;
export type InvokeFrame = RelayFrameOf<'invoke'>;
export type InvokeReply =
  { ok: true; content: string } | { ok: false; error: { code: string; message: string } };

export class UpgradeRefused extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`upgrade refused with HTTP ${String(status)}`);
    this.status = status;
  }
}

export interface SocketOptions {
  /** null sends no Origin header at all. */
  origin?: string | null;
  protocols?: string[];
  /**
   * Another loopback address to connect from, such as 127.0.0.2, so a test can
   * stand for a second remote address; per-address limits count by it.
   */
  localAddress?: string;
  /** Extra request headers, such as the Host a tunnel would forward. */
  headers?: Record<string, string>;
}

/** Opens a page socket; rejects with UpgradeRefused when the relay answers with an HTTP status. */
export function openSocket(url: string, options: SocketOptions = {}): Promise<WebSocket> {
  const origin = options.origin === undefined ? PAGE_ORIGIN : options.origin;
  const ws = new WebSocket(url, options.protocols ?? [SUBPROTOCOL], {
    ...(origin === null ? {} : { origin }),
    ...(options.localAddress === undefined ? {} : { localAddress: options.localAddress }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  return new Promise((resolve, reject) => {
    ws.once('open', () => {
      resolve(ws);
    });
    ws.once('unexpected-response', (request, response) => {
      ws.on('error', () => {
        // Expected once the refused request is torn down.
      });
      reject(new UpgradeRefused(response.statusCode ?? 0));
      request.destroy();
    });
    ws.once('error', reject);
  });
}

export interface PageOptions extends SocketOptions {
  title?: string;
  url?: string;
  resumeToken?: string;
  policy?: PolicyInput;
  tools?: PageTool[];
  onInvoke?: (frame: InvokeFrame) => InvokeReply | undefined | Promise<InvokeReply | undefined>;
  /** Answer the relay's pings; on by default. */
  autoPong?: boolean;
}

export class TestPage {
  readonly ws: WebSocket;
  /** Every frame from the relay, in order. */
  readonly received: RelayFrame[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  welcome: RelayFrameOf<'welcome'> | null = null;
  /** The newest pairing code the relay sent, as displayed. */
  code = '';
  onInvoke: PageOptions['onInvoke'];
  readonly #autoPong: boolean;
  readonly #queue: RelayFrame[] = [];
  readonly #waiters: { type: string; resolve: (frame: RelayFrame) => void }[] = [];

  constructor(ws: WebSocket, options: PageOptions = {}) {
    this.ws = ws;
    this.onInvoke = options.onInvoke;
    this.#autoPong = options.autoPong ?? true;
    this.closed = new Promise((resolve) => {
      ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString('utf8') });
      });
    });
    ws.on('message', (data: Buffer) => {
      this.#receive(data.toString('utf8'));
    });
  }

  get pageId(): string {
    if (!this.welcome) throw new Error('no welcome yet');
    return this.welcome.pageId;
  }

  #receive(text: string): void {
    const parsed = parseRelayFrame(text);
    if (parsed.kind !== 'ok') throw new Error(`relay sent a bad frame: ${parsed.kind}`);
    const frame = parsed.frame;
    this.received.push(frame);
    if (frame.t === 'welcome') this.code = frame.pairing.code;
    if (frame.t === 'pairing') this.code = frame.code;
    if (frame.t === 'ping' && this.#autoPong) this.send({ t: 'pong' });
    if (frame.t === 'invoke' && this.onInvoke) {
      const answer = this.onInvoke;
      void Promise.resolve(answer(frame)).then((reply) => {
        if (reply) this.send({ t: 'result', callId: frame.callId, ...reply });
      });
    }
    const index = this.#waiters.findIndex((waiter) => waiter.type === frame.t);
    const waiter = index === -1 ? undefined : this.#waiters.splice(index, 1)[0];
    if (waiter) waiter.resolve(frame);
    else this.#queue.push(frame);
  }

  /** The next unclaimed frame of a type, waiting for it if needed. */
  next<T extends RelayFrame['t']>(type: T, timeoutMs = 3000): Promise<RelayFrameOf<T>> {
    const index = this.#queue.findIndex((frame) => frame.t === type);
    if (index !== -1) {
      const [frame] = this.#queue.splice(index, 1);
      return Promise.resolve(frame as RelayFrameOf<T>);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        type,
        resolve: (frame: RelayFrame) => {
          clearTimeout(timer);
          resolve(frame as RelayFrameOf<T>);
        },
      };
      const timer = setTimeout(() => {
        const at = this.#waiters.indexOf(waiter);
        if (at !== -1) this.#waiters.splice(at, 1);
        reject(new Error(`no ${type} frame within ${String(timeoutMs)} ms`));
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  /** Frames of a type received so far, claimed or not. */
  all<T extends RelayFrame['t']>(type: T): RelayFrameOf<T>[] {
    return this.received.filter((frame): frame is RelayFrameOf<T> => frame.t === type);
  }

  send(frame: PageFrameInput | Record<string, unknown>): void {
    this.ws.send(encodeFrame(frame as PageFrameInput));
  }

  sendRaw(data: string | Buffer, binary = false): void {
    this.ws.send(data, { binary });
  }

  /** A ping round trip: once the pong is back, the relay has handled every earlier frame. */
  async sync(): Promise<void> {
    this.send({ t: 'ping' });
    await this.next('pong');
  }

  async close(): Promise<void> {
    this.ws.close(1000, 'test done');
    await this.closed;
  }
}

/** Opens a socket, sends hello, waits for welcome, then publishes the tools (if any). */
export async function connectPage(pageUrl: string, options: PageOptions = {}): Promise<TestPage> {
  const ws = await openSocket(pageUrl, options);
  const page = new TestPage(ws, options);
  page.send({
    t: 'hello',
    v: 1,
    title: options.title ?? 'Test page',
    url: options.url ?? `${PAGE_ORIGIN}/`,
    adapterVersion: 'test',
    policy: options.policy ?? {},
    ...(options.resumeToken === undefined ? {} : { resumeToken: options.resumeToken }),
  });
  page.welcome = await page.next('welcome');
  if (options.tools) {
    page.send({ t: 'tools', tools: options.tools });
    await page.sync();
  }
  return page;
}

export const READ_TOOL: PageTool = {
  name: 'get_view',
  title: 'Get view',
  description: 'Return the current viewport.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true },
};

export const WRITE_TOOL: PageTool = {
  name: 'add_item',
  title: 'Add item',
  description: 'Add an item to the board.',
  inputSchema: {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
  },
  annotations: { readOnlyHint: false },
};

export const UNMARKED_TOOL: PageTool = {
  name: 'clear_board',
  description: 'Remove every item. No annotations at all, as on the polyfill.',
  inputSchema: { type: 'object' },
};

export const TOOLS: PageTool[] = [READ_TOOL, WRITE_TOOL, UNMARKED_TOOL];
