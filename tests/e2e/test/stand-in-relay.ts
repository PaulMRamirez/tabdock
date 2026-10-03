// A scripted stand-in for the relay: a `ws` server that speaks the page link
// with the protocol package's own schemas and does only what the test tells it
// to. It runs no checks of its own, so a test can send the real adapter what a
// buggy or hostile relay might (an invoke claiming driver for an observer, a
// roster that lies) and see what the page does with it (S5's second check).

import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  IDLE_TIMEOUT_MS,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RelayFrameSchema,
  RESUME_WINDOW_MS,
  SUBPROTOCOL,
} from '@tabdock/protocol';
import { type WebSocket, WebSocketServer } from 'ws';

export type PageFrameOf<T extends PageFrame['t']> = Extract<PageFrame, { t: T }>;

export interface StandInRelay {
  /** ws://127.0.0.1:<port>/page */
  readonly url: string;
  /** Every valid frame the page sent, oldest first. */
  readonly received: readonly PageFrame[];
  /** Sends a frame to the page, checked against the protocol schema first. */
  send(frame: RelayFrame): void;
  /** Resolves with the first frame of this type, already received or still to come, that matches. */
  next<T extends PageFrame['t']>(
    type: T,
    match?: (frame: PageFrameOf<T>) => boolean,
    timeoutMs?: number,
  ): Promise<PageFrameOf<T>>;
  close(): Promise<void>;
}

/** The limits a real relay sends in welcome, at their protocol defaults. */
export const STAND_IN_LIMITS = {
  maxFrameBytes: MAX_FRAME_BYTES,
  maxResultChars: MAX_RESULT_CHARS,
  maxDescriptionChars: MAX_DESCRIPTION_CHARS,
  pingIntervalMs: PING_INTERVAL_MS,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  resumeWindowMs: RESUME_WINDOW_MS,
  attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
};

export async function startStandInRelay(): Promise<StandInRelay> {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    path: '/page',
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('the stand-in relay has no port');
  }

  const received: PageFrame[] = [];
  const waiters = new Set<() => void>();
  let socket: WebSocket | null = null;

  server.on('connection', (ws) => {
    // One page at a time, like a page socket that a newer one replaces.
    socket?.terminate();
    socket = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary || !Buffer.isBuffer(data)) return;
      const parsed = parsePageFrame(data.toString('utf8'));
      if (parsed.kind !== 'ok') return;
      received.push(parsed.frame);
      for (const wake of [...waiters]) wake();
    });
    ws.on('error', () => undefined);
  });

  return {
    url: `ws://127.0.0.1:${String(address.port)}/page`,
    received,
    send(frame) {
      if (!socket) throw new Error('no page is connected to the stand-in relay');
      socket.send(encodeFrame(RelayFrameSchema.parse(frame)));
    },
    next(type, match = () => true, timeoutMs = 5000) {
      type Frame = PageFrameOf<typeof type>;
      const find = (): Frame | undefined =>
        received.find((frame): frame is Frame => frame.t === type && match(frame as Frame));
      return new Promise((resolve, reject) => {
        const found = find();
        if (found) {
          resolve(found);
          return;
        }
        const wake = (): void => {
          const frame = find();
          if (!frame) return;
          clearTimeout(timer);
          waiters.delete(wake);
          resolve(frame);
        };
        const timer = setTimeout(() => {
          waiters.delete(wake);
          reject(
            new Error(`the page sent no matching ${type} frame within ${String(timeoutMs)} ms`),
          );
        }, timeoutMs);
        waiters.add(wake);
      });
    },
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
