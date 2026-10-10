// Publishing page state (ADR 0040, A6.6): the adapter writes a value once,
// sends the first change after a quiet spell at once and the last of a burst
// when STATE_MIN_INTERVAL_MS ends, never resends what the relay holds from
// this link, holds state while paused, refuses what is too large or not an
// object without throwing and clears what the relay holds then, sends only
// to a relay whose welcome names maxStateBytes, and sends its value after
// every welcome before its tools. Its status changes only between states,
// so a page publishing every frame re-renders nothing.

import {
  MAX_STATE_BYTES,
  type PageFrame,
  RECONNECT_MAX_MS,
  STATE_MIN_INTERVAL_MS,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { flush, type Harness, link, setup, welcome } from './harness.ts';

type WelcomeOverrides = Parameters<typeof link>[1];

/** A welcome from a relay that takes state, as every M6 relay's does. */
function taking(h: Harness, maxStateBytes = MAX_STATE_BYTES): NonNullable<WelcomeOverrides> {
  return { limits: { ...welcome(h.clock).limits, maxStateBytes } };
}

function values(frames: PageFrame[]): unknown[] {
  return frames.flatMap((frame) => (frame.t === 'state' ? [frame.value] : []));
}

describe('how often state goes out (ADR 0040)', () => {
  it('sends the first value of a burst at once and its last when the interval ends', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    for (let n = 0; n < 10; n += 1) {
      expect(h.dock.publishState({ n })).toEqual({ ok: true });
      await h.clock.advance(10);
    }
    expect(values(socket.frames())).toEqual([{ n: 0 }]);
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(values(socket.frames())).toEqual([{ n: 0 }, { n: 9 }]);
    // Nothing more once the burst is out.
    await h.clock.advance(STATE_MIN_INTERVAL_MS * 4);
    expect(values(socket.frames())).toHaveLength(2);
  });

  it('sends at most 21 frames for 10 s of a value every frame, and says shared once', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    let renders = 0;
    h.dock.on('state', () => {
      renders += 1;
    });
    for (let frame = 0; frame < 600; frame += 1) {
      h.dock.publishState({ frame, view: { zoom: frame / 600 } });
      await h.clock.advance(1000 / 60);
    }
    const sent = values(socket.frames());
    expect(sent.length).toBeGreaterThanOrEqual(19);
    expect(sent.length).toBeLessThanOrEqual(21);
    expect(h.dock.state.published).toBe('shared');
    expect(renders).toBeLessThanOrEqual(2);
  });

  it('never resends what the relay already holds from this link', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    h.dock.publishState({ stop: 1 });
    // Within the interval, a burst that comes back to where it started sends nothing at its end.
    h.dock.publishState({ stop: 2 });
    h.dock.publishState({ stop: 1 });
    await h.clock.advance(STATE_MIN_INTERVAL_MS * 2);
    // Nor does the same value once the interval is over.
    h.dock.publishState({ stop: 1 });
    await h.clock.advance(STATE_MIN_INTERVAL_MS * 2);
    expect(values(socket.frames())).toEqual([{ stop: 1 }]);
  });

  it('writes a value once, so a getter that changes between reads cannot change what goes out', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    let reads = 0;
    const live = {
      get stop(): number {
        reads += 1;
        return reads;
      },
    };
    expect(h.dock.publishState(live)).toEqual({ ok: true });
    expect(reads).toBe(1);
    expect(values(socket.frames())).toEqual([{ stop: 1 }]);
  });
});

describe('values the adapter refuses (ADR 0040)', () => {
  it('answers too_large and invalid, never throws, and clears what the relay holds', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    h.dock.publishState({ stop: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [cyclic, { big: 1n }, [1, 2], 'text', undefined]) {
      expect(h.dock.publishState(bad)).toEqual({ ok: false, reason: 'invalid' });
      expect(h.dock.state.published).toBe('invalid');
    }
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    // What the relay held is cleared, rather than left current.
    expect(values(socket.frames())).toEqual([{ stop: 1 }, null]);
    h.dock.publishState({ stop: 2 });
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(h.dock.publishState({ t: 'a'.repeat(MAX_STATE_BYTES - 7) })).toEqual({
      ok: false,
      reason: 'too_large',
    });
    expect(h.dock.state.published).toBe('too_large');
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(values(socket.frames())).toEqual([{ stop: 1 }, null, { stop: 2 }, null]);
    // The line names bytes and the limit, never the value.
    expect(h.logs).toContain(
      `warn page state not shared: ${String(MAX_STATE_BYTES + 1)} bytes, over the ${String(MAX_STATE_BYTES)} byte limit`,
    );
    expect(h.logs.join('\n')).not.toContain('aaaa');
  });

  it("holds to a relay's smaller cap, refusing a held value past it at the welcome", async () => {
    const h = setup();
    h.dock.publishState({ t: 'a'.repeat(200) });
    const socket = await link(h, taking(h, 100), {});
    expect(h.dock.state.published).toBe('too_large');
    expect(values(socket.frames())).toEqual([]);
    expect(h.dock.publishState({ t: 'a'.repeat(200) })).toEqual({ ok: false, reason: 'too_large' });
    expect(h.dock.publishState({ t: 'small' })).toEqual({ ok: true });
    expect(values(socket.frames())).toEqual([{ t: 'small' }]);
  });
});

describe('pause holds state (ADR 0040)', () => {
  it('sends null while paused and the latest value on resume', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    h.dock.publishState({ stop: 1 });
    h.dock.pause(true);
    expect(h.dock.state.published).toBe('paused');
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    h.dock.publishState({ stop: 2 });
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(values(socket.frames())).toEqual([{ stop: 1 }, null]);
    h.dock.pause(false);
    expect(h.dock.state.published).toBe('shared');
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(values(socket.frames())).toEqual([{ stop: 1 }, null, { stop: 2 }]);
  });
});

describe('state and the link (ADR 0040)', () => {
  it('sends nothing to a relay whose welcome names no maxStateBytes, and says so', async () => {
    const h = setup();
    const socket = await link(h, {}, {});
    expect(h.dock.publishState({ stop: 1 })).toEqual({ ok: true });
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(h.dock.state.published).toBe('unsupported');
    expect(socket.framesOf('state')).toEqual([]);
  });

  it('sends its value after every welcome, before its tools frame', async () => {
    const h = setup();
    h.dock.publishState({ stop: 3 });
    expect(h.dock.state.published).toBe('shared');
    const first = await link(h, taking(h), {});
    await flush();
    const order = (frames: PageFrame[]) =>
      frames.map((frame) => frame.t).filter((t) => t === 'state' || t === 'tools');
    expect(order(first.frames())).toEqual(['state', 'tools']);
    expect(values(first.frames())).toEqual([{ stop: 3 }]);
    // The link drops; the relay drops what it held, so the resumed welcome gets it again at once.
    first.drop();
    await h.clock.advance(RECONNECT_MAX_MS);
    const second = h.socket();
    expect(second).not.toBe(first);
    second.accept();
    second.deliver(welcome(h.clock, { ...taking(h), resumed: true }));
    await flush();
    expect(order(second.frames())).toEqual(['state', 'tools']);
    expect(values(second.frames())).toEqual([{ stop: 3 }]);
  });

  it('sends nothing while the link is down, and no trailing frame from the old link', async () => {
    const h = setup();
    const socket = await link(h, taking(h), {});
    h.dock.publishState({ stop: 1 });
    h.dock.publishState({ stop: 2 });
    socket.drop();
    await h.clock.advance(STATE_MIN_INTERVAL_MS);
    expect(values(socket.frames())).toEqual([{ stop: 1 }]);
  });
});
