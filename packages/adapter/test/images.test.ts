// The adapter's half of image results (ADR 0039, A6.3 and A6.4): only a tool
// the page declares in policy.imageTools has its result read as an envelope,
// unwrapped once more where MCP-B 6 quotes a string; the image is checked
// here with the protocol's checkImage before any frame goes out, against the
// welcome's maxImageBytes held to the ceiling; it is never cut, while the
// words beside it are; and image calls pass one at a time through the gate,
// IMAGE_CALL_SPACING_MS apart with MAX_WAITING_IMAGE_CALLS waiting, each
// answered without its handler running when a pause, revoke, cancel or
// deadline ends it first.

import {
  DEFAULT_IMAGE_BYTES,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TEXT_CHARS,
  type PageFrame,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  IMAGE_CALL_SPACING_MS,
  MAX_WAITING_IMAGE_CALLS,
  type RuntimeTool,
  UNWATCHED_HANDLER_GRACE_MS,
} from '../src/core.ts';
import {
  attachment,
  type FakeSocket,
  flush,
  type Harness,
  invoke,
  link,
  polyfillTools,
  results,
  runtimeTool,
  setup,
  welcome,
} from './harness.ts';

type ResultFrame = Extract<PageFrame, { t: 'result' }>;

function u32be(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** A PNG's signature and IHDR, then filler up to `size` bytes: only the header is read. */
function png(width: number, height: number, size = 2_000): Uint8Array {
  const bytes = new Uint8Array(size).fill(0x5a);
  bytes.set([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52],
    ...u32be(width),
    ...u32be(height),
  ]);
  return bytes;
}

/** btoa over the bytes as one binary string, built in slices a call's arguments can hold. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 8_192));
  }
  return btoa(binary);
}

const PNG = png(640, 480);
const DATA = base64(PNG);
const ENVELOPE = { image: { mimeType: 'image/png', data: DATA }, text: 'the view' };

const CAPTURE_HINTS = {
  consequentialHint: false,
  readOnlyHint: true,
  untrustedContentHint: false,
};
const CAPTURE = runtimeTool('capture', CAPTURE_HINTS);

/** A page whose capture tool is declared an image tool, welcomed with `maxImageBytes`. */
async function page(
  options: { maxImageBytes?: number | null; maxFrameBytes?: number; polyfill?: boolean } = {},
): Promise<{ h: Harness; socket: FakeSocket }> {
  const h = setup({
    tools: options.polyfill
      ? [{ ...CAPTURE, annotations: { readOnlyHint: true } }, ...polyfillTools()]
      : [CAPTURE, runtimeTool('get_value', { readOnlyHint: true })],
    core: { policy: { imageTools: ['capture'] } },
    ...(options.polyfill ? { polyfill: true } : {}),
  });
  const base = welcome(h.clock).limits;
  const maxImageBytes =
    options.maxImageBytes === undefined ? DEFAULT_IMAGE_BYTES : options.maxImageBytes;
  const socket = await link(h, {
    limits: {
      ...base,
      ...(maxImageBytes === null ? {} : { maxImageBytes }),
      ...(options.maxFrameBytes === undefined ? {} : { maxFrameBytes: options.maxFrameBytes }),
    },
  });
  return { h, socket };
}

async function call(
  h: Harness,
  socket: FakeSocket,
  handler: () => unknown,
  tool = 'capture',
): Promise<ResultFrame> {
  h.context.handlers.set(tool, handler);
  const before = results(socket).length;
  socket.deliver(invoke(tool, { callId: `call-${String(before + 1)}` }));
  // The gate holds a second image call until the spacing has passed.
  await h.clock.advance(IMAGE_CALL_SPACING_MS);
  const frame = results(socket)[before];
  if (!frame) throw new Error('no result frame');
  return frame;
}

