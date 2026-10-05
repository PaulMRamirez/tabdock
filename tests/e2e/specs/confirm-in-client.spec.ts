import {
  Client,
  type ElicitRequestFormParams,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, test } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import type { Relay } from '@tabdock/relay';
import type { DevTokenUser } from '@tabdock/relay';
import {
  callTool,
  clickInWidget,
  dockState,
  startTabdock,
  type Tabdock,
  waitForDock,
  waitForLink,
  widgetEvaluate,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// Confirmation in the caller's client on the demo board, in a real browser
// (ADR 0026, A5.3): the board opened with ?confirm=client lets its member
// driver confirm clear_board in their own MCP client. The SDK client 2.3.0
// answers the relay's question with its elicitation handler, on both
// revisions; the board raises no prompt, clears, and its widget's activity
// log draws the page's own badge on that line, naming the client and the
// person: confirmed in "<client>" by <name>. The same call from a client that
// declares no form elicitation gets the board's own prompt and no badge.

let demo: DemoServer;
let tabdock: Tabdock;
const clients: Client[] = [];

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
  for (const client of clients.splice(0)) await client.close();
  await tabdock.close();
});

/** The SDK client, declaring form elicitation when `confirming`, its handler accepting every question. */
async function claudeCode(
  relay: Relay,
  user: DevTokenUser,
  modern: boolean,
  confirming: boolean,
): Promise<{ client: Client; asked: ElicitRequestFormParams[] }> {
  const asked: ElicitRequestFormParams[] = [];
  const client = new Client(
    { name: 'claude-code', version: '2.1.289' },
    {
      capabilities: confirming ? { elicitation: { form: {} } } : {},
      ...(modern ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}),
    },
  );
  if (confirming) {
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push(request.params as ElicitRequestFormParams);
      return Promise.resolve({ action: 'accept', content: { confirm: true } });
    });
  }
  await client.connect(
    new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
    }),
  );
  clients.push(client);
  return { client, asked };
}

/** Each activity line's call id, and the text of each page-built "confirmed in" badge in it. */
const READ_BADGES = `function () {
  return Array.from(this.children, (li) => ({
    id: li.dataset.activityId || '',
    badges: Array.from(li.querySelectorAll('[data-role="confirmed"]'), (el) => el.textContent),
  }));
}`;

for (const [label, modern] of [
  ['a 2025-era session', false],
  ['2026-07-28', true],
] as const) {
  test(`?confirm=client: a member driver confirms clear_board in the client, and the widget's line says so (${label})`, async ({
    page,
  }) => {
    const url = new URL(tabdock.pageUrl);
    url.searchParams.set('confirm', 'client');
    await page.goto(url.href);
    await page.waitForSelector('html[data-tools="ready"]');
    const { code } = await waitForLink(page);

    const { client, asked } = await claudeCode(tabdock.relay, tabdock.users.alice, modern, true);
    const pairing = callTool(client, 'pair_page', { code });
    const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
    await clickInWidget(page, { action: 'approve-driver', requestId });
    const paired = await pairing;
    expect(paired.isError, paired.text).toBe(false);
    const pageId = (paired.structured as { page: string }).page;

    // An item to clear, then clear_board, confirmed in the client.
    const added = await callTool(client, 'call_page_tool', {
      page: pageId,
      tool: 'add_item',
      arguments: { label: 'buy milk', x: 0, y: 0 },
    });
    expect(added.isError, added.text).toBe(false);
    const cleared = await callTool(client, 'call_page_tool', {
      page: pageId,
      tool: 'clear_board',
      arguments: {},
    });
    expect(cleared.isError, cleared.text).toBe(false);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.message).toContain(`Page: ${pageId}`);
    expect(asked[0]?.message).toContain('Tool: "clear_board"');

    const state = await dockState(page);
    // The board never asked its operator.
    expect(state?.pendingConfirms).toEqual([]);
    const entry = state?.activity.find((each) => each.tool === 'clear_board');
    expect(entry).toMatchObject({ outcome: 'ok', confirmedBy: 'client' });
    expect(tabdock.relay.audit.records().at(-1)).toMatchObject({
      tool: 'clear_board',
      confirmedBy: 'client',
    });

    // The widget's activity line carries the page's own badge, whole.
    if (!(await widgetVisible(page, 'activity'))) await clickInWidget(page, { action: 'toggle' });
    await expect.poll(() => widgetVisible(page, 'activity')).toBe(true);
    const lines = (await widgetEvaluate(page, 'activity', READ_BADGES)) as {
      id: string;
      badges: string[];
    }[];
    const confirmedLine = lines.find((line) => line.id === entry?.callId);
    expect(confirmedLine?.badges).toEqual(['confirmed in "claude-code 2.1.289" by Alice']);
    // The add_item line, which needed no confirmation, has none.
    expect(lines.filter((line) => line.badges.length > 0)).toHaveLength(1);
  });
}

test('?confirm=client: a client without form elicitation gets the board prompt, and no badge', async ({
  page,
}) => {
  const url = new URL(tabdock.pageUrl);
  url.searchParams.set('confirm', 'client');
  await page.goto(url.href);
  await page.waitForSelector('html[data-tools="ready"]');
  const { code } = await waitForLink(page);
  const { client } = await claudeCode(tabdock.relay, tabdock.users.alice, true, false);
  const pairing = callTool(client, 'pair_page', { code });
  const requestId = await waitForDock(page, (s) => s.pendingRequests[0]?.requestId);
  await clickInWidget(page, { action: 'approve-driver', requestId });
  const pageId = ((await pairing).structured as { page: string }).page;

  const clearing = callTool(client, 'call_page_tool', {
    page: pageId,
    tool: 'clear_board',
    arguments: {},
  });
  const callId = await waitForDock(page, (s) => s.pendingConfirms[0]?.callId);
  await clickInWidget(page, { action: 'confirm-allow', callId });
  const cleared = await clearing;
  expect(cleared.isError, cleared.text).toBe(false);
  const entry = (await dockState(page))?.activity.find((each) => each.tool === 'clear_board');
  expect(entry).toMatchObject({ outcome: 'ok', confirmedBy: null });
  if (!(await widgetVisible(page, 'activity'))) await clickInWidget(page, { action: 'toggle' });
  await expect.poll(() => widgetVisible(page, 'activity')).toBe(true);
  const lines = (await widgetEvaluate(page, 'activity', READ_BADGES)) as {
    id: string;
    badges: string[];
  }[];
  expect(lines.flatMap((line) => line.badges)).toEqual([]);
});
