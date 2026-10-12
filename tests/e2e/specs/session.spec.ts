import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type BrowserContext, expect, test } from '@playwright/test';
import { startDemoServer, type DemoServer } from '@tabdock/demo/server';
import {
  type AuditLine,
  MAX_INVITE_LIFETIME_MS,
  MAX_LIVE_INVITES_PER_PAGE,
  MAX_SESSION_MS,
} from '@tabdock/protocol';
import { EMAIL_CLAIM, EMAIL_VERIFIED_CLAIM, readAuditLines } from '@tabdock/relay';
import { tunnelFetch } from '@tabdock/relay/test/tunnel';
import { OPERATOR_GRANTS_PER_PAGE } from '../../../packages/relay/src/hub.ts';
import {
  MOCK_SUBJECT,
  playTunnel,
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  type PublicTabdock,
  startPublicTabdock,
} from '../src/public-harness.ts';
import {
  fillSessionForm,
  memberEntry,
  openWithSessionRelay,
  pauseClock,
  sessionLinkInWidget,
  sessionRedemption,
  sidewaysScroll,
  startSessionInWidget,
} from '../src/session-helpers.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  mintInWidget,
  typeInWidget,
  waitForDock,
  waitForLink,
  widgetBoxText,
  widgetButtonCentre,
  widgetButtonNow,
  widgetEvaluate,
  widgetText,
  widgetVisible,
} from '../src/tabdock-harness.ts';

// Time-boxed sessions in the widget (ADR 0043; A6.16 and A6.17), on the real
// demo board: first against a scripted relay that applies the session frames
// as Tabdock's does, so a spec can stall it or move the page's clock; then a
// whole lesson on a real relay in public URL mode, a phone joining at /i by
// the session's link, ended with End and recorded on the audit log.

/** The widget's ARM_DELAY_MS. */
const ARM_DELAY_MS = 500;
/** The adapter's MINT_ANSWER_MS: how long a start waits for the relay's answer. */
const MINT_ANSWER_MS = 10_000;
const MINUTE = 60_000;
const GUEST = `g_${'1a2b3c4d'.repeat(4)}`;
const SESSION_LINK = /^https:\/\/relay\.example\/i#([A-Za-z0-9_-]{22})$/;

// A phone's width, and tall enough that the panel never scrolls: a box that
// scrolls into view has moved, and waits again before it takes a click.
test.use({ viewport: { width: 375, height: 1400 } });

let demo: DemoServer;
let pageErrors: string[];

