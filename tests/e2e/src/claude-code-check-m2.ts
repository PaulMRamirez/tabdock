// The M2 re-check with the real Claude Code CLI, headless:
//   node src/claude-code-check-m2.ts   (from tests/e2e)
// Needs `claude` on PATH and signed in; it spends a few model calls.
//
// M1's check, run against the M2 relay, plus what M2 gives the operator: the
// widget's roster names Claude Code's client under its user, and Claude's
// write shows in the page's activity log with that client. The operator here
// approves with a real mouse click on Allow as driver inside the widget's
// closed shadow root, as a person would, rather than through the test hook.
// The script also reports which MCP leg Claude Code took (ADR 0009), but
// passes on either, since that depends on the CLI's protocol revision.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { launchChromium } from './harness.ts';
import {
  activityStrip,
  clickInWidget,
  dockState,
  maskCode,
  startTabdock,
  waitForLink,
  widgetItems,
} from './tabdock-harness.ts';

const SERVER = 'tabdock';
const CLIENT = 'claude-code';
const LABEL = 'Claude was here in M2';
/** Claude Code expands ${VAR} in headers, so the token reaches it through the environment and never touches disk. */
const TOKEN_VARIABLE = 'TABDOCK_DEV_TOKEN';

const tool = (name: string) => `mcp__${SERVER}__${name}`;

/** The relay's log lines, kept in memory for the checks below and never printed. */
const relayLogs: string[] = [];
const tabdock = await startTabdock({
  logLevel: 'debug',
  logSink: (line) => {
    relayLogs.push(line);
  },
});
let browser: Browser | undefined;
const dir = await mkdtemp(join(tmpdir(), 'tabdock-m2-claude-'));
const operator = { stop: false, approved: [] as string[], failures: [] as string[] };
/** Every pairing code the page showed; masked wherever text from Claude is printed. */
const codes = new Set<string>();

