// A1.2 with the real Claude Code CLI, headless:
//   pnpm --filter @tabdock/e2e check:claude-code:m1
// Needs `claude` on PATH and signed in; it spends a few model calls.
//
// The Tabdock relay runs here with a throwaway dev user, and the demo board
// runs the real adapter in headless Chromium. Claude Code reaches the relay as
// an HTTP MCP server with a bearer header, pairs with the code this script
// reads off the page, and drives the board. A loop here plays the operator:
// it approves Claude's attach request as driver once it shows up on the page.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from '@playwright/test';
import { launchChromium } from './harness.ts';
import {
  activityStrip,
  approveThroughHandle,
  dockState,
  startTabdock,
  waitForLink,
} from './tabdock-harness.ts';

const SERVER = 'tabdock';
const LABEL = 'Claude was here';
/** Claude Code expands ${VAR} in headers, so the token reaches it through the environment and never touches disk. */
const TOKEN_VARIABLE = 'TABDOCK_DEV_TOKEN';

const tool = (name: string) => `mcp__${SERVER}__${name}`;

const tabdock = await startTabdock();
let browser: Browser | undefined;
const dir = await mkdtemp(join(tmpdir(), 'tabdock-a12-'));
const operator = { stop: false, approved: [] as string[] };
try {
  browser = await launchChromium(true);
  const page = await browser.newPage();
  await page.goto(tabdock.pageUrl);
  await page.waitForSelector('html[data-tools="ready"]');
  const { pageId, code } = await waitForLink(page);

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

  const operatorLoop = approveAlice(page);

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

  const parsed = JSON.parse(output) as { result?: string; num_turns?: number; is_error?: boolean };
  console.log(
    `\nClaude Code answered (${String(parsed.num_turns)} turns):\n${parsed.result ?? output}\n`,
  );

  console.log(`The operator loop approved ${String(operator.approved.length)} attach request(s).`);
  const strip = await activityStrip(page);
  console.log('Page activity strip, newest first:');
  for (const line of strip) console.log(`   ${line}`);
  const audit = tabdock.relay.audit.records();
  console.log('Relay audit log:');
  for (const record of audit) {
    const client = record.client ? `${record.client.name} ${record.client.version}` : '(unnamed)';
    console.log(`   ${record.userId}  ${client}  ${record.tool}  ${record.outcome}`);
  }
  const roster = (await dockState(page))?.roster ?? [];

  const called = (name: string) =>
    audit.some((r) => r.pageId === pageId && r.tool === name && r.outcome === 'ok');
  // Proof that Claude Code itself made the calls, not some other client with the token.
  // Its version varies by install, so only the name is checked.
  const byClaudeCode = audit.some((r) => r.pageId === pageId && r.client?.name === 'claude-code');
  if (!byClaudeCode) console.log('No audit record names the client claude-code.');
  const passed =
    operator.approved.length === 1 &&
    roster.some((a) => a.userId === 'alice' && a.role === 'driver') &&
    called('get_view') &&
    called('add_item') &&
    byClaudeCode &&
    strip.some((line) => line.includes('get_view: read the view')) &&
    strip.some((line) => line.includes('add_item: added'));
  console.log(
    passed
      ? '\nA1.2 PASS: Claude Code paired by code, was approved on the page, and called its tools through the relay.'
      : '\nA1.2 FAIL',
  );
  process.exitCode = passed && parsed.is_error !== true ? 0 : 1;
} catch (error) {
  console.log(`A1.2 FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  operator.stop = true;
  await browser?.close();
  await tabdock.close();
  await rm(dir, { recursive: true, force: true });
}

/** Approves every attach request from alice as driver, until told to stop. */
async function approveAlice(page: Page): Promise<void> {
  while (!operator.stop) {
    const state = await dockState(page).catch(() => null);
    for (const request of state?.pendingRequests ?? []) {
      if (request.user.userId !== 'alice' || operator.approved.includes(request.requestId))
        continue;
      if (await approveThroughHandle(page, request.requestId, 'driver')) {
        operator.approved.push(request.requestId);
        console.log(`   operator: approved ${request.user.displayName} as driver`);
      }
    }
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
