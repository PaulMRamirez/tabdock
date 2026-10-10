// pnpm demo:m4: local mode, then invites, narrated, entirely on this machine.
//   --headed   watch the boards and the phone in visible browsers
// Part one runs `pnpm dev` as the owner does on a clean clone, in local mode
// with a throwaway TABDOCK_HOME: the relay draws its owner token into a
// private file, and an MCP client reads that file as the printed Claude Code
// line does, pairs with the demo board and calls a tool (ADR 0022). Part two
// runs public URL mode with invites on and an audit directory, against the
// stand-in provider through the stand-in tunnel, as demo:m3 does: the board,
// opened with ?invites=all, mints a Can watch link and a Can control link
// with real clicks in its widget; Bob joins by the first at /i on a phone,
// reads and is refused a write; Carol redeems the second through pair_page,
// the operator approves her, and she writes; Revoke all ends both and closes
// the links; and `pnpm audit:log --verify` checks the record of it all
// (ADRs 0016, 0017 and 0019). It never prints a token, a code, an invite
// secret or its hash, a cookie or a subject: links appear masked, and every
// line is checked against the secrets seen so far before it is printed (S11).

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, Page } from '@playwright/test';
import { type AuditLine, AuditLineSchema } from '@tabdock/protocol';
import { EMAIL_CLAIM, EMAIL_VERIFIED_CLAIM, listAuditFiles } from '@tabdock/relay';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { PAIR_CLIENT } from '@tabdock/relay/test/provider';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { tunnelFetch } from '@tabdock/relay/test/tunnel';
import { launchChromium } from './harness.ts';
import { blankEnv, readBanner, type Run, runPnpm } from './local-harness.ts';
import {
  MOCK_SUBJECT,
  playTunnel,
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  type PublicTabdock,
  startPublicTabdock,
} from './public-harness.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  maskCode,
  mintInWidget,
  type ToolOutcome,
  waitForDock,
  waitForLink,
  widgetBoxText,
  widgetItems,
  widgetText,
} from './tabdock-harness.ts';

const headed = process.argv.includes('--headed');
const BOB = { sub: 'sub-bob-demo', email: 'bob@example.com' };
const CAROL = { sub: 'sub-carol-demo', email: 'carol@example.com' };
const WATCH_LABEL = 'Watch the board';
const CONTROL_LABEL = 'Drive with me';
const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
// Tall enough that the widget's panel never scrolls a prompt out from under the pointer.
const LAPTOP = { viewport: { width: 1280, height: 1200 } };

/** Everything that must never be printed: tokens, codes, invite secrets and hashes, cookies, subjects. */
const secrets = new Set<string>([PAIR_CLIENT.clientSecret, MOCK_SUBJECT, BOB.sub, CAROL.sub]);
/** Local mode's owner token, scanned for in every form leakIn knows. */
let ownerToken: string | null = null;
let tabdock: PublicTabdock | undefined;
let unexpected = 0;

function remember(secret: string | null | undefined): void {
  if (secret !== null && secret !== undefined && secret.length >= 6) secrets.add(secret);
}

/** An invite secret and the digest the relay keeps of it: neither may be printed. */
function rememberInvite(link: string): void {
  const secret = link.split('#')[1] ?? '';
  remember(secret);
  remember(createHash('sha256').update(secret, 'utf8').digest('hex'));
}

/** Prints a line, unless it would print a secret: then the secret is hidden and the run fails. */
function say(text: string): void {
  let line = text;
  for (const secret of [...secrets, ...(tabdock?.provider.issuedTokens ?? [])]) {
    if (secret.length > 0 && line.includes(secret)) {
      line = line.split(secret).join('[hidden]');
      unexpected += 1;
      console.log('   UNEXPECTED: a secret was about to be printed, and was hidden');
    }
  }
  if (ownerToken !== null && leakIn(line, ownerToken) !== null) {
    line = '[a line holding part of the owner token, hidden]';
    unexpected += 1;
    console.log('   UNEXPECTED: part of the owner token was about to be printed, and was hidden');
  }
  console.log(line);
}

