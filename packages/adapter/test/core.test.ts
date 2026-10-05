import {
  CLOSE_DETACH,
  CLOSE_INVALID_FRAME_PAGE,
  CLOSE_SILENT,
  IDLE_TIMEOUT_MS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  TOOL_POLL_MS,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { backoffDelay, createAdapterCore, type LocksLike, type RuntimeTool } from '../src/core.ts';
import {
  FRAME_WINDOW,
  GRANTS_KEY,
  HANDLER_FAILED,
  MapStorage,
  PAGE_WINDOW,
  RELAY_URL,
  RESUME_KEY,
  attachRequest,
  attachment,
  flush,
  grant,
  invoke,
  link,
  polyfillTools,
  results,
  runtimeTool,
  setup,
  welcome,
} from './harness.ts';

describe('linking', () => {
  it('dials with tabdock.v1 and says hello first, without the page query or a token', () => {
    const h = setup();
    h.core.start();
    expect(h.dock.state.link).toBe('connecting');
    const socket = h.socket();
    expect(socket.url).toBe(RELAY_URL);
    expect(socket.protocols).toEqual(['tabdock.v1']);
    socket.accept();
    expect(socket.frames()).toEqual([
      {
        t: 'hello',
        v: 1,
        title: 'Test page',
        url: 'http://127.0.0.1:5173/board',
        adapterVersion: '0.0.0-test',
        policy: {
          autoApprove: 'none',
          maxDrivers: 1,
          consequential: 'confirm',
          consequentialTools: [],
          invites: 'watch',
          // M5's default (ADR 0026): the operator confirms on the page.
          confirmVia: 'page',
        },
      },
    ]);
  });

  it('stores the token from welcome, shows the pairing code, then sends its tools', async () => {
    const h = setup();
    const socket = await link(h, {}, {});
    expect(h.storage.getItem(RESUME_KEY)).toBe('resume-1');
    expect(h.dock.state).toMatchObject({
      link: 'linked',
      pageId: 'page-1',
      pairing: { code: 'ABCDE-FGHJK' },
      roster: [],
      error: null,
    });
    expect(socket.frames().map((frame) => frame.t)).toEqual(['hello', 'tools']);
    expect(socket.framesOf('tools')[0]?.tools.map((tool) => tool.name)).toEqual([
      'get_value',
      'set_value',
      'wipe',
    ]);
  });

  it('resumes with the stored token and keeps only the newest one', async () => {
    const h = setup();
    h.storage.setItem(RESUME_KEY, 'old-token');
    const socket = await link(h, { resumeToken: 'new-token', resumed: true });
    expect(socket.framesOf('hello')[0]?.resumeToken).toBe('old-token');
    expect(h.storage.getItem(RESUME_KEY)).toBe('new-token');
  });

  it('refuses a relay URL it could never dial', () => {
    expect(() => setup({ core: { relayUrl: 'https://relay.test/page' } })).toThrow(TypeError);
    expect(() => setup({ core: { relayUrl: 'not a url' } })).toThrow(TypeError);
  });

  it('stays idle and says how to add a polyfill when modelContext is missing', () => {
    const h = setup({ core: { modelContext: undefined } });
    h.core.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.dock.state.link).toBe('idle');
    expect(h.dock.state.error).toMatch(/polyfill/);
    expect(h.logs.some((line) => line.startsWith('error') && line.includes('polyfill'))).toBe(true);
  });

  it('answers ping with pong', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver({ t: 'ping' });
    expect(socket.last()).toEqual({ t: 'pong' });
  });

  it('applies pairing and roster frames, and asks for a new code on request', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver({ t: 'pairing', code: 'ZZZZZ-ZZZZZ', expiresAt: h.clock.now + 120_000 });
    expect(h.dock.state.pairing?.code).toBe('ZZZZZ-ZZZZZ');
    const attachment = {
      userId: 'bob',
      displayName: 'Bob',
      kind: 'member' as const,
      role: 'driver' as const,
      grantedAt: h.clock.now,
      lastUsedAt: null,
      expiresAt: null,
      clients: [],
      inviteId: null,
      endsAt: null,
    };
    socket.deliver({ t: 'roster', attachments: [attachment] });
    expect(h.dock.state.roster).toEqual([attachment]);
    expect(h.dock.rotatePairing()).toBe(true);
    expect(socket.last()).toEqual({ t: 'rotate_pairing' });
  });

  it('holds a Web Lock named after the page while linked', async () => {
    const held: { name: string; released: boolean }[] = [];
    const locks: LocksLike = {
      request: (name, callback) => {
        const entry = { name, released: false };
        held.push(entry);
        return callback(null).then(() => {
          entry.released = true;
        });
      },
    };
    const h = setup({ core: { locks } });
    const socket = await link(h);
    expect(held).toEqual([{ name: 'tabdock:page-1', released: false }]);
    socket.drop();
    await flush();
    expect(held[0]?.released).toBe(true);
  });

  it('keeps a throwing state listener from breaking the link', async () => {
    const h = setup();
    h.dock.on('state', () => {
      throw new Error('listener bug');
    });
    await link(h);
    expect(h.dock.state.link).toBe('linked');
    expect(h.logs.some((line) => line.includes('a state listener threw'))).toBe(true);
  });
});

