// pnpm demo:m3: the phone milestone, narrated, entirely on this machine.
//   --headed   watch the laptop's board and the phone in visible browsers
// The relay runs here in public URL mode for https://relay.test with the spike
// flag on. Nothing is public: a stand-in tunnel (src/public-harness.ts for the
// browsers, the relay tests' tunnelFetch for MCP clients) sends requests for
// that name to the loopback relay with the public Host, as ngrok forwards
// them, and oauth2-mock-server stands in for the identity provider. Two
// people: Alice drives from an MCP client that signs in the way Claude Code
// does and pairs by code; Bob scans the widget's QR code with a phone-sized
// browser, signs in, joins, and then reads the page from the phone's client.
// It never prints a token, a nonce, a cookie or a pairing code; codes and the
// pairing URL appear masked, and every line is checked against the secrets
// seen so far before it is printed (S11).

import type { Client } from '@modelcontextprotocol/client';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { DockState } from '@tabdock/adapter';
import { qrPath } from '@tabdock/adapter/qr';
import { PAIR_CLIENT } from '@tabdock/relay/test/provider';
import { tunnelFetch } from '@tabdock/relay/test/tunnel';
import { launchChromium } from './harness.ts';
import {
  playTunnel,
  PUBLIC_MCP_URL,
  PUBLIC_ORIGIN,
  type PublicTabdock,
  startPublicTabdock,
} from './public-harness.ts';
import { connectWithOAuth } from './spike/latency.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  maskCode,
  type ToolOutcome,
  waitForDock,
  waitForLink,
  widgetQrDrawing,
} from './tabdock-harness.ts';

const headed = process.argv.includes('--headed');
const BOB_SUBJECT = 'sub-bob';
const STRANGER_SUBJECT = 'sub-stranger';
const METADATA_URL = `${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`;
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true };

/** Everything that must never be printed: codes, nonces, tokens, cookie values. */
const secrets = new Set<string>([PAIR_CLIENT.clientSecret]);
let tabdock: PublicTabdock | undefined;
let unexpected = 0;

function remember(secret: string | null | undefined): void {
  if (secret !== null && secret !== undefined && secret.length >= 6) secrets.add(secret);
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
  } else say(`   result  ${outcome.text.slice(0, 160)}`);
  const got = outcome.isError ? (errorCode(outcome) ?? 'error') : 'ok';
  check(got === expected, `${label}: expected ${expected}, got ${got}`);
}

/** The pairing URL with its nonce hidden: what the QR code says, minus the part that is a secret. */
function maskUrl(url: string): string {
  const split = url.indexOf('#');
  return split === -1 ? url : `${url.slice(0, split + 1)}${'*'.repeat(url.length - split - 1)}`;
}

/** The pairing the page shows once it has replaced `previous`, which a pairing just used up. */
async function nextPairing(page: Page, previous: string): Promise<{ code: string; url: string }> {
  const pairing = await waitForDock(page, (state) =>
    state.pairing !== null && state.pairing.code !== previous && state.pairing.url !== undefined
      ? { code: state.pairing.code, url: state.pairing.url }
      : null,
  );
  remember(pairing.code);
  remember(pairing.url.split('#')[1]);
  return pairing;
}

async function stateOf(page: Page): Promise<DockState> {
  const state = await dockState(page);
  if (!state) throw new Error('the page has no Tabdock handle');
  return state;
}

const relayLines: string[] = [];

type Milestone = Record<string, unknown> & { stage: string };

/** The spike's scan-to-first-call milestones (spike.ts), from the relay's own log. */
function milestones(): Milestone[] {
  return relayLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (entry): entry is Milestone =>
        entry.msg === 'spike: pairing milestone' && typeof entry.stage === 'string',
    );
}