/** Counts a step that did not behave as the narration says it should. */
function check(ok: boolean, what: string): void {
  if (ok) return;
  unexpected += 1;
  say(`   UNEXPECTED: ${what}`);
}

function report(label: string, outcome: ToolOutcome, expected: string): void {
  const firstLine = outcome.text.split('\n', 1)[0] ?? '';
  if (outcome.isError) say(`   error   ${outcome.text.slice(0, 200)}`);
  else if (firstLine.startsWith('[tabdock: untrusted')) {
    say(`   header  ${firstLine}`);
    say(`   result  ${outcome.text.slice(firstLine.length + 1, firstLine.length + 141)}`);
  } else say(`   result  ${outcome.text.slice(0, 200)}`);
  const got = outcome.isError ? (errorCode(outcome) ?? 'error') : 'ok';
  check(got === expected, `${label}: expected ${expected}, got ${got}`);
}

/** A link with its secret hidden: what the QR code says, minus the part that is a secret. */
function maskLink(url: string): string {
  const split = url.indexOf('#');
  return split === -1 ? url : `${url.slice(0, split + 1)}${'*'.repeat(url.length - split - 1)}`;
}

/** An MCP client on a relay's MCP URL, carrying a bearer token. */
async function bearerClient(
  url: string,
  name: string,
  token: string,
  fetch?: ReturnType<typeof tunnelFetch>,
): Promise<Client> {
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      ...(fetch === undefined ? {} : { fetch }),
    }),
  );
  return client;
}

/** Claude on an account in public URL mode, with ADR 0020's email claims when it has an email. */
async function claudeAs(
  live: PublicTabdock,
  name: string,
  sub: string,
  email: string | null,
): Promise<Client> {
  const token = await live.provider.token({
    sub,
    aud: PUBLIC_MCP_URL,
    ...(email === null ? {} : { [EMAIL_CLAIM]: email, [EMAIL_VERIFIED_CLAIM]: true }),
  });
  remember(token);
  return bearerClient(PUBLIC_MCP_URL, name, token, tunnelFetch(live.relay.url));
}

/** An account as the narration names it: a member by id, an invitee by its short id. */
function who(userId: string): string {
  return userId.startsWith('g_') ? `invitee ${userId.slice(2, 10)}` : userId;
}

/** One audit record in a line, from the reader's --json output: the fields that tell the story. */
function storyLine(record: AuditLine): string {
  const seq = String(record.seq).padStart(3);
  switch (record.type) {
    case 'attach':
      return `${seq} attach           ${who(record.userId)} as ${record.role} via ${record.via}${record.email === undefined ? '' : `, email ${record.email}`}`;
    case 'invite_minted':
      return `${seq} invite_minted    ${record.inviteId}, ${record.role === 'observer' ? 'Can watch' : 'Can control'}, ${String(record.uses)} use(s), sponsor ${record.sponsor}`;
    case 'invite_redeemed':
      return `${seq} invite_redeemed  ${record.inviteId} by ${who(record.userId)}, ${String(record.usesLeft)} use(s) left`;
    case 'invite_closed':
      return `${seq} invite_closed    ${record.inviteId}, ${record.reason}`;
    case 'attach_refused':
      return `${seq} attach_refused   ${who(record.userId)} via ${record.via}: ${record.outcome}`;
    case 'revoke':
      return `${seq} revoke           ${who(record.userId)}${record.everyone ? ', by Revoke all' : ''}`;
    case 'call':
      return `${seq} call             ${who(record.userId)} ${record.client?.name ?? '(no client)'} ${record.tool}: ${record.outcome}`;
    default:
      return `${seq} ${record.type}`;
  }
}