describe('tool sync', () => {
  it('sends a tools frame only when the list changes, and coalesces toolchange bursts', async () => {
    const h = setup();
    const socket = await link(h);
    await h.clock.advance(TOOL_POLL_MS * 3);
    expect(socket.framesOf('tools')).toHaveLength(1);

    h.context.tools.push(runtimeTool('extra', { readOnlyHint: true }));
    for (let i = 0; i < 5; i += 1) h.context.fireToolChange();
    await h.clock.advance(100);
    expect(socket.framesOf('tools')).toHaveLength(2);
    expect(socket.framesOf('tools')[1]?.tools.map((tool) => tool.name)).toContain('extra');

    // Without an event, the poll still notices.
    h.context.tools.pop();
    await h.clock.advance(TOOL_POLL_MS);
    expect(socket.framesOf('tools')).toHaveLength(3);
  });

  it('says it has no tools when getTools() fails after a welcome, and sends them once it reads', async () => {
    const h = setup();
    const getTools = h.context.getTools.bind(h.context);
    let failing = true;
    h.context.getTools = () => (failing ? Promise.reject(new Error('runtime busy')) : getTools());
    const socket = await link(h);
    // An empty list ends the relay's wait for a resumed page's tools.
    expect(socket.framesOf('tools').map((frame) => frame.tools)).toEqual([[]]);
    await h.clock.advance(TOOL_POLL_MS * 2);
    expect(socket.framesOf('tools')).toHaveLength(1);

    failing = false;
    await h.clock.advance(TOOL_POLL_MS);
    expect(socket.framesOf('tools')).toHaveLength(2);
    expect(socket.framesOf('tools')[1]?.tools.length).toBeGreaterThan(0);
  });

  it('parses string schemas, keeps only known boolean hints and skips malformed tools', async () => {
    const h = setup({
      tools: [
        runtimeTool(
          'from_chrome_154',
          { readOnlyHint: true, destructiveHint: true, debugging: 'yes' },
          { inputSchema: '{"type":"object","properties":{"x":{"type":"string"}}}' },
        ),
        runtimeTool('broken', { readOnlyHint: true }, { inputSchema: '{not json' }),
        runtimeTool('array_schema', { readOnlyHint: true }, { inputSchema: '[1]' }),
        runtimeTool('has space'),
        { name: 'bare', window: PAGE_WINDOW },
      ],
    });
    const socket = await link(h);
    expect(socket.framesOf('tools')[0]?.tools).toEqual([
      {
        name: 'from_chrome_154',
        description: 'from_chrome_154 tool',
        inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
        annotations: { readOnlyHint: true },
      },
      { name: 'bare', description: '', inputSchema: { type: 'object', properties: {} } },
    ]);
    const warnings = h.logs.filter((line) => line.startsWith('warn'));
    expect(warnings).toEqual([
      'warn skipped "broken": its inputSchema is not a JSON object',
      'warn skipped "array_schema": its inputSchema is not a JSON object',
      'warn skipped "has space": its name breaks the WebMCP naming rule',
    ]);
    await h.clock.advance(TOOL_POLL_MS * 2);
    expect(h.logs.filter((line) => line.startsWith('warn'))).toHaveLength(3);
  });

  it("shares only its own window's tools, as Chrome lists same-origin iframe tools too", async () => {
    const windowless: RuntimeTool = {
      name: 'windowless',
      description: 'from a runtime that sets no window',
      annotations: { readOnlyHint: true },
    };
    const h = setup({
      tools: [
        runtimeTool('framed', { readOnlyHint: true }, { window: FRAME_WINDOW }),
        runtimeTool('mine', { readOnlyHint: true }),
        windowless,
      ],
    });
    const socket = await link(h);
    expect(socket.framesOf('tools')[0]?.tools.map((tool) => tool.name)).toEqual([
      'mine',
      'windowless',
    ]);
    socket.deliver(invoke('framed'));
    await flush();
    expect(results(socket)[0]?.error?.code).toBe('tool_not_found');
    expect(h.context.attempts).toHaveLength(0);
  });
});

describe('running calls', () => {
  it('returns the runtime result and passes the arguments through', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('get_value', { arguments: { a: 1 } }));
    await flush();
    expect(results(socket)).toEqual([
      { t: 'result', callId: 'call-1', ok: true, content: '{"a":1}' },
    ]);
    expect(h.context.runs[0]?.args).toEqual({ a: 1 });
  });

  it('answers tool_not_found for a tool the page does not have', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('nope'));
    await flush();
    expect(results(socket)[0]).toMatchObject({ ok: false, error: { code: 'tool_not_found' } });
  });

  it('detects a string-input runtime on the first call and remembers it (ADR 0001)', async () => {
    const h = setup();
    h.context.inputForm = 'string';
    const socket = await link(h);
    socket.deliver(invoke('get_value', { arguments: { a: 1 } }));
    await flush();
    expect(results(socket)[0]).toMatchObject({ ok: true, content: '{"a":1}' });
    expect(h.context.attempts.map((attempt) => attempt.input)).toEqual([{ a: 1 }, '{"a":1}']);

    socket.deliver(invoke('get_value', { callId: 'call-2', arguments: { b: 2 } }));
    await flush();
    expect(h.context.attempts.map((attempt) => attempt.input)).toEqual([
      { a: 1 },
      '{"a":1}',
      '{"b":2}',
    ]);
  });

  it('keeps objects on an object runtime, and switches back when the runtime asks', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    expect(h.context.attempts).toHaveLength(1);

    h.context.inputForm = 'string';
    socket.deliver(invoke('get_value', { callId: 'call-2' }));
    await flush();
    h.context.inputForm = 'object';
    socket.deliver(invoke('get_value', { callId: 'call-3' }));
    await flush();
    expect(h.context.attempts.map((attempt) => typeof attempt.input)).toEqual([
      'object',
      'object',
      'string',
      'string',
      'object',
    ]);
    expect(results(socket).every((frame) => frame.ok)).toBe(true);
  });

  it('never retries a handler error, even one that mentions parsing input', async () => {
    const h = setup();
    h.context.handlers.set('set_value', () => {
      throw new Error('Failed to parse input date');
    });
    const socket = await link(h);
    socket.deliver(invoke('set_value'));
    await flush();
    expect(h.context.runs).toHaveLength(1);
    expect(results(socket)[0]?.error).toEqual({
      code: 'tool_error',
      message: `${HANDLER_FAILED}: Failed to parse input date`,
    });
  });

  it('caps error messages at 2000 characters', async () => {
    const h = setup();
    h.context.handlers.set('get_value', () => {
      throw new Error('e'.repeat(5000));
    });
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    expect(results(socket)[0]?.error?.message).toHaveLength(2000);
  });

  it('truncates a long result with a visible marker, within the result cap', async () => {
    const h = setup();
    h.context.handlers.set('get_value', () => 'x'.repeat(MAX_RESULT_CHARS + 10_000));
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    const content = results(socket)[0]?.content ?? '';
    expect(content.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(content.startsWith('x'.repeat(1000))).toBe(true);
    expect(content).toMatch(/\[tabdock: truncated, \d+ of 130000 characters removed\]$/);
  });

  it('cuts further when multi-byte text would overflow a smaller frame limit', async () => {
    const h = setup();
    h.context.handlers.set('get_value', () => '€'.repeat(50_000));
    const socket = await link(h, {
      limits: { ...welcome(h.clock).limits, maxFrameBytes: 20_000 },
    });
    socket.deliver(invoke('get_value'));
    await flush();
    const sent = socket.sent.at(-1) ?? '';
    expect(new TextEncoder().encode(sent).length).toBeLessThanOrEqual(20_000);
    expect(results(socket)[0]?.content).toMatch(
      /\[tabdock: truncated, \d+ of 50000 characters removed\]$/,
    );
  });

  it('ignores a repeated invoke for a call already running', async () => {
    const h = setup();
    let release: () => void = () => undefined;
    h.context.handlers.set(
      'get_value',
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('done');
          };
        }),
    );
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    socket.deliver(invoke('get_value'));
    await flush();
    release();
    await flush();
    expect(h.context.runs).toHaveLength(1);
    expect(results(socket)).toHaveLength(1);
  });
});

