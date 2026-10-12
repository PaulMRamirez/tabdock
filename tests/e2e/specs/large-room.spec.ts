import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test } from '@playwright/test';
import {
  joinAtI,
  memberClaude,
  ROOM_MEMBERS,
  type RoomTabdock,
  startRoomTabdock,
  student,
} from '../src/room-harness.ts';
import {
  approveThroughHandle,
  callTool,
  clickInWidget,
  dockState,
  typeInWidget,
  waitForDock,
  waitForLink,
  widgetButtonNow,
  widgetEvaluate,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// ADR 0044, A6.24: a class of forty watching the operator's board, at phone
// width. Forty students join by two watch invites at /i, beside two members,
// and the widget holds them in a compact Watching section that starts
// closed, filters by name or short id, scrolls inside the panel with no
// sideways scroll anywhere, takes a Revoke only once its row has held still,
// and tells of the joins in one line per invite. Revoke all, and Revoke on
// the sponsor's row, ask first (plan C21). A second spec shows a promotion
// the people have no seat for, in the operator's own words.

test.use({ viewport: { width: 390, height: 844 } });

const [ALICE, BOB, DAVE] = ROOM_MEMBERS;
let room: RoomTabdock | undefined;
const clients: Client[] = [];

test.afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await room?.close();
  room = undefined;
});

/** A member's Claude pairs by the page's current code, and the operator allows it as `role`. */
async function pairMember(
  page: Page,
  live: RoomTabdock,
  member: (typeof ROOM_MEMBERS)[number],
  role: 'driver' | 'observer',
): Promise<void> {
  const client = await memberClaude(live, member.sub, `claude-${member.userId}`);
  clients.push(client);
  const { code } = await waitForLink(page);
  const pairing = callTool(client, 'pair_page', { code });
  const asks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === member.userId),
  );
  expect(await approveThroughHandle(page, asks.requestId, role)).toBe(true);
  expect((await pairing).isError).toBe(false);
}

/** Mints through the page's handle (the ?e2e hook); the secret is the link's fragment. */
async function mint(
  page: Page,
  options: { label: string; role: 'observer' | 'driver'; uses?: number },
): Promise<string> {
  const result = await page.evaluate((opts) => window.__tabdockDock?.invite(opts) ?? null, options);
  if (!result?.ok) throw new Error(`no invite: ${JSON.stringify(result)}`);
  return result.link.slice(result.link.indexOf('#') + 1);
}

interface WatchingView {
  title: string;
  toggle: string;
  listShown: boolean;
  rows: { userId: string; shown: boolean; height: number; text: string }[];
}

/** The Watching section as the operator sees it: its title, its toggle, and each row. */
async function watchingView(page: Page): Promise<WatchingView> {
  return (await widgetEvaluate(
    page,
    'watching',
    `function () {
      const list = this.querySelector('ul');
      return {
        title: this.firstElementChild.firstElementChild.textContent,
        toggle: this.querySelector('[data-action="watching-toggle"]').textContent,
        listShown: list.getBoundingClientRect().height > 0,
        rows: Array.from(list.children, (row) => ({
          userId: row.dataset.userId,
          shown: row.getBoundingClientRect().height > 0,
          height: row.getBoundingClientRect().height,
          text: row.textContent,
        })),
      };
    }`,
  )) as WatchingView;
}

/**
 * Whether the Watching list and each row in it fit their own width, so
 * nothing in them scrolls sideways, and how wide each row's name shows: the
 * list scrolls on its own, so the panel's width alone cannot tell.
 */
async function watchingFits(page: Page): Promise<{ fits: boolean; names: number[] }> {
  return (await widgetEvaluate(
    page,
    'watching',
    `function () {
      const list = this.querySelector('ul');
      const rows = Array.from(list.children);
      return {
        fits: [list, ...rows].every((box) => box.scrollWidth <= box.clientWidth),
        names: rows.map((row) => row.firstElementChild.getBoundingClientRect().width),
      };
    }`,
  )) as { fits: boolean; names: number[] };
}

/** Whether the confirm box Revoke opens is on screen, and what it says. */
async function confirmShown(page: Page): Promise<string | null> {
  const box = await widgetButtonNow(page, { action: 'revoke-anyway' });
  if (box === null) return null;
  return (await widgetEvaluate(
    page,
    'roster',
    `function () {
      const button = this.parentElement.querySelector('[data-action="revoke-anyway"]');
      return button.closest('.prompt').firstElementChild.textContent;
    }`,
  )) as string;
}