/** Runs `pnpm audit:log` on a directory as the operator would, and returns what it printed. */
async function auditLog(
  dir: string,
  args: string[],
): Promise<{ code: number | null; out: string[]; err: string[] }> {
  const run = runPnpm(['audit:log', ...args], { ...blankEnv(), TABDOCK_AUDIT_DIR: dir });
  const code = await run.exited;
  const lines = (text: string): string[] =>
    text.split('\n').filter((line) => line.length > 0 && !line.startsWith('>'));
  return { code, out: lines(run.stdout()), err: lines(run.stderr()) };
}

async function linkedBoard(
  browser: Browser,
  url: string,
): Promise<{ page: Page; pageId: string; code: string }> {
  const context = await browser.newContext(LAPTOP);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  remember(code);
  return { page, pageId, code };
}

say('Tabdock M4: local mode by default, then a page shared by invite\n');
// Not the shared temporary directory, where local mode refuses its token (ADR 0028's notes).
const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-demo-m4-')));
let browser: Browser | undefined;
let dev: Run | undefined;
const clients: Client[] = [];
try {
  browser = await launchChromium(!headed);

  // Part one: local mode.
  const home = join(scratch, 'tabdock home');
  say('Part one: local mode, with no .env and no account (ADR 0022)\n');
  say(`1. pnpm dev, with nothing set but a throwaway TABDOCK_HOME (${home}).`);
  // The board's ?e2e hook, which drives it here, exists only under a key pnpm dev is given.
  const e2eKey = randomBytes(16).toString('base64url');
  dev = runPnpm(['dev'], {
    ...blankEnv(),
    TABDOCK_HOME: home,
    TABDOCK_PORT: '0',
    DEMO_PORT: '0',
    DEMO_E2E_KEY: e2eKey,
  });
  await dev.waitFor('Relay logs follow');
  const printed = dev.stdout();
  const banner = readBanner(printed);
  const tokenFile = statSync(banner.tokenPath);
  const tokenDir = statSync(join(banner.tokenPath, '..'));
  ownerToken = readFileSync(banner.tokenPath, 'latin1').trim();
  say(`   MCP endpoint ${banner.mcpUrl}, page socket ${banner.pageUrl}, loopback only.`);
  say(
    `   The owner token is in ${banner.tokenPath} (${banner.created ? 'created just now' : 'kept from an earlier start'}),`,
  );
  if (process.platform !== 'win32') {
    say(
      `   the file mode ${(tokenFile.mode & 0o777).toString(8)} and its directory ${(tokenDir.mode & 0o777).toString(8)}; the banner names the path, never the token.`,
    );
    check((tokenFile.mode & 0o777) === 0o600, 'the token file should be 0600');
    check((tokenDir.mode & 0o777) === 0o700, 'the token directory should be 0700');
  }
  check(banner.created, 'a first start should create the token');
  say(
    '   For Claude Code it printed this line, whose header helper reads the file at each connection (ADR 0028):',
  );
  say(`   ${banner.command}`);
  check(
    process.platform === 'win32'
      ? banner.command.includes('Get-Content')
      : banner.command.startsWith('claude mcp add-json ') &&
          banner.command.includes('claude-headers'),
    'the printed line should hand Claude Code the helper that reads the token file',
  );

  say(
    '\n2. An MCP client does what that line does: it reads the token from the file and sends it.',
  );
  const local = await bearerClient(banner.mcpUrl, 'claude-code-local', ownerToken);
  clients.push(local);
  const tools = (await local.listTools()).tools.map((tool) => tool.name);
  say(`   tools/list: ${tools.join(', ')}`);
  check(tools.length === 9, 'the relay should offer its nine fixed tools');
  const wrong = await fetch(banner.mcpUrl, {
    method: 'POST',
    headers: { Authorization: 'Bearer tabdock_not-the-owner-token' },
  });
  await wrong.body?.cancel();
  say(`   With another token: HTTP ${String(wrong.status)}.`);
  check(wrong.status === 401, 'a wrong token should get 401');
  const proxied = await fetch(banner.mcpUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'X-Forwarded-For': '203.0.113.9' },
  });
  say(
    `   With the right token through a proxy (X-Forwarded-For): HTTP ${String(proxied.status)} "${(await proxied.text()).slice(0, 80)}"`,
  );
  check(proxied.status === 403, 'local mode should refuse a proxied request');

  const demoLink = /Demo board linked to the relay: (\S+)/.exec(printed)?.[1] ?? '';
  const localBoardUrl = new URL(demoLink);
  localBoardUrl.searchParams.set('e2e', e2eKey);
  const localBoard = await linkedBoard(browser, localBoardUrl.href);
  say(
    `\n3. The demo board it printed, open in Chromium ${browser.version()}, linked as ${localBoard.pageId}, shows the code ${maskCode(localBoard.code)}.`,
  );
  say(`tools/call pair_page { code: "${maskCode(localBoard.code)}" } from claude-code-local`);
  const localPairing = callTool(local, 'pair_page', { code: localBoard.code });
  const youAsk = await waitForDock(localBoard.page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'you'),
  );
  say(
    `   the widget shows "${youAsk.user.displayName} wants to attach via ${youAsk.via}": local mode decides who may call /mcp, never who reaches a page`,
  );
  await clickInWidget(localBoard.page, {
    action: 'approve-driver',
    requestId: youAsk.requestId,
  });
  report('pair_page in local mode', await localPairing, 'ok');
  say('tools/call call_page_tool { tool: "get_view" } from claude-code-local');
  report(
    'get_view in local mode',
    await callTool(local, 'call_page_tool', {
      page: localBoard.pageId,
      tool: 'get_view',
      arguments: {},
    }),
    'ok',
  );
  await local.close();
  clients.splice(clients.indexOf(local), 1);
  await localBoard.page.context().close();
  await dev.stop();
  const devOutput = `${dev.stdout()}\n${dev.stderr()}`;
  const devLeak = leakIn(devOutput, ownerToken);
  say(
    `\n4. pnpm dev stopped. Of the ${String(devOutput.split('\n').length)} lines it printed, none holds the token, its digest or any 8 characters of it.`,
  );
  check(devLeak === null, `pnpm dev printed ${devLeak ?? 'nothing'} of the owner token`);
  const localAudit = await auditLog(join(home, 'audit'), ['--verify']);
  say(`   Its audit log is in audit/ beside the token. pnpm audit:log --verify says:`);
  say(`   ${localAudit.err.at(-1) ?? '(nothing)'}`);
  check(localAudit.code === 0, 'the local audit chain should verify');

  // Part two: public URL mode, with invites.
  say('\nPart two: a page shared by invite, in public URL mode (ADRs 0016, 0017 and 0019)\n');
  const auditDir = join(scratch, 'audit');
  const relayLines: string[] = [];
  tabdock = await startPublicTabdock({
    invites: true,
    auditDir,
    logSink: (line) => {
      relayLines.push(line);
    },
  });
  const live = tabdock;
  say(
    `5. The relay listens on ${live.relay.url} (loopback) in public URL mode for ${PUBLIC_ORIGIN}, with invites on`,
  );
  say(
    '   (TABDOCK_INVITES) and its audit log on disk. A stand-in tunnel and a stand-in provider play the host edge and the',
  );
  say(
    "   identity provider, as in demo:m3. Alice is on the relay's list; anyone else who signs in is an invitee.\n",
  );
  const boardUrl = new URL(live.pageUrl);
  boardUrl.searchParams.set('invites', 'all');
  const board = await linkedBoard(browser, boardUrl.href);
  const policy = (await dockState(board.page))?.policy;
  say(
    `6. The demo board, opened with ?invites=all (invites "${policy?.invites ?? ''}", ${String(policy?.maxDrivers ?? 0)} driver seats), is ${board.pageId}.`,
  );
  check(policy?.invites === 'all', 'the board should offer Can control invites');
  const alice = await claudeAs(live, 'claude-alice', MOCK_SUBJECT, null);
  clients.push(alice);
  const alicePairing = callTool(alice, 'pair_page', { code: board.code });
  const aliceAsks = await waitForDock(board.page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'alice'),
  );
  await clickInWidget(board.page, { action: 'approve-driver', requestId: aliceAsks.requestId });
  report('pair_page from claude-alice', await alicePairing, 'ok');
  say(
    '   Alice, a member, is attached: only while one is can the page mint invites, and she sponsors them.',
  );

  say(
    '\n7. The operator opens Invite, types a label, picks Can watch and 2 uses, and clicks Create.',
  );
  const watch = await mintInWidget(board.page, { label: WATCH_LABEL, role: 'observer', uses: 2 });
  rememberInvite(watch.link);
  say(`   The widget shows the link once, as a QR code and as text: ${maskLink(watch.link)}`);
  say(
    '   (masked here). The secret after # was drawn on the page; the relay holds only its SHA-256.',
  );
  const watchRow = (await widgetItems(board.page, 'invite-list')).find(
    (row) => row.data.inviteId === watch.inviteId,
  );
  const watchView = (await dockState(board.page))?.invites.find(
    (invite) => invite.inviteId === watch.inviteId,
  );
  say(
    `   The live list shows it as the page keeps it: "${watchView?.label ?? ''}", Can watch, ${String(watchView?.joined ?? 0)} of ${String(watchView?.uses ?? 0)} joined, shared by ${watchView?.sponsor.displayName ?? ''}.`,
  );
  check(watchRow?.text.includes('shared by Alice') === true, 'the list should name the sponsor');

  say('\n8. Bob opens the link on his phone, a phone-sized browser.');
  const phoneContext = await browser.newContext(PHONE);
  const requested: string[] = [];
  await playTunnel(phoneContext, live, requested);
  const phone = await phoneContext.newPage();
  const phoneErrors: string[] = [];
  phone.on('pageerror', (error) => phoneErrors.push(error.message));
  await phone.goto(watch.link);
  await phone.waitForURL(`${PUBLIC_ORIGIN}/i`);
  await phone.locator('#message').filter({ hasText: 'Sign in to join this page.' }).waitFor();
  const shown = async (id: string): Promise<string> =>
    (await phone.locator(`#${id}`).textContent()) ?? '';
  say(`   The address bar reads ${phone.url()}: the page took the secret out of it at once.`);
  say(
    `   The preview: shared by ${await shown('sponsor')}, page ${await shown('origin')}, title "${await shown('title')}" and label`,
  );
  say(
    `   "${await shown('label')}" as written by the page; this invite lets you ${await shown('role')}.`,
  );
  live.provider.signInSubject = BOB.sub;
  live.provider.idTokenClaims = { email: BOB.email, email_verified: true };
  try {
    await phone.locator('#signin').tap();
    await phone.locator('#account').filter({ hasText: BOB.email }).waitFor();
  } finally {
    live.provider.signInSubject = null;
    live.provider.idTokenClaims = null;
  }
  for (const cookie of await phoneContext.cookies(PUBLIC_ORIGIN)) remember(cookie.value);
  say(
    `   He taps Sign in, signs in at the provider with scope openid email, and comes back: "${await shown('account')}"`,
  );
  check(
    ((await dockState(board.page))?.pendingRequests.length ?? 1) === 0,
    'signing in should ask the operator nothing',
  );
  await phone.locator('#join').tap();
  await phone.locator('#message').filter({ hasText: 'Joined as observer.' }).waitFor();
  say(
    `   He taps Join. A Can watch invite is approval given in advance: "${await shown('message')}"`,
  );
  const notice = await waitForDock(board.page, (state) =>
    state.joins.length > 0 ? state.joins : null,
  );
  check(notice.length === 1, 'the page should record one join');
  const joinsText = (await widgetText(board.page, 'joins')) ?? '';
  say(`   On the board, no prompt, and a notice: "${joinsText}"`);
  check(joinsText.includes(`joined by your invite "${WATCH_LABEL}" as observer`), 'the notice');

  say(
    "\n9. Claude on Bob's phone, with a token the stand-in provider issued for the same account, uses the page",
  );
  say('   (demo:m3 shows that sign-in itself).');
  const bob = await claudeAs(live, 'claude-bob', BOB.sub, BOB.email);
  clients.push(bob);
  const listed = await callTool(bob, 'list_pages');
  const pages =
    (listed.structured as { pages?: { page: string; role: string }[] } | undefined)?.pages ?? [];
  say(`   list_pages: ${pages.map((entry) => `${entry.page} as ${entry.role}`).join('; ')}`);
  check(
    pages.length === 1 && pages[0]?.page === board.pageId && pages[0].role === 'observer',
    'Bob should see exactly the board, as observer',
  );
  const call = (client: Client, tool: string, args: Record<string, unknown> = {}) =>
    callTool(client, 'call_page_tool', { page: board.pageId, tool, arguments: args });
  say('tools/call call_page_tool { tool: "get_view" } from claude-bob');
  report('get_view from claude-bob', await call(bob, 'get_view'), 'ok');
  say('tools/call call_page_tool { tool: "add_item" } from claude-bob');
  report(
    'add_item from claude-bob',
    await call(bob, 'add_item', { label: 'From Bob', x: 0, y: 80 }),
    'role_denied',
  );
  say('   A Can watch guest reads and never writes, whatever role an approval named.');

  say('\n10. The operator mints a Can control link, which only a page with invites "all" offers.');
  const control = await mintInWidget(board.page, { label: CONTROL_LABEL, role: 'driver' });
  rememberInvite(control.link);
  say(`   ${maskLink(control.link)}, for one use. Carol pastes it into Claude:`);
  const carol = await claudeAs(live, 'claude-carol', CAROL.sub, CAROL.email);
  clients.push(carol);
  say(`tools/call pair_page { invite: "${maskLink(control.link)}" } from claude-carol`);
  const carolPairing = callTool(carol, 'pair_page', { invite: control.link });
  const carolAsks = await waitForDock(board.page, (state) =>
    state.pendingRequests.find((request) => request.via === 'invite'),
  );
  const prompt = (await widgetBoxText(board.page, { requestId: carolAsks.requestId })) ?? '';
  const asks = `${CAROL.email} (${carolAsks.user.userId.slice(2, 10)}) wants to join by your invite "${CONTROL_LABEL}"`;
  say(`   A Can control invite always asks. The prompt reads: ${asks},`);
  say(
    `   with the invited badge and the client, ${carolAsks.client?.name ?? 'unnamed'}; the short id is the start of her account key.`,
  );
  check(prompt.includes(asks), 'the prompt should name the account with its short id');
  check(prompt.includes('invited'), 'the prompt should carry the invited badge');
  await clickInWidget(board.page, { action: 'approve-driver', requestId: carolAsks.requestId });
  say('   The operator clicks Allow as driver.');
  report('pair_page with the control link', await carolPairing, 'ok');
  say('tools/call call_page_tool { tool: "add_item" } from claude-carol');
  report(
    'add_item from claude-carol',
    await call(carol, 'add_item', { label: 'From Carol', x: 120, y: 80 }),
    'ok',
  );
  const roster = (await dockState(board.page))?.roster ?? [];
  say(
    `   The roster: ${roster.map((entry) => `${entry.displayName} (${entry.role}${entry.inviteId === null ? '' : ', invited'})`).join(', ')}`,
  );

  say('\n11. The operator clicks Revoke all.');
  await clickInWidget(board.page, { action: 'revoke-all' });
  await waitForDock(board.page, (state) => state.roster.length === 0 && state.invites.length === 0);
  say('   Every attachment ends, and so does every live invite.');
  say('tools/call call_page_tool { tool: "get_view" } from claude-bob');
  report('get_view after Revoke all', await call(bob, 'get_view'), 'not_attached');
  say('tools/call call_page_tool { tool: "add_item" } from claude-carol');
  report(
    'add_item after Revoke all',
    await call(carol, 'add_item', { label: 'Again', x: 0, y: 0 }),
    'not_attached',
  );
  const again = await phoneContext.newPage();
  await again.goto(watch.link);
  await again.locator('#message').filter({ hasText: 'This invite is' }).waitFor();
  say(
    `   Bob's link, which had a use left, now says: "${(await again.locator('#message').textContent()) ?? ''}"`,
  );
  say(`tools/call pair_page { invite: "${maskLink(control.link)}" } from claude-carol`);
  report(
    'the control link again',
    await callTool(carol, 'pair_page', { invite: control.link }),
    'pairing_expired',
  );
  check(phoneErrors.length === 0, `the /i page threw: ${phoneErrors.join('; ')}`);
  const inUrls = [...secrets].filter((secret) => requested.some((url) => url.includes(secret)));
  check(
    inUrls.length === 0,
    `${String(inUrls.length)} secret(s) appeared in a URL the phone asked for`,
  );

  say('\n12. The relay stops, and its audit log on disk tells the story (pnpm audit:log):');
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  for (const token of live.provider.issuedTokens) remember(token);
  await live.close();
  tabdock = undefined;
  const story = await auditLog(auditDir, [
    '--json',
    '--type',
    'attach,attach_refused,invite_minted,invite_redeemed,invite_closed,revoke,call',
  ]);
  const told = story.out.map((line) => AuditLineSchema.parse(JSON.parse(line)));
  for (const record of told) say(`   ${storyLine(record)}`);
  check(story.code === 0, 'pnpm audit:log should read the log');
  check(
    told.some((record) => record.type === 'attach' && record.email === BOB.email),
    "Bob's attach record should keep his verified email",
  );
  say(
    '   Each line also carries the time, the page and its origin, and the digest of the line before.',
  );
  const verified = await auditLog(auditDir, ['--verify']);
  say('   pnpm audit:log --verify:');
  say(`   ${verified.err.at(-1) ?? '(nothing)'}`);
  check(verified.code === 0, 'the audit chain should verify');

  // Every secret this run saw, against everything the relay logged and wrote to its audit files.
  const logged = relayLines.join('\n');
  const filed = listAuditFiles(auditDir)
    .map((file) => readFileSync(join(auditDir, file.name), 'utf8'))
    .join('\n');
  const leaked = [...secrets].filter((secret) => logged.includes(secret)).length;
  const filedLeaks = [...secrets].filter((secret) => filed.includes(secret)).length;
  const emails = [BOB.email, CAROL.email].filter((email) => logged.includes(email)).length;
  const labels = [WATCH_LABEL, CONTROL_LABEL].filter((label) => filed.includes(label)).length;
  say(
    `\n13. The relay wrote ${String(relayLines.length)} log lines and its audit files: none holds any of the ${String(secrets.size)} tokens,`,
  );
  say(
    "   codes, invite secrets, their hashes, cookies or subjects this run saw; no guest's email reaches stderr,",
  );
  say('   and no label the page wrote reaches the audit file.');
  check(leaked === 0, `${String(leaked)} secret(s) reached the relay log`);
  check(filedLeaks === 0, `${String(filedLeaks)} secret(s) reached the audit file`);
  check(emails === 0, `${String(emails)} email(s) reached the relay log`);
  check(labels === 0, `${String(labels)} page-written label(s) reached the audit file`);

  if (headed) {
    say('\nBrowsers stay open for 30 s so you can look at the boards and the phone.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  if (unexpected > 0) {
    say(`\n${String(unexpected)} step(s) did not behave as expected.`);
    process.exitCode = 1;
  } else {
    say('\nEvery step behaved as expected.');
  }
} catch (error) {
  say(`\nThe demo stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  await browser?.close();
  await tabdock?.close();
  await dev?.stop();
  rmSync(scratch, { recursive: true, force: true });
}
