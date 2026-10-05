import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { type AuditLine, InviteeIdSchema } from '@tabdock/protocol';
import { EMAIL_CLAIM, EMAIL_VERIFIED_CLAIM, listAuditFiles, readAuditLines } from '@tabdock/relay';
import { PAIR_CLIENT } from '@tabdock/relay/test/provider';
import { tunnelFetch } from '@tabdock/relay/test/tunnel';
import { blankEnv, runPnpm } from '../src/local-harness.ts';
import {
  MOCK_SUBJECT,
  playTunnel,
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  startPublicTabdock,
  type PublicTabdock,
} from '../src/public-harness.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  mintInWidget,
  waitForDock,
  waitForLink,
  widgetBoxText,
  widgetItems,
  widgetText,
} from '../src/tabdock-harness.ts';

// M4's invite journey end to end (ADRs 0016, 0017 and 0019), in public URL
// mode against the stand-in provider and through the https stand-in tunnel:
// the operator's demo board, opened with ?invites=all, mints a Can watch link
// with real clicks in its widget; a second account opens it at /i on a
// phone-sized page, signs in, joins without a prompt, and from Claude reads
// the board and is refused a write. A Can control link, redeemed through
// pair_page by a third account, raises a prompt naming that account, is
// approved with a click, and writes. Revoke all ends both and closes the
// links, and the audit log on disk records the whole journey, chain intact,
// as `pnpm audit:log --verify` says. No secret it saw reaches a log.

const BOB = { sub: 'sub-bob-journey', email: 'bob@example.com' };
const CAROL = { sub: 'sub-carol-journey', email: 'carol@example.com' };
/** Page-written labels: the audit log never holds them (ADR 0019). */
const WATCH_LABEL = 'Watch the board';
const CONTROL_LABEL = 'Drive with me';
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const INVITE_LINK = /^https:\/\/relay\.test\/i#([A-Za-z0-9_-]{22})$/;

// The operator's laptop: tall enough that the panel never scrolls, since a
// prompt that scrolls into view has moved, and a moved box ignores the next
// click until it holds still again, as it should.
test.use({ viewport: { width: 1280, height: 1200 } });

let tabdock: PublicTabdock | undefined;
let scratch: string;
let relayLogs: string[];
const clients: Client[] = [];
const contexts: BrowserContext[] = [];

test.beforeEach(() => {
  relayLogs = [];
  scratch = mkdtempSync(join(tmpdir(), 'tabdock-e2e-journey-'));
});
test.afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const context of contexts.splice(0)) await context.close();
  await tabdock?.close();
  tabdock = undefined;
  rmSync(scratch, { recursive: true, force: true });
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Claude on an account: an MCP client through the stand-in tunnel, with ADR 0020's email claims. */
async function claudeAs(
  live: PublicTabdock,
  name: string,
  sub: string,
  email: string | null,
  tokens: string[],
): Promise<Client> {
  const token = await live.provider.token({
    sub,
    aud: PUBLIC_MCP_URL,
    ...(email === null ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
  });
  tokens.push(token);
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: tunnelFetch(live.relay.url),
    }),
  );
  clients.push(client);
  return client;
}

/** The board's view and a write, as a client on that page. */
function onPage(client: Client, pageId: string, tool: string, args: Record<string, unknown> = {}) {
  return callTool(client, 'call_page_tool', { page: pageId, tool, arguments: args });
}

async function rosterIds(page: Page): Promise<string[]> {
  return ((await dockState(page))?.roster ?? []).map((entry) => entry.userId);
}

