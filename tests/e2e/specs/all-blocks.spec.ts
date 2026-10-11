import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test } from '@playwright/test';
import { startDemoServer } from '@tabdock/demo/server';
import { createOAuthAuth, createRelay } from '@tabdock/relay';
import { PAIR_CLIENT, startProvider } from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from '@tabdock/relay/test/tunnel';
import { AGENT_COMMAND } from '../src/agent-harness.ts';
import { imagePart, type ResultContent } from '../src/image-helpers.ts';
import { propose } from '../src/proposal-helpers.ts';
import { joinAtI, memberClaude, ROOM_MEMBERS, type RoomTabdock } from '../src/room-harness.ts';
import { sessionLinkInWidget, startSessionInWidget } from '../src/session-helpers.ts';
import {
  approveThroughHandle,
  callTool,
  clickInWidget,
  demoPageUrl,
  dockState,
  typeInWidget,
  waitForDock,
  waitForLink,
  widgetButtonNow,
  widgetEvaluate,
  widgetItems,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// The widget with every M6 block open at once (A6.26), on the demo board
// against a real relay in public URL mode with invites and agent tokens on:
// the state line, a call's image in the activity log, two proposals waiting,
// a running session with its countdown, QR and Extend, thirty-nine students
// watching by its links in an open Watching section, an agent token with its
// command still shown, and the record a finished session offers. Each block
// is reached the way an operator and a class reach it, so the combination
// is one the product can be in; then nothing may scroll sideways, neither
// the page, nor the panel, nor any box inside it, at a phone's 360 px and at
// a desktop's 1280.

const [ALICE, BOB] = ROOM_MEMBERS;
/** The lesson's observers, as two session links of twenty uses each. */
const SEATS = 40;
/**
 * The students who join: one short of the seats, so the second link keeps a
 * use and with it the QR on show, which hides once no link has a use left.
 */
const CLASS = SEATS - 1;

let room: RoomTabdock | undefined;
const clients: Client[] = [];
let pageErrors: string[];

test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await room?.close();
  room = undefined;
  expect(pageErrors).toEqual([]);
});

/**
 * room-harness.ts's class relay with agent tokens on too: members Alice,
 * Bob and Dave, invites, and the page's pairing limit raised so a class of
 * forty joins at once, as there.
 */
async function startClassTabdock(): Promise<RoomTabdock> {
  const provider = await startProvider();
  const demo = await startDemoServer({ e2eHook: true });
  try {
    const relay = await createRelay({
      auth: createOAuthAuth({
        issuer: provider.issuer,
        resource: PUBLIC_MCP_URL,
        users: [...ROOM_MEMBERS],
      }),
      publicUrl: PUBLIC_ORIGIN,
      pairClient: PAIR_CLIENT,
      allowedOrigins: [new URL(demo.url).origin],
      invites: true,
      agentTokens: true,
      port: 0,
      logSink: () => undefined,
      rateLimits: { pairAttemptsPerPage: 500, pairSignIns: 500 },
    });
    return {
      relay,
      provider,
      demo,
      pageUrl: demoPageUrl(demo, relay.pageUrl),
      async close() {
        await relay.close();
        await demo.close();
        await provider.stop();
      },
    };
  } catch (error) {
    await demo.close();
    await provider.stop();
    throw error;
  }
}

/** A member's Claude pairs by the page's current code, and the operator allows it as `role`. */
async function pairMember(
  page: Page,
  live: RoomTabdock,
  member: (typeof ROOM_MEMBERS)[number],
  role: 'driver' | 'observer',
): Promise<Client> {
  const client = await memberClaude(live, member.sub, `claude-${member.userId}`);
  clients.push(client);
  const { code } = await waitForLink(page);
  const pairing = callTool(client, 'pair_page', { code });
  const asks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === member.userId),
  );
  expect(await approveThroughHandle(page, asks.requestId, role)).toBe(true);
  expect((await pairing).isError).toBe(false);
  return client;
}

/** The secret a session link carries in its fragment. */
function secretOf(link: string): string {
  return link.slice(link.indexOf('#') + 1);
}

