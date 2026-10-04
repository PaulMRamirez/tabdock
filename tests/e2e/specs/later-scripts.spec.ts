import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  ATTACH_REQUEST_TTL_MS,
  encodeFrame,
  MAX_DESCRIPTION_CHARS,
  MAX_FRAME_BYTES,
  MAX_RESULT_CHARS,
  type PageFrame,
  parsePageFrame,
  PING_INTERVAL_MS,
  type RelayFrame,
  RESUME_WINDOW_MS,
} from '@tabdock/protocol';
import {
  clickInWidget,
  demoPageUrl,
  typeInWidget,
  waitForDock,
  widgetButtonCentre,
  widgetButtonNow,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// What a page script that runs after attach() can catch or change by
// patching the browser's built-ins (threat model B5, S4, S11 and S14),
// against a scripted relay. The adapter drives its page link through
// functions it took by the time attach() returned, so patching
// WebSocket.prototype, MessageEvent's data getter or JSON.parse afterwards,
// even before a reconnect makes a new socket, hands such a script no relay
// frame and so no invite secret (packages/adapter/test/later-scripts.test.ts
// covers minting); patching JSON.stringify or the typed array length getter
// hands it no frame the page sends, so it cannot turn the operator's Deny
// into Allow there. The widget makes its DOM calls the same way, so patching
// a DOM prototype afterwards hands it none of the widget's nodes, and so
// never the closed shadow root that getRootNode() on one would return; and
// it times and measures its boxes the same way, so patching setTimeout or
// DOMRect's getters afterwards arms no box early and keeps no moved box
// armed. What stays open (the page's other JavaScript built-ins, any toJSON,
// and covering the widget with a look-alike) is the trusted page's, as
// docs/threat-model.md says.

/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
/** What a redemption presents: an invite secret's shape, 22 base64url characters. */
const SECRET = 'LaterScriptProbe_0123x';
const GUEST = `g_${'1a2b3c4d'.repeat(4)}`;
const LINK_BASE = 'https://relay.example/i';
const BOB = { userId: 'bob', displayName: 'Bob' };
/** The widget's ARM_DELAY_MS. */
const ARM_DELAY_MS = 500;
/** How often the widget's tick looks for boxes that moved. */
const TICK_MS = 1000;

test.use({ viewport: { width: 1280, height: 1200 } });

let demo: DemoServer;

test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});

interface FakeRelay {
  readonly frames: PageFrame[];
  readonly connections: number;
  send(frame: RelayFrame): void;
  drop(): Promise<void>;
}

/**
 * The demo page against a relay that welcomes every hello, resuming when it
 * carries a token, offers invites at LINK_BASE and lists every one the page
 * mints, with Bob as its sponsor.
 */
