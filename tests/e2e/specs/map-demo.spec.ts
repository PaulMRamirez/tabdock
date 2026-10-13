// The map demo (ADR 0050) as the Pages site serves it: its static build at
// /map/ of a loopback static host that sends no header of ours, so its meta
// policy is the only one in force. It loads with no policy violation or
// console error and only its own two files, registers the map profile's
// twelve clockless tools and the two editing tools, and dials nothing from
// its URL, a script's click or a frame: only a person's click on its armed
// Connect bar, remembered under a key of its own. Through that click and
// Allow in the widget a client pairs against a real relay whose allowlist
// names the site's origin, walks the tour, reads each stop's view back from
// the page's published state as it and the visitor's own buttons move the
// map, captures one view to the same PNG twice and another to other bytes,
// and meets the operator's prompt for reset_edits; the call strip names no
// argument, and at 375 px nothing scrolls sideways.

import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test } from '@playwright/test';
import {
  CaptureImageTextSchema,
  GoToStopResultSchema,
  ListWalkthroughsResultSchema,
  MAP_EDIT_TOOLS,
  MAP_PROFILE_TOOLS,
  type MapPageState,
  MapPageStateSchema,
  MapStopSchema,
} from '@tabdock/sim-page/map';
import {
  firstText,
  imageBytes,
  imagePart,
  pngDimensions,
  type ResultContent,
} from '../src/image-helpers.ts';
import {
  clickConnect,
  type MapDemoRelay,
  type MapDemoSite,
  mapDemoUrl,
  openMapDemo,
  serveMapDemoSite,
  STAND_IN_CODE,
  standInRelays,
  startMapDemoRelay,
} from '../src/map-demo-harness.ts';
import { callMapTool, pairMapPage } from '../src/map-harness.ts';
import { readPageState, stateBody, waitPageState } from '../src/state-helpers.ts';
import {
  clickInWidget,
  connectMcp,
  errorCode,
  widgetButtonCentre,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

/** The profile's tools without its clock group, which Earth has no use for, and the two editing tools. */
const TOOLS = [
  ...MAP_PROFILE_TOOLS.filter((tool) => tool.group !== 'clock'),
  ...MAP_EDIT_TOOLS,
].map((tool) => tool.name);
const TOUR = 'earth';
/** Never dialled: routeWebSocket answers in its place. */
const STAND_IN = 'ws://127.0.0.1:9/page';
/** Long enough for a dial the page would make at once to have been made. */
const SETTLE_MS = 750;

let site: MapDemoSite;
let tabdock: MapDemoRelay | null = null;
let client: Client | null = null;
let consoleErrors: string[];

test.beforeAll(async () => {
  site = await serveMapDemoSite();
});
test.afterAll(async () => {
  await site.close();
});

test.beforeEach(async ({ page }) => {
  consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // Policy violations are reported as events too, before any page script runs.
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
});

test.afterEach(async () => {
  await client?.close();
  client = null;
  await tabdock?.close();
  tabdock = null;
});

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** Nothing the page did broke its policy or logged an error. */
async function expectClean(page: Page): Promise<void> {
  expect(await cspViolations(page)).toEqual([]);
  expect(consoleErrors).toEqual([]);
}

/** The page linked to a real relay by a person's click, and a client paired as driver through the widget. */
async function pairedPage(page: Page): Promise<{ alice: Client; pageId: string }> {
  tabdock = await startMapDemoRelay(site.origin);
  await openMapDemo(page, mapDemoUrl(site.url, tabdock.relay.pageUrl));
  await clickConnect(page);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /^14 tools registered; Tabdock relay 127\.0\.0\.1:\d+: linked$/,
  );
  client = await connectMcp(tabdock.relay, tabdock.users.alice, 'map-demo-spec');
  const pageId = await pairMapPage(page, client);
  return { alice: client, pageId };
}