test.beforeAll(async () => {
  demo = await startDemoServer({ e2eHook: true });
});
test.afterAll(async () => {
  await demo.close();
});
test.beforeEach(({ page }) => {
  pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(() => {
  expect(pageErrors).toEqual([]);
});

/** The session block's line read by its CSS selector, which no data-role names. */
async function sessionLine(page: Parameters<typeof widgetText>[0], selector: string) {
  return widgetEvaluate(
    page,
    'session',
    `function () { return this.querySelector(${JSON.stringify(selector)})?.textContent ?? null; }`,
  );
}

test('Start waits until the form holds still, then runs a session with its watch links, QR, countdown and Extend, 375 px wide', async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo, { query: 'invites=all' });
  expect((await dockState(page))?.policy).toMatchObject({ invites: 'all', maxDrivers: 2 });
  await fillSessionForm(page, { label: 'Class 7B', minutes: 45, drivers: 1, observers: 25 });
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
  // The form names the member whose invites the room joins by before Start grants anything.
  expect(await widgetText(page, 'session-effects')).toBe(
    "Invites shared by Alice, whose leaving ends guests' access. At its end 0 guests leave and 0 links close.",
  );
  await widgetButtonCentre(page, { action: 'session-start' });

  // A change to the seats makes Start mean something else, so it waits again.
  await pauseClock(page);
  await typeInWidget(page, 'session-observers', '24');
  const start = await widgetButtonNow(page, { action: 'session-start' });
  expect(start?.armed).toBe(false);
  await page.mouse.click(start?.x ?? 0, start?.y ?? 0);
  await page.clock.runFor(ARM_DELAY_MS - 100);
  expect(relay.framesOf('session_start')).toEqual([]);
  await page.clock.runFor(100);
  expect((await widgetButtonNow(page, { action: 'session-start' }))?.armed).toBe(true);
  await page.mouse.click(start?.x ?? 0, start?.y ?? 0);
  await expect
    .poll(() => relay.framesOf('session_start'))
    .toEqual([
      expect.objectContaining({
        lengthMs: 45 * MINUTE,
        policy: { maxDrivers: 1, proposals: 'off' },
      }),
    ]);
  await page.clock.resume();

  // One watch invite for every 20 observers, labelled as the session.
  const running = await waitForDock(page, (state) =>
    state.session?.inviteIds.length === 2 ? state.session : null,
  );
  expect(relay.framesOf('invite_create').map(({ label, uses }) => [label, uses])).toEqual([
    ['Class 7B', 20],
    ['Class 7B', 4],
  ]);
  expect(running).toMatchObject({ label: 'Class 7B', lengthMinutes: 45, observers: 24 });
  await expect.poll(() => widgetText(page, 'session-countdown')).toMatch(/^Ends in 4[45]:\d\d$/);
  const link = await sessionLinkInWidget(page);
  expect(link).toMatch(SESSION_LINK);
  expect(await sessionLine(page, '.qr path')).not.toBeNull();
  expect(await widgetButtonNow(page, { action: 'session-extend' })).not.toBeNull();
  expect(await widgetText(page, 'badge-session')).toMatch(/^4[45] min$/);
  // S11: the link's secret is shown and kept nowhere.
  const secret = SESSION_LINK.exec(link)?.[1] ?? 'no secret';
  const stored = await page.evaluate(() =>
    JSON.stringify(Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key))),
  );
  expect(stored).toContain('Class 7B');
  expect(stored).not.toContain(secret);

  // Nothing scrolls sideways at a phone's size, the QR on show.
  await page.setViewportSize({ width: 375, height: 667 });
  expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
});

test('the countdown warns at five minutes, and at its end on the page clock the guest leaves though the relay says nothing', async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo);
  await startSessionInWidget(page, { label: 'Lesson', minutes: 30, observers: 3 });
  const link = await sessionLinkInWidget(page);
  const [create] = relay.framesOf('invite_create');
  if (create === undefined) throw new Error('no invite_create');
  relay.send(
    sessionRedemption('join', create, link, { userId: GUEST, displayName: 'guest@example.com' }),
  );
  await expect
    .poll(() => relay.framesOf('attach_decision').at(-1))
    .toEqual({ t: 'attach_decision', requestId: 'join', allow: true, role: 'observer' });
  relay.send({
    t: 'roster',
    attachments: [
      memberEntry('alice', 'Alice'),
      {
        ...memberEntry(GUEST, 'guest@example.com', 'observer'),
        kind: 'invitee',
        inviteId: create.inviteId,
        endsAt: Date.now() + MAX_INVITE_LIFETIME_MS,
      },
    ],
  });
  await waitForDock(page, (state) => state.roster.length === 2);

  // From here the relay says six minutes are left, and then nothing more.
  relay.remainingMs = 6 * MINUTE;
  relay.send({
    t: 'session',
    session: {
      sessionId: relay.framesOf('session_start')[0]?.sessionId ?? '',
      lengthMs: 30 * MINUTE,
      remainingMs: 6 * MINUTE,
      policy: { maxDrivers: 1, proposals: 'off' },
    },
  });
  await expect.poll(() => widgetText(page, 'badge-session')).toBe('6 min');
  relay.silent = true;
  await page.clock.fastForward(MINUTE);
  await expect.poll(() => widgetText(page, 'session-countdown')).toMatch(/^Ends in (5:00|4:5\d)$/);
  await expect.poll(() => sessionLine(page, '[aria-live]')).toBe('5 min left.');

  await page.clock.fastForward(5 * MINUTE + 1000);
  const ended = await waitForDock(page, (state) => state.sessionEnded);
  expect(ended).toMatchObject({ label: 'Lesson', reason: 'time' });
  expect(await widgetText(page, 'session-ended')).toBe('Session "Lesson" ended (time).');
  expect(await widgetVisible(page, 'badge-session')).toBe(false);
  // The guest's grant went with it: the page refuses their call though the relay still lists them.
  relay.send({
    t: 'invoke',
    callId: 'after-end',
    tool: 'get_view',
    arguments: {},
    caller: { userId: GUEST, displayName: 'guest@example.com', client: null, role: 'observer' },
    deadlineMs: 45_000,
  });
  await expect
    .poll(() => relay.framesOf('result').find((frame) => frame.callId === 'after-end')?.error?.code)
    .toBe('role_denied');
  // The relay hears of the page's own end only after the grace its own end is given.
  expect(relay.framesOf('session_end')).toEqual([]);
  await page.clock.fastForward(5000);
  await expect.poll(() => relay.framesOf('session_end')).toHaveLength(1);
});