describe("a declared image tool's result (A6.3)", () => {
  it('sends the image in its own field and the words as content, from an object or a string', async () => {
    const { h, socket } = await page();
    expect(h.dock.state.maxImageBytes).toBe(DEFAULT_IMAGE_BYTES);
    for (const returned of [
      ENVELOPE,
      JSON.stringify(ENVELOPE),
      // MCP-B 6 serializes every result, so a string arrives quoted once more.
      JSON.stringify(JSON.stringify(ENVELOPE)),
      // A data URL names the type itself.
      { image: { data: `data:image/png;base64,${DATA}` }, text: 'the view' },
    ]) {
      const frame = await call(h, socket, () => returned);
      expect(frame).toEqual({
        t: 'result',
        callId: frame.callId,
        ok: true,
        content: 'the view',
        image: { mimeType: 'image/png', data: DATA },
      });
    }
    const [entry] = h.dock.state.activity;
    expect(entry?.image).toEqual({ mimeType: 'image/png', bytes: PNG.length });
  });

  it('leaves words from a declared tool and an envelope from any other tool as text', async () => {
    const { h, socket } = await page();
    const words = await call(h, socket, () => 'nothing to show yet');
    expect(words).toMatchObject({ ok: true, content: 'nothing to show yet' });
    expect(words).not.toHaveProperty('image');
    const other = await call(h, socket, () => ENVELOPE, 'get_value');
    expect(other).toMatchObject({ ok: true, content: JSON.stringify(ENVELOPE) });
    expect(other).not.toHaveProperty('image');
    // Thrice encoded is no envelope a runtime makes: it stays text.
    const thrice = JSON.stringify(JSON.stringify(JSON.stringify(ENVELOPE)));
    expect(await call(h, socket, () => thrice)).toMatchObject({ ok: true, content: thrice });
    expect(h.dock.state.activity.every((entry) => entry.image === null)).toBe(true);
  });

  it('cuts the words beside an image so the marker fits in 2,000 characters, the image whole', async () => {
    const { h, socket } = await page();
    const frame = await call(h, socket, () => ({ ...ENVELOPE, text: 'w'.repeat(5_000) }));
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(frame.content?.length).toBeLessThanOrEqual(MAX_IMAGE_TEXT_CHARS);
    expect(frame.content).toContain('[tabdock: truncated');
    expect(frame.image?.data).toBe(DATA);
  });

  it('cuts only the words to fit the frame, and refuses an image the frame cannot hold', async () => {
    const big = base64(png(1000, 1000, 400_000));
    for (const [limit, fits] of [
      [600_000, true],
      [500_000, false],
    ] as const) {
      const { h, socket } = await page({ maxImageBytes: MAX_IMAGE_BYTES, maxFrameBytes: limit });
      const frame = await call(h, socket, () => ({
        image: { mimeType: 'image/png', data: big },
        text: '\u0001'.repeat(1_900),
      }));
      for (const text of socket.sent) expect(text.length).toBeLessThanOrEqual(limit);
      if (fits) {
        expect(frame.ok && frame.image?.data).toBe(big);
      } else {
        expect(frame).toMatchObject({
          ok: false,
          error: {
            code: 'tool_error',
            message: "the image is too large for this relay's page link",
          },
        });
        expect(frame).not.toHaveProperty('image');
      }
    }
    expect(MAX_FRAME_BYTES).toBeGreaterThan(600_000);
  });
});

