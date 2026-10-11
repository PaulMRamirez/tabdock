import { createHash } from 'node:crypto';
import type { Client } from '@modelcontextprotocol/client';
import { expect, type Page, test } from '@playwright/test';
import {
  AGENT_COMMAND,
  AGENT_URL,
  agentStatus,
  type AgentTabdock,
  connectAgent,
  connectAlice,
  startAgentTabdock,
} from '../src/agent-harness.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  typeInWidget,
  waitForDock,
  waitForLink,
  widgetBoxText,
  widgetButtonNow,
  widgetEvaluate,
  widgetItems,
  widgetText,
} from '../src/tabdock-harness.ts';

// Agent tokens in the widget (ADR 0044, A6.23 and the agent parts of A6.24),
// end to end on the demo board in public URL mode, under Trusted Types and a
// strict style-src: the operator mints a token with real clicks in the
// Invite form's agent kind, the command shows once and Done leaves nothing of
// it in the widget; an MCP client on /g/mcp with that token as its bearer
// raises a prompt that names the label and the client and offers observer
// only; once allowed it reads the board and is refused a write; Cancel ends
// it, and /g/mcp then answers 404. The token reaches no log and no storage.

const LABEL = 'Nightly checker';
/** What a strict page sends: Trusted Types for every script sink, and no data: images. */
const TRUSTED_TYPES_CSP = "require-trusted-types-for 'script'; img-src 'self'";

// Tall enough that the open form never makes the panel scroll, which would move its boxes.
test.use({ viewport: { width: 1280, height: 1200 } });

let live: AgentTabdock | undefined;
let relayLogs: string[];
let pageErrors: string[];
let consoleLines: string[];
const clients: Client[] = [];

test.beforeEach(({ page }) => {
  relayLogs = [];
  pageErrors = [];
  consoleLines = [];
  page.on('console', (message) => {
    consoleLines.push(message.text());
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
});
test.afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => undefined);
  await live?.close();
  live = undefined;
  expect(pageErrors).toEqual([]);
});

/**
 * Serves the demo page under Trusted Types and a style-src that allows only
 * its own <style>, as the invites spec does, and returns a reader for the
 * violations the page reported.
 */
async function enforceStrictCsp(page: Page, demoUrl: string): Promise<() => Promise<string[]>> {
  const html = await (await fetch(demoUrl)).text();
  const own = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
  if (own === undefined) throw new Error('the demo page has no <style>');
  const hash = createHash('sha256').update(own, 'utf8').digest('base64');
  const policy = `${TRUSTED_TYPES_CSP}; style-src 'self' 'sha256-${hash}' 'report-sample'`;
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.defineProperty(window, '__cspViolations', { value: seen });
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(event.effectiveDirective);
    });
  });
  const demoOrigin = new URL(demoUrl).origin;
  await page.route(
    (url) => url.origin === demoOrigin && url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const headers = response.headers();
      const existing = headers['content-security-policy'];
      await route.fulfill({
        response,
        headers: {
          ...headers,
          'content-security-policy': existing ? `${existing}; ${policy}` : policy,
        },
      });
    },
  );
  return () =>
    page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
}

/** Opens the board and pairs Alice, a member, as driver, so she can sponsor what the page mints. */
async function openWithAlice(page: Page, tabdock: AgentTabdock): Promise<string> {
  await page.goto(tabdock.pageUrl);
  const { pageId, code } = await waitForLink(page);
  const alice = await connectAlice(tabdock);
  clients.push(alice);
  const pairing = callTool(alice, 'pair_page', { code });
  const asks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'alice'),
  );
  await clickInWidget(page, { action: 'approve-driver', requestId: asks.requestId });
  expect((await pairing).isError).toBe(false);
  await waitForDock(page, (state) => (state.invitesOffered?.linkBase ?? null) !== null);
  return pageId;
}

/** Everything the page keeps where script can read it: both storages, as text. */
function storedText(page: Page): Promise<string> {
  return page.evaluate(() =>
    JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]),
  );
}

