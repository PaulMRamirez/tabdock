// pnpm demo:m6 on a run that goes wrong: a leg that leaves a call running
// while it clicks in the widget must not let the demo's cleanup, which
// closes the clients and so rejects that call, end the process on an
// unhandled rejection before the run's private directory is removed; and a
// wait for the page's state must end at a deadline rather than loop for as
// long as a page that never publishes the expected stop keeps quiet.

import type { PageStateResult } from '@tabdock/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { inFlight, stateWhere } from '../src/demo-m6/lesson.ts';

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  unhandled.length = 0;
});

function state(version: number, stop: number): PageStateResult {
  return {
    page: 'pg_DEMOPAGE01',
    origin: 'http://127.0.0.1:5174',
    version,
    publishedAt: 1_000 + version,
    heardAt: 1_000 + version,
    value: { stop },
    changed: true,
  };
}

const stopOf = (body: PageStateResult): unknown => (body.value as { stop?: unknown }).stop;

describe("demo:m6's in-flight calls", () => {
  it('leave no unhandled rejection when the client closes under a call nobody awaits yet', async () => {
    process.on('unhandledRejection', onUnhandled);
    let close: (error: Error) => void = () => undefined;
    const call = inFlight(
      new Promise<string>((_, reject) => {
        close = reject;
      }),
    );
    // The leg's next step threw, and the cleanup closed the client.
    close(new Error('the client closed'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).toEqual([]);
    // A leg that does reach its await still sees the call's own error.
    await expect(call).rejects.toThrow('the client closed');
  });

  it('pass a result through unchanged', async () => {
    await expect(inFlight(Promise.resolve('paired'))).resolves.toBe('paired');
  });
});

describe("demo:m6's wait for a stop", () => {
  it('answers at once when the first read already shows the stop', async () => {
    let waits = 0;
    const body = await stateWhere(
      state(4, 2),
      () => {
        waits += 1;
        return Promise.resolve(state(5, 2));
      },
      (read) => stopOf(read) === 2,
      'stop 3',
    );
    expect(body.version).toBe(4);
    expect(waits).toBe(0);
  });

  it('waits after each version it read until the stop is published', async () => {
    const asked: [number, number][] = [];
    const later = [state(5, 0), state(6, 1)];
    const body = await stateWhere(
      state(4, 0),
      (after, waitMs) => {
        asked.push([after, waitMs]);
        return Promise.resolve(later.shift() ?? state(7, 1));
      },
      (read) => stopOf(read) === 1,
      'stop 2',
    );
    expect(body.version).toBe(6);
    expect(asked.map(([after]) => after)).toEqual([4, 5]);
    // No wait asks for more than 5 s, the most the walk gives one.
    expect(asked.every(([, waitMs]) => waitMs > 0 && waitMs <= 5_000)).toBe(true);
  });

  it('fails at its deadline, naming what it waited for, when the page never publishes the stop', async () => {
    let waits = 0;
    const waited = stateWhere(
      state(4, 0),
      async (after) => {
        waits += 1;
        // A wait that times out answers the same version, unchanged.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...state(after, 0), changed: false };
      },
      (read) => stopOf(read) === 3,
      'stop 4 of the flyby',
      100,
    );
    await expect(waited).rejects.toThrow('timed out waiting for stop 4 of the flyby');
    expect(waits).toBeGreaterThan(0);
  }, 5_000);
});
