// The canvas map page (ADR 0038): the profile's sixteen tools over a MapWorld,
// registered through WebMCP and drawn on a plain canvas. It dials a relay only
// on a trusted click on its Connect button, or when page script calls
// window.__tabdockMapPage.connect(), which Playwright uses; it reads nothing
// from its URL, so no link can make it dial, and it never puts the Dock on
// window, so tests take the operator's real path through the widget. It is a
// test page and is never published.

import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { attach, type Dock, type PolicyInput } from '@tabdock/adapter';
import {
  createMapEditTools,
  createMapTools,
  createMapWorld,
  MAP_PAGE_POLICY,
  type MapToolDefinition,
  type MapViewport,
} from '@tabdock/sim-page/map';
import { drawMap } from './draw.ts';
import './webmcp.ts';

declare global {
  interface Window {
    /** The page's own connect hook; it hands out no handle. */
    __tabdockMapPage?: { connect(relayUrl: string, policy?: PolicyInput): boolean };
  }
}

/** The drawing buffer's size; CSS scales it to the screen, so a capture never depends on the window. */
const VIEWPORT: MapViewport = { widthPx: 960, heightPx: 540 };
/** Lines the call strip keeps. */
const CALLS_SHOWN = 20;

// Installs document.modelContext only where the browser has no native WebMCP.
initializeWebMCPPolyfill();

function required<T extends Element>(selector: string, found: T | null): T {
  if (!found) throw new Error(`the map page's markup is missing ${selector}`);
  return found;
}

const canvas = required('canvas#map', document.querySelector<HTMLCanvasElement>('canvas#map'));
const statusLine = required(
  '[data-role="status"]',
  document.querySelector<HTMLElement>('[data-role="status"]'),
);
const viewLine = required(
  '[data-role="view"]',
  document.querySelector<HTMLElement>('[data-role="view"]'),
);
const clockLine = required(
  '[data-role="clock"]',
  document.querySelector<HTMLElement>('[data-role="clock"]'),
);
const callStrip = required(
  '[data-role="calls"]',
  document.querySelector<HTMLOListElement>('[data-role="calls"]'),
);
const form = required('form', document.querySelector<HTMLFormElement>('form[data-role="connect"]'));
const relayInput = required('#relay', document.querySelector<HTMLInputElement>('#relay'));
const connectButton = required(
  'Connect',
  document.querySelector<HTMLButtonElement>('[data-action="connect"]'),
);

canvas.width = VIEWPORT.widthPx;
canvas.height = VIEWPORT.heightPx;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('this browser gives the map page no 2D canvas');

const world = createMapWorld({ viewport: VIEWPORT });

function redraw(): void {
  if (ctx) drawMap(ctx, world, VIEWPORT);
  const view = world.view();
  viewLine.textContent = `${view.body}, ${view.projection}, centre lat ${view.lat.toFixed(3)} lon ${view.lon.toFixed(3)}, ${(view.widthM / 1000).toFixed(1)} km across, heading ${view.headingDeg.toFixed(1)}`;
  const clock = world.clock();
  clockLine.textContent = clock
    ? `${clock.time}, ${clock.playing ? 'playing' : 'paused'} at rate ${String(clock.rate)}`
    : '';
}
world.subscribe(redraw);
redraw();

/** The strip names the tool and how it ended, never its arguments, which may be anyone's text (S7). */
function logCall(tool: string, outcome: 'ok' | 'error'): void {
  const line = document.createElement('li');
  line.textContent = `${tool}: ${outcome}`;
  callStrip.prepend(line);
  while (callStrip.children.length > CALLS_SHOWN) callStrip.lastElementChild?.remove();
}

function logged(tool: MapToolDefinition): MapToolDefinition {
  return {
    ...tool,
    execute: (input, options) =>
      Promise.resolve(tool.execute(input, options)).then(
        (result) => {
          logCall(tool.name, 'ok');
          return result;
        },
        (error: unknown) => {
          logCall(tool.name, 'error');
          throw error;
        },
      ),
  };
}