async function openWithFakeRelay(page: Page): Promise<FakeRelay> {
  const frames: PageFrame[] = [];
  const listings: Extract<RelayFrame, { t: 'invites' }>['invites'] = [];
  let current: WebSocketRoute | null = null;
  let connections = 0;
  await page.routeWebSocket(FAKE_RELAY, (ws) => {
    current = ws;
    connections += 1;
    const list = (): void => {
      ws.send(encodeFrame({ t: 'invites', linkBase: LINK_BASE, invites: [...listings] }));
    };
    ws.onMessage((message) => {
      const parsed = parsePageFrame(typeof message === 'string' ? message : message.toString());
      if (parsed.kind !== 'ok') throw new Error(`the page sent a ${parsed.kind} frame`);
      const frame = parsed.frame;
      frames.push(frame);
      if (frame.t === 'invite_create') {
        listings.push({
          inviteId: frame.inviteId,
          role: frame.role,
          label: frame.label,
          uses: frame.uses,
          expiresAt: frame.expiresAt,
          usesLeft: frame.uses,
          sponsor: BOB,
          pending: false,
          refusals: 0,
        });
        list();
        return;
      }
      if (frame.t !== 'hello') return;
      ws.send(
        encodeFrame({
          t: 'welcome',
          pageId: 'page-1',
          resumeToken: `resume-${String(connections)}`,
          resumed: frame.resumeToken !== undefined,
          pairing: { code: 'ABCDE-FGHJK', expiresAt: Date.now() + 120_000 },
          roster: [],
          limits: {
            maxFrameBytes: MAX_FRAME_BYTES,
            maxResultChars: MAX_RESULT_CHARS,
            maxDescriptionChars: MAX_DESCRIPTION_CHARS,
            pingIntervalMs: PING_INTERVAL_MS,
            idleTimeoutMs: 600_000,
            resumeWindowMs: RESUME_WINDOW_MS,
            attachRequestTtlMs: ATTACH_REQUEST_TTL_MS,
          },
        }),
      );
      list();
    });
  });
  await page.goto(demoPageUrl(demo.url, FAKE_RELAY));
  await page.waitForSelector('html[data-tools="ready"]');
  await waitForDock(page, (state) => state.link === 'linked');
  return {
    frames,
    get connections() {
      return connections;
    },
    send(frame) {
      if (!current) throw new Error('the page has not connected');
      current.send(encodeFrame(frame));
    },
    async drop() {
      await current?.close({ code: 1001, reason: 'gone' });
    },
  };
}

/**
 * Stops the page's timers; only runFor moves them on from here. pauseAt takes
 * a time in the page's future, and the page's clock runs on while this asks
 * for it, so a loaded machine may need another try.
 */
async function pauseClock(page: Page): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const now = await page.evaluate(() => Date.now());
    try {
      await page.clock.pauseAt(now + 250);
      return;
    } catch (error) {
      if (attempt === 5 || !String(error).includes('to the past')) throw error;
    }
  }
}

/** A member's attach request by code, as the relay forwards it. */
function attachRequest(requestId: string): RelayFrame {
  return {
    t: 'attach_request',
    requestId,
    user: { userId: 'mallory', displayName: 'Mallory' },
    account: { kind: 'member', verified: true },
    via: 'code',
    client: null,
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  };
}

function decisions(relay: FakeRelay) {
  return relay.frames.filter((frame) => frame.t === 'attach_decision');
}

declare global {
  interface Window {
    /** Every string the later script's patches were handed, in order. */
    __laterSeen?: string[];
    /** What the later script's DOM patches caught; see spyOnTheDom. */
    __laterDom?: () => { members: string[]; nodes: number; calls: number };
  }
}

