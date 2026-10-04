import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { attach, type Dock } from '@tabdock/adapter';
import { Board } from './board.ts';
import { busyFromQuery, startBusy } from './busy.ts';
import { policyFromQuery } from './policy.ts';
import { relayFromQuery } from './relay.ts';
import { type BoardUi, mountBoard } from './render.ts';
import { createTools } from './tools.ts';

/**
 * Set by esbuild: true when the dev and test server bundles the page, false in
 * the static build, so the ?e2e test hook below cannot exist on a hosted copy.
 */
declare const __TABDOCK_E2E_HOOK__: boolean;

declare global {
  interface Window {
    /** Present only with ?e2e; see attachToRelay. */
    __tabdockDock?: Dock;
  }
}

// Installs document.modelContext only when the browser has no native WebMCP,
// so the same page exercises Chrome's implementation when the flag is on.
initializeWebMCPPolyfill();

const board = new Board();
const ui = mountBoard(requiredElement('#board'), board);

board.addItem({ label: 'Start', x: 0, y: 0, color: 'green' });
board.addItem({ label: 'North', x: 0, y: -150, color: 'blue' });
board.addItem({ label: 'East', x: 220, y: 40, color: 'orange' });

// The M3 spike's CPU-busy variant, for the owner's Energy Saver run (busy.ts).
const busy = busyFromQuery(new URLSearchParams(window.location.search));
if (busy) {
  const line = document.createElement('p');
  line.className = 'meta';
  line.dataset.role = 'busy';
  line.textContent = startBusy(busy);
  requiredElement('[data-role="status"]').after(line);
}

const context = document.modelContext;
if (context) {
  const tools = createTools(board, ui.logCall);
  // Registration lives as long as the page; aborting this signal would remove every tool.
  const registration = new AbortController();
  await Promise.all(
    tools.map((tool) => context.registerTool(tool, { signal: registration.signal })),
  );
  const registered = `${tools.length} tools registered on document.modelContext`;
  ui.setStatus(registered);
  document.documentElement.dataset.tools = 'ready';
  const params = new URLSearchParams(window.location.search);
  loadMcpbRelayEmbed(params);
  attachToRelay(params, ui, registered);
} else {
  ui.setStatus('WebMCP is unavailable in this browser, so no tools are registered');
  document.documentElement.dataset.tools = 'unavailable';
}

/**
 * The M0 baseline: `?mcpb` loads MCP-B's local relay embed so that relay can
 * reach this page; `?mcpb=9444` also picks its port. It stays for demo:m0 and
 * the M0 specs; Tabdock's own path is ?relay below.
 */
function loadMcpbRelayEmbed(params: URLSearchParams): void {
  if (!params.has('mcpb')) return;
  const script = document.createElement('script');
  script.src = '/vendor/webmcp-local-relay/embed.js';
  const port = params.get('mcpb') ?? '';
  if (/^\d{2,5}$/.test(port)) script.dataset.relayPort = port;
  document.head.append(script);
}

/**
 * `?relay=ws://127.0.0.1:8787/page` links the board to a Tabdock relay. The
 * adapter reads the tools registered above from document.modelContext, so it
 * needs no handle on them. The policy comes from the query too (policy.ts):
 * clear_board always prompts, and `?invites=all` offers Can control invites.
 */
function attachToRelay(params: URLSearchParams, ui: BoardUi, registered: string): void {
  const relay = relayFromQuery(params, window.location.protocol);
  if (relay.kind === 'absent') return;
  if (relay.kind === 'invalid') {
    ui.setStatus(`${registered}; not linked: ${relay.message}`);
    return;
  }
  // Any site can frame the published copy, as a static host cannot send
  // frame-ancestors (ADR 0021), and a page framing the board could dress the
  // widget up to trick its operator into a click. So the board never links
  // inside a frame, in any build; the dev server also refuses other sites' frames.
  if (window.top !== window.self) {
    ui.setStatus(`${registered}; not linked: this board does not link to a relay inside a frame`);
    document.documentElement.dataset.link = 'refused';
    return;
  }
  const dock = attach({ relay: relay.url, policy: policyFromQuery(params) });
  // The status line names the relay, so the person at the tab can see where it dials.
  const host = new URL(relay.url).host;
  dock.on('state', (state) => {
    ui.setStatus(`${registered}; Tabdock relay ${host}: ${state.link}`);
  });
  ui.setStatus(`${registered}; Tabdock relay ${host}: ${dock.state.link}`);
  // Test hook for the Playwright specs and the M1 demo scripts, nothing else:
  // ?e2e puts the control handle on window so a script can read the pairing
  // code and answer prompts. The adapter never offers this; only the code that
  // called attach() holds the handle, and a real page keeps it to itself.
  if (__TABDOCK_E2E_HOOK__ && params.has('e2e')) window.__tabdockDock = dock;
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Demo page markup is missing ${selector}`);
  return element;
}
