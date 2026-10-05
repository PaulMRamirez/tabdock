import {
  type Caller,
  CLOSE_DETACH,
  CLOSE_INVALID_FRAME_PAGE,
  CLOSE_SILENT,
  IDLE_TIMEOUT_MS,
  INVITEE_SHORT_ID_CHARS,
  MAX_FRAME_BYTES,
  MAX_INVITE_LIFETIME_MS,
  MAX_RESULT_CHARS,
  MAX_TIMER_MS,
  type PolicyInput,
  RECONNECT_MAX_MS,
  RECONNECT_MIN_MS,
  TOOL_POLL_MS,
} from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  createAdapterCore,
  type LocksLike,
  MAX_DEADLINE_MS,
  REMEMBERED_PROMPT_IDS,
  type RuntimeTool,
  type UiPort,
} from '../src/core.ts';
import {
  FRAME_WINDOW,
  GRANTS_KEY,
  GUEST,
  HANDLER_FAILED,
  type FakeSocket,
  type Harness,
  type InviteListing,
  ManualClock,
  MapStorage,
  PAGE_WINDOW,
  RELAY_URL,
  RESUME_KEY,
  attachRequest,
  attachment,
  chromeTools,
  flush,
  grant,
  invitedAttachment,
  invitesFrame,
  invoke,
  link,
  mint,
  polyfillTools,
  redemption,
  results,
  runtimeTool,
  setup,
  until,
  welcome,
} from './harness.ts';
import { readScriptOptions } from '../src/script-options.ts';