test('a script that patches the socket, MessageEvent and JSON.parse after attach() reads no relay frame, so no redemption secret', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);

  // A script that runs after attach(): it patches the socket, the events it
  // fires and JSON.parse, which a relay frame's text passes through on its
  // way in, and the socket's send, which a page frame's text leaves through.
  // A later test patches JSON.stringify and the typed array length getter,
  // which a page frame's text passes through before that.
  await page.evaluate(() => {
    const seen: string[] = [];
    window.__laterSeen = seen;
    const record = (value: unknown): void => {
      if (typeof value === 'string') seen.push(value);
    };
    type Fn = (this: unknown, ...args: unknown[]) => unknown;
    // What the chain from `start` holds under `key`, wherever that is (a real
    // WebSocket's own prototype, or the base class of Playwright's stand-in).
    const lookup = (start: object, key: string): PropertyDescriptor => {
      for (
        let proto: object | null = start;
        proto !== null;
        proto = Reflect.getPrototypeOf(proto)
      ) {
        const found = Reflect.getOwnPropertyDescriptor(proto, key);
        if (found) return found;
      }
      throw new Error(`no ${key}`);
    };
    const part = (descriptor: PropertyDescriptor, which: 'get' | 'set' | 'value'): Fn => {
      const found: unknown = Reflect.get(descriptor, which);
      if (typeof found !== 'function') throw new Error(`no ${which}`);
      return found as Fn;
    };
    /** Shadows `key` on `target` with a function of the script's own. */
    const replace = (target: object, key: string, value: Fn): void => {
      Reflect.defineProperty(target, key, { configurable: true, writable: true, value });
    };

    const readData = part(lookup(MessageEvent.prototype, 'data'), 'get');
    Reflect.defineProperty(MessageEvent.prototype, 'data', {
      configurable: true,
      get(this: MessageEvent): unknown {
        const value = Reflect.apply(readData, this, []);
        record(value);
        return value;
      },
    });
    const spyOn = (listener: unknown): unknown =>
      typeof listener === 'function'
        ? function (this: unknown, event: unknown): unknown {
            if (event instanceof MessageEvent) record(Reflect.apply(readData, event, []));
            return Reflect.apply(listener, this, [event]) as unknown;
          }
        : listener;
    for (const name of ['onopen', 'onmessage', 'onclose', 'onerror']) {
      const handler = lookup(WebSocket.prototype, name);
      const get = part(handler, 'get');
      const set = part(handler, 'set');
      Reflect.defineProperty(WebSocket.prototype, name, {
        configurable: true,
        get(this: WebSocket): unknown {
          return Reflect.apply(get, this, []);
        },
        set(this: WebSocket, listener: unknown) {
          Reflect.apply(set, this, [spyOn(listener)]);
        },
      });
    }
    const listen = part(lookup(EventTarget.prototype, 'addEventListener'), 'value');
    replace(
      EventTarget.prototype,
      'addEventListener',
      function (this: unknown, ...args: unknown[]) {
        const [type, listener, options] = args;
        const given = this instanceof WebSocket ? spyOn(listener) : listener;
        return Reflect.apply(listen, this, [type, given, options]);
      },
    );
    const send = part(lookup(WebSocket.prototype, 'send'), 'value');
    replace(WebSocket.prototype, 'send', function (this: unknown, ...args: unknown[]) {
      record(args[0]);
      return Reflect.apply(send, this, args);
    });
    const parse = part(lookup(JSON, 'parse'), 'value');
    replace(JSON, 'parse', function (this: unknown, ...args: unknown[]) {
      record(args[0]);
      return Reflect.apply(parse, JSON, args);
    });
  });

  // A drop and a reconnect, so the new socket is made, and its handler set, after the patches.
  await relay.drop();
  await expect.poll(() => relay.connections).toBe(2);
  await waitForDock(page, (state) => state.link === 'linked');

  relay.send({
    t: 'attach_request',
    requestId: 'redeem-1',
    user: { userId: GUEST, displayName: 'guest@example.com' },
    account: { kind: 'invitee', verified: true },
    via: 'invite',
    client: null,
    invite: { inviteId: 'inv_laterscript1', secret: SECRET, label: 'Probe' },
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  });
  // The page has no record of that invite, so it refuses: proof the frame arrived and was read.
  await expect
    .poll(() =>
      relay.frames.some(
        (frame) => frame.t === 'attach_decision' && frame.requestId === 'redeem-1' && !frame.allow,
      ),
    )
    .toBe(true);

  const seen = await page.evaluate(() => window.__laterSeen ?? []);
  expect(seen.filter((text) => text.includes(SECRET))).toEqual([]);
  // Nor any other frame of the link, either way.
  expect(seen.filter((text) => /"t":"(welcome|hello|attach_decision)"/.test(text))).toEqual([]);
});

/**
 * A script that runs after attach() and wraps every method and accessor of
 * the DOM's prototypes, noting each member whose receiver, an argument or a
 * result is a node inside a shadow root, and keeping every node it is
 * handed, so one that joins a shadow tree later (a node created now and
 * appended afterwards) counts too. getBoundingClientRect, which the A4.3
 * review found, was one such member; textContent's setter and the dataset
 * getter, which the widget also ran every second, were others.
 */
