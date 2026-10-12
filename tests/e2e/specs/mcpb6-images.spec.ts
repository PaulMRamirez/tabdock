import type { Client } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import { imageLine, parsePageFrame, untrustedHeader } from '@tabdock/protocol';
import {
  firstText,
  imageBytes,
  imagePart,
  pngDimensions,
  type ResultContent,
} from '../src/image-helpers.ts';
import { mcpb6Runtime, useMcpb6 } from '../src/mcpb6-page.ts';
import {
  callTool,
  clickInWidget,
  connectMcp,
  startTabdock,
  waitForDock,
  waitForLink,
  type Tabdock,
} from '../src/tabdock-harness.ts';

// capture_board on MCP-B 6 (ADRs 0039 and 0047, A6.3): 6 serializes every
// result as JSON, so the adapter reads a declared image tool's envelope from
// that text, and the result frame on the page link carries the picture in its
// own `image` field, never inside the text. The playwright.config.ts project
// "mcpb6" runs this file, as it runs mcpb6.spec.ts, which W1-H keeps, and
// each test first proves the context is 6's.

let demo: DemoServer;
let tabdock: Tabdock;
let client: Client;
let consoleLines: string[];
let linkFrames: { from: 'page' | 'relay'; text: string }[];

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(async ({ page }) => {
  tabdock = await startTabdock({ demo });
  client = await connectMcp(tabdock.relay, tabdock.users.alice, 'tabdock-playwright-mcpb6-images');
  consoleLines = [];
  linkFrames = [];
  await useMcpb6(page, { recordCalls: false });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleLines.push(message.text());
  });
  page.on('pageerror', (error) => consoleLines.push(error.message));
  page.on('websocket', (socket) => {
    if (socket.url() !== tabdock.relay.pageUrl) return;
    socket.on('framesent', ({ payload }) =>
      linkFrames.push({ from: 'page', text: String(payload) }),
    );
  });
});
test.afterEach(async () => {
  await client.close();
  await tabdock.close();
  expect(consoleLines).toEqual([]);
});

async function openOnMcpb6AndPair(page: Page): Promise<string> {
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  expect(await mcpb6Runtime(page)).toMatchObject({
    hadContextBefore: false,
    installed: true,
    marker: undefined,
    stringInput: 'TypeError: inputObject must be an object',
  });
  const { code } = await waitForLink(page);
  const pending = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const paired = await pending;
  expect(paired.isError, paired.text).toBe(false);
  return (paired.structured as { page: string }).page;
}

test('on MCP-B 6 capture_board reaches the client as an image, carried in the result frame beside the words', async ({
  page,
}) => {
  const pageId = await openOnMcpb6AndPair(page);
  const origin = new URL(demo.url).origin;
  const result = (await client.callTool({
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'capture_board', arguments: { format: 'png', maxEdge: 320 } },
  })) as ResultContent;
  expect(result.isError, firstText(result)).toBeFalsy();
  const image = imagePart(result);
  if (image === null) throw new Error('no image part');
  const bytes = imageBytes(image);
  expect(Math.max(...Object.values(pngDimensions(bytes) ?? { none: 0 }))).toBe(320);
  const [label, line, words] = firstText(result).split('\n');
  expect(label).toBe(untrustedHeader(origin, 'capture_board'));
  expect(line).toBe(imageLine('image/png', bytes.length));
  // The envelope's words, unwrapped from 6's JSON, never its quoted text.
  expect(words).toMatch(/^Board view: centre/);

  // On the wire: the page's result frame held the image in its own field.
  // DevTools reports frames after the fact, so the check waits for this one.
  const withImage = () =>
    linkFrames.flatMap(({ from, text }) => {
      if (from !== 'page') return [];
      const parsed = parsePageFrame(text);
      return parsed.kind === 'ok' &&
        parsed.frame.t === 'result' &&
        parsed.frame.ok &&
        parsed.frame.image !== undefined
        ? [parsed.frame]
        : [];
    });
  await expect.poll(() => withImage().length).toBe(1);
  const [frame] = withImage();
  expect(frame?.image).toEqual({ mimeType: 'image/png', data: image.data });
  expect(frame?.content?.startsWith('Board view: centre')).toBe(true);

  // A tool the page did not declare keeps 6's text as it was: get_view's object as its JSON.
  const view = await callTool(client, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(view.isError, view.text).toBe(false);
  expect(view.structured).toMatchObject({ zoom: 1 });
});