test('a watch invite and a control invite from the widget, joined at /i and through pair_page, end with Revoke all, all on the audit log', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const auditDir = join(scratch, 'audit');
  tabdock = await startPublicTabdock({
    invites: true,
    auditDir,
    logSink: (line) => {
      relayLogs.push(line);
    },
  });
  const live = tabdock;
  const tokens: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  // The operator's board, offering Can control as well as Can watch, with two driver seats.
  const boardUrl = new URL(live.pageUrl);
  boardUrl.searchParams.set('invites', 'all');
  await page.goto(boardUrl.href);
  const { pageId, code } = await waitForLink(page);
  expect((await dockState(page))?.policy).toMatchObject({ invites: 'all', maxDrivers: 2 });

  // A member must be attached to sponsor an invite: Alice pairs by code as driver.
  const alice = await claudeAs(live, 'claude-alice', MOCK_SUBJECT, null, tokens);
  const alicePairing = callTool(alice, 'pair_page', { code });
  const aliceAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'alice'),
  );
  await clickInWidget(page, { action: 'approve-driver', requestId: aliceAsks.requestId });
  expect((await alicePairing).isError).toBe(false);
  await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);

  // 1. Can watch, two uses, minted with the widget's form.
  const watch = await mintInWidget(page, { label: WATCH_LABEL, role: 'observer', uses: 2 });
  const watchSecret = INVITE_LINK.exec(watch.link)?.[1] ?? '';
  expect(watchSecret).toHaveLength(22);
  const watchRow = (await widgetItems(page, 'invite-list')).find(
    (row) => row.data.inviteId === watch.inviteId,
  );
  expect(watchRow?.text).toContain(`"${WATCH_LABEL}", Can watch`);
  expect(watchRow?.text).toContain('shared by Alice');

  // 2. Bob opens the link on his phone: the secret leaves the address bar at once.
  const phoneContext = await browser.newContext(PHONE);
  contexts.push(phoneContext);
  const requested: string[] = [];
  await playTunnel(phoneContext, live, requested);
  const phone = await phoneContext.newPage();
  const phoneErrors: string[] = [];
  phone.on('pageerror', (error) => phoneErrors.push(error.message));
  await phone.goto(watch.link);
  await expect.poll(() => phone.url()).toBe(`${PUBLIC_ORIGIN}/i`);
  await expect(phone.locator('#message')).toHaveText('Sign in to join this page.');
  await expect(phone.locator('#sponsor')).toHaveText('Alice');
  await expect(phone.locator('#origin')).toHaveText(new URL(live.demo.url).origin);
  await expect(phone.locator('#title')).toHaveText('Tabdock demo board');
  await expect(phone.locator('#label')).toHaveText(WATCH_LABEL);
  await expect(phone.locator('#role')).toHaveText('watch it: read only, as an observer');
  await expect(phone.locator('#join')).toBeHidden();

  // He signs in at the provider as an account the relay does not list, with a verified email.
  live.provider.signInSubject = BOB.sub;
  live.provider.idTokenClaims = { email: BOB.email, email_verified: true };
  try {
    await phone.locator('#signin').tap();
    await expect(phone.locator('#account')).toHaveText(`Signed in as ${BOB.email}.`);
  } finally {
    live.provider.signInSubject = null;
    live.provider.idTokenClaims = null;
  }
  expect(phone.url()).toBe(`${PUBLIC_ORIGIN}/i`);
  expect((await dockState(page))?.pendingRequests).toEqual([]);

  // Join: a watch invite is approval given in advance, so no prompt, and a notice on the page.
  await phone.locator('#join').tap();
  await expect(phone.locator('#message')).toHaveText('Joined as observer.');
  await expect(phone.locator('#connector')).toHaveText(PUBLIC_MCP_URL);
  const bobEntry = await waitForDock(page, (state) =>
    state.roster.find((entry) => entry.displayName === BOB.email),
  );
  expect(InviteeIdSchema.safeParse(bobEntry.userId).success).toBe(true);
  expect(bobEntry).toMatchObject({
    kind: 'invitee',
    role: 'observer',
    inviteId: watch.inviteId,
  });
  const bobShort = bobEntry.userId.slice(2, 10);
  await expect
    .poll(() => widgetText(page, 'joins'))
    .toContain(`${BOB.email} (${bobShort}) joined by your invite "${WATCH_LABEL}" as observer`);
  const bobRow = await widgetBoxText(page, { userId: bobEntry.userId });
  expect(bobRow).toContain(`${BOB.email} (${bobShort})`);
  expect(bobRow).toContain('invited');

  // Bob's Claude, signed in as the same account, reads the board and is refused a write.
  const bob = await claudeAs(live, 'claude-bob', BOB.sub, BOB.email, tokens);
  const bobPages = await callTool(bob, 'list_pages');
  expect(bobPages.structured).toMatchObject({ pages: [{ page: pageId, role: 'observer' }] });
  const bobRead = await onPage(bob, pageId, 'get_view');
  expect(bobRead.isError, bobRead.text).toBe(false);
  expect(bobRead.text.split('\n', 1)[0]).toMatch(/^\[tabdock: untrusted content from /);
  const bobWrite = await onPage(bob, pageId, 'add_item', { label: 'Bob was here', x: 0, y: 0 });
  expect(errorCode(bobWrite)).toBe('role_denied');

  // 3. Can control, minted with the form; Carol redeems it through pair_page.
  const control = await mintInWidget(page, { label: CONTROL_LABEL, role: 'driver' });
  const controlSecret = INVITE_LINK.exec(control.link)?.[1] ?? '';
  expect(controlSecret).toHaveLength(22);
  const carol = await claudeAs(live, 'claude-carol', CAROL.sub, CAROL.email, tokens);
  const carolPairing = callTool(carol, 'pair_page', { invite: control.link });
  const carolAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.via === 'invite'),
  );
  expect(carolAsks).toMatchObject({
    user: { displayName: CAROL.email },
    account: { kind: 'invitee', verified: true },
    invite: { inviteId: control.inviteId, label: CONTROL_LABEL },
  });
  // The prompt names the account, with its short id, beside the page's own label.
  const carolShort = carolAsks.user.userId.slice(2, 10);
  const prompt = await widgetBoxText(page, { requestId: carolAsks.requestId });
  expect(prompt).toContain(
    `${CAROL.email} (${carolShort}) wants to join by your invite "${CONTROL_LABEL}"`,
  );
  expect(prompt).toContain('invited');
  await clickInWidget(page, { action: 'approve-driver', requestId: carolAsks.requestId });
  const carolOutcome = await carolPairing;
  expect(carolOutcome.isError, carolOutcome.text).toBe(false);
  expect(carolOutcome.structured).toMatchObject({
    page: pageId,
    role: 'driver',
    sponsor: 'Alice',
  });
  const carolWrite = await onPage(carol, pageId, 'add_item', {
    label: 'Carol was here',
    x: 40,
    y: 40,
  });
  expect(carolWrite.isError, carolWrite.text).toBe(false);
  await expect
    .poll(async () => (await dockState(page))?.activity[0])
    .toMatchObject({ tool: 'add_item', outcome: 'ok', user: { userId: carolAsks.user.userId } });

  // The watch link is still live, with a use left: a fresh tab previews it.
  const before = await phoneContext.newPage();
  await before.goto(watch.link);
  await expect(before.locator('#message')).toHaveText(
    'Check who shared it and where it leads, then join.',
  );
  await before.close();

  // 4. Revoke all: every attachment ends, and so does every live invite.
  expect(await rosterIds(page)).toHaveLength(3);
  await clickInWidget(page, { action: 'revoke-all' });
  await waitForDock(page, (state) => state.roster.length === 0 && state.invites.length === 0);
  await expect.poll(() => widgetItems(page, 'invite-list')).toEqual([]);
  expect(errorCode(await onPage(bob, pageId, 'get_view'))).toBe('not_attached');
  expect(errorCode(await onPage(carol, pageId, 'add_item', { label: 'again', x: 0, y: 0 }))).toBe(
    'not_attached',
  );
  expect((await callTool(bob, 'list_pages')).structured).toMatchObject({ pages: [] });

  // The links stop working: the watch link at /i, the control link through pair_page.
  const after = await phoneContext.newPage();
  await after.goto(watch.link);
  await expect(after.locator('#message')).toHaveText(
    'This invite is used up, closed or expired. Ask the person who shared it for a new one.',
  );
  await expect(after.locator('#join')).toBeHidden();
  await after.close();
  const reused = await callTool(carol, 'pair_page', { invite: control.link });
  expect(errorCode(reused)).toBe('pairing_expired');

  // The secrets went nowhere but the fragment and the pages' own POST bodies.
  for (const url of requested) {
    expect(url).not.toContain(watchSecret);
    expect(url).not.toContain(controlSecret);
  }
  expect(phoneErrors).toEqual([]);
  for (const cookie of await phoneContext.cookies(PUBLIC_ORIGIN)) tokens.push(cookie.value);
  expect(pageErrors).toEqual([]);

  // 5. The audit log on disk, after a clean stop.
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await live.close();
  tabdock = undefined;
  const lines = [...readAuditLines(auditDir)];
  const records = lines.map((line) => line.record).filter((record) => record !== null);
  expect(records).toHaveLength(lines.length);
  const ofType = <T extends AuditLine['type']>(type: T) =>
    records.filter((record): record is Extract<AuditLine, { type: T }> => record.type === type);
  expect(records[0]?.type).toBe('relay_start');
  expect(records.at(-1)?.type).toBe('relay_stop');
  expect(ofType('relay_start')[0]).toMatchObject({ mode: 'public', invites: true });
  expect(ofType('invite_minted')).toEqual([
    expect.objectContaining({
      inviteId: watch.inviteId,
      role: 'observer',
      uses: 2,
      sponsor: 'alice',
    }),
    expect.objectContaining({
      inviteId: control.inviteId,
      role: 'driver',
      uses: 1,
      sponsor: 'alice',
    }),
  ]);
  const attaches = ofType('attach');
  expect(attaches.map((record) => [record.via, record.role, record.kind])).toEqual([
    ['code', 'driver', 'member'],
    ['invite', 'observer', 'invitee'],
    ['invite', 'driver', 'invitee'],
  ]);
  // An invitee's email lives only in its attach record.
  expect(attaches[1]).toMatchObject({ inviteId: watch.inviteId, email: BOB.email });
  expect(attaches[2]).toMatchObject({ inviteId: control.inviteId, email: CAROL.email });
  expect(attaches[0]?.email).toBeUndefined();
  expect(ofType('invite_redeemed').map((record) => [record.inviteId, record.usesLeft])).toEqual([
    [watch.inviteId, 1],
    [control.inviteId, 0],
  ]);
  const calls = ofType('call').map((record) => [record.userId, record.tool, record.outcome]);
  const bobId = attaches[1]?.userId ?? '';
  const carolId = attaches[2]?.userId ?? '';
  expect(calls).toEqual([
    [bobId, 'get_view', 'ok'],
    [bobId, 'add_item', 'role_denied'],
    [carolId, 'add_item', 'ok'],
    [bobId, 'get_view', 'not_attached'],
    [carolId, 'add_item', 'not_attached'],
  ]);
  // Revoke all: one line per attachment it ended, in the order they were made.
  expect(ofType('revoke').map((record) => [record.userId, record.everyone])).toEqual([
    ['alice', true],
    [bobId, true],
    [carolId, true],
  ]);
  expect(ofType('invite_closed').map((record) => [record.inviteId, record.reason])).toEqual([
    [control.inviteId, 'used_up'],
    [watch.inviteId, 'revoked'],
  ]);
  expect(ofType('attach_refused')).toEqual([
    expect.objectContaining({ userId: carolId, via: 'invite', outcome: 'pairing_expired' }),
  ]);

  // pnpm audit:log --verify, as the operator runs it, finds the chain intact.
  const verify = runPnpm(['audit:log', '--verify'], { ...blankEnv(), TABDOCK_AUDIT_DIR: auditDir });
  expect(await verify.exited).toBe(0);
  expect(verify.stderr()).toMatch(
    new RegExp(`verify: chain intact; ${String(records.length)} records in 1 files`),
  );

  // S11 and ADR 0019: no secret, hash, token, cookie or subject in any log or audit file,
  // no email on stderr, and no page-written label in the audit file.
  const fileText = listAuditFiles(auditDir)
    .map((file) => readFileSync(join(auditDir, file.name), 'utf8'))
    .join('\n');
  const logged = relayLogs.join('\n');
  const secrets = [
    watchSecret,
    controlSecret,
    sha256Hex(watchSecret),
    sha256Hex(controlSecret),
    code,
    PAIR_CLIENT.clientSecret,
    MOCK_SUBJECT,
    BOB.sub,
    CAROL.sub,
    ...tokens,
    ...live.provider.issuedTokens,
  ];
  for (const secret of secrets) {
    expect(logged.includes(secret), 'a secret reached the relay log').toBe(false);
    expect(fileText.includes(secret), 'a secret reached the audit file').toBe(false);
    expect(verify.stdout().includes(secret) || verify.stderr().includes(secret)).toBe(false);
  }
  expect(logged).not.toContain(BOB.email);
  expect(logged).not.toContain(CAROL.email);
  expect(fileText).not.toContain(WATCH_LABEL);
  expect(fileText).not.toContain(CONTROL_LABEL);
});