test('forty watchers fit a compact, collapsible, filterable section at 390 px, and Revoke waits for a row to hold still', async ({
  page,
}) => {
  test.setTimeout(240_000);
  room = await startRoomTabdock();
  const live = room;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(live.pageUrl);
  await waitForLink(page);
  await pairMember(page, live, ALICE, 'driver');
  await pairMember(page, live, BOB, 'observer');
  await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);
  expect((await dockState(page))?.seatLimits).toEqual({ usersPerPage: 10, observersPerPage: 40 });

  // Two watch invites of twenty uses: the class joins at /i, with no prompt.
  const secrets = [
    await mint(page, { label: 'Class A', role: 'observer', uses: 20 }),
    await mint(page, { label: 'Class B', role: 'observer', uses: 20 }),
  ];
  for (let index = 0; index < 40; index += 1) {
    const joined = await joinAtI(live, index, secrets[Math.floor(index / 20)] ?? '');
    expect(joined.data, `student ${String(index)}`).toEqual({
      status: 'approved',
      role: 'observer',
    });
  }
  const roster = await waitForDock(page, (state) =>
    state.roster.length === 42 ? state.roster : null,
  );
  const watchers = roster.filter((entry) => entry.kind === 'invitee');
  expect(watchers).toHaveLength(40);

  // One line per invite tells of the joins, never forty.
  await expect
    .poll(() =>
      widgetEvaluate(
        page,
        'joins',
        'function () { return Array.from(this.children, (line) => [line.dataset.joinedBatch ?? null, line.textContent]); }',
      ),
    )
    .toEqual([
      [
        expect.any(String),
        expect.stringMatching(/^20 joined by your invite "Class B" as observer: .+ and 17 more$/),
      ],
      [
        expect.any(String),
        expect.stringMatching(/^20 joined by your invite "Class A" as observer: .+ and 17 more$/),
      ],
    ]);

  // The 41st is turned away at /i before the page hears of it.
  const third = await mint(page, { label: 'Late', role: 'observer' });
  const late = await joinAtI(live, 40, third);
  expect(late).toMatchObject({ status: 409, data: { error: 'page_busy' } });

  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });
  // Closed past eight rows, with the count against the seats.
  let view = await watchingView(page);
  expect(view.title).toBe('Watching by invite: 40 of 40');
  expect(view.toggle).toBe('Show');
  expect(view.listShown).toBe(false);
  expect(await widgetText(page, 'roster')).toContain('Alice');
  await clickInWidget(page, { action: 'watching-toggle' });
  view = await watchingView(page);
  expect(view.toggle).toBe('Hide');
  expect(view.rows.map((row) => row.userId)).toEqual(watchers.map((entry) => entry.userId));
  for (const row of view.rows) {
    expect(row.height).toBeGreaterThanOrEqual(44);
    expect(row.height).toBeLessThanOrEqual(48);
  }
  // Each row names the student beside their short id, with the invited badge.
  const first = watchers[0];
  if (first === undefined) throw new Error('no watcher');
  expect(view.rows[0]?.text).toContain(`${student(0).email} (${first.userId.slice(2, 10)})`);
  expect(view.rows[0]?.text).toContain('invited');
  // Nothing scrolls sideways: not the page, not the panel.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(
    await widgetEvaluate(
      page,
      'watching',
      'function () { const panel = this.closest(".panel"); return panel.scrollWidth <= panel.clientWidth; }',
    ),
  ).toBe(true);
  // Nor the Watching list, which scrolls on its own, and every name shows.
  const fits = await watchingFits(page);
  expect(fits.fits).toBe(true);
  for (const width of fits.names) expect(width).toBeGreaterThan(40);

  // The filter narrows to a short id, and clearing it shows everyone again.
  const sought = watchers[5];
  if (sought === undefined) throw new Error('no sixth watcher');
  await typeInWidget(page, 'watching-filter', sought.userId.slice(2, 10));
  await expect
    .poll(async () =>
      (await watchingView(page)).rows.filter((row) => row.shown).map((row) => row.userId),
    )
    .toEqual([sought.userId]);
  await typeInWidget(page, 'watching-filter', '');
  await page.keyboard.press('Backspace');
  await expect
    .poll(async () => (await watchingView(page)).rows.filter((row) => row.shown).length)
    .toBe(40);

  // Revoke on row 37, clicked the moment a scroll brings it under the pointer, is ignored.
  const target = watchers[36];
  if (target === undefined) throw new Error('no 37th watcher');
  const spot = (await widgetEvaluate(
    page,
    'watching',
    `function () {
      const row = this.querySelector('li[data-user-id="${target.userId}"]');
      row.scrollIntoView({ block: 'center' });
      const box = row.querySelector('[data-action="revoke"]').getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }`,
  )) as { x: number; y: number };
  await page.mouse.click(spot.x, spot.y);
  expect((await widgetButtonNow(page, { action: 'revoke', userId: target.userId }))?.armed).toBe(
    false,
  );
  await page.waitForTimeout(200);
  expect((await dockState(page))?.roster.some((entry) => entry.userId === target.userId)).toBe(
    true,
  );
  // Held still, the same click revokes.
  await expect
    .poll(
      async () => (await widgetButtonNow(page, { action: 'revoke', userId: target.userId }))?.armed,
    )
    .toBe(true);
  const now = await widgetButtonNow(page, { action: 'revoke', userId: target.userId });
  await page.mouse.click(now?.x ?? 0, now?.y ?? 0);
  await waitForDock(page, (state) => !state.roster.some((entry) => entry.userId === target.userId));
  await expect
    .poll(async () => (await watchingView(page)).title)
    .toBe('Watching by invite: 39 of 40');

  // Revoke all asks first while invites let people in, and Keep keeps them.
  await clickInWidget(page, { action: 'revoke-all' });
  await expect
    .poll(() => confirmShown(page))
    .toBe('Revoke all also ends access for 39 people invites let in.');
  expect((await dockState(page))?.roster).toHaveLength(41);
  await clickInWidget(page, { action: 'revoke-keep' });
  await expect.poll(() => confirmShown(page)).toBeNull();
  expect((await dockState(page))?.roster).toHaveLength(41);

  // So does Revoke on the sponsor's row; the first click revokes nothing.
  await clickInWidget(page, { action: 'revoke', userId: 'alice' });
  await expect
    .poll(() => confirmShown(page))
    .toBe('Revoking Alice also ends access for up to 39 people invites let in.');
  expect((await dockState(page))?.roster).toHaveLength(41);
  await clickInWidget(page, { action: 'revoke-anyway' });
  // Alice goes, and with her everyone her invites let in; Bob stays.
  await waitForDock(page, (state) =>
    state.roster.length === 1 && state.roster[0]?.userId === 'bob' ? true : null,
  );
  expect(pageErrors).toEqual([]);
});

