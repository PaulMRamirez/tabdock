import type { Client } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { imageLine, untrustedHeader } from '@tabdock/protocol';
import {
  firstText,
  imageBytes,
  imagePart,
  leakedSlices,
  pngDimensions,
  type ResultContent,
} from '../src/image-helpers.ts';
import {
  callTool,
  clickInWidget,
  connectMcp,
  startTabdock,
  waitForDock,
  waitForLink,
  widgetEvaluate,
  widgetItems,
  type Tabdock,
} from '../src/tabdock-harness.ts';

// capture_board in a real browser (ADR 0039, A6.3): the demo draws its board
// onto a canvas of its own, the real adapter reads the envelope from the
// runtime (the MCP-B polyfill 5.1.0 here, or native WebMCP when
// CHROMIUM_EXECUTABLE names a Chrome that has it), and an SDK client gets
// the picture behind its label: a PNG whose header says the size asked for,
// and WebP by default. The operator's activity log names each picture, and
// at phone width a long client name beside it still fits the panel.

let demo: DemoServer;
let tabdock: Tabdock;
let client: Client;
let consoleLines: string[];
/** Every console message the page wrote, the adapter's info lines about each call included. */
let everyLine: string[];
/** The base64 of each picture a test received. */
let captured: string[];

/** Long enough to wrap the activity line at phone width, as a real client's name might. */
const LONG_CLIENT = 'a-classroom-laptop-client-with-a-very-long-name-indeed';

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async ({ page }) => {
  tabdock = await startTabdock({ demo });
  client = await connectMcp(tabdock.relay, tabdock.users.alice, LONG_CLIENT);
  consoleLines = [];
  everyLine = [];
  captured = [];
  page.on('console', (message) => {
    everyLine.push(message.text());
    if (message.type() === 'error') consoleLines.push(message.text());
  });
  page.on('pageerror', (error) => consoleLines.push(error.message));
});
test.afterEach(async () => {
  await client.close();
  await tabdock.close();
  // No page error.
  expect(consoleLines.filter((line) => !line.startsWith('Failed to load resource'))).toEqual([]);
  // The adapter logged each picture by type and size, and no console line holds any of its data.
  if (captured.length > 0) {
    expect(everyLine.some((line) => /\bok, an image\/\w+ of \d+ bytes/.test(line))).toBe(true);
  }
  const logs = everyLine.join('\n');
  for (const data of captured) expect(leakedSlices(data, logs)).toEqual([]);
});

async function openAndPair(page: Page): Promise<string> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { code } = await waitForLink(page);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  return (paired.structured as { page: string }).page;
}

async function capture(pageId: string, args: Record<string, unknown>): Promise<ResultContent> {
  const result = (await client.callTool({
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'capture_board', arguments: args },
  })) as ResultContent;
  const image = imagePart(result);
  if (image !== null) captured.push(image.data);
  return result;
}

test('capture_board returns the board drawn on its own canvas, as a PNG of the size asked for, behind its label', async ({
  page,
}) => {
  const pageId = await openAndPair(page);
  const origin = new URL(demo.url).origin;
  // Which runtime read the envelope: the polyfill marks its context (ADR 0001).
  const polyfill = await page.evaluate(
    () =>
      (document as unknown as { modelContext?: { __isWebMCPPolyfill?: boolean } }).modelContext
        ?.__isWebMCPPolyfill === true,
  );
  test.info().annotations.push({
    type: 'runtime',
    description: polyfill ? 'MCP-B polyfill 5.1.0' : 'native WebMCP',
  });

  const png = await capture(pageId, { format: 'png', maxEdge: 400 });
  expect(png.isError, firstText(png)).toBeFalsy();
  expect(png.structuredContent).toBeUndefined();
  const image = imagePart(png);
  if (image === null) throw new Error('no image part');
  expect(image.mimeType).toBe('image/png');
  const bytes = imageBytes(image);
  const size = pngDimensions(bytes);
  if (size === null) throw new Error('not a PNG');
  // The long edge is what was asked for, and the picture keeps the board's shape.
  expect(Math.max(size.width, size.height)).toBe(400);
  const [label, line, words] = firstText(png).split('\n');
  expect(label).toBe(untrustedHeader(origin, 'capture_board'));
  expect(line).toBe(imageLine('image/png', bytes.length));
  expect(words).toMatch(/^Board view: centre \(0, 0\), zoom 1, \d+ items, \d+ by \d+ pixels$/);

  // WebP unless asked otherwise, fitted under the relay's 64 KiB.
  const webp = await capture(pageId, {});
  const second = imagePart(webp);
  if (second === null) throw new Error('no image part');
  expect(second.mimeType).toBe('image/webp');
  const riff = imageBytes(second);
  expect(String.fromCharCode(...riff.subarray(0, 4), ...riff.subarray(8, 12))).toBe('RIFFWEBP');
  expect(riff.length).toBeLessThanOrEqual(65_536);

  // The audit names each picture by type, size and digest.
  const records = tabdock.relay.audit.records().filter((record) => record.tool === 'capture_board');
  expect(records.map((record) => record.image?.mimeType)).toEqual(['image/png', 'image/webp']);
  expect(records[0]?.image?.bytes).toBe(bytes.length);

  // The board's own strip, and the widget's activity log, show each capture.
  await expect(page.locator('[data-role="log"] li').first()).toHaveText(
    /capture_board: captured the board as webp/,
  );
  const activity = await widgetItems(page, 'activity');
  expect(activity[0]?.text).toMatch(/capture_board, ok in \d+ ms, image, WEBP, [\d.]+ KB$/);
  expect(activity[1]?.text).toMatch(/capture_board, ok in \d+ ms, image, PNG, [\d.]+ KB$/);
});

test('an argument outside capture_board bounds is refused by the relay, and the page draws nothing', async ({
  page,
}) => {
  const pageId = await openAndPair(page);
  const refused = await callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'capture_board',
    arguments: { maxEdge: 5000 },
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/^invalid_arguments: /);
});

test('at phone width an activity line with an image and a long client name fits the panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const pageId = await openAndPair(page);
  const png = await capture(pageId, { format: 'png', maxEdge: 200 });
  expect(imagePart(png)?.mimeType).toBe('image/png');
  const read = () =>
    widgetEvaluate(
      page,
      'activity',
      `function () {
        const panel = this.closest('.panel');
        const box = panel.getBoundingClientRect();
        return { open: box.width > 0, overflow: panel.scrollWidth - panel.clientWidth, right: box.right, line: this.firstElementChild ? this.firstElementChild.textContent : '' };
      }`,
    ) as Promise<{ open: boolean; overflow: number; right: number; line: string }>;
  let panel = await read();
  if (!panel.open) {
    await clickInWidget(page, { action: 'toggle' });
    panel = await read();
  }
  expect(panel.open).toBe(true);
  expect(panel.line).toContain(LONG_CLIENT);
  expect(panel.line).toMatch(/image, PNG, [\d.]+ KB$/);
  expect(panel.overflow).toBeLessThanOrEqual(0);
  expect(panel.right).toBeLessThanOrEqual(360);
});
