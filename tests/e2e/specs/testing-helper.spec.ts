import type { Client } from '@modelcontextprotocol/client';
import { type CDPSession, expect, type Page, test } from '@playwright/test';
import {
  allowAttach,
  clickInWidget as clickWith,
  readPairingCode,
  waitingPrompts,
  widgetButton,
  widgetText,
  WidgetTestError,
} from '@tabdock/adapter/testing';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  callTool,
  clickInWidget,
  connectMcp,
  dockState,
  errorCode,
  startTabdock,
  type Tabdock,
  waitForDock,
  waitForLink,
} from '../src/tabdock-harness.ts';

// ADR 0041's helper, @tabdock/adapter/testing, on the real demo page and a
// real relay, as a CI check uses it: it reads the pairing code from the
// widget's closed shadow root and clicks Allow as driver through Playwright's
// own DevTools session, passed to it with no cast (so typecheck holds the
// helper's structural session type to Playwright's). Only a trusted click on
// an armed, uncovered button approves; any other would leave the prompt in
// place and these tests would time out. It refuses to choose between two
// waiting requests it cannot tell apart, and approves only the one it names.

const CI = 'tabdock-ci-check';

let demo: DemoServer;
let tabdock: Tabdock;

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async () => {
  tabdock = await startTabdock({ demo });
});
test.afterEach(async () => {
  await tabdock.close();
});

async function openBoard(page: Page): Promise<{ pageId: string; code: string; cdp: CDPSession }> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const linked = await waitForLink(page);
  return { ...linked, cdp: await page.context().newCDPSession(page) };
}

/** The code the page shows once it has moved on from `used`. */
async function nextCode(page: Page, used: string): Promise<string> {
  return waitForDock(page, (s) => (s.pairing && s.pairing.code !== used ? s.pairing.code : null));
}

async function rosterOf(page: Page): Promise<[string, string][] | undefined> {
  return (await dockState(page))?.roster.map((a) => [a.userId, a.role]);
}

/** Makes the board taller than the window and scrolls it by `y`; the widget stays fixed in its corner. */
async function scrollBoard(page: Page, y: number): Promise<void> {
  await page.evaluate((by) => {
    const tall = document.createElement('div');
    tall.style.height = '4000px';
    document.body.append(tall);
    window.scrollTo(0, by);
  }, y);
  expect(await page.evaluate(() => window.scrollY)).toBe(y);
}

/**
 * Gives the board a writing direction or mode from `html`'s style, makes it
 * overflow both ways, and scrolls the window to `x`, `y`; the widget stays
 * fixed in its corner, its own text laid out as always.
 */
async function shapeBoard(page: Page, style: string, x: number, y: number): Promise<void> {
  await page.evaluate(
    ([css, left, top]) => {
      document.documentElement.setAttribute('style', css);
      const big = document.createElement('div');
      Object.assign(big.style, { width: '4000px', height: '4000px' });
      document.body.append(big);
      window.scrollTo(left, top);
    },
    [style, x, y] as const,
  );
}

async function pairsAsDriver(page: Page, shape?: (page: Page) => Promise<void>): Promise<void> {
  const { pageId, code, cdp } = await openBoard(page);
  if (shape !== undefined) await shape(page);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
  try {
    // What the widget shows is what the page's own handle holds.
    expect(await readPairingCode(cdp)).toBe(code);
    expect((await dockState(page))?.pairing?.code).toBe(code);

    const pending = callTool(client, 'pair_page', { code });
    const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    await expect
      .poll(() => waitingPrompts(cdp))
      .toEqual({
        attach: [{ requestId, client: CI }],
        confirm: [],
      });
    expect(await allowAttach(cdp, { as: 'driver', client: CI })).toBe(requestId);
    const paired = await pending;
    expect(paired.isError, paired.text).toBe(false);
    expect(paired.structured).toMatchObject({ page: pageId, role: 'driver' });
    expect(await waitingPrompts(cdp)).toEqual({ attach: [], confirm: [] });

    const listed = await callTool(client, 'list_pages');
    expect((listed.structured as { pages: unknown[] }).pages).toEqual([
      expect.objectContaining({ page: pageId, role: 'driver' }),
    ]);
    await expect.poll(() => rosterOf(page)).toEqual([['alice', 'driver']]);
    const detached = await callTool(client, 'detach_page', { page: pageId });
    expect(detached.isError, detached.text).toBe(false);
  } finally {
    await client.close();
    await cdp.detach();
  }
}

test('reads the pairing code and pairs a client named in the call as driver, with a trusted click', async ({
  page,
}) => {
  await pairsAsDriver(page);
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('reads the code and clicks Allow as driver wherever the panel lays out', async ({
    page,
  }) => {
    await pairsAsDriver(page);
  });
});