/** Signs an MCP client in the way Claude Code does, with `browse` playing the browser it opens. */
async function signedInClient(
  name: string,
  browse: (url: URL) => Promise<void>,
): Promise<{ client: Client; signIn: URL }> {
  if (!tabdock) throw new Error('no relay');
  const shown: { url: URL | null } = { url: null };
  let browsed: Promise<void> = Promise.resolve();
  const client = await connectWithOAuth(PUBLIC_MCP_URL, {
    // Claude registers itself with the real provider; the stand-in takes any client id.
    clientId: `tabdock-demo-${name}`,
    clientIssuer: tabdock.provider.issuer,
    client: { name, version: '0.0.0' },
    fetch: tunnelFetch(tabdock.relay.url),
    timeoutMs: 20_000,
    showSignIn: (url) => {
      shown.url = url;
      browsed = browse(url);
    },
  });
  await browsed;
  if (shown.url === null) throw new Error('the client signed in without showing a sign-in page');
  return { client, signIn: shown.url };
}

/** Opens a sign-in URL in a new tab of `context` and waits until the provider sent it back. */
function browseIn(context: BrowserContext): (url: URL) => Promise<void> {
  return async (url) => {
    const tab = await context.newPage();
    try {
      await tab.goto(url.href);
      await tab.waitForURL((at) => at.pathname === '/callback', { timeout: 10_000 });
    } finally {
      await tab.close();
    }
  };
}