/** Each M6 block's node, by data-role, and whether the operator can see it. */
const BLOCKS = [
  'state-line',
  'activity',
  'proposals',
  'proposal-list',
  'session',
  'session-countdown',
  'watching',
  'agent-list',
  'agent-command',
  'record-offer',
] as const;

async function blocksShown(page: Page): Promise<Record<string, boolean>> {
  const shown: Record<string, boolean> = {};
  for (const block of BLOCKS) shown[block] = await widgetVisible(page, block);
  return shown;
}

interface Sideways {
  /** How far the page itself scrolls sideways. */
  page: number;
  /** Each box in the widget that could scroll sideways and does, by its tag, class and role. */
  scrolling: string[];
  /** Each box drawn past the viewport's left or right edge. */
  outside: string[];
  /** The panel's left and right edges. */
  panel: { left: number; right: number };
}

/**
 * Everything that scrolls sideways or is drawn past the screen's edge, read
 * inside the widget's closed shadow root through the DevTools protocol. A
 * box whose overflow is hidden cuts its text with an ellipsis rather than
 * scrolling it, so only boxes that could scroll are held to their width.
 */
async function sideways(page: Page): Promise<Sideways> {
  const inWidget = (await widgetEvaluate(
    page,
    'activity',
    `function () {
      const root = this.getRootNode();
      const panel = this.closest('.panel');
      const width = window.innerWidth;
      const name = (node) =>
        node.localName + (node.className ? '.' + String(node.className).split(' ').join('.') : '') +
        (node.dataset.role ? '[' + node.dataset.role + ']' : '');
      const scrolling = [];
      const outside = [];
      for (const node of root.querySelectorAll('*')) {
        const box = node.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const overflow = getComputedStyle(node).overflowX;
        if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth) {
          scrolling.push(name(node));
        }
        if (box.left < -0.5 || box.right > width + 0.5) outside.push(name(node));
      }
      const edges = panel.getBoundingClientRect();
      return { scrolling, outside, panel: { left: edges.left, right: edges.right } };
    }`,
  )) as Omit<Sideways, 'page'>;
  const pageScroll = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  return { page: pageScroll, ...inWidget };
}