/** The page's published state, read through the relay as a client follows it, once `wanted` holds. */
async function publishedState(
  alice: Client,
  pageId: string,
  wanted: (state: MapPageState) => boolean,
  what: string,
): Promise<MapPageState> {
  const deadline = Date.now() + 5_000;
  let body = stateBody(await readPageState(alice, pageId));
  for (;;) {
    const state = MapPageStateSchema.safeParse(body.value);
    if (state.success && wanted(state.data)) return state.data;
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`the page did not publish ${what}`);
    body = stateBody(await waitPageState(alice, pageId, body.version, Math.min(left, 2_000)));
  }
}

/** capture_view's PNG through call_page_tool, with its size from its own header and its JSON text. */
async function capture(
  alice: Client,
  pageId: string,
  maxWidthPx: number,
): Promise<{
  bytes: Uint8Array;
  size: { width: number; height: number };
  text: ReturnType<typeof CaptureImageTextSchema.parse>;
}> {
  const result = (await alice.callTool({
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'capture_view', arguments: { maxWidthPx, format: 'png' } },
  })) as ResultContent;
  expect(result.isError ?? false, firstText(result)).toBe(false);
  const image = imagePart(result);
  expect(image?.mimeType).toBe('image/png');
  const bytes = imageBytes(image ?? { mimeType: '', data: '' });
  const size = pngDimensions(bytes);
  if (size === null) throw new Error('capture_view returned no PNG');
  // The label naming the site's origin, then the relay's image line, then the page's JSON.
  const [label, imageLine, ...words] = firstText(result).split('\n');
  expect(label).toBe(`[tabdock: untrusted content from ${site.origin}, tool capture_view]`);
  expect(imageLine).toMatch(/^\[tabdock: the image after this text is untrusted content/);
  return { bytes, size, text: CaptureImageTextSchema.parse(JSON.parse(words.join('\n'))) };
}