/** The policy the script-tag build hands attach() for this data-consequential-tools value. */
function scriptTagPolicy(consequentialTools: string): PolicyInput {
  const options = readScriptOptions({ relay: RELAY_URL, consequentialTools });
  if (!options.ok) throw new Error(options.error);
  return options.policy;
}

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
    // Both majors' entry points: MCP-B 6 exports only installWebMCP(), 5.x only initializeWebMCPPolyfill().
    expect(h.dock.state.error).toContain('installWebMCP()');
    expect(h.dock.state.error).toContain('initializeWebMCPPolyfill()');
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
      {
        name: 'bare',
        description: '',
        inputSchema: { type: 'object', properties: {} },
        // Not read-only, on a runtime that shows annotations without the hint
        // and a page that listed none: consequential by ADR 0002's fallback.
        consequential: true,
      },
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

  describe("the consequential mark (ADR 0026, ADR 0002's rule)", () => {
    async function firstFrame(tools: RuntimeTool[], policy: PolicyInput = {}) {
      const h = setup({ tools, core: { policy } });
      const socket = await link(h, {}, {});
      return socket.framesOf('tools')[0]?.tools ?? [];
    }

    async function marked(tools: RuntimeTool[], policy: PolicyInput = {}): Promise<string[]> {
      return (await firstFrame(tools, policy))
        .filter((tool) => tool.consequential === true)
        .map((tool) => tool.name);
    }

    it('marks each tool the hint or the page list calls consequential where the runtime reports hints', async () => {
      expect(await marked(chromeTools())).toEqual(['wipe']);
      expect(await marked(chromeTools(), { consequentialTools: ['set_value'] })).toEqual([
        'set_value',
        'wipe',
      ]);
      // Unmarked tools carry no key at all, as an older adapter sent them.
      const frame = await firstFrame(chromeTools());
      expect(frame.filter((tool) => 'consequential' in tool).map((tool) => tool.name)).toEqual([
        'wipe',
      ]);
    });

    it('marks every tool that is not read-only where the runtime drops the hint and the page names none', async () => {
      expect(await marked(polyfillTools())).toEqual(['set_value', 'wipe']);
      expect(await marked(polyfillTools(), { consequentialTools: ['wipe'] })).toEqual(['wipe']);
      // An empty list names none, so the fallback still decides (ADR 0034).
      expect(await marked(polyfillTools(), { consequentialTools: [] })).toEqual([
        'set_value',
        'wipe',
      ]);
      expect(await marked([runtimeTool('set_value')])).toEqual([]);
    });

    it('marks the same tools whatever the policy says about who confirms, or whether consequential tools run', async () => {
      for (const policy of [
        { confirmVia: 'client' },
        { confirmVia: 'page' },
        { consequential: 'allow' },
        { consequential: 'deny', confirmVia: 'client' },
      ] satisfies PolicyInput[]) {
        expect(await marked(chromeTools(), policy), JSON.stringify(policy)).toEqual(['wipe']);
        expect(await marked(polyfillTools(), policy), JSON.stringify(policy)).toEqual([
          'set_value',
          'wipe',
        ]);
      }
    });

    it('takes no mark from the runtime: only the page rule marks a tool', async () => {
      expect(
        await marked([
          runtimeTool('get_value', { readOnlyHint: true }, { consequential: true }),
          runtimeTool('wipe', { consequentialHint: true }, { consequential: false }),
        ]),
      ).toEqual(['wipe']);
    });

    it('sends a new frame when only a mark changes', async () => {
      const h = setup({ tools: polyfillTools() });
      const socket = await link(h, {}, {});
      // A hint that is not a boolean stays off the wire, yet shows the runtime
      // reports consequentialHint, so set_value is no longer consequential.
      h.context.tools = polyfillTools().map((tool) =>
        tool.name === 'get_value'
          ? {
              ...tool,
              annotations: {
                readOnlyHint: true,
                untrustedContentHint: false,
                consequentialHint: 'unknown',
              },
            }
          : tool,
      );
      h.context.fireToolChange();
      await h.clock.advance(100);
      const [before, after] = socket.framesOf('tools').map((frame) => frame.tools);
      const unmarked = (tools: typeof before) =>
        tools?.map((tool) => {
          const copy = { ...tool };
          delete copy.consequential;
          return copy;
        });
      expect(unmarked(after)).toEqual(unmarked(before));
      expect(before?.filter((tool) => tool.consequential === true).map((t) => t.name)).toEqual([
        'set_value',
        'wipe',
      ]);
      expect(after?.filter((tool) => tool.consequential === true)).toEqual([]);
    });
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

  // The schema takes any positive safe integer, so a relay the adapter does
  // not trust can send a deadline no timer can hold; Chromium ran such a
  // timer at once, ending the call as it began (ADR 0030).
  it.each([
    ['2^31 ms', 2 ** 31],
    ['Number.MAX_SAFE_INTEGER ms', Number.MAX_SAFE_INTEGER],
  ])(
    'caps a deadline of %s under the timer maximum, so the call ends neither at once nor past the cap',
    async (_, deadlineMs) => {
      const h = setup({ browserTimers: true });
      h.context.handlers.set('get_value', () => new Promise<string>(() => undefined));
      const socket = await link(h);
      socket.deliver(invoke('get_value', { deadlineMs }));
      await h.clock.advance(1000);
      expect(results(socket)).toEqual([]);
      expect(h.context.runs[0]?.signal.aborted).toBe(false);
      // On to just short of the cap at once, the relay's ping keeping the link alive meanwhile.
      h.clock.now += MAX_DEADLINE_MS - 1000 - 1;
      socket.deliver({ t: 'ping' });
      await h.clock.advance(0);
      expect(results(socket)).toEqual([]);
      await h.clock.advance(1);
      expect(results(socket)[0]?.error?.code).toBe('timeout');
      expect(h.context.runs[0]?.signal.aborted).toBe(true);
      expect(h.delays.filter((ms) => ms > MAX_TIMER_MS)).toEqual([]);
    },
  );
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

    it('takes a list that names tools as authoritative', async () => {
      const listed = setup({
        tools: polyfillTools(),
        core: { policy: { consequentialTools: ['wipe'] } },
      });
      const socket = await link(listed);
      expect(listed.dock.state.notice).toBeNull();
      socket.deliver(invoke('set_value'));
      socket.deliver(invoke('wipe', { callId: 'call-2' }));
      await flush();
      expect(results(socket).map((frame) => frame.callId)).toEqual(['call-1']);
      expect(listed.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['wipe']);
    });

    // README and SPEC section 8 once showed consequentialTools: [] in their
    // example, so a page that copied either must still fail safe (ADR 0034).
    it.each<[string, PolicyInput]>([
      ['attach() given consequentialTools: []', { consequentialTools: [] }],
      ['the script tag given data-consequential-tools=""', scriptTagPolicy('')],
      ['the script tag given data-consequential-tools=" , "', scriptTagPolicy(' , ')],
    ])(
      'counts an empty list as naming none, for %s: every write is marked, prompts, and the notice shows',
      async (_how, policy) => {
        expect(policy.consequentialTools).toEqual([]);
        const h = setup({ tools: polyfillTools(), core: { policy } });
        const socket = await link(h);
        expect(h.dock.state.notice).toMatch(/consequentialTools/);
        expect(
          socket
            .framesOf('tools')[0]
            ?.tools.filter((tool) => tool.consequential === true)
            .map((tool) => tool.name),
        ).toEqual(['set_value', 'wipe']);
        socket.deliver(invoke('wipe'));
        socket.deliver(invoke('get_value', { callId: 'call-2' }));
        await flush();
        expect(h.dock.state.pendingConfirms.map((item) => item.tool)).toEqual(['wipe']);
        expect(results(socket).map((frame) => frame.callId)).toEqual(['call-2']);
        expect(h.dock.confirm('call-1', false)).toBe(true);
        await flush();
        expect(results(socket).map((frame) => [frame.callId, frame.error?.code ?? 'ok'])).toEqual([
          ['call-2', 'ok'],
          ['call-1', 'denied_by_operator'],
        ]);
        expect(h.context.attempts.map((attempt) => attempt.tool)).toEqual(['get_value']);
      },
    );

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

describe('an answer counts only for the prompt it was asked about (S6)', () => {
  const consequential = { consequentialHint: true, untrustedContentHint: false };
  /** A mild write the operator may well allow, beside chromeTools()'s wipe. */
  const STAR = runtimeTool('star_item', { ...consequential, readOnlyHint: false });
  /** Read-only and consequential, so its prompts stand side by side rather than queue. */
  const PEEK = runtimeTool('peek', { ...consequential, readOnlyHint: true });
  const IGNORED_ANSWER = 'warn ignored a UI port answer to a confirmation that was already settled';
  const BOB = { userId: 'bob', displayName: 'Bob', client: null, role: 'driver' } as const;

  /**
   * A host dialog that resolves on a later click and ignores its abort
   * signal, as a UI port may: it keeps every prompt it was shown, to answer later.
   */
  function lateDialog() {
    const asked: { tool: string; answer: (allow: boolean) => void }[] = [];
    const ui: UiPort = {
      askConfirm: (pending) =>
        new Promise<boolean>((resolve) => {
          asked.push({ tool: pending.tool, answer: resolve });
        }),
    };
    return { ui, asked };
  }

  const outcomes = (socket: FakeSocket) =>
    results(socket).map((frame) => `${frame.callId}:${frame.error?.code ?? 'ok'}`);

  it('runs nothing when the relay cancels a prompted call and reuses its id for another tool', async () => {
    const dialog = lateDialog();
    const h = setup({ tools: [...chromeTools(), STAR], core: { ui: dialog.ui } });
    const socket = await link(h);
    socket.deliver(invoke('star_item', { callId: 'c1' }));
    await flush();
    expect(dialog.asked.map((prompt) => prompt.tool)).toEqual(['star_item']);
    socket.deliver({ t: 'cancel', callId: 'c1', reason: 'client' });
    socket.deliver(invoke('wipe', { callId: 'c1' }));
    await flush();
    // The operator allows the star they were shown, late, then a host dialog
    // keyed by call id answers through the Dock as well.
    dialog.asked[0]?.answer(true);
    await flush();
    expect(h.dock.confirm('c1', true)).toBe(false);
    await flush();
    expect(h.context.runs).toEqual([]);
    expect(outcomes(socket)).toEqual(['c1:cancelled']);
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(dialog.asked.map((prompt) => prompt.tool)).toEqual(['star_item']);
    expect(h.logs).toContain(
      'warn ignored an invoke under call c1, whose id a prompt here has used',
    );
    expect(h.logs).toContain(IGNORED_ANSWER);
  });

  it.each(['a deadline', 'a revoke', 'a lost link'] as const)(
    'takes no later call under the id of a prompt that ended by %s',
    async (how) => {
      const h = setup({ tools: [...chromeTools(), STAR] });
      const socket = await link(h, {}, { alice: 'driver', bob: 'driver' });
      socket.deliver(invoke('star_item', { callId: 'c1', deadlineMs: 1000 }));
      await flush();
      expect(h.dock.state.pendingConfirms.map((prompt) => prompt.tool)).toEqual(['star_item']);
      let relay = socket;
      if (how === 'a deadline') await h.clock.advance(1000);
      if (how === 'a revoke') expect(h.dock.revoke('alice')).toBe(true);
      if (how === 'a lost link') {
        // The page keeps what it remembers across links, as a host's dialog outlives them.
        socket.drop(1006);
        await h.clock.advance(500);
        relay = h.socket();
        relay.accept();
        relay.deliver(
          welcome(h.clock, {
            resumed: true,
            roster: [attachment('alice', 'driver'), attachment('bob', 'driver')],
          }),
        );
        await flush();
      }
      expect(h.dock.state.pendingConfirms).toEqual([]);
      relay.deliver(invoke('wipe', { callId: 'c1', caller: BOB }));
      await flush();
      expect(h.dock.state.pendingConfirms).toEqual([]);
      expect(h.dock.confirm('c1', true)).toBe(false);
      await flush();
      expect(h.context.runs).toEqual([]);
      expect(results(relay).filter((frame) => frame.error?.code === undefined)).toEqual([]);
      // A fresh id from the same relay prompts as ever.
      relay.deliver(invoke('wipe', { callId: 'c2', caller: BOB }));
      await flush();
      expect(h.dock.state.pendingConfirms.map((prompt) => prompt.callId)).toEqual(['c2']);
    },
  );

  it(`binds a UI port's answer to its prompt even once ${REMEMBERED_PROMPT_IDS} newer prompts have let the page forget the id`, async () => {
    const dialog = lateDialog();
    const h = setup({ tools: [...chromeTools(), STAR, PEEK], core: { ui: dialog.ui } });
    const socket = await link(h);
    socket.deliver(invoke('star_item', { callId: 'c1' }));
    await flush();
    socket.deliver({ t: 'cancel', callId: 'c1', reason: 'client' });
    for (let index = 0; index < REMEMBERED_PROMPT_IDS; index += 1) {
      socket.deliver(invoke('peek', { callId: `p${index}` }));
    }
    await flush();
    expect(h.dock.state.pendingConfirms).toHaveLength(REMEMBERED_PROMPT_IDS);
    for (let index = 0; index < REMEMBERED_PROMPT_IDS; index += 1) {
      socket.deliver({ t: 'cancel', callId: `p${index}`, reason: 'client' });
    }
    socket.deliver(invoke('wipe', { callId: 'c1' }));
    await flush();
    // The page took the id again, so wipe has a prompt of its own.
    expect(h.dock.state.pendingConfirms.map((prompt) => prompt.tool)).toEqual(['wipe']);
    dialog.asked[0]?.answer(true);
    await flush();
    expect(h.context.runs).toEqual([]);
    expect(h.dock.state.pendingConfirms.map((prompt) => prompt.tool)).toEqual(['wipe']);
    expect(h.logs).toContain(IGNORED_ANSWER);
    // Its own prompt still answers for it.
    dialog.asked.at(-1)?.answer(false);
    await flush();
    expect(h.context.runs).toEqual([]);
    expect(outcomes(socket).at(-1)).toBe('c1:denied_by_operator');
  });
});

describe("confirmation in the caller's client (ADR 0026, S6)", () => {
  const OPTED_IN: PolicyInput = { confirmVia: 'client' };
  const CLIENT = { name: 'claude-code', version: '2.1.289' };
  const HOUR = 60 * 60_000;
  const alice: Caller = { userId: 'alice', displayName: 'Alice', client: CLIENT, role: 'driver' };
  const guest: Caller = {
    userId: GUEST,
    displayName: 'guest@example.com',
    client: CLIENT,
    role: 'driver',
  };
  const bob: Caller = { userId: 'bob', displayName: 'Bob', client: CLIENT, role: 'driver' };

  /** What a relay sends for a call the caller confirmed in their client. */
  const confirmation = (h: Harness) =>
    ({ by: 'client', confirmationId: 'cf_1', at: h.clock.now }) as const;

  /** Links a page with Alice approved directly as driver, the one case the page takes a confirmation from. */
  const memberDriver = (h: Harness) => link(h);

  /**
   * A page that offers invites, linked with Alice approved directly, and one
   * Can control invite redeemed by `who` and approved as driver by the
   * operator, so this page's own grant names the invite. The roster then
   * lists them naming that invite when `rosterNamesInvite`, as a truthful
   * relay would, or naming none, as a relay that lies would.
   */
  async function invitedDriver(
    h: Harness,
    who: { userId: string; displayName: string; kind: 'member' | 'invitee' },
    rosterNamesInvite: boolean,
  ): Promise<FakeSocket> {
    const socket = await link(h);
    socket.deliver(invitesFrame([]));
    const listed: InviteListing[] = [];
    const minted = await mint(h, socket, { label: 'Help', role: 'driver' }, listed);
    socket.deliver(
      redemption(h.clock, minted, {
        user: { userId: who.userId, displayName: who.displayName },
        account: { kind: who.kind, verified: true },
      }),
    );
    await until(() => h.dock.state.pendingRequests.length > 0, 'the redemption prompt');
    if (!h.dock.approve(`redeem-${minted.inviteId}`, 'driver')) throw new Error('not approved');
    const endsAt = h.clock.now + MAX_INVITE_LIFETIME_MS;
    const entry = rosterNamesInvite
      ? invitedAttachment(who.userId, 'driver', minted.inviteId, endsAt, who.displayName)
      : { ...attachment(who.userId, 'driver'), displayName: who.displayName, kind: who.kind };
    socket.deliver({ t: 'roster', attachments: [attachment('alice', 'driver'), entry] });
    await flush();
    return socket;
  }

  /** Storage holding a bare driver grant for the guest, as an adapter before M4 kept one: no invite named. */
  function storedGuestGrant(): MapStorage {
    const storage = new MapStorage();
    storage.setItem(
      GRANTS_KEY,
      JSON.stringify({ pageId: 'page-1', grants: { [GUEST]: 'driver' } }),
    );
    return storage;
  }

  interface Case {
    readonly policy?: PolicyInput;
    readonly tools?: () => RuntimeTool[];
    readonly storage?: () => MapStorage;
    readonly prepare: (h: Harness) => Promise<FakeSocket>;
    readonly caller?: Caller;
    readonly tool: string;
    /** Whether the page puts the call to its operator, as it does today. */
    readonly asks: boolean;
  }

  /**
   * What the page does with one invoke, with or without the relay's
   * confirmation: whether it asks, then, after the operator allows or stays
   * silent past the deadline, what it answered, what ran and what the
   * activity log shows.
   */
  async function trace(c: Case, answer: 'allow' | 'silence', confirmed: boolean) {
    const h = setup({
      core: { policy: c.policy ?? OPTED_IN },
      ...(c.tools ? { tools: c.tools() } : {}),
      ...(c.storage ? { storage: c.storage() } : {}),
    });
    const socket = await c.prepare(h);
    socket.deliver(
      invoke(c.tool, {
        deadlineMs: 1000,
        caller: c.caller ?? alice,
        ...(confirmed ? { confirmation: confirmation(h) } : {}),
      }),
    );
    await flush();
    const asked = h.dock.state.pendingConfirms.map((pending) => pending.tool);
    if (answer === 'allow') h.dock.confirm('call-1', true);
    await h.clock.advance(1000);
    return {
      asked,
      results: results(socket),
      runs: h.context.runs.map((run) => run.tool),
      activity: h.dock.state.activity.map(({ outcome, confirmedBy }) => ({ outcome, confirmedBy })),
    };
  }

  const failing: [string, Case][] = [
    ['a page that did not opt in', { policy: {}, prepare: memberDriver, tool: 'wipe', asks: true }],
    [
      'a page that opted in but denies consequential tools',
      {
        policy: { ...OPTED_IN, consequential: 'deny' },
        prepare: memberDriver,
        tool: 'wipe',
        asks: false,
      },
    ],
    [
      'a page that opted in but allows consequential tools',
      {
        policy: { ...OPTED_IN, consequential: 'allow' },
        prepare: memberDriver,
        tool: 'wipe',
        asks: false,
      },
    ],
    [
      'a paused page',
      {
        prepare: async (h) => {
          const socket = await memberDriver(h);
          h.dock.pause(true);
          return socket;
        },
        tool: 'wipe',
        asks: false,
      },
    ],
    [
      "an invitee's id, even on a driver grant that names no invite",
      {
        storage: storedGuestGrant,
        prepare: (h) =>
          link(
            h,
            {
              resumed: true,
              roster: [
                {
                  ...attachment(GUEST, 'driver'),
                  displayName: 'guest@example.com',
                  kind: 'invitee',
                },
              ],
            },
            {},
          ),
        caller: guest,
        tool: 'wipe',
        asks: true,
      },
    ],
    [
      'an invitee a Can control invite let in',
      {
        policy: { ...OPTED_IN, invites: 'all' },
        prepare: (h) =>
          invitedDriver(
            h,
            { userId: GUEST, displayName: 'guest@example.com', kind: 'invitee' },
            true,
          ),
        caller: guest,
        tool: 'wipe',
        asks: true,
      },
    ],
    [
      "a member whose grant on this page an invite made, though the relay's roster names none",
      {
        policy: { ...OPTED_IN, invites: 'all' },
        prepare: (h) =>
          invitedDriver(h, { userId: 'bob', displayName: 'Bob', kind: 'member' }, false),
        caller: bob,
        tool: 'wipe',
        asks: true,
      },
    ],
    [
      'a member approved here whom the relay lists as let in by an invite',
      {
        prepare: (h) =>
          link(h, {
            roster: [
              {
                ...attachment('alice', 'driver'),
                inviteId: 'inv_relay',
                endsAt: h.clock.now + HOUR,
              },
            ],
          }),
        tool: 'wipe',
        asks: true,
      },
    ],
    [
      'an observer by the operator grant',
      {
        policy: { ...OPTED_IN, consequentialTools: ['get_value'] },
        prepare: (h) => link(h, {}, { alice: 'observer' }),
        tool: 'get_value',
        asks: true,
      },
    ],
    [
      "an observer by the relay's roster",
      {
        policy: { ...OPTED_IN, consequentialTools: ['get_value'] },
        prepare: (h) => link(h, { roster: [attachment('alice', 'observer')] }),
        tool: 'get_value',
        asks: true,
      },
    ],
    [
      'an observer by the role the invoke claims',
      {
        policy: { ...OPTED_IN, consequentialTools: ['get_value'] },
        prepare: memberDriver,
        caller: { ...alice, role: 'observer' },
        tool: 'get_value',
        asks: true,
      },
    ],
    [
      'an observer calling a consequential write',
      {
        prepare: (h) => link(h, {}, { alice: 'observer' }),
        tool: 'wipe',
        asks: false,
      },
    ],
    [
      'a tool the page does not count as consequential, whatever the relay thinks',
      { prepare: memberDriver, tool: 'set_value', asks: false },
    ],
  ];

  describe.each(failing)('for %s', (_, c) => {
    it.each([
      ['allows', 'allow'],
      ['stays silent', 'silence'],
    ] as const)(
      'does exactly what it does without a confirmation when the operator %s',
      async (_how, answer) => {
        const crafted = await trace(c, answer, true);
        expect(crafted.asked.length > 0).toBe(c.asks);
        expect(crafted).toEqual(await trace(c, answer, false));
        // The client is never credited with a call it did not let run.
        expect(crafted.activity.every((entry) => entry.confirmedBy === null)).toBe(true);
        if (c.asks) {
          expect(crafted.results.map((frame) => frame.error?.code ?? 'ok')).toEqual([
            answer === 'allow' ? 'ok' : 'denied_by_operator',
          ]);
        }
      },
    );
  });

  it("runs a member driver's consequential call with no prompt on a page that opted in, and says so", async () => {
    const h = setup({ core: { policy: OPTED_IN } });
    const socket = await memberDriver(h);
    socket.deliver(invoke('wipe', { caller: alice, confirmation: confirmation(h) }));
    await flush();
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(results(socket)).toEqual([{ t: 'result', callId: 'call-1', ok: true, content: '{}' }]);
    expect(h.context.runs.map((run) => run.tool)).toEqual(['wipe']);
    expect(h.dock.state.activity).toMatchObject([
      { callId: 'call-1', tool: 'wipe', client: CLIENT, outcome: 'ok', confirmedBy: 'client' },
    ]);
    expect(h.logs).toContain(
      'info call call-1 wipe by Alice (driver): confirmed in their client, so the page did not ask',
    );
    expect(h.logs.join('\n')).not.toContain('cf_1');

    // The same page still asks its operator about a call that comes unconfirmed.
    socket.deliver(invoke('wipe', { callId: 'call-2', caller: alice }));
    await flush();
    expect(h.dock.state.pendingConfirms.map((pending) => pending.callId)).toEqual(['call-2']);
    expect(h.context.runs).toHaveLength(1);
  });

  it('takes it for a tool consequential by the fallback, where the runtime drops the hint (ADR 0002)', async () => {
    const h = setup({ tools: polyfillTools(), core: { policy: OPTED_IN } });
    const socket = await memberDriver(h);
    socket.deliver(invoke('set_value', { caller: alice, confirmation: confirmation(h) }));
    await flush();
    expect(h.dock.state.pendingConfirms).toEqual([]);
    expect(results(socket)[0]?.ok).toBe(true);
    expect(h.dock.state.activity[0]?.confirmedBy).toBe('client');
  });

  it('logs why it asks when it does not take a confirmation, naming nobody an invitee is', async () => {
    const h = setup({ core: { policy: OPTED_IN }, storage: storedGuestGrant() });
    const socket = await link(
      h,
      {
        resumed: true,
        roster: [
          { ...attachment(GUEST, 'driver'), displayName: 'guest@example.com', kind: 'invitee' },
        ],
      },
      {},
    );
    socket.deliver(invoke('wipe', { caller: guest, confirmation: confirmation(h) }));
    await flush();
    expect(h.dock.state.pendingConfirms).toHaveLength(1);
    const line = h.logs.find((entry) => entry.includes('asking on the page'));
    expect(line).toBe(
      `info call call-1 wipe by invitee ${GUEST.slice(2, 2 + INVITEE_SHORT_ID_CHARS)} (driver): asking on the page, as the caller is an invitee, whatever the relay says of their client`,
    );
    expect(h.logs.join('\n')).not.toContain('guest@example.com');
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

  // The schema takes any positive integer for idleTimeoutMs, as for
  // deadlineMs, and a silence timer past the maximum fired at once in
  // Chromium: a reconnect loop on every welcome (ADR 0030).
  it.each([
    ['2^31 ms', 2 ** 31],
    ['Number.MAX_SAFE_INTEGER ms', Number.MAX_SAFE_INTEGER],
  ])(
    'caps a relay idle timeout of %s at the timer maximum, so the link neither drops at once nor waits past it',
    async (_, idleTimeoutMs) => {
      const h = setup({ browserTimers: true });
      const socket = await link(h, { limits: { ...welcome(h.clock).limits, idleTimeoutMs } });
      await h.clock.advance(IDLE_TIMEOUT_MS * 4);
      expect(h.sockets).toHaveLength(1);
      expect(socket.closedWith).toBeNull();
      expect(h.dock.state.link).toBe('linked');
      expect(h.delays.filter((ms) => ms > MAX_TIMER_MS)).toEqual([]);
      // On to just short of the cap at once: still linked, and gone at the cap.
      h.clock.now += MAX_TIMER_MS - IDLE_TIMEOUT_MS * 4 - 1;
      await h.clock.advance(0);
      expect(socket.closedWith).toBeNull();
      await h.clock.advance(1);
      expect(socket.closedWith).toEqual({ code: CLOSE_SILENT, reason: 'relay silent' });
    },
  );

  it('caps the timer for an invite-made grant whose stored end lies past the timer maximum', async () => {
    // Storage is the page's, and only this adapter writes grants there, each
    // ending 24 hours on; anything else in it must still not spin the page.
    const storage = new MapStorage();
    const endsAt = new ManualClock().now + 2 ** 31;
    storage.setItem(
      GRANTS_KEY,
      JSON.stringify({
        pageId: 'page-1',
        grants: { bob: { role: 'observer', inviteId: 'inv_1', endsAt, inviteRole: 'observer' } },
      }),
    );
    const h = setup({ browserTimers: true, storage });
    await link(
      h,
      { resumed: true, roster: [invitedAttachment('bob', 'observer', 'inv_1', endsAt, 'Bob')] },
      {},
    );
    expect(h.dock.state.pageRoles).toMatchObject([{ userId: 'bob', role: 'observer' }]);
    expect(h.delays.filter((ms) => ms > MAX_TIMER_MS)).toEqual([]);
    const before = h.delays.length;
    await h.clock.advance(10_000);
    // Polls rearm a few timers in 10 s, never the grant's end over and over.
    expect(h.delays.length - before).toBeLessThan(20);
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
  it('rejects an invalid policy at once, with a TypeError naming its fields and never their values (ADR 0032)', () => {
    const attachWith = (policy: unknown) => () =>
      createAdapterCore({
        relayUrl: RELAY_URL,
        policy: policy as PolicyInput,
        socketFactory: () => {
          throw new Error('unused');
        },
        pageUrl: '',
        pageInfo: () => ({ title: '' }),
        adapterVersion: '0',
      });
    expect(attachWith({ maxDrivers: 0 })).toThrow(new TypeError('invalid policy for maxDrivers'));
    expect(attachWith({ maxDrivers: 0, consequential: 'maybe' })).toThrow(
      new TypeError('invalid policy for maxDrivers, consequential'),
    );
    expect(attachWith({ consequentialTools: ['ok', 5] })).toThrow(
      new TypeError('invalid policy for consequentialTools.1'),
    );
    expect(attachWith('everything')).toThrow(new TypeError('invalid policy: it must be an object'));
  });
});