// Panning and zooming by hand are discrete changes: one write per drag and
// per wheel step, so a page that publishes its state never does so per frame.
let dragFrom: { x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (event) => {
  dragFrom = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointerup', (event) => {
  if (!dragFrom) return;
  const scale = VIEWPORT.widthPx / canvas.clientWidth;
  const dx = (event.clientX - dragFrom.x) * scale;
  const dy = (event.clientY - dragFrom.y) * scale;
  dragFrom = null;
  if (dx === 0 && dy === 0) return;
  const view = world.view();
  const metresPerPx = view.widthM / VIEWPORT.widthPx;
  const heading = (view.headingDeg * Math.PI) / 180;
  // The ground moves with the pointer, so the centre moves the other way.
  const east = -(dx * Math.cos(heading) - dy * Math.sin(heading)) * metresPerPx;
  const north = (dx * Math.sin(heading) + dy * Math.cos(heading)) * metresPerPx;
  const metresPerDegree = (world.radiusM * Math.PI) / 180;
  const lat = Math.max(-90, Math.min(90, view.lat + north / metresPerDegree));
  const cosLat = Math.max(Math.cos((view.lat * Math.PI) / 180), 1e-6);
  const lon = ((((view.lon + east / (metresPerDegree * cosLat) + 180) % 360) + 360) % 360) - 180;
  world.setView({ lon, lat });
});
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const view = world.view();
    const widthM = Math.min(1e10, Math.max(1, view.widthM * (event.deltaY > 0 ? 1.25 : 0.8)));
    world.setView({ widthM });
  },
  { passive: false },
);

const context = document.modelContext;
const tools = [...createMapTools(world), ...createMapEditTools(world)].map(logged);
if (context) {
  // Registration lasts as long as the page; aborting this would remove every tool.
  const registration = new AbortController();
  await Promise.all(
    tools.map((tool) => context.registerTool(tool, { signal: registration.signal })),
  );
  statusLine.textContent = `${String(tools.length)} tools registered; not linked to a relay`;
  document.documentElement.dataset.tools = 'ready';
} else {
  statusLine.textContent = 'WebMCP is unavailable in this browser, so no tools are registered';
  document.documentElement.dataset.tools = 'unavailable';
}

/**
 * A relay page URL this page will dial: ws: or wss:, with no user name,
 * password, query or fragment, so nothing rides along that a relay or a
 * proxy would log. null for anything else.
 */
function relayUrlOf(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.includes('?') || trimmed.includes('#')) return null;
  const url = URL.parse(trimmed);
  if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return null;
  if (url.username !== '' || url.password !== '') return null;
  return url.href;
}

let dock: Dock | null = null;

/**
 * Links this page to a relay once. The policy is MAP_PAGE_POLICY with
 * capture_view among the image tools; a caller may raise it, as a test that
 * needs proposals or more drivers does, and a session can only narrow what
 * this sets (ADR 0043).
 */
function connect(relayUrl: string, policy: PolicyInput = {}): boolean {
  if (dock || !context) return false;
  const relay = relayUrlOf(relayUrl);
  if (relay === null) {
    statusLine.textContent = `${String(tools.length)} tools registered; that relay URL is not a ws: or wss: page URL without a query`;
    return false;
  }
  const host = new URL(relay).host;
  const linked = attach({
    relay,
    policy: {
      ...MAP_PAGE_POLICY,
      consequentialTools: [...MAP_PAGE_POLICY.consequentialTools],
      imageTools: ['capture_view'],
      ...policy,
    },
  });
  dock = linked;
  const show = (): void => {
    statusLine.textContent = `${String(tools.length)} tools registered; Tabdock relay ${host}: ${linked.state.link}`;
  };
  linked.on('state', show);
  show();
  document.documentElement.dataset.link = 'chosen';
  form.hidden = true;
  return true;
}

// Every submit stays in the page, whoever asked for it. Only a person's own
// click on Connect dials: a script's form.requestSubmit() fires a trusted
// submit event, so the submit event alone would not do.
form.addEventListener('submit', (event) => {
  event.preventDefault();
});
connectButton.addEventListener('click', (event) => {
  event.preventDefault();
  if (!event.isTrusted) return;
  connect(relayInput.value);
});

window.__tabdockMapPage = Object.freeze({ connect });