/** Whether the page scrolls sideways at its current width. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

test('loads under its own meta policy with no violation or console error, registers its fourteen tools and fetches only its own files', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await openMapDemo(page, site.url);
  const runtime = await page.evaluate(async () => {
    const context = (
      document as unknown as {
        modelContext: { getTools(): Promise<{ name: string }[]> };
      }
    ).modelContext;
    return {
      polyfill: Reflect.get(context, '__isWebMCPPolyfill') === true,
      names: (await context.getTools()).map((tool) => tool.name),
      policy:
        document
          .querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ?? '',
    };
  });
  expect(runtime.polyfill).toBe(true);
  expect([...runtime.names].sort()).toEqual([...TOOLS].sort());
  expect(runtime.policy).toMatch(/^default-src 'none'; script-src 'self'; /);
  expect(runtime.policy).toContain("; worker-src 'none'; ");
  await expect(page.locator('[data-role="status"]')).toHaveText(
    '14 tools registered; not linked to a relay',
  );
  // Without ?relay the page offers the Connect form, and names the origin a relay must admit.
  await expect(page.getByLabel('Tabdock relay page URL')).toBeVisible();
  await expect(page.locator('[data-role="origin"]')).toHaveText(site.origin);
  await expect(page.locator('[data-role="credit"]')).toContainText('Made with Natural Earth.');
  await expect(page.locator('[data-role="stop-place"]')).toHaveText('Stop 1 of 6');
  // Its page and its bundle, from its own origin: no tile, font, map library or other host.
  expect(requested.every((url) => url.startsWith(`${site.origin}/`))).toBe(true);
  expect(requested.map((url) => new URL(url).pathname).sort()).toEqual(['/map/', '/map/main.js']);
  // Earth is drawn: the canvas holds many colours, not one blank fill.
  const colours = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return 0;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const seen = new Set<number>();
    for (let index = 0; index < data.length; index += 4 * 97) {
      seen.add(((data[index] ?? 0) << 16) | ((data[index + 1] ?? 0) << 8) | (data[index + 2] ?? 0));
    }
    return seen.size;
  });
  expect(colours).toBeGreaterThan(4);
  await expectClean(page);
});

test("enforces its policy: no worker, from the site's own script or a blob, and no service worker", async ({
  page,
}) => {
  await openMapDemo(page, site.url);
  const outcomes = await page.evaluate(async () => {
    // A refused worker is constructed and then fails to load, firing error;
    // one that loads would not, within the wait.
    const worker = (url: string): Promise<string> =>
      new Promise((resolve) => {
        const started = new Worker(url, { type: 'module' });
        const timer = setTimeout(() => {
          started.terminate();
          resolve('loaded');
        }, 3_000);
        started.addEventListener('error', () => {
          clearTimeout(timer);
          resolve('refused');
        });
      });
    const blob = URL.createObjectURL(new Blob(['postMessage(1);'], { type: 'text/javascript' }));
    const registration = await navigator.serviceWorker.register('./main.js').then(
      () => 'registered',
      (error: unknown) => (error instanceof Error ? error.name : 'refused'),
    );
    return {
      sameOrigin: await worker('./main.js'),
      blob: await worker(blob),
      serviceWorker: registration,
    };
  });
  expect(outcomes).toEqual({
    sameOrigin: 'refused',
    blob: 'refused',
    serviceWorker: 'SecurityError',
  });
  // Each was refused by worker-src itself, not by some later failure to run.
  const violations = (await cspViolations(page)).filter((line) => line.startsWith('worker-src'));
  expect(violations).toHaveLength(3);
  expect(violations).toContain(`worker-src ${site.url}main.js`);
  expect(violations).toContain('worker-src blob');
});

test('enforces its policy: an inline script is refused', async ({ page }) => {
  await openMapDemo(page, site.url);
  const ran = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'document.documentElement.dataset.inline = "ran";';
    document.head.append(script);
    return document.documentElement.dataset.inline ?? null;
  });
  expect(ran).toBeNull();
  // The yardstick for every "no violation" here: the collector does see one.
  await expect.poll(() => cspViolations(page)).toContainEqual(expect.stringMatching(/^script-src/));
});

test('dials nothing from its URL, a script or a frame; a person on the armed Connect bar dials once, remembered under its own key', async ({
  page,
  context,
}) => {
  const dialled = await standInRelays(context);
  // A relay chosen on the board in this tab never connects the map.
  await openMapDemo(page, site.url);
  await page.evaluate((relay) => {
    sessionStorage.setItem(`tabdock-demo:connect:${relay}`, '1');
  }, STAND_IN);

  const bar = page.locator('[data-role="connect-bar"]');
  const button = bar.getByRole('button', { name: 'Connect to 127.0.0.1:9' });
  for (const extra of [{}, { e2e: 'x'.repeat(22) }, { confirm: 'client', invites: 'all' }]) {
    const url = new URL(mapDemoUrl(site.url, STAND_IN));
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    await openMapDemo(page, url.href);
    await expect(button).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-link', 'waiting');
    await expect(page.locator('[data-role="status"]')).toHaveText(
      '14 tools registered; Tabdock relay 127.0.0.1:9: waiting for you to connect',
    );
  }
  // A relay in the fragment is no choice either: the form is offered.
  await openMapDemo(page, `${site.url}#relay=${STAND_IN}`);
  await expect(page.locator('form[data-role="connect-form"]')).toBeVisible();
  await expect(bar).toHaveCount(0);

  // A script on the page cannot click for the visitor, on the bar or the form.
  await openMapDemo(page, mapDemoUrl(site.url, STAND_IN));
  await page.waitForSelector('[data-action="connect"][data-armed="true"]');
  await page.evaluate(() => {
    const target = document.querySelector<HTMLButtonElement>('[data-action="connect"]');
    target?.click();
    target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await button.dispatchEvent('click');
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toEqual([]);
  await expect(button).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('tabdock-map-demo:')),
    ),
  ).toEqual([]);
  await openMapDemo(page, site.url);
  const form = page.locator('form[data-role="connect-form"]');
  await form.getByLabel('Tabdock relay page URL').fill(STAND_IN);
  await page.evaluate(() => {
    const scripted = document.querySelector<HTMLFormElement>('form[data-role="connect-form"]');
    scripted?.requestSubmit();
    scripted?.querySelector('button')?.click();
  });
  await page.waitForTimeout(SETTLE_MS);
  expect(new URL(page.url()).searchParams.has('relay')).toBe(false);
  expect(dialled.urls).toEqual([]);
  expect(await page.locator('tabdock-dock').count()).toBe(0);

  // Inside a frame the page offers neither bar nor form, so a framing site cannot dress up a click.
  const framer = `${site.origin}/framer`;
  await page.route(framer, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><iframe src="${mapDemoUrl(site.url, STAND_IN)}"></iframe><iframe src="${site.url}"></iframe>`,
    }),
  );
  await page.goto(framer);
  const linked = page.locator('iframe').nth(0).contentFrame();
  const bare = page.locator('iframe').nth(1).contentFrame();
  await expect(linked.locator('[data-role="status"]')).toHaveText(
    /not linked: this page does not link to a relay inside a frame/,
  );
  await expect(bare.locator('html')).toHaveAttribute('data-tools', 'ready');
  for (const frame of [linked, bare]) {
    await expect(frame.locator('[data-role="connect-bar"]')).toHaveCount(0);
    await expect(frame.locator('form[data-role="connect-form"]')).toHaveCount(0);
  }
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toEqual([]);

  // A person's click, once the bar has armed, dials that relay and nothing else.
  await openMapDemo(page, mapDemoUrl(site.url, STAND_IN));
  await clickConnect(page);
  await expect.poll(() => dialled.urls).toEqual([STAND_IN]);
  await expect(bar).toHaveCount(0);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    '14 tools registered; Tabdock relay 127.0.0.1:9: linked',
  );
  await expect.poll(() => widgetText(page, 'pairing-code')).toContain(STAND_IN_CODE);
  const stored = await page.evaluate(() => Object.entries(sessionStorage));
  expect(stored).toContainEqual([`tabdock-map-demo:connect:${STAND_IN}`, '1']);
  expect(stored.filter(([key]) => key.startsWith('tabdock-map-demo:'))).toHaveLength(1);
  // The page hands out no handle on window.
  expect(
    await page.evaluate(() =>
      Object.keys(window).filter((key) => key.toLowerCase().includes('tabdock')),
    ),
  ).toEqual([]);

  // A reload in this tab reconnects without a click; another tab asks again.
  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  await expect.poll(() => dialled.urls.length).toBe(2);
  const other = await context.newPage();
  await openMapDemo(other, mapDemoUrl(site.url, STAND_IN));
  await expect(other.locator('[data-role="connect-bar"]')).toBeVisible();
  await other.waitForTimeout(SETTLE_MS);
  expect(dialled.urls).toHaveLength(2);
  await expectClean(page);
});

test("pairs through the Connect bar and the widget, walks the tour, and its published state follows each stop and the visitor's buttons", async ({
  page,
}) => {
  const { alice, pageId } = await pairedPage(page);
  const listed = ListWalkthroughsResultSchema.parse(
    (await callMapTool(alice, pageId, 'list_walkthroughs')).structured,
  );
  expect(listed.walkthroughs).toEqual([{ id: TOUR, title: 'A short tour of Earth', stopCount: 6 }]);
  expect(listed.current).toEqual({ walkthroughId: TOUR, stopIndex: 0 });

  for (let index = 0; index < 6; index += 1) {
    const stop = MapStopSchema.parse(
      (await callMapTool(alice, pageId, 'get_stop', { walkthroughId: TOUR, index })).structured,
    );
    const went = await callMapTool(alice, pageId, 'go_to_stop', { walkthroughId: TOUR, index });
    expect(went.isError, went.text).toBe(false);
    const arrived = GoToStopResultSchema.parse(went.structured);
    // The member gets the stop's view, and the page shows the stop.
    expect(arrived.view).toMatchObject({
      projection: stop.view.projection,
      lon: stop.view.lon,
      lat: stop.view.lat,
    });
    await expect(page.locator('[data-role="stop-place"]')).toHaveText(
      `Stop ${String(index + 1)} of 6`,
    );
    await expect(page.locator('[data-role="stop-title"]')).toHaveText(stop.title);
    await expect(page.locator('[data-role="stop-text"]')).toHaveText(stop.text);
    // What the page publishes is that view and that stop.
    const state = await publishedState(
      alice,
      pageId,
      (published) => published.walkthrough?.stopIndex === index,
      `stop ${String(index)}`,
    );
    expect(state.view).toEqual(arrived.view);
    expect(state.walkthrough).toEqual({ id: TOUR, stopIndex: index });
    expect(state.observationId).toBe(stop.observationId);
    expect(state.clock).toBeNull();
  }
  // The last stop is Madagascar on the globe; nothing lies past it.
  await expect(page.getByRole('button', { name: 'Next stop' })).toBeDisabled();

  // On a wide screen the column leaves the widget's open panel a lane, so the
  // map and its controls stay whole beside it, and no line asks to fold it.
  const dock = await page.locator('tabdock-dock').boundingBox();
  // Open, the panel is 360 pixels wide; folded, the dock is its chip alone.
  expect(dock?.width ?? 0).toBeGreaterThanOrEqual(360);
  const beside = await page.evaluate(() =>
    Math.max(
      ...Array.from(document.querySelectorAll('canvas, .controls button, .cards'), (element) =>
        Math.ceil(element.getBoundingClientRect().right),
      ),
    ),
  );
  expect(dock).not.toBeNull();
  expect(beside).toBeLessThanOrEqual(dock?.x ?? 0);
  await expect(page.locator('.fold-hint')).toBeHidden();

  // The visitor's own buttons move the map, and the published state follows
  // each.
  const before = MapPageStateSchema.parse(stateBody(await readPageState(alice, pageId)).value);
  expect(before.view.projection).toBe('globe');
  await page.getByRole('button', { name: 'Flat map' }).click();
  const flat = await publishedState(
    alice,
    pageId,
    (published) => published.view.projection === 'equirectangular',
    'the flat map',
  );
  await page.getByRole('button', { name: 'Zoom in' }).click();
  const closer = await publishedState(
    alice,
    pageId,
    (published) => published.view.widthM < flat.view.widthM,
    'a closer view',
  );
  // The world keeps its last stop, and the tour card says the map has left it.
  await expect(page.locator('[data-role="stop-place"]')).toHaveText('Stop 6 of 6, map moved');
  await expect(page.locator('[data-role="stop-title"]')).toHaveText('Madagascar');
  await expect(page.locator('[data-role="stop-text"]')).toHaveText(
    'The map has left this stop. Press Next stop or Previous stop, or ask your client to go back.',
  );
  await page.getByRole('button', { name: 'Previous stop' }).click();
  await publishedState(
    alice,
    pageId,
    (published) => published.walkthrough?.stopIndex === 4,
    'the previous stop',
  );
  // A client's own move is followed too, and read back as get_view gives it.
  const moved = await callMapTool(alice, pageId, 'set_view', { lon: 10.5, lat: -20.25 });
  expect(moved.isError, moved.text).toBe(false);
  const followed = await publishedState(
    alice,
    pageId,
    (published) => published.view.lon === 10.5 && published.view.lat === -20.25,
    'the view set_view chose',
  );
  expect(followed.view).toEqual((await callMapTool(alice, pageId, 'get_view')).structured);
  expect(closer.view.widthM).toBeLessThan(flat.view.widthM);
  await expectClean(page);
});

test('a plain wheel scrolls the page past the map; Ctrl with the wheel, the arrow keys and plus and minus move the map', async ({
  page,
}) => {
  await openMapDemo(page, site.url);
  const canvas = page.locator('canvas#map');
  const view = page.locator('[data-role="view"]');
  const start = (await view.textContent()) ?? '';
  const box = await canvas.boundingBox();
  if (!box) throw new Error('the map has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  for (let notch = 0; notch < 5; notch += 1) await page.mouse.wheel(0, 100);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.waitForTimeout(SETTLE_MS);
  await expect(view).toHaveText(start);
  // Ctrl with the wheel, as a trackpad pinch arrives, zooms the map and not the page.
  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await expect(view).toHaveText(/^Globe, centred on 20\.0° N, 30\.0° W, 21,246 km across/);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // The map takes focus in the tab order, and its keys pan and zoom it.
  await expect(canvas).toHaveAttribute('tabindex', '0');
  await expect(canvas).toHaveAttribute('aria-label', /arrow keys, to pan; hold Ctrl and scroll/);
  // Focus brings the whole map into view; the keys then scroll nothing.
  await canvas.focus();
  const focused = await page.evaluate(() => window.scrollY);
  await page.keyboard.press('ArrowRight');
  await expect(view).toHaveText(/^Globe, centred on 20\.0° N, \d+\.\d° W, 21,246 km across/);
  expect(await view.textContent()).not.toContain('30.0° W');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('-');
  await expect(view).not.toHaveText(/21,246 km across/);
  expect(await page.evaluate(() => window.scrollY)).toBe(focused);
  await expectClean(page);
});

test('says what to check when a chosen relay never links, naming the origin it must list', async ({
  page,
}) => {
  // A relay whose allowlist names another origin, the likeliest setup mistake.
  tabdock = await startMapDemoRelay('http://127.0.0.1:1');
  await openMapDemo(page, mapDemoUrl(site.url, tabdock.relay.pageUrl));
  await clickConnect(page);
  const status = page.locator('[data-role="status"]');
  await expect(status).toHaveText(/^14 tools registered; Tabdock relay 127\.0\.0\.1:\d+: \w+$/);
  await expect(status).toHaveText(
    `14 tools registered; Tabdock relay ${new URL(tabdock.relay.pageUrl).host}: reconnecting; still not linked: check that the relay is running and lists ${site.origin} in TABDOCK_ALLOWED_ORIGINS`,
    { timeout: 15_000 },
  );
  // The browser logs the refused handshake itself; the page broke no policy.
  expect(await cspViolations(page)).toEqual([]);
});

test('capture_view draws its own map again: one view gives the same PNG twice at any window size, another other bytes', async ({
  page,
}) => {
  const { alice, pageId } = await pairedPage(page);
  const baikal = await callMapTool(alice, pageId, 'go_to_stop', { walkthroughId: TOUR, index: 2 });
  expect(baikal.isError, baikal.text).toBe(false);
  const view = GoToStopResultSchema.parse(baikal.structured).view;

  const first = await capture(alice, pageId, 512);
  expect([...first.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(first.size.width).toBeLessThanOrEqual(512);
  expect(first.size.width).toBe(first.text.widthPx);
  expect(first.size.height).toBe(first.text.heightPx);
  expect(first.text.view).toEqual(view);
  expect(first.text.observationId).toBe('baikal-outline');
  const again = await capture(alice, pageId, 512);
  expect(Buffer.from(again.bytes).equals(Buffer.from(first.bytes))).toBe(true);
  // The capture depends on the world alone, never on the window the page sits in.
  await page.setViewportSize({ width: 375, height: 812 });
  const narrow = await capture(alice, pageId, 512);
  expect(Buffer.from(narrow.bytes).equals(Buffer.from(first.bytes))).toBe(true);

  const lakes = await callMapTool(alice, pageId, 'go_to_stop', { walkthroughId: TOUR, index: 3 });
  expect(lakes.isError, lakes.text).toBe(false);
  const other = await capture(alice, pageId, 512);
  expect(Buffer.from(other.bytes).equals(Buffer.from(first.bytes))).toBe(false);
  expect(other.text.observationId).toBe('great-lakes-outline');
  await expectClean(page);
});

test("reset_edits prompts the person at the tab, a stop's edited text shows only as text, and the call strip names no argument", async ({
  page,
}) => {
  const { alice, pageId } = await pairedPage(page);
  const marker = 'Zq7Mark9Wq';
  const edited = await callMapTool(alice, pageId, 'edit_stop', {
    walkthroughId: TOUR,
    index: 0,
    text: `<b>${marker}</b> <img src=x>`,
  });
  expect(edited.isError, edited.text).toBe(false);
  const text = page.locator('[data-role="stop-text"]');
  await expect(text).toHaveText(`<b>${marker}</b> <img src=x>`);
  expect(await text.locator('b, img').count()).toBe(0);
  await callMapTool(alice, pageId, 'set_view', { lon: 3.654321, lat: 7.123456 });
  await callMapTool(alice, pageId, 'features_in_view', { kind: 'lake', limit: 7 });

  // reset_edits alone asks the operator; Deny answers denied_by_operator and keeps the edit.
  const pending = callMapTool(alice, pageId, 'reset_edits');
  await clickInWidget(page, { action: 'confirm-deny' });
  const denied = await pending;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  const stop = MapStopSchema.parse(
    (await callMapTool(alice, pageId, 'get_stop', { walkthroughId: TOUR, index: 0 })).structured,
  );
  expect(stop.text).toContain(marker);

  const strip = page.locator('[data-role="calls"] li');
  await expect(strip.first()).toHaveText('get_stop: ok');
  const lines = await strip.allTextContents();
  expect(lines).toContain('edit_stop: ok');
  expect(lines).toContain('set_view: ok');
  expect(lines).toContain('features_in_view: ok');
  for (const line of lines) expect(line).toMatch(/^[a-z_]+: (ok|error)$/);
  const words = (await page.locator('[data-role="calls"]').textContent()) ?? '';
  for (const value of [marker, '7.123456', '3.654321', 'lake', '<b>']) {
    expect(words).not.toContain(value);
  }
  await expectClean(page);
});

test.describe('on a 375 px phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('nothing scrolls sideways, with the form, the bar and the widget open or folded, and every control in reach', async ({
    page,
    context,
  }) => {
    const dialled = await standInRelays(context);
    await openMapDemo(page, site.url);
    await expect(page.getByLabel('Tabdock relay page URL')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);

    await openMapDemo(page, mapDemoUrl(site.url, STAND_IN));
    await expect(page.locator('[data-role="connect-bar"]')).toBeVisible();
    expect(await scrollsSideways(page)).toBe(false);
    // The line on folding the widget waits until there is a widget to fold.
    await expect(page.locator('.fold-hint')).toBeHidden();

    await clickConnect(page);
    await expect(page.locator('.fold-hint')).toBeVisible();
    await expect.poll(() => dialled.urls).toEqual([STAND_IN]);
    await expect.poll(() => widgetText(page, 'pairing-code')).toContain(STAND_IN_CODE);
    expect(await widgetVisible(page, 'pairing-code')).toBe(true);
    expect(await scrollsSideways(page)).toBe(false);
    // The badge folds the widget, and is armed and in reach where a thumb would tap it.
    const badge = await widgetButtonCentre(page, { action: 'toggle' });
    expect(badge.x).toBeLessThanOrEqual(375);
    expect(badge.y).toBeLessThanOrEqual(812);
    await clickInWidget(page, { action: 'toggle' });
    await expect.poll(() => widgetVisible(page, 'pairing-code')).toBe(false);
    expect(await scrollsSideways(page)).toBe(false);

    // The map sits inside the 16 px gutter, and every map control lies within the screen's width.
    const layout = await page.evaluate(() => ({
      canvas: document.querySelector('canvas')?.getBoundingClientRect().width ?? 0,
      controls: Array.from(document.querySelectorAll('.controls button'), (button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      }),
    }));
    expect(layout.canvas).toBeLessThanOrEqual(375 - 32);
    expect(layout.controls).toHaveLength(5);
    for (const rect of layout.controls) {
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(375);
    }
    await expectClean(page);
  });
});