test("says when the page's people have no seat for a watcher made a driver", async ({ page }) => {
  test.setTimeout(120_000);
  // The narrowest phone the widget is held to: a control guest's compact row carries Make driver too.
  await page.setViewportSize({ width: 360, height: 780 });
  room = await startRoomTabdock({ limits: { usersPerPage: 3 } });
  const live = room;
  const url = new URL(live.pageUrl);
  url.searchParams.set('invites', 'all');
  await page.goto(url.href);
  await waitForLink(page);
  await pairMember(page, live, ALICE, 'driver');
  await pairMember(page, live, BOB, 'observer');
  await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);

  // A control invite, which the operator answers with Allow as observer: the guest watches.
  const secret = await mint(page, { label: 'Pair', role: 'driver' });
  const joining = joinAtI(live, 0, secret);
  const asks = await waitForDock(page, (state) => state.pendingRequests[0]);
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });
  await clickInWidget(page, { action: 'approve-observer', requestId: asks.requestId });
  expect((await joining).data).toEqual({ status: 'approved', role: 'observer' });
  const guest = asks.user.userId;
  await expect
    .poll(async () => (await watchingView(page)).title)
    .toBe('Watching by invite: 1 of 40');
  // At 360 px the row's buttons go below its name rather than past the list's edge.
  expect(
    await widgetEvaluate(
      page,
      'watching',
      'function () { return this.querySelector(\'[data-action="make-driver"]\').getBoundingClientRect().width > 0; }',
    ),
  ).toBe(true);
  const fits = await watchingFits(page);
  expect(fits.fits).toBe(true);
  expect(fits.names[0]).toBeGreaterThan(40);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  // Dave takes the last of the three people seats, so Make driver finds none.
  await pairMember(page, live, DAVE, 'observer');
  await clickInWidget(page, { action: 'make-driver', userId: guest });
  await expect
    .poll(() => widgetText(page, 'joins'))
    .toContain(
      `The page has no seat left among its 3 people, so ${student(0).email} (${guest.slice(2, 10)}) is still an observer.`,
    );
  expect((await dockState(page))?.roster.find((entry) => entry.userId === guest)?.role).toBe(
    'observer',
  );
});

