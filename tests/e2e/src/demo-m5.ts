// pnpm demo:m5: first-class page tools on both MCP revisions, then a
// consequential call confirmed in the caller's own client, narrated, entirely
// on this machine.
//   --headed   watch the boards in a visible browser
// It runs `pnpm dev` as the owner does on a clean clone, in local mode with a
// throwaway TABDOCK_HOME and TABDOCK_FIRST_CLASS_TOOLS=1 (ADRs 0022 and
// 0025), and opens the demo board it printed in Chromium. Two SDK clients
// read the owner token from its file as the printed Claude Code line does, one
// pinned to 2026-07-28 (no session) and one on 2025-11-25 (a session); each
// pairs with the board, lists its tools as `<page id>__<tool>` beside the
// five fixed tools and calls one by that name. Then a second board, opened
// with ?confirm=client, takes clear_board's confirmation from the caller's
// client (ADR 0026): each of the two clients answers the relay's question in
// its elicitation handler, by input_required on 2026-07-28 and by an
// elicitation inside the request on the session, and the board raises no
// prompt; a third client that declares no form elicitation gets the board's
// own prompt instead, which the demo answers on the page. The audit log then
// tells which calls a client confirmed. It never prints the owner token or a
// pairing code, and checks every line against them before printing it (S11).

import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  type ElicitRequestFormParams,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { Browser, Page } from '@playwright/test';
import { AuditLineSchema } from '@tabdock/protocol';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { DEMO_TOOL_NAMES, launchChromium } from './harness.ts';
import { blankEnv, readBanner, type Run, runPnpm } from './local-harness.ts';
import {
  callTool,
  clickInWidget,
  dockState,
  errorCode,
  maskCode,
  type ToolOutcome,
  waitForDock,
  waitForLink,
  widgetEvaluate,
  widgetVisible,
} from './tabdock-harness.ts';

const headed = process.argv.includes('--headed');
const FIXED_TOOLS = ['list_pages', 'pair_page', 'list_page_tools', 'call_page_tool', 'detach_page'];
const LAPTOP = { viewport: { width: 1280, height: 1200 } };

/** Pairing codes seen so far, which must never be printed whole. */
const codes = new Set<string>();
let ownerToken: string | null = null;
let unexpected = 0;

