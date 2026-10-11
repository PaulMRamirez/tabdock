// The relay's side of a page socket made to look unread, as hub.test.ts
// does for calls (ADR 0024): every frame still reaches the test page, so it
// can look and answer, but the relay sees each one queued (bufferedAmount)
// and never hears that it left (its send callback) until drain() lets it go.

import type { WebSocket } from 'ws';

/** What stall() leaves a test: the queue the relay sees, and a way to let it go. */
export interface Stall {
  /** Frames the relay handed ws that it still sees queued. */
  readonly frames: number;
  /** Those frames' bytes, plus any added. */
  readonly bytes: number;
  /** Bytes the relay sees queued that it did not send itself, as if another frame were stuck. */
  add(bytes: number): void;
  /** Lets the oldest `count` frames leave, as if the page read them; every one, and the added bytes, by default. */
  drain(count?: number): void;
}

export function stall(served: WebSocket): Stall {
  const withheld: { bytes: number; written: (() => void) | undefined }[] = [];
  let added = 0;
  const socket = served as unknown as {
    send: (data: string, written?: () => void) => void;
    pong: (data: Buffer, mask?: boolean, written?: () => void) => void;
  };
  const send = socket.send.bind(served);
  const pong = socket.pong.bind(served);
  // A frame's header is at least two bytes, so even an empty pong is queued as something.
  socket.send = (data, written) => {
    withheld.push({ bytes: 2 + Buffer.byteLength(data), written });
    send(data);
  };
  socket.pong = (data, mask, written) => {
    withheld.push({ bytes: 2 + data.length, written });
    pong(data, mask);
  };
  const bytes = (): number => withheld.reduce((sum, frame) => sum + frame.bytes, added);
  Object.defineProperty(served, 'bufferedAmount', { get: bytes, configurable: true });
  return {
    get frames() {
      return withheld.length;
    },
    get bytes() {
      return bytes();
    },
    add(more) {
      added += more;
    },
    drain(count = withheld.length) {
      if (count >= withheld.length) added = 0;
      for (const frame of withheld.splice(0, count)) frame.written?.();
    },
  };
}