describe('an image the adapter refuses before sending (A6.4)', () => {
  const cases: [string, unknown, string][] = [
    ['an SVG', { image: { mimeType: 'image/svg+xml', data: 'PHN2Zy8+' } }, 'not PNG, JPEG or WebP'],
    ['a GIF', { image: { mimeType: 'image/gif', data: 'R0lGODlh' } }, 'not PNG, JPEG or WebP'],
    [
      'unpadded base64',
      { image: { mimeType: 'image/png', data: DATA.replace(/=+$/, '') } },
      'not canonical base64',
    ],
    [
      'base64 with a line break',
      { image: { mimeType: 'image/png', data: `${DATA.slice(0, 4)}\n${DATA.slice(4)}` } },
      'not canonical base64',
    ],
    [
      'PNG bytes declared JPEG',
      { image: { mimeType: 'image/jpeg', data: DATA } },
      'first bytes are not those of its type',
    ],
    [
      'a header of 50,000 by 50,000 pixels',
      { image: { mimeType: 'image/png', data: base64(png(50_000, 50_000, 64)) } },
      'at most 8192 a side',
    ],
    [
      'one byte over the cap',
      { image: { mimeType: 'image/png', data: base64(png(10, 10, DEFAULT_IMAGE_BYTES + 1)) } },
      `over the cap of ${String(DEFAULT_IMAGE_BYTES)} bytes`,
    ],
    ['extra keys', { ...ENVELOPE, structuredContent: {} }, 'does not take'],
    ['bare base64 with no type', { image: { data: DATA } }, 'image.mimeType is required'],
    [
      'a data URL whose type differs from the one given',
      { image: { mimeType: 'image/png', data: `data:image/webp;base64,${DATA}` } },
      'differs from the type its data URL names',
    ],
  ];
  for (const [what, returned, words] of cases) {
    it(`answers ${what} tool_error in fixed words, sending no image`, async () => {
      const { h, socket } = await page();
      const frame = await call(h, socket, () => returned);
      expect(frame).toMatchObject({ ok: false, error: { code: 'tool_error' } });
      expect(frame).not.toHaveProperty('image');
      const message = frame.ok ? '' : (frame.error?.message ?? '');
      expect(message).toContain(words);
      // Never the page's own type or data.
      expect(message).not.toMatch(/svg|gif|PHN2|R0lG/);
      expect(h.dock.state.activity[0]?.image).toBeNull();
    });
  }

  it('refuses every image when the welcome names no cap or 0, and clamps a larger one to the ceiling', async () => {
    for (const maxImageBytes of [null, 0]) {
      const { h, socket } = await page({ maxImageBytes });
      expect(h.dock.state.maxImageBytes).toBe(0);
      expect(await call(h, socket, () => ENVELOPE)).toMatchObject({
        ok: false,
        error: { code: 'tool_error', message: 'image results are off here (a cap of 0 bytes)' },
      });
    }
    const { h, socket } = await page({ maxImageBytes: 2 ** 31 });
    expect(h.dock.state.maxImageBytes).toBe(MAX_IMAGE_BYTES);
    const over = base64(png(10, 10, MAX_IMAGE_BYTES + 1));
    expect(
      await call(h, socket, () => ({ image: { mimeType: 'image/png', data: over } })),
    ).toMatchObject({
      ok: false,
      error: {
        message: `the image is ${String(MAX_IMAGE_BYTES + 1)} bytes, over the cap of ${String(MAX_IMAGE_BYTES)} bytes`,
      },
    });
    // The link going down forgets what its relay said.
    socket.drop();
    await flush();
    expect(h.dock.state.maxImageBytes).toBeNull();
  });

  it('logs the type and size of an image, never any of its data', async () => {
    const { h, socket } = await page();
    const random = new Uint8Array(3_000).map(() => Math.floor(Math.random() * 256));
    const bytes = png(320, 200, 4_000);
    bytes.set(random, 1_000);
    const data = base64(bytes);
    await call(h, socket, () => ({ image: { mimeType: 'image/png', data } }));
    await call(h, socket, () => ({ image: { mimeType: 'image/jpeg', data } }));
    expect(
      h.logs.some((line) => line.includes(`an image/png of ${String(bytes.length)} bytes`)),
    ).toBe(true);
    const logs = h.logs.join('\n');
    for (let offset = 0; offset + 32 <= data.length; offset += 101) {
      expect(logs.includes(data.slice(offset, offset + 32))).toBe(false);
    }
  });
});