say('Tabdock M3: a phone joins a page on the laptop through a public URL and real sign-in\n');
let browser: Browser | undefined;
const clients: Client[] = [];
try {
  tabdock = await startPublicTabdock({
    spike: true,
    users: [{ sub: BOB_SUBJECT, userId: 'bob', displayName: 'Bob' }],
    logSink: (line) => {
      relayLines.push(line);
    },
  });
  const live = tabdock;
  const fetchPublic = tunnelFetch(live.relay.url);
  say(
    `1. The relay listens on ${live.relay.url} (loopback only) in public URL mode for ${PUBLIC_ORIGIN}.`,
  );
  say(
    `   A stand-in tunnel routes ${PUBLIC_ORIGIN} to it here, as ngrok will on the owner's laptop, and a stand-in`,
  );
  say(
    `   identity provider (oauth2-mock-server) at ${live.provider.issuer} signs people in. Accounts allowed: alice, bob.`,
  );
  say(
    '   The spike flag is on, so the relay logs the pairing milestones that time scan to first call.\n',
  );

  say(`2. A request with no token: POST ${PUBLIC_MCP_URL}`);
  const unsigned = await fetchPublic(PUBLIC_MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'curious', version: '0.0.0' },
      },
    }),
  });
  const challenge = unsigned.headers.get('www-authenticate') ?? '';
  await unsigned.body?.cancel();
  say(`   HTTP ${String(unsigned.status)}, WWW-Authenticate: ${challenge}`);
  check(
    unsigned.status === 401,
    `an unsigned request should get 401, got ${String(unsigned.status)}`,
  );
  check(
    challenge.includes(`resource_metadata="${METADATA_URL}"`),
    'the challenge should name the protected resource metadata',
  );
  say('   The challenge is how a client learns where to sign in; nothing of the MCP server ran.\n');

  say(`3. The protected resource metadata (RFC 9728): GET ${METADATA_URL}`);
  const metadataAnswer = await fetchPublic(METADATA_URL);
  const metadata = (await metadataAnswer.json()) as Record<string, unknown>;
  for (const [key, value] of Object.entries(metadata)) say(`   ${key}: ${JSON.stringify(value)}`);
  check(metadata.resource === PUBLIC_MCP_URL, 'the metadata resource should be the connector URL');
  check(
    Array.isArray(metadata.authorization_servers) &&
      metadata.authorization_servers.length === 1 &&
      metadata.authorization_servers[0] === live.provider.issuer,
    'the metadata should name the provider as the only authorization server',
  );
  say(
    '   Tokens must carry this resource as their audience; the relay checks every one (ADR 0013).\n',
  );

  browser = await launchChromium(!headed);
  const laptop = await browser.newContext();
  const page = await laptop.newPage();
  await page.goto(live.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  remember(code);
  const firstUrl = await waitForDock(page, (state) => state.pairing?.url);
  remember(firstUrl.split('#')[1]);
  say(
    `4. The demo board is open on the laptop in Chromium ${browser.version()}, linked over loopback as ${pageId}.`,
  );
  say(
    `   Its widget shows the code ${maskCode(code)} and, beside it, a QR code for ${maskUrl(firstUrl)}`,
  );
  say(
    '   (masked here: the code and the nonce after # are secrets, and the nonce never leaves the fragment).',
  );

  say('\n5. Alice adds the connector in an MCP client that signs in the way Claude Code does.');
  const alice = await signedInClient('alice-laptop', browseIn(laptop));
  clients.push(alice.client);
  const asked = alice.signIn.searchParams;
  say(
    `   The SDK followed the challenge to ${alice.signIn.origin}${alice.signIn.pathname} and opened it in the laptop's browser,`,
  );
  say(
    `   asking for resource=${asked.get('resource') ?? ''} with PKCE (${asked.get('code_challenge_method') ?? ''}) and a loopback redirect.`,
  );
  check(asked.get('resource') === PUBLIC_MCP_URL, 'the sign-in should ask for the connector URL');
  check(asked.get('code_challenge_method') === 'S256', 'the sign-in should use S256 PKCE');
  say(
    '   The provider signed Alice in and the client now holds a token for the relay (never printed).',
  );
  say(`tools/call pair_page { code: "${maskCode(code)}" } from alice-laptop`);
  const alicePairing = callTool(alice.client, 'pair_page', { code });
  const aliceAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'alice'),
  );
  say(
    `   the widget shows "${aliceAsks.user.displayName} wants to attach via ${aliceAsks.via}"; the operator clicks Allow as driver`,
  );
  await clickInWidget(page, { action: 'approve-driver', requestId: aliceAsks.requestId });
  report('pair_page from alice-laptop', await alicePairing, 'ok');
  const call = (client: Client, tool: string, args: Record<string, unknown> = {}) =>
    callTool(client, 'call_page_tool', { page: pageId, tool, arguments: args });
  say('tools/call call_page_tool { tool: "add_item" } from alice-laptop');
  report(
    'add_item from alice-laptop',
    await call(alice.client, 'add_item', { label: 'From the laptop', x: -120, y: 0 }),
    'ok',
  );

  const { url: pairingUrl } = await nextPairing(page, code);
  const drawing = await widgetQrDrawing(page);
  const expected = qrPath(pairingUrl);
  const modules = expected === null ? 0 : expected.size - 8;
  say(
    `\n6. The code was used, so the widget shows a new code and QR code. The QR code is ${String(modules)} by ${String(modules)} modules, level M,`,
  );
  say(
    `   one SVG path drawn inside the widget's closed shadow root; it encodes ${maskUrl(pairingUrl)}`,
  );
  check(
    expected !== null &&
      drawing?.d === expected.d &&
      drawing.viewBox === `0 0 ${String(expected.size)} ${String(expected.size)}`,
    "the widget's QR drawing should be exactly the code for the new pairing URL",
  );

  say('\n7. Bob scans it with his phone: a phone-sized browser opens the pairing URL.');
  const phoneContext = await browser.newContext({ ...PHONE, hasTouch: true });
  const requested: string[] = [];
  await playTunnel(phoneContext, live, requested);
  const phone = await phoneContext.newPage();
  const phoneErrors: string[] = [];
  phone.on('pageerror', (error) => phoneErrors.push(error.message));
  await phone.goto(pairingUrl);
  await phone.waitForURL(`${PUBLIC_ORIGIN}/pair`);
  const shownCode = (await phone.locator('#code').textContent({ timeout: 10_000 })) ?? '';
  await phone.locator('#message').filter({ hasText: 'Sign in to join this page.' }).waitFor();
  const shownOrigin = (await phone.locator('#origin').textContent()) ?? '';
  const shownTitle = (await phone.locator('#title').textContent()) ?? '';
  say(`   The address bar now reads ${phone.url()}: the page took the nonce out of it at once.`);
  say(
    `   The preview (which uses nothing up): page address ${shownOrigin}, title "${shownTitle}" as written by the page,`,
  );
  say(`   and the code ${maskCode(shownCode)}, the same as the widget's, for Bob to compare.`);
  check(shownCode === (await stateOf(page)).pairing?.code, 'the phone should show the widget code');
  check(shownOrigin === new URL(live.demo.url).origin, 'the preview should show the page origin');
  check(!(await phone.locator('#join').isVisible()), 'Join should be hidden until Bob signs in');

  say('   Bob taps "Sign in to join" and signs in at the provider as Bob.');
  live.provider.signInSubject = BOB_SUBJECT;
  await phone.locator('#signin').tap();
  await phone.locator('#account').filter({ hasText: 'Signed in as Bob.' }).waitFor();
  const cookies = await phoneContext.cookies(PUBLIC_ORIGIN);
  for (const cookie of cookies) remember(cookie.value);
  say(
    `   Back on ${phone.url()}: "${(await phone.locator('#account').textContent()) ?? ''}" The browser holds only ${cookies.map((cookie) => cookie.name).join(', ')}`,
  );
  say('   (Secure, HttpOnly, SameSite=Lax), and nothing is claimed yet.');
  check(
    cookies.length === 1 && cookies[0]?.name === '__Host-tabdock-pair' && cookies[0].httpOnly,
    'the phone should hold one __Host- session cookie',
  );
  check(
    (await stateOf(page)).pendingRequests.length === 0,
    'signing in should ask the operator nothing',
  );

  say('   Bob taps Join.');
  await phone.locator('#join').tap();
  const bobAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'bob'),
  );
  await phone.locator('#message').filter({ hasText: 'Waiting for' }).waitFor();
  say(`   the phone says "${(await phone.locator('#message').textContent()) ?? ''}"`);

  say(
    `\n8. The widget shows "${bobAsks.user.displayName} wants to attach via ${bobAsks.via}"; the operator clicks Allow as observer.`,
  );
  check(bobAsks.via === 'qr', 'the request should say it came by QR');
  await clickInWidget(page, { action: 'approve-observer', requestId: bobAsks.requestId });
  await phone
    .locator('#message')
    .filter({ hasText: /^Approved as observer\./ })
    .waitFor();
  say(`   the phone says "${(await phone.locator('#message').textContent()) ?? ''}"`);
  const roster = await waitForDock(page, (state) =>
    state.roster.length === 2 ? state.roster : null,
  );
  say(`   the roster: ${roster.map((entry) => `${entry.displayName} (${entry.role})`).join(', ')}`);

  say("\n9. Claude on Bob's phone signs in as Bob, the same OAuth flow, and uses the page.");
  const bob = await signedInClient('bob-phone', browseIn(phoneContext));
  clients.push(bob.client);
  live.provider.signInSubject = null;
  const listed = await callTool(bob.client, 'list_pages');
  const pages =
    (listed.structured as { pages?: { page: string; role: string; title: string }[] } | undefined)
      ?.pages ?? [];
  say(
    `   list_pages: ${pages.map((entry) => `${entry.page} "${entry.title}" as ${entry.role}`).join('; ')}`,
  );
  check(
    pages.length === 1 && pages[0]?.page === pageId && pages[0].role === 'observer',
    'Bob should see exactly the board, as observer',
  );
  say('tools/call call_page_tool { tool: "get_view" } from bob-phone');
  const timed = await bob.client.callTool({
    name: 'call_page_tool',
    arguments: { page: pageId, tool: 'get_view', arguments: {} },
  });
  const timedText = timed.content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('\n');
  report(
    'get_view from bob-phone',
    { isError: timed.isError === true, text: timedText, structured: timed.structuredContent },
    'ok',
  );
  const timing = timed._meta?.['tabdock/spikeTiming'] as
    { relayMs?: number; pageMs?: number | null } | undefined;
  if (timing?.relayMs !== undefined) {
    say(
      `   the spike's timestamps ride in the result's _meta: ${String(timing.relayMs)} ms in the relay, ${String(timing.pageMs ?? 'n/a')} ms of it on the page`,
    );
  }
  check(timing?.relayMs !== undefined, 'the spike flag should put timings in the result');
  say('tools/call call_page_tool { tool: "add_item" } from bob-phone');
  report(
    'add_item from bob-phone',
    await call(bob.client, 'add_item', { label: 'From the phone', x: 120, y: 0 }),
    'role_denied',
  );
  say('   An observer reads but does not write; the relay refused it before the page saw it.');

  say("\n10. A stranger who can sign in at the provider but is not on the relay's list.");
  const strangerToken = await live.provider.token({ sub: STRANGER_SUBJECT, aud: PUBLIC_MCP_URL });
  remember(strangerToken);
  const stranger = await fetchPublic(PUBLIC_MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${strangerToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stranger', version: '0.0.0' },
      },
    }),
  });
  const strangerBody = (await stranger.text()).slice(0, 120);
  say(
    `   a valid token, signed by the provider for ${PUBLIC_MCP_URL}: HTTP ${String(stranger.status)} "${strangerBody}"`,
  );
  check(
    stranger.status === 403,
    `a stranger's valid token should get 403, got ${String(stranger.status)}`,
  );
  check(
    stranger.headers.get('www-authenticate') === null,
    'a 403 should not invite the stranger to sign in again',
  );
  say('   A plain 403, with no challenge: Claude treats it as final rather than signing in again.');

  say("\n11. Scan to first call, from the spike's pairing milestones in the relay log (A3.3):");
  const all = milestones();
  const bobFirst = all.find((entry) => entry.stage === 'first_call' && entry.userId === 'bob');
  const bobTrace = bobFirst?.trace;
  const bobSteps = all.filter((entry) => entry.trace === bobTrace);
  const ms = (value: unknown): string =>
    typeof value === 'number' ? `${String(value)} ms` : 'n/a';
  say(
    `   Bob, via ${String(bobFirst?.via)}, trace ${String(bobTrace)} (a random id, not the nonce):`,
  );
  for (const step of bobSteps) {
    const since =
      step.stage === 'issued'
        ? 'the widget showed the code and QR code'
        : step.stage === 'scanned'
          ? `${ms(step.sinceIssuedMs)} after it was issued`
          : step.stage === 'claimed'
            ? `${ms(step.sinceScannedMs)} after the scan (sign-in included)`
            : step.stage === 'approved'
              ? `${ms(step.sinceClaimedMs)} after the claim (the operator's click)`
              : `${ms(step.sinceApprovedMs)} after the approval; ${ms(step.sinceScannedMs)} from scan to first call`;
    say(`   ${step.stage.padEnd(10)} ${since}`);
  }
  check(
    bobSteps.map((step) => step.stage).join(' ') === 'issued scanned claimed approved first_call',
    "Bob's pairing should run issued, scanned, claimed, approved, first_call under one trace",
  );
  check(
    typeof bobFirst?.sinceScannedMs === 'number',
    'the first call should be timed from the scan',
  );
  const aliceFirst = all.find((entry) => entry.stage === 'first_call' && entry.userId === 'alice');
  say(
    `   Alice, via ${String(aliceFirst?.via)}: ${ms(aliceFirst?.sinceClaimedMs)} from typing the code to her first call.`,
  );
  check(aliceFirst?.via === 'code', "Alice's pairing should be timed via code");

  // Every secret this run saw, against everything the relay logged and every URL the phone asked for.
  for (const token of live.provider.issuedTokens) remember(token);
  const logged = relayLines.join('\n');
  const leaked = [...secrets].filter((secret) => logged.includes(secret)).length;
  const inUrls = [...secrets].filter((secret) =>
    requested.some((url) => url.includes(secret)),
  ).length;
  say(
    `\n12. The relay wrote ${String(relayLines.length)} log lines; none holds any of the ${String(secrets.size)} codes, nonces, tokens, cookies or secrets`,
  );
  say(
    `   this run saw, and none of the ${String(requested.length)} URLs the phone asked for carries one either.`,
  );
  check(leaked === 0, `${String(leaked)} secret(s) reached the relay log`);
  check(inUrls === 0, `${String(inUrls)} secret(s) appeared in a URL the phone requested`);
  check(phoneErrors.length === 0, `the /pair page threw: ${phoneErrors.join('; ')}`);

  if (headed) {
    say('\nBrowsers stay open for 30 s so you can look at the board, the widget and the phone.');
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
}
