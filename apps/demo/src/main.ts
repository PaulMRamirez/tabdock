import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { attach, type Dock } from '@tabdock/adapter';
import { Board } from './board.ts';
import { busyFromQuery, startBusy } from './busy.ts';
import { mountConnectBar, mountConnectForm, tabStore, wasChosen } from './connect.ts';
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
 * `?relay=ws://127.0.0.1:8787/page` names a Tabdock relay; the board dials it
 * only once its visitor chooses to (ADR 0029, connect.ts): a trusted click on
 * the Connect bar, a trusted submit of the Connect form shown without ?relay,
 * or that same choice made earlier in this tab. The adapter reads the tools
 * registered above from document.modelContext, so it needs no handle on them.
 * The policy comes from the query too (policy.ts): clear_board always prompts,
 * `?invites=all` offers Can control invites, and `?confirm=client` lets a
 * member driver confirm clear_board in their own client (ADR 0026).
 */
function attachToRelay(params: URLSearchParams, ui: BoardUi, registered: string): void {
  const status = requiredElement('[data-role="status"]');
  const protocol = window.location.protocol;
  const relay = relayFromQuery(params, protocol);
  // Any site can frame the published copy, as a static host cannot send
  // frame-ancestors (ADR 0021), and a page framing the board could dress the
  // widget up to trick its operator into a click. So the board never links
  // inside a frame, in any build, and offers no bar or form there; the dev
  // server also refuses other sites' frames.
  const framed = window.top !== window.self;
  const store = tabStore();
  if (relay.kind !== 'ok') {
    if (relay.kind === 'invalid') ui.setStatus(`${registered}; not linked: ${relay.message}`);
    if (!framed) {
      mountConnectForm(status, protocol, store, (href) => {
        window.location.assign(href);
      });
    }
    return;
  }
  if (framed) {
    ui.setStatus(`${registered}; not linked: this board does not link to a relay inside a frame`);
    document.documentElement.dataset.link = 'refused';
    return;
  }
  const link = (): void => {
    const dock = attach({ relay: relay.url, policy: policyFromQuery(params) });
    // The status line names the relay, so the person at the tab can see where it dials.
    dock.on('state', (state) => {
      ui.setStatus(`${registered}; Tabdock relay ${relay.host}: ${state.link}`);
    });
    ui.setStatus(`${registered}; Tabdock relay ${relay.host}: ${dock.state.link}`);
    document.documentElement.dataset.link = 'chosen';
    // Test hook for the Playwright specs and the demo scripts, nothing else:
    // ?e2e puts the control handle on window so a script can read the pairing
    // code and answer prompts. The adapter never offers this; only the code that
    // called attach() holds the handle, and a real page keeps it to itself.
    if (__TABDOCK_E2E_HOOK__ && params.has('e2e')) window.__tabdockDock = dock;
  };
  // Only the dev and test bundle's ?e2e skips the click: the static build
  // defines the hook false, so esbuild drops this test and a published copy
  // always waits for its visitor (tests/e2e/test/demo-static-build.test.ts).
  if ((__TABDOCK_E2E_HOOK__ && params.has('e2e')) || wasChosen(store, relay.url)) {
    link();
    return;
  }
  ui.setStatus(`${registered}; Tabdock relay ${relay.host}: waiting for you to connect`);
  document.documentElement.dataset.link = 'waiting';
  mountConnectBar(status, relay, store, link);
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Demo page markup is missing ${selector}`);
  return element;
}
