// pnpm demo:m1: the walking skeleton end to end, narrated.
//   --headed       watch the board and the Tabdock widget in a visible browser
//   --screenshot   also save the final board to docs/tour/img/m1-board.png
// The relay runs in this process with two throwaway dev users. The demo page
// runs the real adapter in Chromium and dials the relay. An MCP client (the
// official SDK over Streamable HTTP with a bearer header, standing in for
// Claude Code) pairs by the code on the page, and the operator's answers go
// through the page's control handle, which the demo exposes only under ?e2e.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Client } from '@modelcontextprotocol/client';
import type { Browser } from '@playwright/test';
import { launchChromium } from './harness.ts';
import {
  activityStrip,
  approveThroughHandle,
  callTool,
  connectMcp,
  errorCode,
  maskCode,
  startTabdock,
  waitForDock,
  waitForLink,
  type ToolOutcome,
} from './tabdock-harness.ts';

const headed = process.argv.includes('--headed');
const screenshotPath = fileURLToPath(
  new URL('../../../docs/tour/img/m1-board.png', import.meta.url),
);

const say = (text: string) => {
  console.log(text);
};

let unexpected = 0;
/** Prints one outcome and counts it when it is not what the step expected. */
/** expected is 'ok' or the error code the step should produce. */
function report(label: string, outcome: ToolOutcome, expected: string): void {
  const firstLine = outcome.text.split('\n', 1)[0] ?? '';
  const rest = outcome.text.slice(firstLine.length + 1);
  if (outcome.isError) say(`   error   ${outcome.text.slice(0, 300)}`);
  else if (firstLine.startsWith('[tabdock: untrusted')) {
    say(`   header  ${firstLine}`);
    say(`   result  ${rest.slice(0, 300)}`);
  } else say(`   result  ${outcome.text.slice(0, 300)}`);
  const got = outcome.isError ? (errorCode(outcome) ?? 'error') : 'ok';
  if (got !== expected) {
    unexpected += 1;
    say(`   UNEXPECTED in ${label}: expected ${expected}, got ${got}`);
  }
}

say('Tabdock M1: an MCP client attaches to the demo board through the Tabdock relay\n');
const tabdock = await startTabdock();
const { relay, users } = tabdock;
let browser: Browser | undefined;
let client: Client | undefined;
try {
  say(`1. Relay on ${relay.url}: MCP clients use ${relay.mcpUrl}, pages dial ${relay.pageUrl}.`);
  say(`   Two throwaway dev users, alice and bob, with random tokens held in memory only.`);
  browser = await launchChromium(!headed);
  const page = await browser.newPage();
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  say(
    `2. Demo board open in Chromium ${browser.version()}; the adapter linked it as page ${pageId}.`,
  );
  say(
    `   The widget in the corner shows a pairing code, ${maskCode(code)} (masked here: codes stay out of logs).`,
  );
  say('   Codes carry 50 bits, work once and live 120 s.\n');

  client = await connectMcp(relay, users.alice, 'tabdock-demo-m1', { modern: true });
  say('3. Alice connects an MCP client with her bearer token, speaking MCP 2026-07-28.\n');

  say('tools/call pair_page with a wrong code');
  report(
    'wrong code',
    await callTool(client, 'pair_page', { code: 'ZZZZZ-ZZZZZ' }),
    'pairing_expired',
  );

  say(`\ntools/call pair_page { code: "${maskCode(code)}" }`);
  const pairing = callTool(client, 'pair_page', { code });
  const request = await waitForDock(page, (state) => state.pendingRequests[0]);
  say(
    `   the page shows "${request.user.displayName} wants to attach via ${request.via}"; the operator allows as driver`,
  );
  await approveThroughHandle(page, request.requestId, 'driver');
  const paired = await pairing;
  report('pair_page', paired, 'ok');

  say('\ntools/call list_pages');
  // Tools reach the relay right after the link comes up; wait until all six are there.
  let pages = await callTool(client, 'list_pages');
  for (let i = 0; i < 40 && !pages.text.includes('"toolCount":6'); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    pages = await callTool(client, 'list_pages');
  }
  report('list_pages', pages, 'ok');

  say(`\ntools/call list_page_tools { page: "${pageId}" }`);
  const listed = await callTool(client, 'list_page_tools', { page: pageId });
  if (listed.isError) report('list_page_tools', listed, 'ok');
  else {
    const tools =
      (listed.structured as { tools?: { name: string; allowed: boolean }[] } | undefined)?.tools ??
      [];
    say(`   ${listed.text.split('\n', 1)[0] ?? ''}`);
    for (const tool of tools) say(`   ${tool.name.padEnd(16)} allowed: ${String(tool.allowed)}`);
    if (tools.length !== 6) {
      unexpected += 1;
      say(`   UNEXPECTED: ${String(tools.length)} tools, expected 6`);
    }
  }

  const call = async (tool: string, args: Record<string, unknown>, expected: string) => {
    say(`\ntools/call call_page_tool { tool: "${tool}", arguments: ${JSON.stringify(args)} }`);
    const outcome = await callTool(client as Client, 'call_page_tool', {
      page: pageId,
      tool,
      arguments: args,
    });
    report(tool, outcome, expected);
    return outcome;
  };

  await call('get_view', {}, 'ok');
  const added = await call(
    'add_item',
    { label: 'Hello from M1', x: 160, y: -120, color: 'purple' },
    'ok',
  );
  const itemId =
    (added.structured as { item?: { id?: string } } | undefined)?.item?.id ?? 'item-unknown';
  await call('highlight_item', { id: itemId }, 'ok');

  // S6: clear_board is consequential, so the page asks its operator, who says no.
  const clearing = call('clear_board', {}, 'denied_by_operator');
  const confirm = await waitForDock(page, (state) => state.pendingConfirms[0]);
  say(
    `   the page asks "${confirm.caller.displayName} wants to run ${confirm.tool}"; the operator denies`,
  );
  await page.evaluate((id) => window.__tabdockDock?.confirm(id, false), confirm.callId);
  await clearing;

  say("\nThe page's own activity strip, newest first:");
  for (const line of await activityStrip(page)) say(`   ${line}`);

  say('\nThe relay audit log (S7: who, which client, what, when, how; never the arguments):');
  for (const record of relay.audit.records()) {
    const client = record.client ? `${record.client.name} ${record.client.version}` : '(unnamed)';
    say(
      `   ${new Date(record.at).toISOString()}  ${record.userId}  ${client}  ${record.tool.padEnd(15)} ${record.outcome} in ${String(record.durationMs)} ms`,
    );
  }

  if (process.argv.includes('--screenshot')) {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    say(`\nSaved ${screenshotPath}`);
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
  await client?.close();
  await browser?.close();
  await tabdock.close();
}
