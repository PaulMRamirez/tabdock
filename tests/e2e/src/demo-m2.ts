// pnpm demo:m2: many clients and many users on one page, narrated.
//   --headed   watch the board and the Tabdock widget in a visible browser
// The relay runs in this process with two throwaway dev users and keeps its
// log in memory at debug level, where the write queue's 'call queued' lines
// record the order calls reached it; the demo reads them back. It never prints
// a token, and pairing codes only masked, as demo:m1 does (S11). The demo page
// runs the real adapter in Chromium.
// Three MCP clients from the official SDK share it: two of Alice's on both
// protocol eras and one of Bob's. The operator's answers and the revoke go
// through the page's control handle, which the demo exposes only under ?e2e;
// the widget's buttons call the same handle.

import { type Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Browser, Page } from '@playwright/test';
import type { ActivityEntry, DockState } from '@tabdock/adapter';
import { startDemoServer } from '@tabdock/demo/server';
import { createDevTokenAuth, createRelay, type Relay } from '@tabdock/relay';
import { launchChromium } from './harness.ts';
import {
  approveThroughHandle,
  callTool,
  connectMcp,
  demoPageUrl,
  dockState,
  errorCode,
  maskCode,
  throwawayUser,
  type ToolOutcome,
  waitForDock,
  waitForLink,
} from './tabdock-harness.ts';

const headed = process.argv.includes('--headed');
/** How many add_item calls the burst sends. */
const BURST = 10;

const say = (text: string): void => {
  console.log(text);
};

let unexpected = 0;
/** Counts a step that did not behave as the narration says it should. */
function check(ok: boolean, what: string): void {
  if (ok) return;
  unexpected += 1;
  say(`   UNEXPECTED: ${what}`);
}

/** Prints one outcome; expected is 'ok' or the error code the step should produce. */
function report(label: string, outcome: ToolOutcome, expected: string): void {
  const firstLine = outcome.text.split('\n', 1)[0] ?? '';
  if (outcome.isError) say(`   error   ${outcome.text.slice(0, 200)}`);
  else if (firstLine.startsWith('[tabdock: untrusted')) {
    say(`   result  ${outcome.text.slice(firstLine.length + 1, firstLine.length + 161)}`);
  } else say(`   result  ${outcome.text.slice(0, 160)}`);
  const got = outcome.isError ? (errorCode(outcome) ?? 'error') : 'ok';
  check(got === expected, `${label}: expected ${expected}, got ${got}`);
}

/** Polls a condition in this process (the relay's log) until it yields something. */
async function until<T>(
  pick: () => T | null | undefined | false,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const picked = pick();
    if (picked !== null && picked !== undefined && picked !== false) return picked;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function stateOf(page: Page): Promise<DockState> {
  const state = await dockState(page);
  if (!state) throw new Error('the page has no Tabdock handle');
  return state;
}

/** The code the page shows once it has replaced `previous`, which a pairing just used up. */
async function nextCode(page: Page, previous: string): Promise<string> {
  return waitForDock(page, (state) =>
    state.pairing !== null && state.pairing.code !== previous ? state.pairing.code : null,
  );
}

function clientName(entry: { client: { name: string } | null }): string {
  return entry.client?.name ?? '(unnamed)';
}

/** Whether a client holds a 2025-era session. The id itself is never printed. */
function hasSession(client: Client): boolean {
  const transport = client.transport;
  return transport instanceof StreamableHTTPClientTransport && transport.sessionId !== undefined;
}

const relayLines: string[] = [];

interface Queued {
  callId: string;
  userId: string;
  /** Calls ahead of it on the page when it arrived, the running one included. */
  ahead: number;
}

/** Every mutating call in the order it reached the relay, from the relay's own debug log. */
function queuedCalls(): Queued[] {
  const out: Queued[] = [];
  for (const line of relayLines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.msg !== 'call queued') continue;
    const { callId, userId, ahead } = entry;
    if (typeof callId === 'string' && typeof userId === 'string' && typeof ahead === 'number') {
      out.push({ callId, userId, ahead });
    }
  }
  return out;
}

