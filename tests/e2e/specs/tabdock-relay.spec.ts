import type { Client } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { untrustedHeader } from '@tabdock/protocol';
import {
  activityStrip,
  callTool,
  clickInWidget,
  connectMcp,
  dockState,
  errorCode,
  startTabdock,
  waitForDock,
  waitForLink,
  widgetText,
  type Tabdock,
} from '../src/tabdock-harness.ts';

// M1 in a real browser: the demo page runs the real adapter (bundled into the
// page, over the MCP-B polyfill) and dials a Tabdock relay; an MCP client pairs
// by the code on the page, and the operator answers by clicking the widget.

let demo: DemoServer;
let tabdock: Tabdock;
let client: Client;
/** Everything the page printed to its console, and every pairing code it showed. */
let consoleLines: string[];
let codesSeen: Set<string>;

test.beforeAll(async () => {
  demo = await startDemoServer();
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async ({ page }) => {
  tabdock = await startTabdock({ demo });
  client = await connectMcp(tabdock.relay, tabdock.users.alice, 'tabdock-playwright');
  consoleLines = [];
  codesSeen = new Set();
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
  page.on('pageerror', (error) => consoleLines.push(`pageerror: ${error.message}`));
});
test.afterEach(async () => {
  await client.close();
  await tabdock.close();
  // The adapter logs to the console; no page error, token or code may show up there (S11).
  expect(consoleLines.filter((line) => /^(error|pageerror):/.test(line))).toEqual([]);
  const secrets = [tabdock.users.alice.token, tabdock.users.bob.token, ...codesSeen];
  for (const secret of secrets) {
    expect(consoleLines.filter((line) => line.includes(secret))).toEqual([]);
  }
});

async function openDemo(page: Page): Promise<{ pageId: string; code: string }> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const linked = await waitForLink(page);
  codesSeen.add(linked.code);
  return linked;
}

/** pair_page, then a click on the widget's Allow as driver button. */
async function pairByClick(page: Page): Promise<string> {
  const { code } = await waitForLink(page);
  codesSeen.add(code);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  expect(paired.structured).toMatchObject({ role: 'driver' });
  return (paired.structured as { page: string }).page;
}

async function waitForToolCount(pageId: string, count: number): Promise<{ name: string }[]> {
  let tools: { name: string }[] = [];
  await expect
    .poll(async () => {
      const listed = await callTool(client, 'list_page_tools', { page: pageId });
      tools = (listed.structured as { tools?: { name: string }[] } | undefined)?.tools ?? [];
      return tools.length;
    })
    .toBe(count);
  return tools;
}

test('the widget shows the pairing code in a closed shadow root page script cannot open', async ({
  page,
}) => {
  const { code } = await openDemo(page);
  const host = await page.evaluate(() => {
    const element = document.querySelector('tabdock-dock');
    return { present: element !== null, shadowRoot: element?.shadowRoot ?? null };
  });
  expect(host).toEqual({ present: true, shadowRoot: null });
  expect(await widgetText(page, 'pairing-code')).toBe(code);
  // The console guard in afterEach sees the adapter's own lines.
  expect(consoleLines.some((line) => line.includes('[tabdock] linked as page'))).toBe(true);
  await expect(page.locator('[data-role="status"]')).toHaveText(
    /Tabdock relay 127\.0\.0\.1:\d+: linked/,
  );
});

test('pair by code, approve by clicking Allow as driver, then list and call tools', async ({
  page,
}) => {
  const { pageId } = await openDemo(page);
  expect(await pairByClick(page)).toBe(pageId);
  expect((await dockState(page))?.roster.map((a) => [a.userId, a.role])).toEqual([
    ['alice', 'driver'],
  ]);

  const tools = await waitForToolCount(pageId, 6);
  expect(tools.map((t) => t.name).sort()).toEqual([
    'add_item',
    'clear_board',
    'get_view',
    'highlight_item',
    'list_items',
    'move_view',
  ]);
  const pages = await callTool(client, 'list_pages');
  const origin = new URL(demo.url).origin;
  expect((pages.structured as { pages: unknown[] }).pages).toEqual([
    {
      page: pageId,
      origin,
      title: 'Tabdock demo board',
      role: 'driver',
      state: 'awake',
      toolCount: 6,
    },
  ]);

  const view = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(view.isError, view.text).toBe(false);
  expect(view.text.split('\n', 1)[0]).toBe(untrustedHeader(origin, 'get_view'));
  expect(view.structured).toMatchObject({ zoom: 1 });

  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'From Playwright', x: 120, y: 80, color: 'purple' },
  });
  expect(added.isError, added.text).toBe(false);
  expect(added.structured).toMatchObject({ item: { id: 'item-4', label: 'From Playwright' } });
  await expect(page.locator('[data-role="view"]')).toHaveText(/4 items/);
  expect((await activityStrip(page))[0]).toMatch(/add_item: added item-4/);

  // A handler error is page content, labelled like any result.
  const missing = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'highlight_item',
    arguments: { id: 'item-999' },
  });
  expect(missing.isError).toBe(true);
  expect(missing.text.split('\n', 1)[0]).toBe(untrustedHeader(origin, 'highlight_item'));
});

test('clear_board shows a confirm prompt on the page, and Deny returns denied_by_operator', async ({
  page,
}) => {
  await openDemo(page);
  const pageId = await pairByClick(page);
  await waitForToolCount(pageId, 6);

  const pending = callTool(client, 'call_page_tool', { page: pageId, tool: 'clear_board' });
  const confirm = await waitForDock(page, (s) => s.pendingConfirms[0]);
  expect(confirm.tool).toBe('clear_board');
  expect(confirm.caller).toMatchObject({ userId: 'alice', role: 'driver' });
  await clickInWidget(page, { action: 'confirm-deny', callId: confirm.callId });

  const denied = await pending;
  expect(errorCode(denied), denied.text).toBe('denied_by_operator');
  await expect(page.locator('[data-role="view"]')).toHaveText(/3 items/);
  expect((await dockState(page))?.pendingConfirms).toEqual([]);
});

test('a page reload keeps the attachment, and calls work afterwards (A1.3)', async ({ page }) => {
  await openDemo(page);
  const pageId = await pairByClick(page);
  await waitForToolCount(pageId, 6);

  await page.reload();
  await page.waitForSelector('html[data-tools="ready"]');
  const after = await waitForLink(page);
  expect(after.pageId).toBe(pageId);
  expect((await dockState(page))?.roster.map((a) => a.userId)).toEqual(['alice']);

  await waitForToolCount(pageId, 6);
  const pages = await callTool(client, 'list_pages');
  expect((pages.structured as { pages: unknown[] }).pages).toMatchObject([
    { page: pageId, state: 'awake', role: 'driver' },
  ]);
  const added = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'After reload', x: -100, y: 60 },
  });
  expect(added.isError, added.text).toBe(false);
  expect((await activityStrip(page))[0]).toMatch(/add_item: added item-4/);
});