// The box and the press count from the viewport's corner and the hit test
// from the document's, so on a scrolled page the helper must move its hit
// test by the scroll, or it checks a spot that far from where it presses.
test.describe('on a scrolled page', () => {
  test.use({ viewport: { width: 1280, height: 600 } });

  test('finds Allow where the press lands and pairs as driver', async ({ page }) => {
    await pairsAsDriver(page, (p) => scrollBoard(p, 400));
  });

  // These count the layout viewport's scroll from the far end, unlike the
  // visual viewport's, which the helper must not take for an element
  // scrolling in the document's place.
  test('pairs on a right-to-left page scrolled left', async ({ page }) => {
    await pairsAsDriver(page, async (p) => {
      await shapeBoard(p, 'direction: rtl', -401, 300);
      expect(await p.evaluate(() => [window.scrollX, window.scrollY])).toEqual([-401, 300]);
    });
  });

  test('pairs on a page whose block axis starts at the bottom', async ({ page }) => {
    await pairsAsDriver(page, async (p) => {
      await shapeBoard(p, 'writing-mode: vertical-lr; direction: rtl', 10, -200);
      expect(await p.evaluate(() => [window.scrollX, window.scrollY])).toEqual([10, -200]);
    });
  });

  // A cover that takes clicks catches the press; one that lets clicks through
  // (pointer-events: none) passes it to Allow, which would approve.
  for (const cover of [
    { kind: 'that takes clicks', passThrough: false },
    { kind: 'that lets clicks through to it', passThrough: true },
  ]) {
    test(`presses nothing while a page element ${cover.kind} covers the centre of Allow, though the spot it scrolled from is clear`, async ({
      page,
    }) => {
      const { code, cdp } = await openBoard(page);
      // A few pixels, so the spot a hit test in the viewport's coordinates
      // would check still lies on Allow, above the cover.
      await scrollBoard(page, 6);
      const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
      try {
        const pending = callTool(client, 'pair_page', { code });
        const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
        const target = { action: 'approve-driver', requestId } as const;
        const at = await widgetButton(cdp, target);

        // A page element over the centre of Allow alone, painted above the
        // widget, that counts the presses it takes.
        await page.evaluate(
          ({ x, y, passThrough }) => {
            const over = document.createElement('div');
            over.id = 'cover';
            Object.assign(over.style, {
              position: 'fixed',
              left: `${String(x - 2)}px`,
              top: `${String(y - 2)}px`,
              width: '4px',
              height: '4px',
              zIndex: '2147483647',
              pointerEvents: passThrough ? 'none' : 'auto',
            });
            Object.assign(window, { __coverClicks: 0 });
            over.addEventListener('mousedown', () => {
              Object.assign(window, { __coverClicks: 1 });
            });
            document.documentElement.append(over);
          },
          { ...at, passThrough: cover.passThrough },
        );
        const under = (x: number, y: number): Promise<string | null> =>
          page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.localName ?? null, { x, y });
        // elementFromPoint, like a click, skips an element that lets clicks through.
        expect(await under(at.x, at.y)).toBe(cover.passThrough ? 'tabdock-dock' : 'div');
        expect(await under(at.x, at.y - 6)).toBe('tabdock-dock');

        await expect(clickWith(cdp, target, { timeoutMs: 1500 })).rejects.toThrow(WidgetTestError);
        expect(
          await page.evaluate(() => (window as { __coverClicks?: number }).__coverClicks),
        ).toBe(0);
        expect((await waitingPrompts(cdp)).attach).toEqual([{ requestId, client: CI }]);

        // Uncovered, the same press goes through.
        await page.evaluate(() => document.getElementById('cover')?.remove());
        expect(await allowAttach(cdp, { as: 'driver', requestId })).toBe(requestId);
        expect((await pending).structured).toMatchObject({ role: 'driver' });
      } finally {
        await client.close();
        await cdp.detach();
      }
    });
  }
});

/**
 * A script loaded after attach(), as later-scripts.spec.ts plays one: it
 * wraps the DOM getters and methods a read of the widget would go through and
 * notes each one handed a node of a closed shadow root, which is the widget's.
 */
function installLaterScript(): void {
  const rootOf: unknown = Reflect.get(Node.prototype, 'getRootNode');
  if (typeof rootOf !== 'function') throw new Error('no getRootNode');
  const handed: string[] = [];
  Object.assign(window, { __handed: handed });
  const note = (name: string, self: unknown): void => {
    if (!(self instanceof Node)) return;
    const root: unknown = Reflect.apply(rootOf, self, []);
    if (root instanceof ShadowRoot && root.mode === 'closed') handed.push(name);
  };
  const wrap = (proto: object, name: string): void => {
    const own = Reflect.getOwnPropertyDescriptor(proto, name);
    if (own === undefined) return;
    const get: unknown = Reflect.get(own, 'get');
    const value: unknown = Reflect.get(own, 'value');
    const patched: PropertyDescriptor = { ...own };
    if (typeof get === 'function') {
      patched.get = function (this: unknown): unknown {
        note(name, this);
        return Reflect.apply(get, this, []) as unknown;
      };
    } else if (typeof value === 'function') {
      patched.value = function (this: unknown, ...args: unknown[]): unknown {
        note(name, this);
        return Reflect.apply(value, this, args) as unknown;
      };
    }
    Reflect.defineProperty(proto, name, patched);
  };
  for (const name of ['textContent', 'nodeValue', 'childNodes']) wrap(Node.prototype, name);
  for (const name of ['getAttribute', 'getBoundingClientRect', 'innerHTML']) {
    wrap(Element.prototype, name);
  }
  for (const name of ['innerText', 'click', 'dataset']) wrap(HTMLElement.prototype, name);
}