describe('cancel and deadline', () => {
  function slowHarness() {
    const h = setup();
    let finish: (value: string) => void = () => undefined;
    h.context.handlers.set(
      'get_value',
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    return {
      h,
      finish: (value: string) => {
        finish(value);
      },
    };
  }

  it('answers cancelled at once, aborts the signal and drops the late result', async () => {
    const { h, finish } = slowHarness();
    // A runtime that keeps going after abort, as the polyfill's handlers do.
    h.context.honoursAbort = false;
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'call-1', reason: 'client' });
    expect(results(socket)).toEqual([
      {
        t: 'result',
        callId: 'call-1',
        ok: false,
        error: { code: 'cancelled', message: 'the call was cancelled' },
      },
    ]);
    expect(h.context.runs[0]?.signal.aborted).toBe(true);
    finish('too late');
    await flush();
    expect(results(socket)).toHaveLength(1);
  });

  it('answers timeout at the deadline and aborts the signal', async () => {
    const { h } = slowHarness();
    const socket = await link(h);
    socket.deliver(invoke('get_value', { deadlineMs: 500 }));
    await h.clock.advance(499);
    expect(results(socket)).toHaveLength(0);
    await h.clock.advance(1);
    expect(results(socket)[0]?.error?.code).toBe('timeout');
    expect(h.context.runs[0]?.signal.aborted).toBe(true);
  });
});