test("Revoke on a watcher's row closes the link they joined by, unless the section's box is unticked", async ({
  page,
}) => {
  test.setTimeout(120_000);
  room = await startRoomTabdock();
  const live = room;
  await page.goto(live.pageUrl);
  await waitForLink(page);
  await pairMember(page, live, ALICE, 'driver');
  await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);
  if (!(await widgetVisible(page, 'pause-box'))) await clickInWidget(page, { action: 'toggle' });

  /** Two students join by a fresh five-use link; returns the link's invite id and their ids. */
  const joinTwo = async (label: string, from: number) => {
    const before = new Set((await dockState(page))?.invites.map((view) => view.inviteId));
    const secret = await mint(page, { label, role: 'observer', uses: 5 });
    const inviteId =
      (await dockState(page))?.invites.find((view) => !before.has(view.inviteId))?.inviteId ?? '';
    for (const index of [from, from + 1]) {
      expect((await joinAtI(live, index, secret)).data).toEqual({
        status: 'approved',
        role: 'observer',
      });
    }
    const ids = await waitForDock(page, (state) => {
      const made = state.roster.filter((entry) => entry.inviteId === inviteId);
      return made.length === 2 ? made.map((entry) => entry.userId) : null;
    });
    return { inviteId, ids };
  };

  // Ticked by default, as ADR 0016 asks of a multi-use link: Revoke closes it.
  const first = await joinTwo('Class', 0);
  await clickInWidget(page, { action: 'revoke', userId: first.ids[0] ?? '' });
  await waitForDock(page, (state) =>
    !state.invites.some((view) => view.inviteId === first.inviteId) &&
    !state.roster.some((entry) => entry.userId === first.ids[0])
      ? true
      : null,
  );

  /** The Watching section's "Revoke closes their link" box: where it is, and whether it is ticked. */
  const closeBox = async () =>
    (await widgetEvaluate(
      page,
      'watching',
      `function () {
        const input = this.querySelector('[data-action="close-link"]');
        input.scrollIntoView({ block: 'center' });
        const at = input.getBoundingClientRect();
        return { x: at.x + at.width / 2, y: at.y + at.height / 2, checked: input.checked };
      }`,
    )) as { x: number; y: number; checked: boolean };
  const untick = async () => {
    const box = await closeBox();
    expect(box.checked).toBe(true);
    await page.mouse.click(box.x, box.y);
    expect((await closeBox()).checked).toBe(false);
  };

  // Unticked, Revoke ends the one person only, and the link stays live.
  const second = await joinTwo('Class two', 2);
  await untick();
  await clickInWidget(page, { action: 'revoke', userId: second.ids[0] ?? '' });
  await waitForDock(page, (state) =>
    !state.roster.some((entry) => entry.userId === second.ids[0]) ? true : null,
  );
  expect((await dockState(page))?.invites.map((view) => view.inviteId)).toContain(second.inviteId);

  // That choice was for that Revoke alone: the box is ticked again, so the
  // next Revoke, on another link, closes its link as a full row's would.
  expect((await closeBox()).checked).toBe(true);
  const third = await joinTwo('Class three', 4);
  await clickInWidget(page, { action: 'revoke', userId: third.ids[0] ?? '' });
  await waitForDock(page, (state) =>
    !state.invites.some((view) => view.inviteId === third.inviteId) &&
    !state.roster.some((entry) => entry.userId === third.ids[0])
      ? true
      : null,
  );
  expect((await dockState(page))?.invites.map((view) => view.inviteId)).toContain(second.inviteId);

  // So is an untick the box outlived: hidden once no row's link is left to
  // close (Cancel closes the last), it comes back ticked with the next link.
  await untick();
  await clickInWidget(page, { action: 'cancel-invite', inviteId: second.inviteId });
  await waitForDock(page, (state) =>
    state.invites.some((view) => view.inviteId === second.inviteId) ? null : true,
  );
  await expect
    .poll(() =>
      widgetEvaluate(
        page,
        'watching',
        'function () { return this.querySelector(\'[data-action="close-link"]\').parentElement.hidden; }',
      ),
    )
    .toBe(true);
  await joinTwo('Class four', 6);
  expect((await closeBox()).checked).toBe(true);
});
