import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { Board } from './board.ts';
import { mountBoard } from './render.ts';
import { createTools } from './tools.ts';

// Installs document.modelContext only when the browser has no native WebMCP,
// so the same page exercises Chrome's implementation when the flag is on.
initializeWebMCPPolyfill();

const board = new Board();
const ui = mountBoard(requiredElement('#board'), board);

board.addItem({ label: 'Start', x: 0, y: 0, color: 'green' });
board.addItem({ label: 'North', x: 0, y: -150, color: 'blue' });
board.addItem({ label: 'East', x: 220, y: 40, color: 'orange' });

const context = document.modelContext;
if (context) {
  const tools = createTools(board, ui.logCall);
  // Registration lives as long as the page; aborting this signal would remove every tool.
  const registration = new AbortController();
  await Promise.all(
    tools.map((tool) => context.registerTool(tool, { signal: registration.signal })),
  );
  ui.setStatus(`${tools.length} tools registered on document.modelContext`);
  document.documentElement.dataset.tools = 'ready';
  loadMcpbRelayEmbed();
} else {
  ui.setStatus('WebMCP is unavailable in this browser, so no tools are registered');
  document.documentElement.dataset.tools = 'unavailable';
}

/**
 * M0 baseline only: `?mcpb` loads MCP-B's local relay embed so the relay can
 * reach this page; `?mcpb=9444` also picks the relay port. Tabdock's own
 * adapter replaces this in M1.
 */
function loadMcpbRelayEmbed(): void {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('mcpb')) return;
  const script = document.createElement('script');
  script.src = '/vendor/webmcp-local-relay/embed.js';
  const port = params.get('mcpb') ?? '';
  if (/^\d{2,5}$/.test(port)) script.dataset.relayPort = port;
  document.head.append(script);
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Demo page markup is missing ${selector}`);
  return element;
}
