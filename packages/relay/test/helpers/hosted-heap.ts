// What the heap tests share when they run main.ts as the image runs it (S9,
// ADR 0018): the image's own heap flag, read from the Dockerfile so a test
// can never drift from it, and a page that fills its slot through the
// stand-in edge with tools frames, so a test can fill every hosted page slot
// to the tool budget before it adds load of its own.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeFrame, SUBPROTOCOL } from '@tabdock/protocol';
import WebSocket from 'ws';

const DOCKERFILE = resolve(import.meta.dirname, '../../../../Dockerfile');

/** The heap flag the image starts node with, read from the Dockerfile's CMD. */
export function imageHeapFlag(): string {
  const cmd = readFileSync(DOCKERFILE, 'utf8')
    .split('\n')
    .find((line) => line.startsWith('CMD '));
  const flag = (JSON.parse(cmd?.slice(4) ?? '[]') as string[]).find((arg) =>
    arg.startsWith('--max-old-space-size='),
  );
  if (flag === undefined) throw new Error('the Dockerfile CMD sets no --max-old-space-size');
  return flag;
}

/** What a page got: its tools listed, a close code, or no answer at all from a relay that is gone. */
export type FillOutcome = 'listed' | 'unreachable' | number;

export interface EdgeTarget {
  /** The port main.ts listens on. */
  port: number;
  /** The relay's public host, which the edge passes on as Host. */
  publicHost: string;
  /** An origin the relay lists. */
  origin: string;
}

/**
 * A page through the stand-in edge from `address`: hello, then its tools
 * frames, then a ping. 'listed' when the pong comes back, so the relay took
 * every frame; otherwise the close code it was refused with. The socket goes
 * into `sockets`, for the test to close.
 */
export async function fillPage(
  target: EdgeTarget,
  address: string,
  frames: readonly string[],
  sockets: WebSocket[],
): Promise<FillOutcome> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(target.port)}/page`, [SUBPROTOCOL], {
    origin: target.origin,
    headers: { Host: target.publicHost, 'Fly-Client-IP': address },
  });
  sockets.push(ws);
  const closed = new Promise<number>((resolveClose) => {
    ws.once('close', (code) => {
      resolveClose(code);
    });
  });
  const opened = await new Promise<void>((resolveOpen, reject) => {
    ws.once('open', () => {
      resolveOpen();
    });
    ws.once('error', reject);
  }).catch(() => 'unreachable' as const);
  if (opened === 'unreachable') return opened;
  const ponged = new Promise<'listed'>((resolvePong) => {
    ws.on('message', (data: Buffer) => {
      const text = data.toString('utf8');
      if (text.includes('"t":"ping"')) ws.send(encodeFrame({ t: 'pong' }));
      if (text.includes('"t":"pong"')) resolvePong('listed');
    });
  });
  ws.send(
    encodeFrame({
      t: 'hello',
      v: 1,
      title: 'Heap test',
      url: `${target.origin}/`,
      adapterVersion: 'test',
      policy: {},
    }),
  );
  for (const frame of frames) ws.send(frame);
  ws.send(encodeFrame({ t: 'ping' }));
  return Promise.race([ponged, closed]);
}