async function spyOnTheDom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const rootOf: unknown = Reflect.get(Node.prototype, 'getRootNode');
    if (typeof rootOf !== 'function') throw new Error('no getRootNode');
    const inShadow = (value: unknown): boolean =>
      value instanceof Node && Reflect.apply(rootOf, value, []) instanceof ShadowRoot;
    const members = new Set<string>();
    const nodes = new Set<Node>();
    let calls = 0;
    let busy = false;
    const note = (member: string, values: unknown[]): void => {
      if (busy) return;
      busy = true;
      calls += 1;
      for (const value of values) {
        if (!(value instanceof Node)) continue;
        nodes.add(value);
        if (inShadow(value)) members.add(member);
      }
      busy = false;
    };
    const elements = Object.getOwnPropertyNames(window).filter((name) =>
      /^(HTML|SVG)\w*Element$/.test(name),
    );
    const interfaces = [
      'EventTarget',
      'Node',
      'Element',
      'Document',
      'DocumentFragment',
      'ShadowRoot',
      'CharacterData',
      'Text',
      'DOMTokenList',
      'DOMStringMap',
      'HTMLCollection',
      'NodeList',
      'NamedNodeMap',
      ...elements,
    ];
    for (const name of interfaces) {
      const owner: unknown = Reflect.get(window, name);
      if (typeof owner !== 'function') continue;
      const proto = (owner as { prototype: object }).prototype;
      for (const key of Reflect.ownKeys(proto)) {
        if (key === 'constructor') continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(proto, key);
        if (!descriptor?.configurable) continue;
        const member = `${name}.${String(key)}`;
        const value: unknown = Reflect.get(descriptor, 'value');
        const get: unknown = Reflect.get(descriptor, 'get');
        const set: unknown = Reflect.get(descriptor, 'set');
        const patched: PropertyDescriptor = { ...descriptor };
        if (typeof value === 'function') {
          patched.value = function (this: unknown, ...args: unknown[]): unknown {
            const result: unknown = Reflect.apply(value, this, args);
            note(member, [this, ...args, result]);
            return result;
          };
        } else if (typeof get === 'function' || typeof set === 'function') {
          if (typeof get === 'function') {
            patched.get = function (this: unknown): unknown {
              const result: unknown = Reflect.apply(get, this, []);
              note(member, [this, result]);
              return result;
            };
          }
          if (typeof set === 'function') {
            patched.set = function (this: unknown, given: unknown): void {
              Reflect.apply(set, this, [given]);
              note(member, [this, given]);
            };
          }
        } else {
          continue;
        }
        Reflect.defineProperty(proto, key, patched);
      }
    }
    window.__laterDom = () => {
      const caught = new Set(members);
      for (const node of nodes) if (inShadow(node)) caught.add('a node it was handed earlier');
      return { members: [...caught].sort(), nodes: nodes.size, calls };
    };
  });
}

