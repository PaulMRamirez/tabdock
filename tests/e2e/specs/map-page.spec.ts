// A6.2, the canvas map page in a real browser (ADR 0038): it registers the
// sixteen tools on the MCP-B polyfill 5.1.0 with no map library, pairs
// through the widget as a person would, redraws when a client moves it,
// prompts for reset_edits alone, fits a phone, dials nothing from its URL or
// a script's click (S4), and shows no argument in its call strip (S7).
// Case 2's PNG capture comes with the page's capture wiring (W2-E).

import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test, type WebSocketRoute } from '@playwright/test';
import { MAP_EDIT_TOOLS, MAP_PROFILE_TOOLS } from '@tabdock/sim-page/map';
import {
  callMapTool,
  connectMapPage,
  type MapTabdock,
  openMapPage,
  pairMapPage,
  startMapTabdock,
} from '../src/map-harness.ts';
import {
  clickInWidget,
  connectMcp,
  errorCode,
  widgetButtonCentre,
  widgetButtonNow,
} from '../src/tabdock-harness.ts';

const ALL_TOOLS = [...MAP_PROFILE_TOOLS, ...MAP_EDIT_TOOLS].map((tool) => tool.name);
/** Never dialled: routeWebSocket answers in its place. */
const FAKE_RELAY = 'ws://127.0.0.1:9/page';
/** Long enough for a dial the page would make at once to have been made. */
const SETTLE_MS = 750;

let tabdock: MapTabdock;
let client: Client | null = null;
let consoleErrors: string[];

test.beforeEach(async ({ page }) => {
  tabdock = await startMapTabdock();
  consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  // Policy violations are reported as events too, before anything else runs.
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
  await tabdock.close();
});

async function cspViolations(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** The map page linked to the test relay and a client paired with it as driver. */
async function pairedPage(page: Page): Promise<{ client: Client; pageId: string }> {
  await openMapPage(page, tabdock.map.url);
  expect(await connectMapPage(page, tabdock.relay.pageUrl)).toBe(true);
  client = await connectMcp(tabdock.relay, tabdock.users.alice, 'map-spec');
  const pageId = await pairMapPage(page, client);
  return { client, pageId };
}

/** The canvas's pixels as a data URL, to see whether a drawing changed. */
async function drawing(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('canvas')?.toDataURL('image/png') ?? '');
}

test('1. registers the sixteen tools on the MCP-B polyfill 5.1.0 and draws with no map library', async ({
  page,
}) => {
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  await openMapPage(page, tabdock.map.url);
  const runtime = await page.evaluate(async () => {
    const context = (
      document as unknown as {
        modelContext: {
          getTools(): Promise<{ name: string; annotations?: Record<string, unknown> }[]>;
        };
      }
    ).modelContext;
    const tools = await context.getTools();
    return {
      polyfill: Reflect.get(context, '__isWebMCPPolyfill') === true,
      names: tools.map((tool) => tool.name),
      readOnly: tools.filter((tool) => tool.annotations?.readOnlyHint === true).map((t) => t.name),
      hinted: tools
        .filter((tool) => tool.annotations !== undefined && 'consequentialHint' in tool.annotations)
        .map((tool) => tool.name),
    };
  });
  expect(runtime.polyfill).toBe(true);
  expect([...runtime.names].sort()).toEqual([...ALL_TOOLS].sort());
  expect([...runtime.readOnly].sort()).toEqual(
    MAP_PROFILE_TOOLS.filter((tool) => tool.readOnly)
      .map((tool) => tool.name)
      .sort(),
  );
  // 5.1.0 drops consequentialHint, which is why the page names reset_edits in its policy.
  expect(runtime.hinted).toEqual([]);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    '16 tools registered; not linked to a relay',
  );
  // Only the page and its own bundle load: no tiles, no map library, no other origin.
  const origin = new URL(tabdock.map.url).origin;
  expect(requested.every((url) => url.startsWith(`${origin}/`))).toBe(true);
  expect(requested.map((url) => new URL(url).pathname).sort()).toEqual(['/', '/main.js']);
  // The Moon is drawn: the centre of the view is the albedo ground, not space.
  const centre = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const data = canvas?.getContext('2d')?.getImageData(480, 270, 1, 1).data;
    return data ? Array.from(data) : [];
  });
  expect(centre).not.toEqual([11, 13, 18, 255]);
  expect(centre[3]).toBe(255);
});

test('2. pairs through the widget as a person would, and redraws on set_view and go_to_stop', async ({
  page,
}) => {
  const { client: alice, pageId } = await pairedPage(page);
  const view = page.locator('[data-role="view"]');
  await expect(view).toHaveText(/moon, equirectangular, centre lat 0\.000 lon 0\.000/);
  const before = await drawing(page);

  const moved = await callMapTool(alice, pageId, 'set_view', { lat: 10.5, lon: -20.25 });
  expect(moved.isError, moved.text).toBe(false);
  await expect(view).toHaveText(/centre lat 10\.500 lon -20\.250/);
  const afterSet = await drawing(page);
  expect(afterSet).not.toBe(before);

  const stop = await callMapTool(alice, pageId, 'go_to_stop', { walkthroughId: 'flyby', index: 3 });
  expect(stop.isError, stop.text).toBe(false);
  await expect(view).toHaveText(/moon, globe, centre lat -43\.310 lon -11\.360/);
  await expect(page.locator('[data-role="clock"]')).toHaveText(
    /^2026-01-01T12:00:00\.000Z, paused/,
  );
  expect(await drawing(page)).not.toBe(afterSet);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /16 tools registered; Tabdock relay 127\.0\.0\.1:\d+: linked/,
  );
  // M6 seam: not built. W2-E adds case 2's capture here: capture_view returns a PNG (89 50 4E 47)
  // no wider than maxWidthPx, byte-identical for one view and different for another.
});