async function handed(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as { __handed?: unknown }).__handed);
}

test('runs nothing in the page, so a script that patched the DOM after attach() is handed no widget node', async ({
  page,
}) => {
  const { code, cdp } = await openBoard(page);
  await page.evaluate(installLaterScript);
  const client = await connectMcp(tabdock.relay, tabdock.users.alice, CI);
  try {
    expect(await readPairingCode(cdp)).toBe(code);
    const pending = callTool(client, 'pair_page', { code });
    await expect.poll(async () => (await waitingPrompts(cdp)).attach.length).toBe(1);
    await allowAttach(cdp, { as: 'driver', client: CI });
    expect((await pending).structured).toMatchObject({ role: 'driver' });
    expect(await widgetText(cdp, 'roster')).not.toBeNull();
    expect(await handed(page)).toEqual([]);

    // The spy works: a function run on a widget node in the page's own world,
    // as the helper once read text, hands that node straight to it.
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    type DomNode = typeof root;
    const hostIn = (node: DomNode): DomNode | undefined =>
      node.localName === 'tabdock-dock'
        ? node
        : (node.children ?? []).map(hostIn).find((found) => found !== undefined);
    const inside = hostIn(root)?.shadowRoots?.[0]?.children?.[0];
    if (inside === undefined) throw new Error('no node inside the widget');
    const { object } = await cdp.send('DOM.resolveNode', { backendNodeId: inside.backendNodeId });
    await cdp.send('Runtime.callFunctionOn', {
      objectId: object.objectId ?? '',
      functionDeclaration: 'function () { return this.textContent; }',
      returnByValue: true,
    });
    expect(await handed(page)).toEqual(['textContent']);
  } finally {
    await client.close();
    await cdp.detach();
  }
});

test('refuses to choose between two requests from clients of one name, and approves only the one it names', async ({
  page,
}) => {
  const { code, cdp } = await openBoard(page);
  const clients: Client[] = [];
  const connect = async (user: 'alice' | 'bob', name: string): Promise<Client> => {
    const client = await connectMcp(tabdock.relay, tabdock.users[user], name);
    clients.push(client);
    return client;
  };
  try {
    const aliceTwin = await connect('alice', 'twin');
    const bobTwin = await connect('bob', 'twin');
    const aliceAsks = callTool(aliceTwin, 'pair_page', { code });
    const second = await nextCode(page, code);
    const bobAsks = callTool(bobTwin, 'pair_page', { code: second });
    const waiting = await waitForDock(page, (s) =>
      s.pendingRequests.length === 2 ? s.pendingRequests : null,
    );

    const refused = await allowAttach(cdp, { as: 'driver', client: 'twin' }).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(WidgetTestError);
    expect((refused as Error).message).toBe('2 waiting attach requests match, so none is approved');
    // Nothing was approved: the roster is empty and both still wait.
    expect(await rosterOf(page)).toEqual([]);
    expect((await dockState(page))?.pendingRequests.map((r) => r.requestId)).toEqual(
      waiting.map((r) => r.requestId),
    );
    for (const request of waiting) {
      await clickInWidget(page, { action: 'deny', requestId: request.requestId });
    }
    expect(errorCode(await aliceAsks)).toBe('denied_by_operator');
    expect(errorCode(await bobAsks)).toBe('denied_by_operator');

    // Clients that name themselves apart: only the one named is approved.
    const other = await connect('alice', `${CI}-other`);
    const wanted = await connect('bob', CI);
    const third = await nextCode(page, second);
    const otherAsks = callTool(other, 'pair_page', { code: third });
    const fourth = await nextCode(page, third);
    const wantedAsks = callTool(wanted, 'pair_page', { code: fourth });
    const both = await waitForDock(page, (s) =>
      s.pendingRequests.length === 2 ? s.pendingRequests : null,
    );
    const bobsRequest = both.find((r) => r.user.userId === 'bob')?.requestId;
    expect(await allowAttach(cdp, { as: 'driver', client: CI })).toBe(bobsRequest);
    expect((await wantedAsks).structured).toMatchObject({ role: 'driver' });
    await expect.poll(() => rosterOf(page)).toEqual([['bob', 'driver']]);
    const alicesRequest = both.find((r) => r.user.userId === 'alice')?.requestId ?? '';
    expect((await dockState(page))?.pendingRequests.map((r) => r.requestId)).toEqual([
      alicesRequest,
    ]);
    await clickInWidget(page, { action: 'deny', requestId: alicesRequest });
    expect(errorCode(await otherAsks)).toBe('denied_by_operator');
  } finally {
    for (const client of clients) await client.close();
    await cdp.detach();
  }
});