/** Prints a line, unless it would print a secret: then the secret is hidden and the run fails. */
function say(text: string): void {
  let line = text;
  for (const code of codes) {
    if (line.includes(code)) {
      line = line.split(code).join('[hidden]');
      unexpected += 1;
      console.log('   UNEXPECTED: a pairing code was about to be printed, and was hidden');
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
    say(`   result  ${outcome.text.slice(firstLine.length + 1, firstLine.length + 141)}`);
  } else say(`   result  ${outcome.text.slice(0, 160)}`);
  const got = outcome.isError ? (errorCode(outcome) ?? 'error') : 'ok';
  check(got === expected, `${label}: expected ${expected}, got ${got}`);
}

interface DemoClient {
  name: string;
  client: Client;
  /** The questions its elicitation handler answered, if it declares form elicitation. */
  asked: ElicitRequestFormParams[];
}

/**
 * An SDK client 2.3.0 with the owner token, as the printed line hands it to
 * Claude Code: pinned to 2026-07-28 when `modern`, else on the SDK's default
 * 2025-11-25 session; declaring form elicitation, and accepting every
 * question, when `confirming`.
 */
async function demoClient(
  mcpUrl: string,
  token: string,
  name: string,
  modern: boolean,
  confirming: boolean,
): Promise<DemoClient> {
  const asked: ElicitRequestFormParams[] = [];
  const client = new Client(
    { name, version: '1.0.0' },
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
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return { name, client, asked };
}

/** Whether a client holds a 2025-era session. The id itself is never printed. */
function hasSession(client: Client): boolean {
  const transport = client.transport;
  return transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined;
}

/** The names a client lists, asked afresh: a 2026-07-28 list is otherwise cached for 10 s. */
async function toolNames(client: Client): Promise<string[]> {
  return (await client.listTools(undefined, { cacheMode: 'refresh' })).tools.map(
    (tool) => tool.name,
  );
}

/** Lists until the page's tools have all reached the relay, since they follow the link by a moment. */
async function listedWith(client: Client, pageId: string): Promise<string[]> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const names = await toolNames(client);
    if (DEMO_TOOL_NAMES.every((tool) => names.includes(`${pageId}__${tool}`))) return names;
    if (Date.now() > deadline) return names;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function linkedBoard(browser: Browser, url: string): Promise<{ page: Page; pageId: string }> {
  const context = await browser.newContext(LAPTOP);
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  codes.add(code);
  return { page, pageId };
}

/** Codes a pairing has used up; each works once. */
const used = new Set<string>();

/** The code the board shows now, once it has replaced any code a pairing used up. */
async function freshCode(page: Page): Promise<string> {
  const code = await waitForDock(page, (state) =>
    state.pairing !== null && !used.has(state.pairing.code) ? state.pairing.code : null,
  );
  codes.add(code);
  used.add(code);
  return code;
}

/** pair_page by the board's code; the operator clicks Allow as driver in the widget if asked. */
async function pair(through: DemoClient, page: Page): Promise<ToolOutcome> {
  const code = await freshCode(page);
  say(`tools/call pair_page { code: "${maskCode(code)}" } from ${through.name}`);
  const call = { done: false };
  const pairing = callTool(through.client, 'pair_page', { code }).finally(() => {
    call.done = true;
  });
  // Handled where the caller awaits it; this keeps a refusal from counting as unhandled meanwhile.
  pairing.catch(() => undefined);
  // A person already attached joins at once; anyone else waits for the operator.
  while (!call.done) {
    const asking = (await dockState(page))?.pendingRequests[0];
    if (asking !== undefined) {
      say(
        `   the widget asks its operator about "${asking.user.displayName}" via ${asking.via} from ${asking.client?.name ?? '(unnamed)'}; the operator clicks Allow as driver`,
      );
      await clickInWidget(page, { action: 'approve-driver', requestId: asking.requestId });
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pairing;
}

/** A call, with whether the board raised a confirmation prompt at any point while it ran. */
async function watchingPrompts(
  page: Page,
  call: Promise<ToolOutcome>,
): Promise<{ outcome: ToolOutcome; prompted: boolean }> {
  const running = { done: false };
  let prompted = false;
  const settled = call.finally(() => {
    running.done = true;
  });
  // Handled where it is awaited below; this keeps a refusal from counting as unhandled meanwhile.
  settled.catch(() => undefined);
  while (!running.done) {
    if (((await dockState(page))?.pendingConfirms.length ?? 0) > 0) prompted = true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { outcome: await settled, prompted };
}

/** The relay's `mcp client` line for a client, from what pnpm dev printed (ADR 0027). */
function clientLine(dev: Run, name: string): Record<string, unknown> | null {
  for (const text of dev.stderr().split('\n')) {
    if (!text.startsWith('{')) continue;
    try {
      const entry = JSON.parse(text) as Record<string, unknown>;
      if (entry.msg === 'mcp client' && entry.client === name) return entry;
    } catch {
      // Not a log line.
    }
  }
  return null;
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

/** Each activity line's text and its page-built "confirmed in" badges, as the widget draws them. */
const READ_LINES = `function () {
  return Array.from(this.children, (li) => ({
    text: li.textContent || '',
    badges: Array.from(li.querySelectorAll('[data-role="confirmed"]'), (el) => el.textContent),
  }));
}`;

say('Tabdock M5: first-class page tools on both MCP revisions, and confirmation in the client\n');
// Not the shared temporary directory, where local mode refuses its token (ADR 0028's notes).
const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-demo-m5-')));
let browser: Browser | undefined;
let dev: Run | undefined;
const clients: DemoClient[] = [];
try {
  browser = await launchChromium(!headed);
  const home = join(scratch, 'tabdock home');
  say('Part one: first-class page tools (ADR 0025)\n');
  say('1. pnpm dev in local mode, with a throwaway TABDOCK_HOME and TABDOCK_FIRST_CLASS_TOOLS=1.');
  // The board's ?e2e hook, which drives it here, exists only under a key pnpm dev is given.
  const e2eKey = randomBytes(16).toString('base64url');
  dev = runPnpm(['dev'], {
    ...blankEnv(),
    TABDOCK_HOME: home,
    TABDOCK_PORT: '0',
    DEMO_PORT: '0',
    DEMO_E2E_KEY: e2eKey,
    TABDOCK_FIRST_CLASS_TOOLS: '1',
  });
  await dev.waitFor('Relay logs follow');
  const printed = dev.stdout();
  const banner = readBanner(printed);
  ownerToken = readFileSync(banner.tokenPath, 'latin1').trim();
  const started = dev
    .stderr()
    .split('\n')
    .find((line) => line.includes('"relay listening"'));
  const firstClassOn = started?.includes('"firstClassTools":true') === true;
  say(
    `   MCP endpoint ${banner.mcpUrl}, loopback only; the start line says firstClassTools ${String(firstClassOn)}.`,
  );
  check(firstClassOn, 'the relay should start with first-class tools on');
  say(`   The owner token stays in ${banner.tokenPath}; each client reads it from there.`);

  const demoLink = /Demo board linked to the relay: (\S+)/.exec(printed)?.[1] ?? '';
  const boardUrl = new URL(demoLink);
  boardUrl.searchParams.set('e2e', e2eKey);
  const board = await linkedBoard(browser, boardUrl.href);
  say(
    `\n2. The demo board it printed, open in Chromium ${browser.version()}, is linked as ${board.pageId}.`,
  );

  const modern = await demoClient(banner.mcpUrl, ownerToken, 'demo-2026-07-28', true, true);
  clients.push(modern);
  const legacy = await demoClient(banner.mcpUrl, ownerToken, 'demo-2025-11-25', false, true);
  clients.push(legacy);
  say('\n3. Two MCP clients (the SDK, 2.3.0) connect with the owner token:');
  for (const each of [modern, legacy]) {
    const revision = each.client.getNegotiatedProtocolVersion() ?? 'unknown';
    say(
      `   ${each.name.padEnd(16)} MCP ${revision}, ${hasSession(each.client) ? 'on a session' : 'no session; every request names the client'}`,
    );
  }
  check(
    modern.client.getNegotiatedProtocolVersion() === '2026-07-28' && !hasSession(modern.client),
    'the pinned client should speak 2026-07-28 with no session',
  );
  check(
    legacy.client.getNegotiatedProtocolVersion() === '2025-11-25' && hasSession(legacy.client),
    'the default client should speak 2025-11-25 on a session',
  );
  const before = await toolNames(modern.client);
  say(`   tools/list before pairing: ${before.join(', ')}`);
  check(
    before.length === FIXED_TOOLS.length && FIXED_TOOLS.every((name) => before.includes(name)),
    'a client attached to nothing should list the five fixed tools alone',
  );

  say('\n4. The 2026-07-28 client pairs with the code the board shows.');
  report('pair_page from demo-2026-07-28', await pair(modern, board.page), 'ok');
  const afterModern = await listedWith(modern.client, board.pageId);
  const firstClass = afterModern.filter((name) => name.includes('__'));
  say(`   tools/list now adds ${String(firstClass.length)} first-class names:`);
  say(`   ${firstClass.join(', ')}`);
  check(
    DEMO_TOOL_NAMES.every((tool) => firstClass.includes(`${board.pageId}__${tool}`)),
    'each of the board tools should be listed as <page id>__<tool>',
  );
  const entry = (await modern.client.listTools()).tools.find(
    (tool) => tool.name === `${board.pageId}__add_item`,
  );
  say(`   ${board.pageId}__add_item's description starts with the relay's own prefix:`);
  say(`   "${(entry?.description ?? '').slice(0, 150)}..."`);
  check(
    entry?.description?.startsWith('[tabdock') === true,
    'a first-class description should start with the relay prefix',
  );
  say(`tools/call ${board.pageId}__add_item { label: "From 2026-07-28" } from demo-2026-07-28`);
  report(
    'first-class add_item on 2026-07-28',
    await callTool(modern.client, `${board.pageId}__add_item`, {
      label: 'From 2026-07-28',
      x: -80,
      y: 0,
    }),
    'ok',
  );

  say('\n5. The 2025-11-25 client pairs with the next code.');
  const legacyPairing = await pair(legacy, board.page);
  report('pair_page from demo-2025-11-25', legacyPairing, 'ok');
  check(
    legacyPairing.text.includes('already attached'),
    'the same account should join its attachment without asking the operator',
  );
  say('   The same account is attached already, so its second client joins without a prompt.');
  const afterLegacy = await listedWith(legacy.client, board.pageId);
  check(
    DEMO_TOOL_NAMES.every((tool) => afterLegacy.includes(`${board.pageId}__${tool}`)),
    'the session client should list the same first-class names',
  );
  say(
    `   Its tools/list holds the same ${String(afterLegacy.filter((name) => name.includes('__')).length)} first-class names.`,
  );
  say(`tools/call ${board.pageId}__list_items {} from demo-2025-11-25`);
  report(
    'first-class list_items on 2025-11-25',
    await callTool(legacy.client, `${board.pageId}__list_items`, {}),
    'ok',
  );
  say("   The relay's mcp client lines name each client's leg and revision (ADR 0027):");
  for (const each of [modern, legacy]) {
    const line = clientLine(dev, each.name);
    say(
      `   ${each.name.padEnd(16)} leg ${String(line?.leg)}, revision ${String(line?.revision)}, form elicitation ${String(line?.formElicitation)}`,
    );
    check(
      line?.revision === each.client.getNegotiatedProtocolVersion(),
      `the relay should log ${each.name}'s revision`,
    );
  }
  const roster = (await dockState(board.page))?.roster ?? [];
  say(
    `   The board's roster: ${roster.map((who) => `${who.displayName} (${who.role}) with ${who.clients.map((c) => c.name).join(' and ')}`).join('; ')}`,
  );

  say('\nPart two: a consequential call confirmed in the client (ADR 0026)\n');
  const confirmUrl = new URL(boardUrl);
  confirmUrl.searchParams.set('confirm', 'client');
  const second = await linkedBoard(browser, confirmUrl.href);
  const policy = (await dockState(second.page))?.policy;
  say(
    `6. A second board, opened with ?confirm=client (confirmVia "${policy?.confirmVia ?? ''}"), is linked as ${second.pageId}.`,
  );
  check(policy?.confirmVia === 'client', 'the second board should opt in');
  say(
    '   clear_board is consequential, and this board lets a member driver confirm it in the client.',
  );
  report('pair_page with the second board', await pair(modern, second.page), 'ok');
  const both = await listedWith(modern.client, second.pageId);
  say(
    `   The account now holds two pages, so each client lists ${String(both.filter((name) => name.includes('__')).length)} first-class names.`,
  );

  const clearBy = async (who: DemoClient, label: string): Promise<boolean> => {
    say(`tools/call ${second.pageId}__add_item { label: "${label}" } from ${who.name}`);
    report(
      `add_item from ${who.name}`,
      await callTool(who.client, `${second.pageId}__add_item`, { label, x: 0, y: 0 }),
      'ok',
    );
    say(`tools/call ${second.pageId}__clear_board {} from ${who.name}`);
    const { outcome, prompted } = await watchingPrompts(
      second.page,
      callTool(who.client, `${second.pageId}__clear_board`, {}),
    );
    report(`clear_board from ${who.name}`, outcome, 'ok');
    return prompted;
  };

  say(
    '\n7. The 2026-07-28 client clears the board. The relay answers input_required, the client asks',
  );
  say(
    '   its own person (here its elicitation handler, which accepts) and retries with the answer.',
  );
  const modernPrompted = await clearBy(modern, 'Confirmed on 2026-07-28');
  const question = modern.asked.at(-1)?.message ?? '';
  say("   The question, in the relay's words (never the page's title or descriptions):");
  for (const line of question.split('\n')) say(`   | ${line}`);
  check(modern.asked.length === 1, 'the 2026-07-28 client should be asked once');
  check(!modernPrompted, 'the board should raise no prompt for a call confirmed in the client');
  const modernEntry = (await dockState(second.page))?.activity[0];
  say(
    `   The board raised no prompt; its activity log has ${modernEntry?.tool ?? '?'} ${modernEntry?.outcome ?? '?'}, confirmed by ${modernEntry?.confirmedBy ?? 'nobody'}.`,
  );
  check(
    modernEntry?.tool === 'clear_board' && modernEntry.confirmedBy === 'client',
    'the activity log should mark the call confirmed in the client',
  );

  say('\n8. The 2025-11-25 client, the same account, needs no pairing of its own for this board.');
  say('   On its session the relay asks with elicitation/create inside the call instead.');
  const legacyPrompted = await clearBy(legacy, 'Confirmed on 2025-11-25');
  check(legacy.asked.length === 1, 'the 2025-11-25 client should be asked once');
  check(!legacyPrompted, 'the board should raise no prompt for a call confirmed in the client');
  const legacyEntry = (await dockState(second.page))?.activity[0];
  say(
    `   Asked ${String(legacy.asked.length)} time(s), accepted; the board raised no prompt and logs it confirmed by ${legacyEntry?.confirmedBy ?? 'nobody'}.`,
  );
  check(legacyEntry?.confirmedBy === 'client', 'the call should be logged confirmed in the client');

  say(
    '\n9. A third client of the same account, which declares no form elicitation, clears it too.',
  );
  const plain = await demoClient(banner.mcpUrl, ownerToken, 'demo-no-elicitation', true, false);
  clients.push(plain);
  say(
    `tools/call ${second.pageId}__add_item { label: "Confirmed on the page" } from ${plain.name}`,
  );
  report(
    'add_item from demo-no-elicitation',
    await callTool(plain.client, `${second.pageId}__add_item`, {
      label: 'Confirmed on the page',
      x: 0,
      y: 0,
    }),
    'ok',
  );
  say(`tools/call ${second.pageId}__clear_board {} from demo-no-elicitation`);
  const clearing = callTool(plain.client, `${second.pageId}__clear_board`, {});
  const confirm = await waitForDock(second.page, (state) => state.pendingConfirms[0]);
  say(
    `   The board asks its operator instead, to confirm ${confirm.tool} for ${confirm.caller.displayName} from ${confirm.caller.client?.name ?? '(unnamed)'}; the demo clicks Allow on the page.`,
  );
  await clickInWidget(second.page, { action: 'confirm-allow', callId: confirm.callId });
  report('clear_board confirmed on the page', await clearing, 'ok');
  const plainEntry = (await dockState(second.page))?.activity[0];
  check(
    plainEntry?.tool === 'clear_board' && plainEntry.confirmedBy === null,
    'a call the operator confirmed should not be marked confirmed in the client',
  );

  if (!(await widgetVisible(second.page, 'activity'))) {
    await clickInWidget(second.page, { action: 'toggle' });
  }
  for (let tries = 0; !(await widgetVisible(second.page, 'activity')); tries += 1) {
    if (tries > 100) throw new Error("the widget's activity log did not open");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const lines = (await widgetEvaluate(second.page, 'activity', READ_LINES)) as {
    text: string;
    badges: string[];
  }[];
  const badges = lines.flatMap((line) => line.badges);
  say("   The widget's activity log draws its own badge on the two calls a client confirmed:");
  for (const badge of badges) say(`   ${badge}`);
  check(badges.length === 2, 'two activity lines should carry a "confirmed in" badge');

  say(
    '\n10. pnpm dev stops, and the audit log tells which calls a client confirmed (pnpm audit:log):',
  );
  for (const each of clients.splice(0)) await each.client.close().catch(() => undefined);
  await dev.stop();
  const devOutput = `${dev.stdout()}\n${dev.stderr()}`;
  const devLeak = leakIn(devOutput, ownerToken);
  check(devLeak === null, `pnpm dev printed ${devLeak ?? 'nothing'} of the owner token`);
  check(
    [...codes].every((code) => !devOutput.includes(code)),
    'pnpm dev printed a pairing code',
  );
  const auditDir = join(home, 'audit');
  const calls = await auditLog(auditDir, ['--json', '--type', 'call']);
  const records = calls.out
    .map((line) => AuditLineSchema.parse(JSON.parse(line)))
    .filter((record) => record.type === 'call');
  for (const record of records) {
    say(
      `   ${String(record.seq).padStart(3)} call  ${(record.client?.name ?? '(no client)').padEnd(19)} ${record.tool.padEnd(11)} ${record.outcome}${record.confirmedBy === undefined ? '' : `, confirmedBy ${record.confirmedBy}`}`,
    );
  }
  check(calls.code === 0, 'pnpm audit:log should read the log');
  const confirmedInClient = records.filter(
    (record) => record.tool === 'clear_board' && record.confirmedBy === 'client',
  ).length;
  check(confirmedInClient === 2, 'two clear_board records should carry confirmedBy client');
  const verified = await auditLog(auditDir, ['--verify']);
  say(`   pnpm audit:log --verify: ${verified.err.at(-1) ?? '(nothing)'}`);
  check(verified.code === 0, 'the audit chain should verify');
  say(
    `   Of the ${String(devOutput.split('\n').length)} lines pnpm dev printed, none holds the owner token or a pairing code.`,
  );

  if (headed) {
    say('\nThe browser stays open for 30 s so you can look at the boards.');
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
  for (const each of clients) await each.client.close().catch(() => undefined);
  await browser?.close();
  await dev?.stop();
  rmSync(scratch, { recursive: true, force: true });
}