test("a Can control prompt during a session counts the session's driver seats, not attach()'s", async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo, { query: 'invites=all' });
  // Two seats on the board, one in the session, and Alice already drives.
  await startSessionInWidget(page, { label: 'Seats', minutes: 30, drivers: 1 });
  const control = await mintInWidget(page, { label: 'Help', role: 'driver' });
  relay.send(
    sessionRedemption('seats', { inviteId: control.inviteId, label: 'Help' }, control.link, {
      userId: GUEST,
      displayName: 'guest@example.com',
    }),
  );
  await waitForDock(page, (state) => state.pendingRequests.length === 1);
  expect(await widgetBoxText(page, { requestId: 'seats' })).toContain(
    'The driver seats are full, so they join as observer for now.',
  );
});

test('Extend lengthens it through the relay, and End asks once before the room leaves', async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo);
  await startSessionInWidget(page, { label: 'Review', minutes: 30 });
  await clickInWidget(page, { action: 'session-extend' });
  await expect
    .poll(() => relay.framesOf('session_extend').map((frame) => frame.lengthMs))
    .toEqual([45 * MINUTE]);
  await waitForDock(page, (state) => state.session?.lengthMinutes === 45);

  await clickInWidget(page, { action: 'session-end' });
  expect(await sessionLine(page, '.buttons span')).toBe('End now? 0 guests leave. ');
  await clickInWidget(page, { action: 'session-end-no' });
  expect(await widgetButtonNow(page, { action: 'session-end-yes' })).toBeNull();
  expect(relay.framesOf('session_end')).toEqual([]);
  await clickInWidget(page, { action: 'session-end' });
  await clickInWidget(page, { action: 'session-end-yes' });
  await expect.poll(() => relay.framesOf('session_end')).toHaveLength(1);
  expect(await waitForDock(page, (state) => state.sessionEnded)).toMatchObject({
    label: 'Review',
    reason: 'operator',
  });
  // Four hours from its start at most: a session of 240 minutes offers no Extend.
  await startSessionInWidget(page, { label: 'Long', minutes: MAX_SESSION_MS / MINUTE });
  await expect
    .poll(async () =>
      widgetEvaluate(
        page,
        'session',
        `function () { return this.querySelector('[data-action="session-extend"]').disabled; }`,
      ),
    )
    .toBe(true);
});

// A refused start once showed only its code, "The session did not start
// (invalid).", which told a teacher with 41 students nothing of the relay's
// 40 watching seats; each reason now has a sentence (ADR 0049, decision 4).