test('a token minted in the widget prompts with its label and client, reads as observer only, and ends with Cancel', async ({
  page,
}) => {
  test.setTimeout(90_000);
  live = await startAgentTabdock({
    logSink: (line) => {
      relayLogs.push(line);
    },
  });
  const tabdock = live;
  const violations = await enforceStrictCsp(page, tabdock.demo.url);
  const pageId = await openWithAlice(page, tabdock);
  await waitForDock(page, (state) => state.agentsOffered?.endpoint === AGENT_URL);

  // The agent kind in the Invite form: no uses to count, and its own lifetimes.
  await clickInWidget(page, { action: 'invite-open' });
  await typeInWidget(page, 'invite-label', LABEL);
  expect(await widgetButtonNow(page, { action: 'agent-lifetime-4h' })).toBeNull();
  await clickInWidget(page, { action: 'invite-kind-agent' });
  expect(await widgetButtonNow(page, { action: 'invite-uses' })).toBeNull();
  expect(await widgetButtonNow(page, { action: 'invite-lifetime-15m' })).toBeNull();
  await clickInWidget(page, { action: 'agent-lifetime-4h' });
  const minting = Date.now();
  await clickInWidget(page, { action: 'invite-create' });

  // The command, once, with the token as its only secret.
  await expect.poll(async () => (await widgetText(page, 'agent-command')) ?? '').not.toBe('');
  const command = (await widgetText(page, 'agent-command')) ?? '';
  const match = AGENT_COMMAND.exec(command);
  expect(match, command.replace(/tda_\S+/, 'tda_***')).not.toBeNull();
  const [, , endpoint = '', token = ''] = match ?? [];
  expect(endpoint).toBe(AGENT_URL);
  const minted = await waitForDock(page, (state) =>
    state.agents.find((agent) => agent.label === LABEL),
  );
  expect(minted.state).toBe('dormant');
  expect(minted.expiresAt - minting).toBeGreaterThan(4 * 3_600_000 - 60_000);
  expect(minted.expiresAt - minting).toBeLessThanOrEqual(4 * 3_600_000 + 60_000);
  const [row] = await widgetItems(page, 'agent-list');
  expect(row?.text).toContain(`"${LABEL}", agent token`);
  expect(row?.text).toContain('not used yet');
  expect(row?.data.tokenId).toBe(minted.tokenId);

  // Never stored, never in the page's state, never logged on either side.
  expect(await storedText(page)).not.toContain(token);
  expect(JSON.stringify(await dockState(page))).not.toContain(token);

  // Done: nothing of the command stays anywhere in the widget's shadow root.
  await clickInWidget(page, { action: 'agent-done' });
  expect(await widgetText(page, 'agent-command')).toBe('');
  const shadow = await widgetEvaluate(
    page,
    'invites',
    'function () { return this.getRootNode().innerHTML; }',
  );
  expect(typeof shadow).toBe('string');
  expect(shadow).not.toContain(token);
  expect(shadow).not.toContain('Authorization');

  // Its first request raises an ordinary prompt: the label, the client, observer only.
  const agent = await connectAgent(tabdock.relay.url, token, 'claude-code');
  clients.push(agent);
  const asked = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.agent?.tokenId === minted.tokenId),
  );
  expect(asked.via).toBe('agent');
  const prompt = (await widgetBoxText(page, { requestId: asked.requestId })) ?? '';
  expect(prompt).toContain(`wants to watch by your agent token "${LABEL}"`);
  expect(prompt).toContain('claude-code');
  expect(prompt).not.toContain('Unverified account');
  expect(
    await widgetButtonNow(page, { action: 'approve-driver', requestId: asked.requestId }),
  ).toBeNull();
  await expect
    .poll(async () => (await widgetItems(page, 'agent-list'))[0]?.text ?? '')
    .toContain('asking now');

  // pair_page on /g/mcp waits on that prompt, and the operator allows it.
  const paired = callTool(agent, 'pair_page', {});
  await clickInWidget(page, { action: 'approve-observer', requestId: asked.requestId });
  const outcome = await paired;
  expect(outcome.isError, outcome.text).toBe(false);
  expect(outcome.text).toContain('as observer');
  const read = await callTool(agent, 'call_page_tool', { page: pageId, tool: 'get_view' });
  expect(read.isError, read.text).toBe(false);
  const write = await callTool(agent, 'call_page_tool', {
    page: pageId,
    tool: 'add_item',
    arguments: { label: 'agent was here', x: 0, y: 0 },
  });
  expect(errorCode(write)).toBe('role_denied');
  await expect
    .poll(async () => (await widgetItems(page, 'agent-list'))[0]?.text ?? '')
    .toContain('attached');

  // Cancel ends it: its attachment goes, and /g/mcp answers 404 from then on.
  await clickInWidget(page, { action: 'agent-cancel' });
  await waitForDock(page, (state) =>
    state.agents.length === 0 && !state.roster.some((entry) => entry.kind === 'invitee')
      ? true
      : null,
  );
  expect(await widgetItems(page, 'agent-list')).toEqual([]);
  await expect.poll(() => agentStatus(tabdock.relay.url, token)).toBe(404);

  expect(relayLogs.join('\n')).not.toContain(token);
  expect(consoleLines.join('\n')).not.toContain(token);
  expect(await storedText(page)).not.toContain(token);
  expect(await violations()).toEqual([]);
});

test('with agent tokens off, the form offers no agent kind and /g/mcp answers 404', async ({
  page,
}) => {
  test.setTimeout(60_000);
  live = await startAgentTabdock({ agentTokens: false });
  const tabdock = live;
  await openWithAlice(page, tabdock);
  expect((await dockState(page))?.agentsOffered).toBeNull();
  await clickInWidget(page, { action: 'invite-open' });
  expect(await widgetButtonNow(page, { action: 'invite-role-observer' })).not.toBeNull();
  expect(await widgetButtonNow(page, { action: 'invite-kind-agent' })).toBeNull();
  const refused = await page.evaluate(
    () => window.__tabdockDock?.agentToken({ label: 'Not served' }) ?? null,
  );
  expect(refused).toEqual({ ok: false, reason: 'unavailable' });
  expect(await agentStatus(tabdock.relay.url, `tda_${'A'.repeat(43)}`)).toBe(404);
});