describe('the image gate (A6.4)', () => {
  /** Captures that record when each handler started, and finish when the test says. */
  function slowCaptures(h: Harness): { starts: number[]; finishAll: () => void } {
    const starts: number[] = [];
    const ends: (() => void)[] = [];
    h.context.handlers.set('capture', () => {
      starts.push(h.clock.now);
      return new Promise((resolve) => {
        ends.push(() => {
          resolve(ENVELOPE);
        });
      });
    });
    return {
      starts,
      finishAll: () => {
        for (const end of ends.splice(0)) end();
      },
    };
  }

  function invokeMany(socket: FakeSocket, count: number, from = 1): void {
    for (let index = from; index < from + count; index += 1) {
      socket.deliver(invoke('capture', { callId: `img-${String(index)}` }));
    }
  }

  it('starts image calls one at a time, 250 ms apart, with 8 waiting and the next answered page_busy', async () => {
    const { h, socket } = await page();
    const runs = slowCaptures(h);
    invokeMany(socket, 1 + MAX_WAITING_IMAGE_CALLS + 1);
    await h.clock.advance(0);
    const start = h.clock.now;
    expect(runs.starts).toEqual([start]);
    // The tenth found one running and eight waiting.
    expect(results(socket)).toEqual([
      expect.objectContaining({
        callId: `img-${String(MAX_WAITING_IMAGE_CALLS + 2)}`,
        ok: false,
        error: { code: 'page_busy', message: 'too many image calls are waiting' },
      }),
    ]);
    // A read beside it is not held by the gate.
    socket.deliver(invoke('get_value', { callId: 'read-1' }));
    await h.clock.advance(0);
    expect(results(socket).some((frame) => frame.callId === 'read-1' && frame.ok)).toBe(true);
    for (let index = 0; index < 2; index += 1) {
      runs.finishAll();
      await h.clock.advance(IMAGE_CALL_SPACING_MS);
    }
    expect(runs.starts).toEqual([
      start,
      start + IMAGE_CALL_SPACING_MS,
      start + 2 * IMAGE_CALL_SPACING_MS,
    ]);
    // Even a handler that answers at once leaves the next one waiting out the spacing.
    runs.finishAll();
    await h.clock.advance(IMAGE_CALL_SPACING_MS - 1);
    expect(runs.starts).toHaveLength(3);
    await h.clock.advance(1);
    expect(runs.starts).toHaveLength(4);
  });

  it('answers waiting calls page_busy on a pause, and a revoked caller at once, their handlers never run', async () => {
    const { h, socket } = await page();
    const runs = slowCaptures(h);
    invokeMany(socket, 3);
    await h.clock.advance(0);
    expect(runs.starts).toHaveLength(1);
    h.dock.pause(true);
    await h.clock.advance(0);
    const paused = results(socket).filter((frame) => !frame.ok);
    expect(paused.map((frame) => frame.callId).sort()).toEqual(['img-2', 'img-3']);
    for (const frame of paused) expect(frame).toMatchObject({ error: { code: 'page_busy' } });
    h.dock.pause(false);
    invokeMany(socket, 2, 4);
    await h.clock.advance(0);
    expect(h.dock.revoke('alice')).toBe(true);
    await h.clock.advance(0);
    runs.finishAll();
    await h.clock.advance(10 * IMAGE_CALL_SPACING_MS);
    // Only the first ever ran.
    expect(runs.starts).toHaveLength(1);
    expect(results(socket).filter((frame) => frame.callId === 'img-5')).toEqual([
      expect.objectContaining({ ok: false }),
    ]);
  });

  it('answers a waiting call at its deadline, and frees the gate from a handler the runtime never settles', async () => {
    const { h, socket } = await page({ polyfill: true });
    h.context.honoursAbort = false;
    const starts: number[] = [];
    // A polyfill 5.1 read whose handler never ends.
    h.context.handlers.set('capture', () => {
      starts.push(h.clock.now);
      return new Promise(() => undefined);
    });
    socket.deliver(invoke('capture', { callId: 'stuck', deadlineMs: 1_000 }));
    await h.clock.advance(0);
    socket.deliver(invoke('capture', { callId: 'early', deadlineMs: 500 }));
    socket.deliver(invoke('capture', { callId: 'later', deadlineMs: 60_000 }));
    await h.clock.advance(0);
    const start = h.clock.now;
    await h.clock.advance(500);
    // 'early' timed out in the queue, without its handler ever running.
    expect(results(socket).find((frame) => frame.callId === 'early')).toMatchObject({
      ok: false,
      error: { code: 'timeout' },
    });
    await h.clock.advance(500 + UNWATCHED_HANDLER_GRACE_MS - 1);
    expect(starts).toHaveLength(1);
    await h.clock.advance(1);
    expect(starts).toEqual([start, start + 1_000 + UNWATCHED_HANDLER_GRACE_MS]);
  });

  describe('a tool the page registers anew while a call waits at the gate (A6.28)', () => {
    const WRITE = { readOnlyHint: false, consequentialHint: false, untrustedContentHint: false };
    const BOB = { userId: 'bob', displayName: 'Bob', client: null, role: 'observer' as const };

    /**
     * Alice's capture holds the gate while a second capture waits behind it;
     * the page then registers capture again, as `again` with a handler of
     * its own, and Alice's capture ends. The page runs each call through a
     * wrapper that notes which registration it was handed.
     */
    async function swapWhileWaiting(
      again: RuntimeTool,
      caller?: typeof BOB,
    ): Promise<{ socket: FakeSocket; ran: string[]; handed: unknown[] }> {
      const h = setup({ tools: [CAPTURE], core: { policy: { imageTools: ['capture'] } } });
      const socket = await link(
        h,
        { limits: { ...welcome(h.clock).limits, maxImageBytes: DEFAULT_IMAGE_BYTES } },
        { alice: 'driver', bob: 'observer' },
      );
      const ran: string[] = [];
      const handed: unknown[] = [];
      const execute = h.context.executeTool.bind(h.context);
      h.context.executeTool = (tool, input, options) => {
        handed.push(tool.description);
        return execute(tool, input, options);
      };
      let release: (value: unknown) => void = () => undefined;
      h.context.handlers.set('capture', () => {
        ran.push('first');
        return new Promise((resolve) => {
          release = resolve;
        });
      });
      socket.deliver(invoke('capture', { callId: 'holding' }));
      await h.clock.advance(0);
      socket.deliver(invoke('capture', { callId: 'waiting', ...(caller && { caller }) }));
      await h.clock.advance(0);
      h.context.tools = [again];
      h.context.handlers.set('capture', () => {
        ran.push('again');
        return ENVELOPE;
      });
      h.context.fireToolChange();
      await h.clock.advance(0);
      release(ENVELOPE);
      await h.clock.advance(IMAGE_CALL_SPACING_MS);
      return { socket, ran, handed };
    }

    const asWrite = runtimeTool('capture', WRITE, { description: 'capture, now a write' });

    it("refuses an observer's waiting capture once capture is a write, never running it", async () => {
      const { socket, ran } = await swapWhileWaiting(asWrite, BOB);
      expect(ran).toEqual(['first']);
      expect(results(socket).find((frame) => frame.callId === 'waiting')).toMatchObject({
        ok: false,
        error: { code: 'role_denied', message: 'observers may only run read-only tools' },
      });
    });

    it("refuses a driver's waiting capture that became a write, rather than run it beside the write queue", async () => {
      const { socket, ran } = await swapWhileWaiting(asWrite);
      expect(ran).toEqual(['first']);
      expect(results(socket).find((frame) => frame.callId === 'waiting')).toMatchObject({
        ok: false,
        error: {
          code: 'page_busy',
          message: 'the page changed this tool while the call waited; call again',
        },
      });
    });

    it('refuses a waiting capture that became consequential, rather than run it unasked', async () => {
      const consequential = runtimeTool('capture', {
        ...CAPTURE_HINTS,
        consequentialHint: true,
      });
      const { socket, ran } = await swapWhileWaiting(consequential);
      expect(ran).toEqual(['first']);
      expect(results(socket).find((frame) => frame.callId === 'waiting')).toMatchObject({
        ok: false,
        error: { code: 'page_busy' },
      });
    });

    it('runs the registration the page holds now when it is still a read', async () => {
      const again = runtimeTool('capture', CAPTURE_HINTS, { description: 'capture, again' });
      const { socket, ran, handed } = await swapWhileWaiting(again, BOB);
      expect(ran).toEqual(['first', 'again']);
      expect(handed).toEqual(['capture tool', 'capture, again']);
      expect(results(socket).map((frame) => [frame.callId, frame.ok])).toEqual([
        ['holding', true],
        ['waiting', true],
      ]);
    });
  });

  /**
   * A page with the read-only capture and `snap`, a read-only image tool the
   * page names consequential, on a page that takes a driver's confirmation
   * from their client (ADR 0026).
   */
  async function promptingPage(): Promise<{ h: Harness; socket: FakeSocket }> {
    const h = setup({
      tools: [CAPTURE, runtimeTool('snap', { readOnlyHint: true, untrustedContentHint: false })],
      core: {
        policy: {
          imageTools: ['capture', 'snap'],
          consequentialTools: ['snap'],
          confirmVia: 'client',
        },
      },
    });
    const socket = await link(h, {
      limits: { ...welcome(h.clock).limits, maxImageBytes: DEFAULT_IMAGE_BYTES },
    });
    return { h, socket };
  }

  it("lets other captures through while the operator's prompt for one is open", async () => {
    const { h, socket } = await promptingPage();
    const runs = slowCaptures(h);
    h.context.handlers.set('snap', () => ENVELOPE);
    socket.deliver(invoke('snap', { callId: 'snap-1' }));
    await h.clock.advance(0);
    expect(h.dock.state.pendingConfirms.map((pending) => pending.callId)).toEqual(['snap-1']);
    socket.deliver(invoke('capture', { callId: 'img-1' }));
    await h.clock.advance(0);
    expect(runs.starts).toHaveLength(1);
    // Once allowed, snap still waits its turn at the gate.
    expect(h.dock.confirm('snap-1', true)).toBe(true);
    await h.clock.advance(IMAGE_CALL_SPACING_MS);
    expect(results(socket).map((frame) => frame.callId)).toEqual([]);
    runs.finishAll();
    await h.clock.advance(IMAGE_CALL_SPACING_MS);
    expect(results(socket).map((frame) => [frame.callId, frame.ok])).toEqual([
      ['img-1', true],
      ['snap-1', true],
    ]);
  });

  it('frees the gate when the link drops while the call holding it waits on a prompt', async () => {
    const { h, socket } = await promptingPage();
    const runs = slowCaptures(h);
    h.context.handlers.set('snap', () => ENVELOPE);
    socket.deliver(invoke('capture', { callId: 'img-1' }));
    await h.clock.advance(0);
    // Alice confirmed in her client, so snap asks nobody on arrival and waits at the gate.
    const client = { name: 'claude-code', version: '2.1.296' };
    socket.deliver(
      invoke('snap', {
        callId: 'snap-1',
        caller: { userId: 'alice', displayName: 'Alice', client, role: 'driver' },
        confirmation: { by: 'client', confirmationId: 'cf_1', at: h.clock.now },
      }),
    );
    await h.clock.advance(0);
    expect(h.dock.state.pendingConfirms).toEqual([]);
    // The operator lowers her meanwhile, so her client's word no longer
    // stands and the page asks once snap holds the gate.
    expect(h.dock.setRole('alice', 'observer')).toBe(true);
    runs.finishAll();
    await h.clock.advance(IMAGE_CALL_SPACING_MS);
    expect(h.dock.state.pendingConfirms.map((pending) => pending.callId)).toEqual(['snap-1']);
    socket.drop(1006);
    await h.clock.advance(500);
    const again = h.socket();
    again.accept();
    again.deliver(
      welcome(h.clock, {
        resumed: true,
        roster: [attachment('alice', 'observer')],
        limits: { ...welcome(h.clock).limits, maxImageBytes: DEFAULT_IMAGE_BYTES },
      }),
    );
    await flush();
    const relinked = h.clock.now;
    again.deliver(invoke('capture', { callId: 'img-2' }));
    await h.clock.advance(IMAGE_CALL_SPACING_MS);
    expect(runs.starts.at(-1)).toBeLessThanOrEqual(relinked + IMAGE_CALL_SPACING_MS);
    expect(runs.starts).toHaveLength(2);
  });
});