test('a refused Start says why in a sentence of its own, never a bare code', async ({ page }) => {
  const relay = await openWithSessionRelay(page, demo, { query: 'invites=all' });
  // One past the 40 watching seats this relay's welcome names: refused on the page, unsent.
  await fillSessionForm(page, { label: 'Year 9', minutes: 45, observers: 41 });
  await clickInWidget(page, { action: 'session-start' });
  await expect
    .poll(() => widgetText(page, 'session-reason'))
    .toBe(
      'This relay seats at most 40 observers on a page; its owner sets its watching seats with TABDOCK_MAX_OBSERVERS_PER_PAGE.',
    );
  expect(relay.framesOf('session_start')).toEqual([]);

  // No driver seat, a whole number yet below the 1 a session needs: refused on the page, unsent.
  await typeInWidget(page, 'session-observers', '0');
  await typeInWidget(page, 'session-drivers', '0');
  await clickInWidget(page, { action: 'session-start' });
  await expect
    .poll(() => widgetText(page, 'session-reason'))
    .toBe(
      'Give it a label, a length of 30 to 240 whole minutes, at least 1 driver seat and whole numbers of seats.',
    );
  expect(relay.framesOf('session_start')).toEqual([]);
  await typeInWidget(page, 'session-drivers', '1');

  // What the relay refuses, each in its own words, with the session the relay
  // lists beside the refusal as Tabdock's relay sends it.
  relay.silent = true;
  // An earlier session the relay still holds, which the page has no record of.
  const earlier = {
    sessionId: 'ses_earlier',
    lengthMs: 30 * 60_000,
    remainingMs: 20 * 60_000,
    policy: { maxDrivers: 1, proposals: 'off' },
  } as const;
  const refusals = [
    [
      'policy',
      null,
      "A session only narrows this page's policy: no more driver seats or wider proposals than it allows, and observers only where it makes invites.",
    ],
    // The form hides while this page runs a session, so the widget's `active`
    // is always the relay's, and the page ends that session as it refuses.
    [
      'active',
      earlier,
      'The relay still held an earlier session for this page, which this page has now ended. Start again.',
    ],
    [
      'limit',
      null,
      `This page is at a limit: ${String(MAX_LIVE_INVITES_PER_PAGE)} live invites, counting the links this session needs, or ${String(OPERATOR_GRANTS_PER_PAGE)} grants a minute at the relay (promotions, invites, agent tokens, session starts and extensions). Cancel an invite or wait a minute.`,
    ],
  ] as const;
  for (const [index, [reason, listed, words]] of refusals.entries()) {
    await clickInWidget(page, { action: 'session-start' });
    await expect.poll(() => relay.framesOf('session_start')).toHaveLength(index + 1);
    const sessionId = relay.framesOf('session_start')[index]?.sessionId ?? '';
    relay.send({ t: 'session', session: listed, refused: { sessionId, reason } });
    await expect.poll(() => widgetText(page, 'session-reason')).toBe(words);
    // The start the page held closed the form; a refusal opens it again, so the words show.
    expect(await widgetVisible(page, 'session-reason')).toBe(true);
  }
  // What the `active` words say happened did: the page asked the relay to end its earlier one.
  expect(relay.framesOf('session_end')).toEqual([{ t: 'session_end', sessionId: 'ses_earlier' }]);

  // A relay that never answers: the start gives up as unavailable.
  await clickInWidget(page, { action: 'session-start' });
  await expect.poll(() => relay.framesOf('session_start')).toHaveLength(refusals.length + 1);
  await page.clock.runFor(MINT_ANSWER_MS);
  await expect
    .poll(() => widgetText(page, 'session-reason'))
    .toBe(
      'The relay did not answer in time, or this page cannot make invite links (they need https). Try again.',
    );
  expect(await widgetVisible(page, 'session-reason')).toBe(true);
  expect(await dockState(page)).toMatchObject({ session: null });
});