say('Tabdock M2: two people and three MCP clients share one page through the Tabdock relay\n');
const users = { alice: throwawayUser('alice', 'Alice'), bob: throwawayUser('bob', 'Bob') };
const demo = await startDemoServer();
let relay: Relay | undefined;
let browser: Browser | undefined;
const clients: Client[] = [];
try {
  relay = await createRelay({
    auth: createDevTokenAuth([users.alice, users.bob]),
    port: 0,
    // A real browser always sends Origin; the dev default allows 127.0.0.1 at any port.
    allowMissingOrigin: false,
    logLevel: 'debug',
    logSink: (line) => {
      relayLines.push(line);
    },
  });
  const live = relay;
  say(`1. Relay on ${live.url}: MCP clients use ${live.mcpUrl}, pages dial ${live.pageUrl}.`);
  say('   Two throwaway dev users, alice and bob, with random tokens held in memory only.');

  browser = await launchChromium(!headed);
  const page = await browser.newPage();
  await page.goto(demoPageUrl(demo.url, live.pageUrl));
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  say(
    `2. Demo board open in Chromium ${browser.version()}; the adapter linked it as page ${pageId}.`,
  );
  say(
    `   The widget shows the pairing code ${maskCode(code)} (masked here: codes stay out of logs).\n`,
  );

  const connect = async (who: 'alice' | 'bob', name: string, modern: boolean) => {
    const client = await connectMcp(live, users[who], name, { modern });
    clients.push(client);
    return client;
  };
  const laptop = await connect('alice', 'alice-laptop', false);
  const phone = await connect('alice', 'alice-phone', true);
  const tablet = await connect('bob', 'bob-tablet', false);
  const named: [string, Client][] = [
    ['alice-laptop', laptop],
    ['alice-phone', phone],
    ['bob-tablet', tablet],
  ];
  say('3. Three MCP clients connect with their user bearer tokens:');
  for (const [name, client] of named) {
    const version = client.getNegotiatedProtocolVersion() ?? 'unknown';
    const how = hasSession(client)
      ? 'a session on the relay, which knows the client from initialize'
      : 'no session; every request names the client';
    say(`   ${name.padEnd(13)} MCP ${version}, ${how}`);
  }
  check(
    hasSession(laptop) && !hasSession(phone) && hasSession(tablet),
    'the 2025-era clients should hold sessions and the 2026-07-28 client none',
  );

  say('\n4. Each client pairs with the code the page shows; codes work once.');
  say(`tools/call pair_page { code: "${maskCode(code)}" } from alice-laptop`);
  const laptopPairing = callTool(laptop, 'pair_page', { code });
  const aliceAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'alice'),
  );
  say(
    `   the page shows "${aliceAsks.user.displayName} wants to attach via ${aliceAsks.via} from ${clientName(aliceAsks)}"; the operator allows as driver`,
  );
  check(await approveThroughHandle(page, aliceAsks.requestId, 'driver'), 'approve Alice');
  report('pair_page from alice-laptop', await laptopPairing, 'ok');

  const phoneCode = await nextCode(page, code);
  say(`tools/call pair_page { code: "${maskCode(phoneCode)}" } from alice-phone`);
  const phonePairing = await callTool(phone, 'pair_page', { code: phoneCode });
  report('pair_page from alice-phone', phonePairing, 'ok');
  check(
    phonePairing.text.includes('You were already attached.'),
    'alice-phone should join the attachment Alice already has',
  );
  say('   Alice is attached already, so her second client joins without asking the operator.');

  const tabletCode = await nextCode(page, phoneCode);
  say(`tools/call pair_page { code: "${maskCode(tabletCode)}" } from bob-tablet`);
  const tabletPairing = callTool(tablet, 'pair_page', { code: tabletCode });
  const bobAsks = await waitForDock(page, (state) =>
    state.pendingRequests.find((request) => request.user.userId === 'bob'),
  );
  say(
    `   the page shows "${bobAsks.user.displayName} wants to attach via ${bobAsks.via} from ${clientName(bobAsks)}"; the operator allows as observer`,
  );
  check(await approveThroughHandle(page, bobAsks.requestId, 'observer'), 'approve Bob');
  report('pair_page from bob-tablet', await tabletPairing, 'ok');

  const roster = await waitForDock(page, (state) =>
    state.roster.length === 2 && state.roster.flatMap((entry) => entry.clients).length === 3
      ? state.roster
      : null,
  );
  say('\n5. The roster on the page, as its operator sees it in the widget:');
  for (const entry of roster) {
    const names = entry.clients.map((client) => client.name).join(', ');
    const idleHours =
      entry.expiresAt === null
        ? null
        : (entry.expiresAt - (entry.lastUsedAt ?? entry.grantedAt)) / 3_600_000;
    say(
      `   ${entry.displayName.padEnd(6)} ${entry.role.padEnd(9)} clients: ${names}; ${idleHours === null ? 'never expires' : `expires after ${String(idleHours)} h without a call`}`,
    );
  }
  // Tools reach the relay right after the link comes up; wait until all six are listed.
  let toolCount = 0;
  for (let i = 0; i < 100 && toolCount !== 6; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 50));
    const listed = await callTool(laptop, 'list_pages');
    toolCount =
      (listed.structured as { pages?: { toolCount?: number }[] } | undefined)?.pages?.[0]
        ?.toolCount ?? 0;
  }
  say('   list_pages from each client:');
  for (const [name, client] of named) {
    const listed = await callTool(client, 'list_pages');
    const pages =
      (
        listed.structured as
          { pages?: { page: string; role: string; state: string; toolCount: number }[] } | undefined
      )?.pages ?? [];
    const first = pages[0];
    say(
      first
        ? `   ${name.padEnd(13)} page ${first.page} as ${first.role}, ${first.state}, ${String(first.toolCount)} tools`
        : `   ${name.padEnd(13)} ${listed.text.slice(0, 120)}`,
    );
    check(
      pages.length === 1 && first?.page === pageId && first.toolCount === 6,
      `list_pages from ${name} should list the board with its six tools`,
    );
  }

  const call = (client: Client, tool: string, args: Record<string, unknown> = {}) =>
    callTool(client, 'call_page_tool', { page: pageId, tool, arguments: args });

  say('\n6. Bob is an observer, so a write is refused before it reaches the page.');
  say('tools/call call_page_tool { tool: "add_item" } from bob-tablet');
  report(
    'observer write',
    await call(tablet, 'add_item', { label: 'From Bob', x: 0, y: 120 }),
    'role_denied',
  );
  check(
    (await stateOf(page)).activity.every((entry) => entry.tool !== 'add_item'),
    "the page's activity log should have no add_item from Bob",
  );
  say("   The page's activity log has no entry for it: the relay refused it alone.");

  say('\n7. A consequential write holds the queue, a burst of writes waits, and a read slips in.');
  say('tools/call call_page_tool { tool: "clear_board" } from alice-laptop');
  const clearing = call(laptop, 'clear_board');
  const prompt = await waitForDock(page, (state) => state.pendingConfirms[0]);
  say(
    `   the page asks "${prompt.caller.displayName} (${prompt.caller.client?.name ?? 'unnamed'}) wants to run ${prompt.tool}"; while the operator decides, this write holds the page`,
  );
  // clear_board's own line is in the log already: it reached the relay before the page prompted.
  const queuedBefore = queuedCalls().length;
  say(
    `   ${String(BURST)} add_item calls follow, none waiting for an answer, alternating alice-laptop and alice-phone`,
  );
  // Each is sent once the one before has reached the relay, so the clients
  // alternate in the arrival order too; all of them are in flight together.
  const burst: Promise<ToolOutcome>[] = [];
  for (let i = 0; i < BURST; i += 1) {
    burst.push(
      call(i % 2 === 0 ? laptop : phone, 'add_item', {
        label: `Burst ${String(i + 1)}`,
        x: -270 + i * 60,
        y: 150,
        color: i % 2 === 0 ? 'purple' : 'orange',
      }),
    );
    await until(
      () => queuedCalls().length === queuedBefore + i + 1,
      `burst write ${String(i + 1)} to reach the relay`,
    );
  }
  const arrivals = queuedCalls().slice(queuedBefore);
  say(
    `   the relay queued all ${String(arrivals.length)} behind clear_board; calls ahead of each on arrival: ${arrivals.map((entry) => String(entry.ahead)).join(', ')}`,
  );
  say('tools/call call_page_tool { tool: "get_view" } from bob-tablet (read-only)');
  const readStarted = Date.now();
  const read = await call(tablet, 'get_view');
  const readMs = Date.now() - readStarted;
  report('read during the burst', read, 'ok');
  const burstIds = new Set(arrivals.map((entry) => entry.callId));
  const during = await stateOf(page);
  const ranDuring = during.activity.filter((entry) => burstIds.has(entry.callId)).length;
  check(during.pendingConfirms.length === 1, 'the clear_board prompt should still be up');
  check(ranDuring === 0, `no write should have run yet, but ${String(ranDuring)} did`);
  say(
    `   the read went straight to the page and back in ${String(readMs)} ms, with the prompt still up and ${String(BURST - ranDuring)} writes still waiting`,
  );
  say('   the operator denies clear_board');
  check(
    await page.evaluate((id) => window.__tabdockDock?.confirm(id, false) ?? false, prompt.callId),
    'deny clear_board',
  );
  report('clear_board', await clearing, 'denied_by_operator');
  const burstOutcomes = await Promise.all(burst);
  burstOutcomes.forEach((outcome, i) => {
    if (outcome.isError) report(`burst write ${String(i + 1)}`, outcome, 'ok');
  });
  say(
    `   all ${String(burstOutcomes.filter((outcome) => !outcome.isError).length)} writes then ran. The page's activity log, in the order the page received them:`,
  );
  const ran = [...(await stateOf(page)).activity]
    .reverse()
    .filter((entry) => burstIds.has(entry.callId));
  const origin = ran[0]?.time ?? 0;
  say('   #   client        call id           on the page, ms after the first write arrived');
  ran.forEach((entry, i) => {
    const start = entry.time - origin;
    const end = start + (entry.durationMs ?? 0);
    say(
      `   ${String(i + 1).padEnd(3)} ${clientName(entry).padEnd(13)} ${entry.callId.padEnd(17)} +${String(start)} to +${String(end)} ms, ${entry.outcome}`,
    );
  });
  const overlaps = ran.filter((entry, i) => {
    const previous: ActivityEntry | undefined = ran[i - 1];
    return previous !== undefined && previous.time + (previous.durationMs ?? 0) > entry.time;
  }).length;
  const inArrivalOrder =
    ran.length === BURST && ran.every((entry, i) => entry.callId === arrivals[i]?.callId);
  check(overlaps === 0, `${String(overlaps)} writes started before the one ahead had ended`);
  check(inArrivalOrder, 'the page should run the writes in the order the relay received them');
  check(
    ran.every((entry) => entry.outcome === 'ok'),
    'every write in the burst should end ok on the page',
  );
  say(
    '   each write ended before the next began, in the order the relay logged them arriving (its call queued lines)',
  );

  say('\n8. Revoke in the middle of a call.');
  say('tools/call call_page_tool { tool: "clear_board" } from alice-phone');
  const revoking = call(phone, 'clear_board');
  const held = await waitForDock(page, (state) => state.pendingConfirms[0]);
  say(
    `   the call is on the page, waiting for the operator ("${held.caller.displayName} wants to run ${held.tool}"); the operator revokes Alice instead`,
  );
  check(await page.evaluate(() => window.__tabdockDock?.revoke('alice') ?? false), 'revoke Alice');
  report('call in flight at the revoke', await revoking, 'not_attached');
  const afterRevoke = await waitForDock(page, (state) =>
    state.pendingConfirms.length === 0 && state.roster.length === 1 ? state : null,
  );
  say(
    `   the prompt is gone from the page, and the roster lists ${afterRevoke.roster.map((entry) => `${entry.displayName} (${entry.role})`).join(', ')}`,
  );
  say('tools/call call_page_tool { tool: "get_view" } from alice-laptop');
  report('next call after the revoke', await call(laptop, 'get_view'), 'not_attached');
  const alicePages = await callTool(laptop, 'list_pages');
  check(
    ((alicePages.structured as { pages?: unknown[] } | undefined)?.pages ?? []).length === 0,
    'list_pages should be empty for Alice after the revoke',
  );
  say('tools/call call_page_tool { tool: "get_view" } from bob-tablet');
  report("Bob's read after Alice's revoke", await call(tablet, 'get_view'), 'ok');

  const final = await stateOf(page);
  say("\n9. The page's activity log (S7), oldest first: who, which client, what, how, how long");
  for (const entry of [...final.activity].reverse()) {
    say(
      `   ${new Date(entry.time).toISOString()}  ${entry.user.userId.padEnd(5)}  ${clientName(entry).padEnd(13)} ${entry.tool.padEnd(12)} ${entry.outcome} in ${String(entry.durationMs ?? 0)} ms`,
    );
  }

  say(
    '\n10. The relay audit log (S7: who, which client, what, when, how; never the arguments), in the order calls ended:',
  );
  for (const record of live.audit.records()) {
    const client = record.client ? record.client.name : '(unnamed)';
    say(
      `   ${new Date(record.at).toISOString()}  ${record.userId.padEnd(5)}  ${client.padEnd(13)} ${record.tool.padEnd(12)} ${record.outcome} in ${String(record.durationMs)} ms`,
    );
  }

  if (headed) {
    say('\nBrowser stays open for 30 s so you can look at the board and the widget.');
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
  for (const client of clients) await client.close();
  await browser?.close();
  await relay?.close();
  await demo.close();
}