test('a script that patches the DOM prototypes after attach() is handed no node of the widget, so never its closed shadow root', async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);
  await spyOnTheDom(page);

  // The widget's own life from here: ticks, a prompt approved, a row, a
  // consequential call denied, an invite minted and its link shown, Pause,
  // Revoke, and more ticks.
  await page.waitForTimeout(1300);
  relay.send({
    t: 'attach_request',
    requestId: 'req-bob',
    user: BOB,
    account: { kind: 'member', verified: true },
    via: 'code',
    client: null,
    expiresAt: Date.now() + ATTACH_REQUEST_TTL_MS,
  });
  await clickInWidget(page, { action: 'approve-driver', requestId: 'req-bob' });
  await expect
    .poll(() => relay.frames.some((frame) => frame.t === 'attach_decision' && frame.allow))
    .toBe(true);
  relay.send({
    t: 'roster',
    attachments: [
      {
        ...BOB,
        kind: 'member',
        role: 'driver',
        grantedAt: Date.now(),
        lastUsedAt: null,
        expiresAt: null,
        clients: [],
        inviteId: null,
        endsAt: null,
      },
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 1);
  relay.send({
    t: 'invoke',
    callId: 'call-1',
    tool: 'clear_board',
    arguments: {},
    caller: { ...BOB, client: null, role: 'driver' },
    deadlineMs: 45_000,
  });
  await clickInWidget(page, { action: 'confirm-deny', callId: 'call-1' });
  await expect
    .poll(() => relay.frames.some((frame) => frame.t === 'result' && frame.callId === 'call-1'))
    .toBe(true);
  // Minted by real clicks and keys only: the harness's mintInWidget reads the
  // link through Runtime.callFunctionOn, which runs in the page's own world
  // and so through the spy's patches, as the widget no longer does.
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Probe');
  await typeInWidget(page, 'invite-uses', '2');
  await clickInWidget(page, { action: 'invite-create' });
  await waitForDock(page, (state) => state.invites.some((invite) => invite.label === 'Probe'));
  await expect.poll(() => widgetVisible(page, 'invite-link')).toBe(true);
  await clickInWidget(page, { action: 'invite-done' });
  await clickInWidget(page, { action: 'pause' });
  await waitForDock(page, (state) => state.paused);
  await clickInWidget(page, { action: 'revoke', userId: 'bob' });
  await expect.poll(() => relay.frames.some((frame) => frame.t === 'revoke')).toBe(true);
  await page.waitForTimeout(1300);

  const report = await page.evaluate(() => window.__laterDom?.());
  if (!report) throw new Error('the spy was not installed');
  // The spy did watch DOM work on the page, the demo board's among it.
  expect(report.calls).toBeGreaterThan(0);
  expect(report.members).toEqual([]);

  // And it would have caught a touch: a closed shadow root of the test's own, used the same way.
  const control = await page.evaluate(() => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const line = document.createElement('p');
    shadow.append(line);
    line.textContent = 'x';
    void line.getBoundingClientRect();
    return window.__laterDom?.().members ?? [];
  });
  expect(control).toEqual(
    expect.arrayContaining(['Element.getBoundingClientRect', 'Node.textContent']),
  );
});

test("a script that patches JSON.stringify and the typed array length after attach() sees no frame the page sends, and the operator's Deny goes out as Deny", async ({
  page,
}) => {
  const relay = await openWithFakeRelay(page);

  // A script that runs after attach() and wants in: it records each frame the
  // page sends, through JSON.stringify and through the length getter a
  // frame's bytes are counted with, and hands back every answer as an Allow
  // as driver.
  await page.evaluate(() => {
    const seen: string[] = [];
    window.__laterSeen = seen;
    const isFrame = (text: string): boolean => text.startsWith('{"t":');
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    Reflect.defineProperty(JSON, 'stringify', {
      configurable: true,
      writable: true,
      value: function (...args: unknown[]): unknown {
        const text: unknown = Reflect.apply(stringify, JSON, args);
        if (typeof text !== 'string' || !isFrame(text)) return text;
        seen.push(text);
        const frame = parse(text) as Record<string, unknown>;
        return frame.t === 'attach_decision'
          ? Reflect.apply(stringify, JSON, [{ ...frame, allow: true, role: 'driver' }])
          : text;
      },
    });
    const typedArrayPrototype = Reflect.getPrototypeOf(Uint8Array.prototype) as object;
    const lengthGetter: unknown = Reflect.getOwnPropertyDescriptor(
      typedArrayPrototype,
      'length',
    )?.get;
    if (typeof lengthGetter !== 'function') throw new Error('no typed array length getter');
    const decoder = new TextDecoder();
    let busy = false;
    Reflect.defineProperty(Uint8Array.prototype, 'length', {
      configurable: true,
      get(this: Uint8Array): unknown {
        const length: unknown = Reflect.apply(lengthGetter, this, []);
        if (!busy) {
          busy = true;
          try {
            const text = decoder.decode(this);
            if (isFrame(text)) seen.push(text);
          } catch {
            // Bytes a decoder refuses, such as a shared buffer's, are no frame.
          } finally {
            busy = false;
          }
        }
        return length;
      },
    });
  });

  relay.send(attachRequest('req-1'));
  // The operator's real click on the real, uncovered Deny.
  await clickInWidget(page, { action: 'deny', requestId: 'req-1' });
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-1', allow: false }]);
  expect(await page.evaluate(() => window.__laterSeen ?? [])).toEqual([]);
});