describe('roles and consequential tools', () => {
  it('refuses an observer a tool that is not read-only, without running it (S5)', async () => {
    const h = setup();
    // Granted driver on the page, but an invoke that claims observer still lowers the role.
    const socket = await link(h, {}, { eve: 'driver' });
    const observer = { userId: 'eve', displayName: 'Eve', client: null, role: 'observer' as const };
    socket.deliver(invoke('set_value', { caller: observer }));
    socket.deliver(invoke('get_value', { callId: 'call-2', caller: observer }));
    await flush();
    expect(results(socket).map((frame) => frame.error?.code ?? 'ok')).toEqual([
      'role_denied',
      'ok',
    ]);
    expect(h.context.runs.map((run) => run.tool)).toEqual(['get_value']);
  });

  it('holds an observer on the roster to read-only tools even if an invoke claims driver', async () => {
    const h = setup();
    const socket = await link(h, {
      roster: [
        {
          userId: 'alice',
          displayName: 'Alice',
          kind: 'member',
          role: 'observer',
          grantedAt: h.clock.now,
          lastUsedAt: null,
          expiresAt: null,
          clients: [],
          inviteId: null,
          endsAt: null,
        },
      ],
    });
    socket.deliver(invoke('set_value'));
    await flush();
    expect(results(socket)[0]?.error?.code).toBe('role_denied');
    expect(h.context.runs).toHaveLength(0);
  });

  describe("the operator's grants (S5, second check)", () => {
    const bob = (role: 'driver' | 'observer' = 'driver') => ({
      userId: 'bob',
      displayName: 'Bob',
      client: null,
      role,
    });
    /** Outcomes in call id order; read-only calls finish later than refusals. */
    const codes = (socket: Awaited<ReturnType<typeof link>>) =>
      results(socket)
        .sort((a, b) => a.callId.localeCompare(b.callId))
        .map((frame) => frame.error?.code ?? 'ok');

    it('refuses a caller nobody approved on the page, whatever role the relay claims', async () => {
      const h = setup();
      // The relay lists Mallory as a driver, but the operator never approved her.
      const socket = await link(h, { roster: [attachment('mallory', 'driver')] }, {});
      const mallory = { userId: 'mallory', displayName: 'Mallory', client: null, role: 'driver' };
      const stranger = { ...mallory, userId: 'stranger', displayName: 'Stranger' };
      socket.deliver(invoke('set_value', { caller: stranger as never }));
      socket.deliver(invoke('get_value', { callId: 'call-2', caller: stranger as never }));
      socket.deliver(invoke('set_value', { callId: 'call-3', caller: mallory as never }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied', 'role_denied', 'role_denied']);
      expect(results(socket)[0]?.error?.message).toBe(
        'the operator has not approved this caller on this page',
      );
      expect(h.context.runs).toHaveLength(0);
    });

    it('never lets the roster or the invoke raise an observer to driver', async () => {
      const h = setup();
      const socket = await link(h, {}, { bob: 'observer' });
      socket.deliver({ t: 'roster', attachments: [attachment('bob', 'driver')] });
      socket.deliver(invoke('set_value', { caller: bob('driver') }));
      socket.deliver(invoke('get_value', { callId: 'call-2', caller: bob('driver') }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied', 'ok']);
      expect(h.context.runs.map((run) => run.tool)).toEqual(['get_value']);
    });

    // The relay keeps a user's first attachment whatever a later request from
    // them gets, so the grant must too, or every call of theirs fails.
    const storedGrants = (h: ReturnType<typeof setup>) =>
      JSON.parse(h.storage.getItem(GRANTS_KEY) ?? 'null') as unknown;

    it('keeps an existing grant when the operator denies a second request from the user', async () => {
      const h = setup();
      const socket = await link(h, {}, { bob: 'driver' });
      socket.deliver(attachRequest(h.clock, 'req-2'));
      expect(h.dock.deny('req-2')).toBe(true);
      socket.deliver(invoke('set_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['ok']);
      expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'driver' } } });
    });

    it('keeps an existing grant when a second request from the user goes unanswered', async () => {
      const h = setup();
      // A relay this quiet would otherwise count as gone before the minute is up.
      const socket = await link(
        h,
        { limits: { ...welcome(h.clock).limits, idleTimeoutMs: 600_000 } },
        { bob: 'driver' },
      );
      socket.deliver(attachRequest(h.clock, 'req-2'));
      await h.clock.advance(60_000);
      expect(socket.last()).toEqual({ t: 'attach_decision', requestId: 'req-2', allow: false });
      socket.deliver(invoke('set_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['ok']);
      expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'driver' } } });
    });

    it('keeps the first role when a second request from the user is approved as another', async () => {
      const h = setup();
      const socket = await link(h, {}, { bob: 'observer' });
      socket.deliver(attachRequest(h.clock, 'req-2'));
      expect(h.dock.approve('req-2', 'driver')).toBe(true);
      socket.deliver(invoke('set_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied']);
      expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'observer' } } });
    });

    it('lets a later approval replace one the relay ignored, before the user is listed', async () => {
      const h = setup();
      const socket = await link(h, {}, {});
      // Approved as observer just as the request expired: the relay drops the
      // decision and never lists Bob.
      socket.deliver(attachRequest(h.clock, 'req-1'));
      expect(h.dock.approve('req-1', 'observer')).toBe(true);
      // Bob pairs again and the operator approves him as driver this time.
      socket.deliver(attachRequest(h.clock, 'req-2'));
      expect(h.dock.approve('req-2', 'driver')).toBe(true);
      socket.deliver({ t: 'roster', attachments: [attachment('bob', 'driver')] });
      socket.deliver(invoke('set_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['ok']);
      expect(storedGrants(h)).toEqual({ pageId: 'page-1', grants: { bob: { role: 'driver' } } });
    });

    it.each(['denies', 'leaves unanswered'] as const)(
      "drops a grant the relay never applied when the operator %s the user's next request",
      async (answer) => {
        const h = setup();
        const socket = await link(
          h,
          { limits: { ...welcome(h.clock).limits, idleTimeoutMs: 600_000 } },
          {},
        );
        // Approved as driver just as the request expired: the relay drops the decision.
        socket.deliver(attachRequest(h.clock, 'req-1'));
        expect(h.dock.approve('req-1', 'driver')).toBe(true);
        socket.deliver(attachRequest(h.clock, 'req-2'));
        if (answer === 'denies') expect(h.dock.deny('req-2')).toBe(true);
        else await h.clock.advance(60_000);
        expect(socket.last()).toEqual({ t: 'attach_decision', requestId: 'req-2', allow: false });
        // The latest decision stands, even if a relay lists Bob after all.
        expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
        socket.deliver({ t: 'roster', attachments: [attachment('bob', 'driver')] });
        socket.deliver(invoke('set_value', { caller: bob() }));
        await flush();
        expect(codes(socket)).toEqual(['role_denied']);
        expect(h.context.runs).toHaveLength(0);
      },
    );

    it('leaves a user whose first request the operator denied with no grant', async () => {
      const h = setup();
      // The relay lists Bob anyway; only an approval on the page counts.
      const socket = await link(h, { roster: [attachment('bob', 'driver')] }, {});
      socket.deliver(attachRequest(h.clock));
      expect(h.dock.deny('req-1')).toBe(true);
      socket.deliver(invoke('get_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied']);
      expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
    });

    it('drops the grant of a user the roster stops listing, so coming back needs a new approval', async () => {
      const h = setup();
      const socket = await link(h);
      // Alice detached (detach_page), so the relay's next roster leaves her out.
      socket.deliver({ t: 'roster', attachments: [] });
      expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
      socket.deliver(invoke('set_value'));
      await flush();
      // A relay that lists her again without asking the operator gets nothing either.
      socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver')] });
      socket.deliver(invoke('set_value', { callId: 'call-2' }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied', 'role_denied']);
      expect(h.context.runs).toHaveLength(0);

      grant(h, socket, 'alice', 'driver');
      socket.deliver(invoke('set_value', { callId: 'call-3' }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied', 'role_denied', 'ok']);
    });

    it('runs nothing for a granted caller the relay does not list, and keeps a fresh grant', async () => {
      const h = setup();
      const socket = await link(h, {}, {});
      grant(h, socket, 'alice', 'driver');
      // A roster sent for another reason crosses the approval on the wire.
      socket.deliver({ t: 'roster', attachments: [attachment('bob', 'observer')] });
      socket.deliver(invoke('set_value'));
      await flush();
      // Then the relay applies the approval and lists her.
      socket.deliver({
        t: 'roster',
        attachments: [attachment('bob', 'observer'), attachment('alice', 'driver')],
      });
      socket.deliver(invoke('set_value', { callId: 'call-2' }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied', 'ok']);
    });

    it('keeps grants across a reload inside the resume window and clears them on detach', async () => {
      const first = setup();
      await link(first, {}, { bob: 'driver' });
      expect(JSON.parse(first.storage.getItem(GRANTS_KEY) ?? 'null')).toEqual({
        pageId: 'page-1',
        grants: { bob: { role: 'driver' } },
      });
      first.core.close('unload');

      // The reloaded page resumes the same session, so Bob may still drive.
      const reloaded = setup({ storage: first.storage });
      const socket = await link(
        reloaded,
        { resumed: true, resumeToken: 'resume-2', roster: [attachment('bob', 'driver')] },
        {},
      );
      socket.deliver(invoke('set_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['ok']);

      reloaded.dock.close();
      expect(first.storage.getItem(GRANTS_KEY)).toBeNull();
      expect(first.storage.getItem(RESUME_KEY)).toBeNull();

      // Nothing survives a detach, even if a relay claimed to resume the session.
      const after = setup({ storage: first.storage });
      const third = await link(after, { resumed: true, roster: [attachment('bob', 'driver')] }, {});
      third.deliver(invoke('get_value', { caller: bob() }));
      await flush();
      expect(codes(third)).toEqual(['role_denied']);
    });

    it('resumes without the grant of a user the relay dropped while the page was away', async () => {
      const first = setup();
      await link(first, {}, { bob: 'driver', carol: 'observer' });
      first.core.close('unload');
      // Bob detached during the resume window, so the welcome lists Carol only.
      const reloaded = setup({ storage: first.storage });
      const socket = await link(
        reloaded,
        { resumed: true, roster: [attachment('carol', 'observer')] },
        {},
      );
      expect(JSON.parse(first.storage.getItem(GRANTS_KEY) ?? 'null')).toEqual({
        pageId: 'page-1',
        grants: { carol: { role: 'observer' } },
      });
      socket.deliver({
        t: 'roster',
        attachments: [attachment('carol', 'observer'), attachment('bob', 'driver')],
      });
      socket.deliver(invoke('get_value', { caller: bob() }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied']);
    });

    it('starts a new page session, or another page, with nobody approved', async () => {
      const listed = { roster: [attachment('bob', 'driver')] };
      for (const overrides of [
        { ...listed, resumed: false },
        { ...listed, resumed: true, pageId: 'page-9' },
      ]) {
        const first = setup();
        await link(first, {}, { bob: 'driver' });
        first.core.close('unload');
        const next = setup({ storage: first.storage });
        const socket = await link(next, overrides, {});
        socket.deliver(invoke('get_value', { caller: bob() }));
        await flush();
        expect(codes(socket)).toEqual(['role_denied']);
        expect(first.storage.getItem(GRANTS_KEY)).toBeNull();
      }
    });

    it('reads malformed stored grants as none', async () => {
      const storage = new MapStorage();
      storage.setItem(GRANTS_KEY, '{"pageId":"page-1","grants":{"bob":"admin","eve":"driver"}}');
      const h = setup({ storage });
      const socket = await link(
        h,
        { resumed: true, roster: [attachment('bob', 'driver'), attachment('eve', 'driver')] },
        {},
      );
      socket.deliver(invoke('get_value', { caller: { ...bob(), userId: 'eve' } }));
      await flush();
      expect(codes(socket)).toEqual(['role_denied']);
      expect(h.logs).toContain('warn ignored stored grants that did not parse');
    });

    it("under autoApprove 'observer', lets a caller the relay lists read but not write", async () => {
      const h = setup({ core: { policy: { autoApprove: 'observer' } } });
      // The relay attached Carol without asking, as the policy allows (S4), and claims driver.
      const socket = await link(h, { roster: [attachment('carol', 'driver')] }, {});
      const carol = {
        userId: 'carol',
        displayName: 'Carol',
        client: null,
        role: 'driver' as const,
      };
      socket.deliver(invoke('get_value', { caller: carol }));
      socket.deliver(invoke('set_value', { callId: 'call-2', caller: carol }));
      // Someone the relay does not list gets nothing.
      socket.deliver(
        invoke('get_value', { callId: 'call-3', caller: { ...carol, userId: 'dave' } }),
      );
      await flush();
      expect(codes(socket)).toEqual(['ok', 'role_denied', 'role_denied']);
      expect(h.context.runs.map((run) => run.tool)).toEqual(['get_value']);

      // An operator's own approval still counts in full.
      grant(h, socket, 'carol', 'driver');
      socket.deliver(invoke('set_value', { callId: 'call-4', caller: carol }));
      await flush();
      expect(codes(socket).at(-1)).toBe('ok');
    });
  });

  it('asks before a consequential tool and runs it once the operator allows', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('wipe'));
    await flush();
    expect(h.dock.state.pendingConfirms).toMatchObject([
      { callId: 'call-1', tool: 'wipe', caller: { displayName: 'Alice' } },
    ]);
    expect(h.context.runs).toHaveLength(0);
    expect(h.dock.confirm('call-1', true)).toBe(true);
    await flush();
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(results(socket)[0]?.ok).toBe(true);
  });

  it('turns a denial into denied_by_operator, and only true allows', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('wipe'));
    await flush();
    expect(h.dock.confirm('call-1', 'yes' as unknown as boolean)).toBe(true);
    await flush();
    expect(results(socket)[0]?.error?.code).toBe('denied_by_operator');
    expect(h.context.runs).toHaveLength(0);
  });

  it('denies when nobody answers before the deadline (S6)', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('wipe', { deadlineMs: 1000 }));
    await h.clock.advance(1000);
    expect(results(socket)[0]?.error?.code).toBe('denied_by_operator');
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(h.dock.confirm('call-1', true)).toBe(false);
    expect(h.context.runs).toHaveLength(0);
  });

  it('lets the UI port answer, and leaves the prompt pending when it returns undefined', async () => {
    const allowing = setup({ core: { ui: { askConfirm: () => Promise.resolve(true) } } });
    const first = await link(allowing);
    first.deliver(invoke('wipe'));
    await flush();
    expect(results(first)[0]?.ok).toBe(true);

    const silent = setup({ core: { ui: { askConfirm: () => undefined } } });
    const second = await link(silent);
    second.deliver(invoke('wipe'));
    await flush();
    expect(silent.dock.state.pendingConfirms).toHaveLength(1);
  });

  it('follows policy deny and allow without prompting', async () => {
    const denying = setup({ core: { policy: { consequential: 'deny' } } });
    const first = await link(denying);
    first.deliver(invoke('wipe'));
    first.deliver(invoke('set_value', { callId: 'call-2' }));
    await flush();
    expect(results(first).map((frame) => frame.error?.code ?? 'ok')).toEqual([
      'denied_by_operator',
      'ok',
    ]);

    const allowing = setup({ core: { policy: { consequential: 'allow' } } });
    const second = await link(allowing);
    second.deliver(invoke('wipe'));
    await flush();
    expect(results(second)[0]?.ok).toBe(true);
    expect(allowing.dock.state.pendingConfirms).toEqual([]);
  });

  it('counts the page list as well as the hint where the runtime reports hints', async () => {
    const h = setup({ core: { policy: { consequentialTools: ['set_value'] } } });
    const socket = await link(h);
    socket.deliver(invoke('set_value'));
    socket.deliver(invoke('wipe', { callId: 'call-2' }));
    socket.deliver(invoke('get_value', { callId: 'call-3' }));
    await flush();
    // Both writes are consequential; the second waits its turn behind the first's prompt (M2).
    expect(h.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['set_value']);
    expect(results(socket).map((frame) => frame.callId)).toEqual(['call-3']);
    expect(h.dock.confirm('call-1', true)).toBe(true);
    await flush();
    expect(h.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['wipe']);
    expect(results(socket).map((frame) => frame.callId)).toEqual(['call-3', 'call-1']);
  });

  describe('ADR 0002 option C, where the runtime drops consequentialHint', () => {
    it('treats every tool that is not read-only as consequential and says how to fix it', async () => {
      const h = setup({ tools: polyfillTools() });
      const socket = await link(h);
      expect(h.dock.state.notice).toMatch(/consequentialTools/);
      socket.deliver(invoke('set_value'));
      socket.deliver(invoke('get_value', { callId: 'call-2' }));
      await flush();
      expect(h.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['set_value']);
      expect(results(socket).map((frame) => frame.callId)).toEqual(['call-2']);
    });

    it('takes the page list as authoritative, even an empty one', async () => {
      const listed = setup({
        tools: polyfillTools(),
        core: { policy: { consequentialTools: ['wipe'] } },
      });
      const first = await link(listed);
      expect(listed.dock.state.notice).toBeNull();
      first.deliver(invoke('set_value'));
      first.deliver(invoke('wipe', { callId: 'call-2' }));
      await flush();
      expect(results(first).map((frame) => frame.callId)).toEqual(['call-1']);
      expect(listed.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['wipe']);

      const none = setup({ tools: polyfillTools(), core: { policy: { consequentialTools: [] } } });
      const second = await link(none);
      second.deliver(invoke('wipe'));
      await flush();
      expect(results(second)[0]?.ok).toBe(true);
    });

    it('assumes nothing when no tool carries annotations at all', async () => {
      const h = setup({ tools: [runtimeTool('set_value')] });
      const socket = await link(h);
      socket.deliver(invoke('set_value'));
      await flush();
      expect(results(socket)[0]?.ok).toBe(true);
      expect(h.dock.state.notice).toBeNull();
    });

    it('gives no notice when policy allows consequential tools anyway', async () => {
      const h = setup({ tools: polyfillTools(), core: { policy: { consequential: 'allow' } } });
      await link(h);
      expect(h.dock.state.notice).toBeNull();
    });
  });
});

describe('attach requests', () => {
  it('waits for the handle, then sends the decision with the role', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(attachRequest(h.clock));
    expect(h.dock.state.pendingRequests).toMatchObject([
      { requestId: 'req-1', user: { displayName: 'Bob' }, via: 'code' },
    ]);
    expect(h.dock.approve('req-1', 'driver')).toBe(true);
    expect(socket.last()).toEqual({
      t: 'attach_decision',
      requestId: 'req-1',
      allow: true,
      role: 'driver',
    });
    expect(h.dock.state.pendingRequests).toEqual([]);
    expect(h.dock.approve('req-1', 'driver')).toBe(false);
  });

  it('denies by itself when the request expires', async () => {
    const h = setup();
    // A relay this quiet would otherwise count as gone before the minute is up.
    const socket = await link(h, {
      limits: { ...welcome(h.clock).limits, idleTimeoutMs: 600_000 },
    });
    socket.deliver(attachRequest(h.clock));
    await h.clock.advance(60_000);
    expect(socket.last()).toEqual({ t: 'attach_decision', requestId: 'req-1', allow: false });
    expect(h.dock.state.pendingRequests).toEqual([]);
  });

  it('never waits longer than a request can live, whatever the relay clock says', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver({ ...attachRequest(h.clock), expiresAt: h.clock.now + 600_000 });
    expect(h.dock.state.pendingRequests[0]?.expiresAt).toBe(h.clock.now + 60_000);
  });

  it('lets the UI port decide', async () => {
    const h = setup({ core: { ui: { askAttach: () => 'observer' } } });
    const socket = await link(h);
    socket.deliver(attachRequest(h.clock));
    await flush();
    expect(socket.last()).toMatchObject({ t: 'attach_decision', allow: true, role: 'observer' });
  });

  it('rejects an approval without a valid role', async () => {
    const h = setup();
    const socket = await link(h, {}, {});
    socket.deliver(attachRequest(h.clock));
    expect(h.dock.approve('req-1', 'admin' as never)).toBe(false);
    expect(h.dock.state.pendingRequests).toHaveLength(1);
    expect(socket.framesOf('attach_decision')).toHaveLength(0);
  });
});

