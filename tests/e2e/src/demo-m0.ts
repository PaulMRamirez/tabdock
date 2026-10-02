// pnpm demo:m0: the M0 baseline end to end, narrated.
//   --headed       watch the board in a visible browser window
//   --screenshot   also save the final board to docs/tour/img/m0-board.png
// An MCP client (the official SDK, standing in for Claude Code) talks to
// MCP-B's local relay over stdio; the relay reaches the demo page in Chromium.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO_TOOL_NAMES, startBaseline } from './harness.ts';

const headed = process.argv.includes('--headed');
const screenshotPath = fileURLToPath(
  new URL('../../../docs/tour/img/m0-board.png', import.meta.url),
);

const say = (text: string) => {
  console.log(text);
};
const show = (label: string, value: unknown) => {
  console.log(`   ${label} ${JSON.stringify(value)}`);
};

say("Tabdock M0: an MCP client drives a WebMCP page through MCP-B's local relay\n");
let listChanged = 0;
const baseline = await startBaseline({
  headless: !headed,
  onToolListChanged: () => listChanged++,
  onRelayLog: (line) => {
    say(`   relay: ${line}`);
  },
});
const { client, demo, relayPort, page } = baseline;

try {
  say(`1. Demo board served at ${demo.url} and opened in Chromium ${baseline.browser.version()}.`);
  say(
    `2. MCP-B's local relay runs as a stdio MCP server; the page dials ws://127.0.0.1:${relayPort}.`,
  );
  say(
    `3. The relay listed all ${DEMO_TOOL_NAMES.length} page tools ${baseline.toolsVisibleAfterMs} ms after navigation (${listChanged} tools/list_changed notifications so far).\n`,
  );

  const { tools } = await client.listTools(undefined, { cacheMode: 'refresh' });
  say('tools/list');
  for (const tool of tools) {
    const readOnly = tool.annotations?.readOnlyHint === true ? 'read-only' : 'mutating';
    say(`   ${tool.name.padEnd(20)} ${readOnly}`);
  }

  const steps: [string, Record<string, unknown>][] = [
    ['get_view', {}],
    ['add_item', { label: 'Hello from MCP', x: 160, y: -120, color: 'purple' }],
    ['highlight_item', { id: 'item-4' }],
    ['move_view', { x: 80, y: -60, zoom: 1.5 }],
    ['list_items', { visibleOnly: true }],
    ['highlight_item', { id: 'item-999' }],
  ];
  for (const [name, args] of steps) {
    say(`\ntools/call ${name}`);
    show('arguments ', args);
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - started);
    if (result.isError) {
      const text = (result.content as { text?: string }[])[0]?.text ?? '';
      show(`error (${ms} ms)`, text);
    } else {
      show(`result (${ms} ms)`, result.structuredContent ?? result.content);
    }
  }

  const log = await page.locator('[data-role="log"] li').allTextContents();
  say("\nThe page's own activity strip, newest first:");
  for (const line of log) say(`   ${line}`);

  if (process.argv.includes('--screenshot')) {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    say(`\nSaved ${screenshotPath}`);
  }

  say('\nclear_board is left uncalled on purpose: it is the consequential tool, and');
  say('MCP-B passes it through with no prompt. Tabdock adds the on-page confirmation in M2.');
  if (headed) {
    say('\nBrowser stays open for 30 s so you can pan and zoom the board.');
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
} finally {
  await baseline.close();
}