/** Whether the line beside New link shows, read by its words, since it carries no data-role. */
async function renewNoteShown(page: Parameters<typeof widgetText>[0]) {
  return widgetEvaluate(
    page,
    'session',
    `function () {
      const note = [...this.querySelectorAll('p')].find(
        (line) => line.textContent === "New link closes the session's earlier links.",
      );
      return note === undefined ? null : note.getClientRects().length > 0;
    }`,
  );
}

test('New link says it closes the earlier links, and does, once no link has uses left', async ({
  page,
}) => {
  const relay = await openWithSessionRelay(page, demo);
  await startSessionInWidget(page, { label: 'Lab', minutes: 30, observers: 3 });
  const [first] = relay.framesOf('invite_create');
  if (first === undefined) throw new Error('no invite_create');
  // A link with uses left shows its QR, and neither New link nor its line.
  expect(await widgetButtonNow(page, { action: 'session-renew' })).toBeNull();
  expect(await renewNoteShown(page)).toBe(false);

  // Its uses spent, as after a reload would leave none shown: New link, with its warning.
  const spent = relay.listings.get(first.inviteId);
  if (spent === undefined) throw new Error('the invite is not listed');
  relay.listings.set(first.inviteId, { ...spent, usesLeft: 0 });
  relay.list();
  await expect.poll(() => renewNoteShown(page)).toBe(true);

  // What it says is what it does: the earlier link closes before the new one is minted.
  await clickInWidget(page, { action: 'session-renew' });
  await expect.poll(() => relay.framesOf('invite_create')).toHaveLength(2);
  expect(relay.framesOf('invite_cancel').map((frame) => frame.inviteId)).toEqual([first.inviteId]);
  await expect.poll(() => renewNoteShown(page)).toBe(false);
});

// A lesson on a real relay: the member's own Claude drives, the session's
// link is opened at /i on a phone by an account the relay does not list, and
// End takes the guest and the link away, all on the audit log.

const BOB = { sub: 'sub-bob-lesson', email: 'bob@example.com' };
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const PUBLIC_LINK = /^https:\/\/relay\.test\/i#([A-Za-z0-9_-]{22})$/;