describe('reconnecting', () => {
  it('backs off with jitter between the bounds and grows each time', () => {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      for (const random of [0, 0.5, 1]) {
        const delay = backoffDelay(attempt, () => random);
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_MIN_MS);
        expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_MS);
      }
    }
    expect(backoffDelay(3, () => 0)).toBe(2000);
    expect(backoffDelay(3, () => 1)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(RECONNECT_MAX_MS);
  });

  it('reconnects after a drop with the resume token, backing off until a welcome', async () => {
    const h = setup();
    const first = await link(h);
    first.drop(1006);
    expect(h.dock.state.link).toBe('reconnecting');
    expect(h.dock.state.pairing).toBeNull();
    await h.clock.advance(499);
    expect(h.sockets).toHaveLength(1);
    await h.clock.advance(1);
    expect(h.sockets).toHaveLength(2);

    const second = h.socket();
    second.accept();
    expect(second.framesOf('hello')[0]?.resumeToken).toBe('resume-1');
    second.drop(1006);
    await h.clock.advance(749);
    expect(h.sockets).toHaveLength(2);
    await h.clock.advance(1);
    expect(h.sockets).toHaveLength(3);

    const third = h.socket();
    third.accept();
    third.deliver(welcome(h.clock, { resumeToken: 'resume-2', resumed: true }));
    await flush();
    expect(h.dock.state.link).toBe('linked');
    expect(h.storage.getItem(RESUME_KEY)).toBe('resume-2');
    third.drop(1006);
    await h.clock.advance(500);
    expect(h.sockets).toHaveLength(4);
  });

  it('stops for good when the relay replaces the link (4001)', async () => {
    const h = setup();
    const socket = await link(h);
    socket.drop(4001, 'replaced');
    expect(h.dock.state.link).toBe('closed');
    expect(h.dock.state.error).toMatch(/4001/);
    await h.clock.advance(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.context.listenerCount).toBe(0);
  });

  it('ignores unknown frame types but closes with 1008 on an invalid frame, then reconnects', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver('{"t":"from_the_future","x":1}');
    expect(socket.closedWith).toBeNull();
    expect(h.logs.some((line) => line.includes('"from_the_future"'))).toBe(true);
    socket.deliver('{"t":"invoke","callId":"c1"}');
    expect(socket.closedWith).toEqual({ code: 1008, reason: 'invalid frame' });
    expect(h.dock.state.link).toBe('reconnecting');
    await h.clock.advance(500);
    expect(h.sockets).toHaveLength(2);
  });

  it('treats non-JSON as invalid too', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver('garbage');
    expect(socket.closedWith?.code).toBe(1008);
  });

  it('falls back to 4008 where the socket refuses 1008, as browsers do', async () => {
    const h = setup({ browserCloseRules: true });
    const socket = await link(h);
    socket.deliver('{"t":"welcome"}');
    expect(socket.closedWith).toEqual({ code: CLOSE_INVALID_FRAME_PAGE, reason: 'invalid frame' });
    expect(CLOSE_INVALID_FRAME_PAGE).toBe(4008);
  });

  it('treats a silent relay as gone with CLOSE_SILENT, which keeps the session resumable', async () => {
    const h = setup();
    const socket = await link(h);
    await h.clock.advance(IDLE_TIMEOUT_MS + 5000);
    // Never CLOSE_DETACH: the relay would end the session instead of letting the page resume.
    expect(socket.closedWith).toEqual({ code: CLOSE_SILENT, reason: 'relay silent' });
    expect(CLOSE_SILENT).toBe(4002);
    expect(CLOSE_SILENT).not.toBe(CLOSE_DETACH);
    expect(h.dock.state.link).toBe('reconnecting');
    expect(h.storage.getItem(RESUME_KEY)).toBe('resume-1');
  });

  it('counts the frame cap in UTF-8 bytes, not string length', async () => {
    const h = setup();
    const socket = await link(h);
    // Under the cap in UTF-16 code units, over it in bytes: each é is two bytes.
    const accented = JSON.stringify({ t: 'ping', pad: 'é'.repeat(600_000) });
    expect(accented.length).toBeLessThan(MAX_FRAME_BYTES);
    expect(new TextEncoder().encode(accented).length).toBeGreaterThan(MAX_FRAME_BYTES);
    socket.deliver(accented);
    expect(socket.framesOf('pong')).toHaveLength(0);
    expect(socket.closedWith).toEqual({ code: 1008, reason: 'invalid frame' });
    expect(h.logs).toContain('warn the relay sent an oversized frame; reconnecting');

    await h.clock.advance(RECONNECT_MIN_MS);
    const next = h.socket();
    next.accept();
    next.deliver(welcome(h.clock, { resumed: true }));
    await flush();
    // The same text in fewer bytes passes.
    next.deliver(JSON.stringify({ t: 'ping', pad: 'é'.repeat(400_000) }));
    expect(next.last()).toEqual({ t: 'pong' });
    // And plain ASCII over the cap fails on the fast length check.
    next.deliver(JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_FRAME_BYTES) }));
    expect(next.closedWith).toEqual({ code: 1008, reason: 'invalid frame' });
    expect(next.framesOf('pong')).toHaveLength(1);
  });

  it('ignores frames other than welcome before welcome', async () => {
    const h = setup();
    h.core.start();
    const socket = h.socket();
    socket.accept();
    socket.deliver(invoke('get_value'));
    await flush();
    expect(results(socket)).toHaveLength(0);
    expect(socket.closedWith).toBeNull();
  });

  it('aborts in-flight calls and clears prompts when the link drops', async () => {
    const h = setup();
    h.context.handlers.set('get_value', () => new Promise(() => undefined));
    const socket = await link(h);
    socket.deliver(invoke('get_value'));
    socket.deliver(invoke('wipe', { callId: 'call-2' }));
    socket.deliver(attachRequest(h.clock));
    await flush();
    socket.drop(1006);
    expect(h.context.runs[0]?.signal.aborted).toBe(true);
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(h.dock.state.pendingRequests).toEqual([]);
  });
});