test('a script that swaps setTimeout after attach() arms no box before it has held still', async ({
  page,
}) => {
  await page.clock.install();
  const relay = await openWithFakeRelay(page);
  await pauseClock(page);

  // A script that runs after attach(): any wait as long as the widget's fires at once.
  await page.evaluate((delay) => {
    const setTimer: unknown = Reflect.get(window, 'setTimeout');
    if (typeof setTimer !== 'function') throw new Error('no setTimeout');
    Reflect.defineProperty(window, 'setTimeout', {
      configurable: true,
      writable: true,
      value: function (...args: unknown[]): unknown {
        const [run, ms, ...rest] = args;
        return Reflect.apply(setTimer, window, [run, ms === delay ? 0 : ms, ...rest]);
      },
    });
  }, ARM_DELAY_MS);

  relay.send(attachRequest('req-1'));
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  const target = { action: 'approve-driver', requestId: 'req-1' };
  await page.clock.runFor(ARM_DELAY_MS - 100);
  const shown = await widgetButtonNow(page, target);
  expect(shown?.armed).toBe(false);

  // A click on it before then lands nowhere, and starts the wait again.
  await page.mouse.click(shown?.x ?? 0, shown?.y ?? 0);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, target))?.armed).toBe(true);
  expect(decisions(relay)).toEqual([]);

  await page.mouse.click(shown?.x ?? 0, shown?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-1', allow: true, role: 'driver' }]);
});

test("a script that patches DOMRect's getters after attach() keeps no box that moved armed", async ({
  page,
}) => {
  await page.clock.install();
  const relay = await openWithFakeRelay(page);
  relay.send(attachRequest('req-1'));
  const target = { action: 'approve-driver', requestId: 'req-1' };
  const before = await widgetButtonCentre(page, target);
  await pauseClock(page);

  // A script that runs after attach(): every rectangle answers the same place.
  await page.evaluate(() => {
    for (const proto of [DOMRectReadOnly.prototype, DOMRect.prototype]) {
      for (const key of ['x', 'y', 'top', 'left', 'right', 'bottom', 'width', 'height']) {
        if (!Reflect.getOwnPropertyDescriptor(proto, key)) continue;
        Reflect.defineProperty(proto, key, { configurable: true, get: () => 0 });
      }
    }
  });
  // Long enough for a tick to see the rectangles' new answer, and for a box
  // that waited again because of it to arm.
  await page.clock.runFor(TICK_MS + ARM_DELAY_MS);

  // A shorter window moves the bottom-pinned panel up; nothing renders, and no tick runs.
  await page.setViewportSize({ width: 1280, height: 1000 });
  const moved = await widgetButtonNow(page, target);
  expect(moved?.y ?? before.y).toBeLessThan(before.y);
  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  expect((await widgetButtonNow(page, target))?.armed).toBe(false);
  await page.clock.runFor(ARM_DELAY_MS);
  expect(decisions(relay)).toEqual([]);

  await page.mouse.click(moved?.x ?? 0, moved?.y ?? 0);
  await expect
    .poll(() => decisions(relay))
    .toEqual([{ t: 'attach_decision', requestId: 'req-1', allow: true, role: 'driver' }]);
});