try {
  browser = await launchChromium(true);
  // Tall enough that the widget's panel never scrolls, which would move its buttons and disarm them.
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);
  codes.add(code);

  const configPath = join(dir, 'mcp.json');
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        [SERVER]: {
          type: 'http',
          url: tabdock.relay.mcpUrl,
          headers: { Authorization: `Bearer \${${TOKEN_VARIABLE}}` },
        },
      },
    }),
  );

  const operatorLoop = approveAliceByClick(page);

  const prompt = [
    `You are connected to Tabdock through the MCP server "${SERVER}". Tabdock attaches you to live web pages whose operator approves you.`,
    'Do these steps with those tools and nothing else:',
    `1. Call pair_page with the code ${code}. The page's operator will approve the request.`,
    '2. Call list_pages and find the page titled "Tabdock demo board".',
    '3. Call call_page_tool on that page with tool "get_view" and arguments {} and report the zoom.',
    `4. Call call_page_tool on that page with tool "add_item" and arguments {"label": "${LABEL}", "x": 100, "y": 100, "color": "green"}.`,
    'Finish with one line: the page id, the new item id and the tool names you used.',
  ].join('\n');

  console.log(`Running claude -p against the Tabdock relay at ${tabdock.relay.mcpUrl}...`);
  // Run from the temp directory so the repo's own CLAUDE.md and settings stay out of the session.
  const output = await run(dir, 'claude', [
    '-p',
    prompt,
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    // Only the tools the prompt needs; the rest are denied outright, and dontAsk
    // refuses anything else instead of prompting, whatever the owner's settings say.
    '--allowedTools',
    ['pair_page', 'list_pages', 'call_page_tool'].map(tool).join(','),
    '--disallowedTools',
    ['list_page_tools', 'detach_page'].map(tool).join(','),
    '--permission-mode',
    'dontAsk',
    '--max-turns',
    '12',
    '--output-format',
    'json',
  ]);
  operator.stop = true;
  await operatorLoop;

  const state = await dockState(page);
  // The code rotates after use; the fresh one stays out of the output too.
  if (state?.pairing) codes.add(state.pairing.code);

  const parsed = JSON.parse(output) as { result?: string; num_turns?: number; is_error?: boolean };
  console.log(
    `\nClaude Code answered (${String(parsed.num_turns)} turns):\n${mask(parsed.result ?? output)}\n`,
  );
  console.log(
    `The operator clicked Allow as driver for ${String(operator.approved.length)} attach request(s).`,
  );
  for (const failure of operator.failures) console.log(`   operator failed: ${failure}`);

  // The roster, as the page holds it and as the widget shows it.
  const roster = state?.roster ?? [];
  console.log('Page roster:');
  for (const entry of roster) {
    const clients = entry.clients.map((c) => `${c.name} ${c.version}`).join(', ') || '(none)';
    console.log(`   ${entry.displayName} (${entry.role}): ${clients}`);
  }
  const alice = roster.find((entry) => entry.userId === 'alice');
  const rosterNamesClaude =
    alice?.role === 'driver' && alice.clients.some((client) => client.name === CLIENT);
  const row = (await widgetItems(page, 'roster')).find((item) => item.data.userId === 'alice');
  const rowNamesClaude = row !== undefined && /Clients: (?:.*, )?claude-code /.test(row.text);

  // Claude's write, in the page's activity log and on the widget's activity list.
  const activity = state?.activity ?? [];
  const lines = await widgetItems(page, 'activity');
  console.log('Widget activity list, newest first:');
  for (const line of lines) console.log(`   ${line.text}`);
  const write = activity.find(
    (entry) =>
      entry.tool === 'add_item' &&
      entry.outcome === 'ok' &&
      entry.user.userId === 'alice' &&
      entry.client?.name === CLIENT,
  );
  const writeLine = write && lines.find((line) => line.data.activityId === write.callId);
  const lineNamesClaude =
    writeLine?.data.outcome === 'ok' &&
    /^\S+ Alice via "claude-code \S+": add_item, ok in \d+ ms$/.test(writeLine.text);

  const strip = await activityStrip(page);
  console.log("The demo page's own activity strip, newest first:");
  for (const line of strip) console.log(`   ${line}`);
  const audit = tabdock.relay.audit.records();
  console.log('Relay audit log:');
  for (const record of audit) {
    const client = record.client ? `${record.client.name} ${record.client.version}` : '(unnamed)';
    console.log(`   ${record.userId}  ${client}  ${record.tool}  ${record.outcome}`);
  }
  const called = (name: string) =>
    audit.some(
      (r) =>
        r.pageId === pageId && r.tool === name && r.outcome === 'ok' && r.client?.name === CLIENT,
    );

  const entries = relayLogs.map((line) => JSON.parse(line) as Record<string, unknown>);
  // A 2025-era client opens a session on the sessionful leg; a 2026-07-28 one opens none.
  const sessions = entries.filter(
    (entry) => entry.msg === 'MCP session opened' && entry.userId === 'alice',
  ).length;
  console.log(
    sessions > 0
      ? `Claude Code spoke a 2025-era revision: ${String(sessions)} MCP session(s) on the sessionful leg.`
      : 'Claude Code spoke revision 2026-07-28: no MCP session was opened.',
  );
  // Only the messages, which are fixed relay text; the fields stay unprinted.
  const troubles = new Set(
    entries
      .filter((entry) => entry.level === 'warn' || entry.level === 'error')
      .map((entry) => String(entry.msg)),
  );
  console.log(
    troubles.size === 0
      ? 'The relay logged no warnings or errors.'
      : `The relay logged warnings or errors: ${[...troubles].join('; ')}`,
  );

  // S11: neither the token nor any code reached the relay's log, debug lines included.
  const secrets = [tabdock.users.alice.token, ...codes];
  const leaks = secrets.filter((secret) => relayLogs.some((line) => line.includes(secret))).length;

  const checks: [string, boolean][] = [
    ['one approval, clicked in the widget', operator.approved.length === 1],
    ['the page roster lists Alice as driver with the claude-code client', rosterNamesClaude],
    ["the widget's roster row names claude-code", rowNamesClaude],
    ["the page's activity log has Claude's add_item, ok, via claude-code", write !== undefined],
    ["the widget's activity list shows that line", lineNamesClaude],
    [
      'the relay audit names claude-code for get_view and add_item',
      called('get_view') && called('add_item'),
    ],
    ['the board ran add_item', strip.some((line) => line.includes('add_item: added'))],
    ['no token or code in the relay log', leaks === 0],
  ];
  console.log('');
  for (const [name, ok] of checks) console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${name}`);
  const passed = checks.every(([, ok]) => ok) && parsed.is_error !== true;
  console.log(
    passed
      ? '\nM2 Claude Code check PASS: the roster and the activity log name Claude Code, and its write ran on the page.'
      : '\nM2 Claude Code check FAIL',
  );
  process.exitCode = passed ? 0 : 1;
} catch (error) {
  console.log(
    `M2 Claude Code check FAIL: ${mask(error instanceof Error ? error.message : String(error))}`,
  );
  process.exitCode = 1;
} finally {
  operator.stop = true;
  await browser?.close();
  await tabdock.close();
  await rm(dir, { recursive: true, force: true });
}

/** Text from Claude or its CLI with every pairing code masked, since the prompt carried one. */
function mask(text: string): string {
  let masked = text;
  for (const known of codes) masked = masked.split(known).join(maskCode(known));
  return masked;
}

/** Clicks Allow as driver on every attach request from alice, until told to stop. */
async function approveAliceByClick(page: Page): Promise<void> {
  while (!operator.stop) {
    const state = await dockState(page).catch(() => null);
    for (const request of state?.pendingRequests ?? []) {
      if (request.user.userId !== 'alice' || operator.approved.includes(request.requestId)) {
        continue;
      }
      try {
        await clickInWidget(page, { action: 'approve-driver', requestId: request.requestId });
        operator.approved.push(request.requestId);
        console.log(`   operator: clicked Allow as driver for ${request.user.displayName}`);
      } catch (error) {
        operator.failures.push(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    // Polls the page for a request; Claude decides when to ask, so there is nothing to await.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function run(cwd: string, command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, [TOKEN_VARIABLE]: tabdock.users.alice.token },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${String(code)}: ${stdout.slice(0, 500)}`));
    });
  });
}