test('3. reset_edits prompts on the page, and Deny answers denied_by_operator', async ({
  page,
}) => {
  const { client: alice, pageId } = await pairedPage(page);
  const edited = await callMapTool(alice, pageId, 'edit_stop', {
    walkthroughId: 'maria',
    index: 0,
    title: 'Tranquility',
  });
  expect(edited.isError, edited.text).toBe(false);
  // No write but reset_edits asks the operator.
  expect(await widgetButtonNow(page, { action: 'confirm-deny' })).toBeNull();

  const pending = callMapTool(alice, pageId, 'reset_edits');
  await clickInWidget(page, { action: 'confirm-deny' });
  const denied = await pending;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  const stop = await callMapTool(alice, pageId, 'get_stop', { walkthroughId: 'maria', index: 0 });
  expect(stop.structured).toMatchObject({ title: 'Tranquility' });
});

test('4. fits a 375 px phone with no sideways scroll, the widget badge in reach', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openMapPage(page, tabdock.map.url);
  expect(await connectMapPage(page, tabdock.relay.pageUrl)).toBe(true);
  // The badge is armed and is what a tap on its centre would hit.
  const badge = await widgetButtonCentre(page, { action: 'toggle' });
  expect(badge.x).toBeLessThanOrEqual(375);
  expect(badge.y).toBeLessThanOrEqual(667);
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
    canvas: document.querySelector('canvas')?.getBoundingClientRect().width ?? 0,
  }));
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth);
  // The 960 px drawing buffer is scaled to the column, inside a 16 px gutter.
  expect(layout.canvas).toBeLessThanOrEqual(375 - 32);
});

test('5. dials nothing from its URL or a script, and a real click on Connect dials', async ({
  page,
  context,
}) => {
  const dialled: string[] = [];
  await context.routeWebSocket(/\/page$/, (ws: WebSocketRoute) => {
    dialled.push(ws.url());
  });
  for (const suffix of [
    `?relay=${FAKE_RELAY}`,
    `#relay=${FAKE_RELAY}`,
    `?e2e=1&relay=${FAKE_RELAY}`,
  ]) {
    await openMapPage(page, `${tabdock.map.url}${suffix}`);
  }
  await page.fill('#relay', FAKE_RELAY);
  await page.evaluate(() => {
    const form = document.querySelector('form');
    const button = document.querySelector<HTMLButtonElement>('[data-action="connect"]');
    form?.requestSubmit();
    form?.requestSubmit(button);
    button?.click();
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.locator('[data-action="connect"]').dispatchEvent('click');
  // The connect hook refuses a URL carrying a query, a fragment or a password.
  for (const bad of [
    `${FAKE_RELAY}?code=1`,
    `${FAKE_RELAY}#x`,
    'ws://a:b@127.0.0.1:9/page',
    'https://127.0.0.1:9/page',
  ]) {
    expect(await connectMapPage(page, bad)).toBe(false);
  }
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled).toEqual([]);
  expect(await page.locator('tabdock-dock').count()).toBe(0);

  await page.locator('[data-action="connect"]').click();
  await expect.poll(() => dialled).toEqual([FAKE_RELAY]);
  // Linked once: neither the hook nor another click dials again.
  expect(await connectMapPage(page, FAKE_RELAY)).toBe(false);
  await page.waitForTimeout(SETTLE_MS);
  expect(dialled).toEqual([FAKE_RELAY]);
  // The page hands out no handle on window.
  const globals = await page.evaluate(() =>
    Object.keys(window).filter((key) => key.toLowerCase().includes('tabdock')),
  );
  expect(globals).toEqual(['__tabdockMapPage']);
});

test('6. shows no console error or policy violation, and no argument in its call strip', async ({
  page,
}) => {
  const { client: alice, pageId } = await pairedPage(page);
  const marker = 'Zq7Mark9Wq';
  for (const [tool, args] of [
    ['edit_stop', { walkthroughId: 'maria', index: 1, text: `${marker} caption` }],
    ['set_view', { lat: 7.123456, lon: 3.654321 }],
    ['get_observation', { id: `${marker}-obs` }],
    ['features_in_view', { kind: 'crater', limit: 7 }],
  ] as const) {
    await callMapTool(alice, pageId, tool, args);
  }
  const strip = page.locator('[data-role="calls"] li');
  await expect(strip).toHaveCount(4);
  expect(await strip.allTextContents()).toEqual([
    'features_in_view: ok',
    'get_observation: error',
    'set_view: ok',
    'edit_stop: ok',
  ]);
  const text = (await page.locator('[data-role="calls"]').textContent()) ?? '';
  for (const value of [marker, '7.123456', '3.654321', 'crater', 'caption']) {
    expect(text).not.toContain(value);
  }
  expect(await cspViolations(page)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