test('every M6 block open at once scrolls nowhere sideways at 360 px, nor at 1280 px', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1280, height: 1200 });
  room = await startClassTabdock();
  const live = room;
  await page.goto(`${live.pageUrl}&proposals=members`);
  const { pageId } = await waitForLink(page);
  const alice = await pairMember(page, live, ALICE, 'driver');
  const bob = await pairMember(page, live, BOB, 'observer');
  // The relay takes images, state, invites, sessions and agent tokens, and the board shares its state.
  await waitForDock(page, (state) =>
    state.maxImageBytes !== null &&
    state.published === 'shared' &&
    state.sessionsOffered &&
    state.agentsOffered !== null &&
    (state.invitesOffered?.linkBase ?? null) !== null
      ? true
      : null,
  );
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });

  // A warm-up session in which Alice captures the board: its end offers its record.
  await startSessionInWidget(page, { label: 'Warm-up', minutes: 30 });
  const shot = (await alice.callTool({
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'capture_board', arguments: {} },
  })) as ResultContent;
  expect(shot.isError).toBeFalsy();
  const image = imagePart(shot);
  expect(image?.mimeType).toMatch(/^image\//);
  await clickInWidget(page, { action: 'session-end' });
  await clickInWidget(page, { action: 'session-end-yes' });
  await waitForDock(page, (state) =>
    state.session === null && state.records.some((view) => view.which === 'ended') ? true : null,
  );

  // The lesson: forty observers by its two watch links, one shown at a time,
  // its QR open from the start to be projected.
  await startSessionInWidget(page, { label: 'Lesson', minutes: 90, observers: SEATS });
  await waitForDock(page, (state) => (state.session?.inviteIds.length === 2 ? true : null));
  await expect.poll(() => sessionLinkInWidget(page), { timeout: 10_000 }).not.toBe('');
  const first = await sessionLinkInWidget(page);
  for (let index = 0; index < SEATS / 2; index += 1) {
    const joined = await joinAtI(live, index, secretOf(first));
    expect(joined.data, `student ${String(index)}`).toEqual({
      status: 'approved',
      role: 'observer',
    });
  }
  // The first link is used up, so the second takes its place.
  await expect.poll(() => sessionLinkInWidget(page), { timeout: 10_000 }).not.toBe(first);
  const second = await sessionLinkInWidget(page);
  expect(second).not.toBe('');
  for (let index = SEATS / 2; index < CLASS; index += 1) {
    const joined = await joinAtI(live, index, secretOf(second));
    expect(joined.data, `student ${String(index)}`).toEqual({
      status: 'approved',
      role: 'observer',
    });
  }
  await waitForDock(page, (state) => (state.roster.length === CLASS + 2 ? true : null));

  // Bob, a member watching, proposes two writes the session still takes from members.
  for (const label of ['Bob was here', 'And here']) {
    const { answer, proposalId } = await propose(bob, pageId, 'add_item', { label, x: 1, y: 2 });
    expect(answer.head, answer.text).toBe('proposed');
    expect(proposalId).not.toBeNull();
  }
  await waitForDock(page, (state) => (state.proposals.length === 2 ? true : null));

  // An agent token minted in the Invite form, its command left on show.
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', 'Nightly checker');
  await clickInWidget(page, { action: 'invite-kind-agent' });
  await clickInWidget(page, { action: 'invite-create' });
  await expect.poll(async () => (await widgetText(page, 'agent-command')) ?? '').not.toBe('');
  expect(AGENT_COMMAND.test((await widgetText(page, 'agent-command')) ?? '')).toBe(true);
  await waitForDock(page, (state) => (state.agents.length === 1 ? true : null));

  // The Watching section opened, which starts closed past eight rows.
  await clickInWidget(page, { action: 'watching-toggle' });

  const state = await dockState(page);
  expect(state?.session?.label).toBe('Lesson');
  expect(state?.activity.some((entry) => entry.image?.mimeType === image?.mimeType)).toBe(true);
  expect(state?.records.map((view) => view.which)).toContain('ended');

  for (const viewport of [
    { width: 1280, height: 1200 },
    { width: 360, height: 780 },
  ]) {
    await page.setViewportSize(viewport);
    const at = `${String(viewport.width)} px`;
    // Every block is on show at once, each with what it holds.
    await expect
      .poll(() => blocksShown(page), { message: at })
      .toEqual(Object.fromEntries(BLOCKS.map((block) => [block, true])));
    expect(await widgetText(page, 'state-line'), at).toContain('shares its state');
    expect(
      (await widgetItems(page, 'activity')).some((line) => /, image, [A-Z]+, /.test(line.text)),
      at,
    ).toBe(true);
    expect(await widgetItems(page, 'proposal-list'), at).toHaveLength(2);
    expect(await widgetText(page, 'session-countdown'), at).toMatch(/^Ends in /);
    expect(await widgetButtonNow(page, { action: 'session-extend' }), at).not.toBeNull();
    expect(
      await widgetEvaluate(
        page,
        'session',
        'function () { const qr = this.querySelector(".qr svg"); return qr !== null && qr.getBoundingClientRect().width > 0; }',
      ),
      at,
    ).toBe(true);
    expect(
      await widgetEvaluate(
        page,
        'watching',
        'function () { return Array.from(this.querySelector("ul").children).filter((row) => row.getBoundingClientRect().height > 0).length; }',
      ),
      at,
    ).toBe(CLASS);
    expect(await widgetItems(page, 'agent-list'), at).toHaveLength(1);
    expect(await widgetText(page, 'record-offer'), at).toContain('Session "Warm-up" ended.');

    // And nothing scrolls sideways or reaches past the screen.
    const found = await sideways(page);
    expect(found.page, at).toBeLessThanOrEqual(0);
    expect(found.scrolling, at).toEqual([]);
    expect(found.outside, at).toEqual([]);
    expect(found.panel.left, at).toBeGreaterThanOrEqual(0);
    expect(found.panel.right, at).toBeLessThanOrEqual(viewport.width);
  }
});