describe('closing', () => {
  it('detaches: denies pending prompts, closes with CLOSE_DETACH and forgets the token', async () => {
    const h = setup();
    h.context.handlers.set('get_value', () => new Promise(() => undefined));
    const socket = await link(h);
    socket.deliver(attachRequest(h.clock));
    socket.deliver(invoke('wipe'));
    socket.deliver(invoke('get_value', { callId: 'call-2' }));
    await flush();
    h.dock.close();
    expect(socket.framesOf('attach_decision').filter((f) => f.requestId === 'req-1')).toEqual([
      { t: 'attach_decision', requestId: 'req-1', allow: false },
    ]);
    // The unanswered prompt is a denial (S6). The running call gets no result at all:
    // the relay fails it with page_gone on CLOSE_DETACH, where 'cancelled' read as timeout.
    expect(results(socket)).toEqual([
      {
        t: 'result',
        callId: 'call-1',
        ok: false,
        error: { code: 'denied_by_operator', message: 'the page detached' },
      },
    ]);
    expect(h.context.runs.find((run) => run.tool === 'get_value')?.signal.aborted).toBe(true);
    expect(h.logs).toContain('info call call-2 get_value by Alice (driver): page detached');
    expect(socket.closedWith).toEqual({ code: CLOSE_DETACH, reason: 'detached' });
    expect(h.storage.getItem(RESUME_KEY)).toBeNull();
    expect(h.storage.getItem(GRANTS_KEY)).toBeNull();
    expect(h.dock.state).toMatchObject({ link: 'closed', error: null });
    await h.clock.advance(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('unloads like a page reload: going away, token kept', async () => {
    const h = setup();
    const socket = await link(h);
    h.core.close('unload');
    expect(socket.closedWith).toEqual({ code: 1001, reason: 'unload' });
    expect(h.storage.getItem(RESUME_KEY)).toBe('resume-1');
  });

  it('never logs the resume token, the pairing code or arguments', async () => {
    const h = setup();
    const socket = await link(h);
    socket.deliver(invoke('get_value', { arguments: { secret: 'argument-value-xyz' } }));
    socket.deliver(
      invoke('set_value', { callId: 'call-2', arguments: { other: 'second-secret' } }),
    );
    await flush();
    socket.deliver('{"t":"invoke","callId":"c9","arguments":{"leak":"third-secret"}}');
    await flush();
    const logs = h.logs.join('\n');
    expect(logs).toContain('call call-1 get_value by Alice (driver): ok');
    for (const secret of [
      'resume-1',
      'ABCDE-FGHJK',
      'argument-value-xyz',
      'second-secret',
      'third-secret',
    ]) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('one approval covers one page (ADR 0011)', () => {
  const BOARD = 'http://127.0.0.1:5173/board';
  const SETTINGS = 'http://127.0.0.1:5173/settings';
  const caller = (userId: string) => ({
    userId,
    displayName: userId.charAt(0).toUpperCase() + userId.slice(1),
    client: null,
    role: 'driver' as const,
  });
  const codes = (socket: Awaited<ReturnType<typeof link>>) =>
    results(socket).map((frame) => frame.error?.code ?? 'ok');
  const listed = [attachment('bob', 'driver'), attachment('carol', 'observer')];

  it('gives two pages of one origin in one tab their own resume token, grants, revokes and pause', async () => {
    const board = setup({ core: { pageUrl: BOARD } });
    const first = await link(board, {}, { bob: 'driver', carol: 'observer' });
    first.drop(1006);
    // A revoke the relay has not heard yet, and a pause, both stored for the board.
    expect(board.dock.revoke('carol')).toBe(true);
    board.dock.pause(true);
    board.core.close('unload');

    // The operator moves to the settings page in the same tab.
    const settings = setup({ storage: board.storage, core: { pageUrl: SETTINGS } });
    expect(settings.dock.state.paused).toBe(false);
    settings.core.start();
    const other = settings.socket();
    other.accept();
    expect(other.framesOf('hello')[0]).toMatchObject({ url: SETTINGS });
    expect(other.framesOf('hello')[0]?.resumeToken).toBeUndefined();
    // Even a relay that wrongly resumed the board's session gets no grant or revoke from it here.
    other.deliver(
      welcome(settings.clock, { resumed: true, resumeToken: 'resume-s', roster: listed }),
    );
    await flush();
    expect(other.framesOf('revoke')).toEqual([]);
    other.deliver(invoke('set_value', { caller: caller('bob') }));
    await flush();
    expect(codes(other)).toEqual(['role_denied']);
    settings.core.close('unload');

    // Back on the board, its reload finds everything it stored, untouched.
    const reloaded = setup({ storage: board.storage, core: { pageUrl: BOARD } });
    expect(reloaded.dock.state.paused).toBe(true);
    reloaded.core.start();
    const back = reloaded.socket();
    back.accept();
    expect(back.framesOf('hello')[0]?.resumeToken).toBe('resume-1');
    back.deliver(
      welcome(reloaded.clock, { resumed: true, resumeToken: 'resume-2', roster: listed }),
    );
    await flush();
    expect(back.framesOf('revoke')).toEqual([{ t: 'revoke', userId: 'carol' }]);
    reloaded.dock.pause(false);
    back.deliver(invoke('set_value', { caller: caller('bob') }));
    await flush();
    expect(codes(back)).toEqual(['ok']);
  });

  it('keeps one page across a reload with another query or fragment, and never sends either', async () => {
    const first = setup({ core: { pageUrl: `${BOARD}?view=list#top` } });
    first.core.start();
    first.socket().accept();
    expect(first.socket().framesOf('hello')[0]).toMatchObject({ url: BOARD });
    first.socket().deliver(welcome(first.clock));
    await flush();
    first.core.close('unload');

    const second = setup({ storage: first.storage, core: { pageUrl: `${BOARD}?view=grid` } });
    second.core.start();
    second.socket().accept();
    expect(second.socket().framesOf('hello')[0]).toMatchObject({
      url: BOARD,
      resumeToken: 'resume-1',
    });
  });

  it('ignores and removes what an older adapter stored under the relay URL alone', async () => {
    const storage = new MapStorage();
    const legacy = (record: string) => `tabdock:${record}:${RELAY_URL}`;
    storage.setItem(legacy('resume'), 'stale-token');
    storage.setItem(legacy('grants'), '{"pageId":"page-1","grants":{"bob":"driver"}}');
    storage.setItem(legacy('revoked'), '{"pageId":"page-1","users":["carol"]}');
    storage.setItem(legacy('paused'), 'true');
    const h = setup({ storage });
    expect(h.dock.state.paused).toBe(false);
    for (const record of ['resume', 'grants', 'revoked', 'paused']) {
      expect(storage.getItem(legacy(record)), record).toBeNull();
    }
    h.core.start();
    const socket = h.socket();
    socket.accept();
    expect(socket.framesOf('hello')[0]?.resumeToken).toBeUndefined();
    socket.deliver(welcome(h.clock, { resumed: true, roster: listed }));
    await flush();
    expect(socket.framesOf('revoke')).toEqual([]);
    socket.deliver(invoke('set_value', { caller: caller('bob') }));
    await flush();
    expect(codes(socket)).toEqual(['role_denied']);
  });
});

describe('createAdapterCore', () => {
  it('rejects an invalid policy at once', () => {
    expect(() =>
      createAdapterCore({
        relayUrl: RELAY_URL,
        policy: { maxDrivers: 0 },
        socketFactory: () => {
          throw new Error('unused');
        },
        pageUrl: '',
        pageInfo: () => ({ title: '' }),
        adapterVersion: '0',
      }),
    ).toThrow();
  });
});
