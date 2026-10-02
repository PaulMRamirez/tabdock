// A0.2 with the real Claude Code CLI, headless:
//   pnpm --filter @tabdock/e2e check:claude-code
// Needs `claude` on PATH and signed in; it spends a few model calls.
//
// The harness starts MCP-B's relay with the demo page attached. Claude Code then
// launches its own relay on the same port, which joins the first in MCP-B's
// client mode, so the page's tools are already there when Claude starts.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RELAY_CLI, relayHome, startBaseline } from './harness.ts';

const LABEL = 'Claude was here';
const SERVER = 'webmcp_relay';

const baseline = await startBaseline();
const dir = await mkdtemp(join(tmpdir(), 'tabdock-a02-'));
const home = await relayHome();
try {
  const origin = new URL(baseline.demo.url).origin;
  const configPath = join(dir, 'mcp.json');
  await writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        [SERVER]: {
          command: process.execPath,
          args: [RELAY_CLI, '--port', String(baseline.relayPort), '--widget-origin', origin],
          env: { HOME: home.env.HOME },
        },
      },
    }),
  );

  const prompt = [
    'You are connected to a web page called "Tabdock demo board" through MCP tools.',
    'Do these steps with the tools and nothing else:',
    '1. List the tools you have that belong to the demo board.',
    '2. Call get_view and report the zoom.',
    `3. Call add_item with label "${LABEL}", x 100, y 100, colour green.`,
    '4. Call highlight_item on the id that add_item returned.',
    'Finish with one line: the new item id and the tool names you used.',
  ].join('\n');

  console.log(`Running claude -p with MCP-B's relay on port ${String(baseline.relayPort)}...`);
  const output = await run('claude', [
    '-p',
    prompt,
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    `mcp__${SERVER}`,
    '--max-turns',
    '12',
    '--output-format',
    'json',
  ]);
  const parsed = JSON.parse(output) as { result?: string; num_turns?: number; is_error?: boolean };
  console.log(
    `\nClaude Code answered (${String(parsed.num_turns)} turns):\n${parsed.result ?? output}\n`,
  );

  const items = await baseline.page.evaluate(() =>
    [...document.querySelectorAll('[data-role="log"] li')].map((li) => li.textContent),
  );
  console.log('Page activity strip, newest first:');
  for (const line of items) console.log(`   ${line}`);
  const passed =
    items.some((line) => line.includes('add_item: added')) &&
    items.some((line) => line.includes('highlight_item: highlighted'));
  console.log(
    passed ? '\nA0.2 PASS: Claude Code listed and called the page tools.' : '\nA0.2 FAIL',
  );
  process.exitCode = passed && parsed.is_error !== true ? 0 : 1;
} finally {
  await baseline.close();
  await home.remove();
  await rm(dir, { recursive: true, force: true });
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with ${String(code)}: ${stdout.slice(0, 500)}`));
    });
  });
}