test.describe('on a real relay', () => {
  // The operator's laptop: tall enough that the panel never scrolls.
  test.use({ viewport: { width: 1280, height: 1200 } });

  let tabdock: PublicTabdock | undefined;
  let scratch: string;
  const clients: Client[] = [];
  const contexts: BrowserContext[] = [];

  test.beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'tabdock-e2e-session-'));
  });
  test.afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    for (const context of contexts.splice(0)) await context.close();
    await tabdock?.close();
    tabdock = undefined;
    rmSync(scratch, { recursive: true, force: true });
  });

  async function claudeAs(live: PublicTabdock, sub: string, email: string | null): Promise<Client> {
    const token = await live.provider.token({
      sub,
      aud: PUBLIC_MCP_URL,
      ...(email === null ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
    });
    const client = new Client({ name: `claude-${sub}`, version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
        authProvider: { token: () => Promise.resolve(token) },
        fetch: tunnelFetch(live.relay.url),
      }),
    );
    clients.push(client);
    return client;
  }

  test('a phone joins by the session link at /i, and End detaches it and closes the link, on the audit log', async ({
    page,
    browser,
  }) => {
    test.setTimeout(120_000);
    const auditDir = join(scratch, 'audit');
    tabdock = await startPublicTabdock({ invites: true, auditDir });
    const live = tabdock;
    await page.goto(live.pageUrl);
    const { pageId, code } = await waitForLink(page);
    await waitForDock(page, (state) => state.sessionsOffered);

    // Alice, a member, pairs by code as driver: she sponsors the session's invites.
    const alice = await claudeAs(live, MOCK_SUBJECT, null);
    const pairing = callTool(alice, 'pair_page', { code });
    const asks = await waitForDock(page, (state) => state.pendingRequests[0]);
    await clickInWidget(page, { action: 'approve-driver', requestId: asks.requestId });
    expect((await pairing).isError).toBe(false);
    await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);

    await startSessionInWidget(page, { label: 'Lesson', minutes: 30, observers: 5 });
    const link = await sessionLinkInWidget(page);
    expect(link).toMatch(PUBLIC_LINK);
    expect(await widgetText(page, 'session-sponsor')).toBe('Invites shared by Alice');

    // Bob opens it on his phone, signs in as an account the relay does not list, and joins.
    const phoneContext = await browser.newContext(PHONE);
    contexts.push(phoneContext);
    await playTunnel(phoneContext, live, []);
    const phone = await phoneContext.newPage();
    await phone.goto(link);
    await expect.poll(() => phone.url()).toBe(`${PUBLIC_ORIGIN}/i`);
    await expect(phone.locator('#label')).toHaveText('Lesson');
    live.provider.signInSubject = BOB.sub;
    live.provider.idTokenClaims = { email: BOB.email, email_verified: true };
    try {
      await phone.locator('#signin').tap();
      await expect(phone.locator('#account')).toHaveText(`Signed in as ${BOB.email}.`);
    } finally {
      live.provider.signInSubject = null;
      live.provider.idTokenClaims = null;
    }
    await phone.locator('#join').tap();
    await expect(phone.locator('#message')).toHaveText('Joined as observer.');
    const bobEntry = await waitForDock(page, (state) =>
      state.roster.find((entry) => entry.displayName === BOB.email),
    );
    const session = (await dockState(page))?.session;
    // Its end is capped at the session's, on the relay's clock.
    expect(bobEntry.endsAt).toBeLessThanOrEqual(Date.now() + 30 * MINUTE + 1000);
    expect(session?.inviteIds).toContain(bobEntry.inviteId);
    const bob = await claudeAs(live, BOB.sub, BOB.email);
    const read = await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_view' });
    expect(read.isError, read.text).toBe(false);

    // End, with the confirm, as the operator does.
    await clickInWidget(page, { action: 'session-end' });
    await clickInWidget(page, { action: 'session-end-yes' });
    await waitForDock(page, (state) => state.session === null && state.roster.length === 1);
    expect(
      errorCode(await callTool(bob, 'call_page_tool', { page: pageId, tool: 'get_view' })),
    ).toBe('not_attached');
    // Alice, a member, keeps the page.
    const kept = await callTool(alice, 'call_page_tool', { page: pageId, tool: 'get_view' });
    expect(kept.isError, kept.text).toBe(false);
    const after = await phoneContext.newPage();
    await after.goto(link);
    await expect(after.locator('#message')).toHaveText(
      'This invite is used up, closed or expired. Ask the person who shared it for a new one.',
    );
    expect(pageErrors).toEqual([]);

    // The audit log on disk, after a clean stop.
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await live.close();
    tabdock = undefined;
    const records = [...readAuditLines(auditDir)]
      .map((line) => line.record)
      .filter((record) => record !== null);
    const ofType = <T extends AuditLine['type']>(type: T) =>
      records.filter((record): record is Extract<AuditLine, { type: T }> => record.type === type);
    expect(ofType('session_start')).toEqual([
      expect.objectContaining({ pageId, lengthMs: 30 * MINUTE, maxDrivers: 1, demoted: 0 }),
    ]);
    expect(ofType('session_end')).toEqual([
      expect.objectContaining({ pageId, reason: 'operator', attachments: 1, invites: 1 }),
    ]);
    expect(ofType('expire')).toEqual([
      expect.objectContaining({ userId: bobEntry.userId, reason: 'session_ended' }),
    ]);
    expect(ofType('invite_closed').map((record) => record.reason)).toEqual(['session_ended']);
    // Never the session's label, which is the page's own text (S10).
    expect(JSON.stringify(records)).not.toContain('Lesson');
  });
});
