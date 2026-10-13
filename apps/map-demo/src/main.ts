// The map demo (ADR 0050): Earth as a flat map and a globe on a plain canvas,
// running the map profile's tools from @tabdock/sim-page/map over a world of
// its own (earth.ts), registered through WebMCP. capture_view returns the
// page's own map drawn again (ADR 0039), and once linked the page publishes
// its view as page state on each discrete change (ADR 0040). It dials only a
// relay its visitor chose, by the board's rules (connect.ts), reads no policy
// from its link, never links inside a frame and has no test hook in any
// build: tests click the bar as a person does and approve in the widget.

import { initializeWebMCPPolyfill } from '@mcp-b/webmcp-polyfill';
import { attach, DEFAULT_IMAGE_BYTES, type Dock } from '@tabdock/adapter';
import { relayFromQuery } from '@tabdock/demo/relay';
import {
  createMapEditTools,
  createMapTools,
  MAP_PAGE_POLICY,
  type MapCapture,
  type MapToolDefinition,
  type MapView,
  type MapViewport,
} from '@tabdock/sim-page/map';
import { captureMap } from './capture.ts';
import {
  LINK_HINT_MS,
  linkStatus,
  mountConnectBar,
  mountConnectForm,
  tabStore,
  wasChosen,
} from './connect.ts';
import { ATTRIBUTION } from './data/natural-earth-110m.ts';
import { drawMap, prepareEarth, sceneOf } from './draw.ts';
import { createEarthWorld, earthGeography, FLAT, featureRanks, TOUR_ID } from './earth.ts';
import {
  BUTTON_ZOOM_STEP,
  draggedView,
  keyAction,
  panBy,
  stepStop,
  toggleGlobe,
  wheelZoom,
  zoomBy,
} from './gestures.ts';
import { mountPanel } from './panel.ts';
import { statePublisher } from './publish.ts';
import './webmcp.ts';

/** The world's viewport: what the tools and captures see, whatever the window's size. */
const VIEWPORT: MapViewport = { widthPx: 960, heightPx: 540 };

// Installs document.modelContext only where the browser has no native WebMCP.
initializeWebMCPPolyfill();

function required<T extends Element>(selector: string, kind: abstract new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof kind)) throw new Error(`the map demo's markup is missing ${selector}`);
  return found;
}

const canvas = required('canvas#map', HTMLCanvasElement);
const statusLine = required('[data-role="status"]', HTMLElement);
const connectSlot = required('[data-role="connect-slot"]', HTMLElement);
required('[data-role="origin"]', HTMLElement).textContent = window.location.origin;
required('[data-role="credit"]', HTMLElement).textContent = ATTRIBUTION;
const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('this browser gives the map demo no 2D canvas');

const world = createEarthWorld({ viewport: VIEWPORT });
world.goToStop(TOUR_ID, 0);
const earth = prepareEarth(earthGeography(), featureRanks());
const panel = mountPanel(document, TOUR_ID);

/** A drag's view while the pointer is down; the world takes it once, on release. */
let dragView: MapView | null = null;
let frame: number | null = null;

/**
 * Draws on the next frame, once however many changes asked. The screen
 * canvas is its CSS width times the device's pixel ratio, drawn through a
 * scale from the fixed viewport, so it is sharp on any screen and nothing the
 * tools or captures see depends on the window.
 */
function scheduleDraw(): void {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round((width * VIEWPORT.heightPx) / VIEWPORT.widthPx));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const scale = width / VIEWPORT.widthPx;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    // On a canvas narrower than the viewport, names and lines are drawn larger, up to 2.4 times.
    const legible = Math.min(2.4, VIEWPORT.widthPx / Math.max(1, canvas.clientWidth));
    drawMap(ctx, sceneOf(world, dragView ?? undefined), VIEWPORT, earth, { scale: legible });
  });
}
new ResizeObserver(scheduleDraw).observe(canvas);

/** The link, once the visitor chooses a relay; the page makes at most one. */
let dock: Dock | null = null;
/** Publishes the world's state once linked (publish.ts); nothing until then. */
let publish: () => void = () => undefined;

world.subscribe(() => {
  scheduleDraw();
  panel.update(world);
  publish();
});
panel.update(world);
scheduleDraw();

// A drag shows its view as it goes and writes it once, on release, so a
// page that publishes its state never does so per frame.
let dragFrom: { x: number; y: number; id: number } | null = null;
const toViewport = (px: number): number => (px * VIEWPORT.widthPx) / canvas.clientWidth;
canvas.addEventListener('pointerdown', (event) => {
  dragFrom = { x: event.clientX, y: event.clientY, id: event.pointerId };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (dragFrom?.id !== event.pointerId) return;
  const dx = toViewport(event.clientX - dragFrom.x);
  const dy = toViewport(event.clientY - dragFrom.y);
  dragView = draggedView(world.view(), world.radiusM, VIEWPORT.widthPx, dx, dy);
  scheduleDraw();
});
canvas.addEventListener('pointerup', (event) => {
  if (dragFrom?.id !== event.pointerId) return;
  const dx = toViewport(event.clientX - dragFrom.x);
  const dy = toViewport(event.clientY - dragFrom.y);
  dragFrom = null;
  dragView = null;
  panBy(world, VIEWPORT.widthPx, dx, dy);
  scheduleDraw();
});
canvas.addEventListener('pointercancel', () => {
  dragFrom = null;
  dragView = null;
  scheduleDraw();
});
// A plain wheel scrolls the page past the map; Ctrl or Cmd with it, which is
// how a trackpad pinch arrives, zooms the map instead of the page.
canvas.addEventListener(
  'wheel',
  (event) => {
    const zoom = wheelZoom(event);
    if (zoom === null) return;
    event.preventDefault();
    zoomBy(world, zoom === 'out');
  },
  { passive: false },
);
// The focused map pans on the arrow keys and zooms on plus and minus, so a
// keyboard reaches all a pointer does.
canvas.addEventListener('keydown', (event) => {
  const action = keyAction(event);
  if (action === null) return;
  event.preventDefault();
  if (action.kind === 'pan') panBy(world, VIEWPORT.widthPx, action.dx, action.dy);
  else zoomBy(world, action.out, BUTTON_ZOOM_STEP);
});

// Zoom, projection and the tour each have a button too, since a phone has
// no wheel or keys; panning is a drag, a touch or the arrow keys.
const actions: Record<string, () => void> = {
  'zoom-in': () => {
    zoomBy(world, false, BUTTON_ZOOM_STEP);
  },
  'zoom-out': () => {
    zoomBy(world, true, BUTTON_ZOOM_STEP);
  },
  projection: () => {
    toggleGlobe(world, FLAT);
  },
  'previous-stop': () => {
    stepStop(world, TOUR_ID, -1);
  },
  'next-stop': () => {
    stepStop(world, TOUR_ID, 1);
  },
};
for (const [name, run] of Object.entries(actions)) {
  required(`[data-action="${name}"]`, HTMLButtonElement).addEventListener('click', run);
}

function logged(tool: MapToolDefinition): MapToolDefinition {
  return {
    ...tool,
    execute: (input, options) =>
      Promise.resolve(tool.execute(input, options)).then(
        (result) => {
          panel.logCall(tool.name, 'ok');
          return result;
        },
        (error: unknown) => {
          panel.logCall(tool.name, 'error');
          throw error;
        },
      ),
  };
}

/**
 * capture_view's picture, drawn afresh from the world in this task and
 * fitted under the cap the relay's welcome named, or the default before one
 * has; a relay that takes no images refuses it in the adapter either way.
 */
const capture: MapCapture = (request, { signal }) =>
  Promise.resolve().then(() => {
    signal?.throwIfAborted();
    const offered = dock?.state.maxImageBytes ?? null;
    const cap = offered === null || offered === 0 ? DEFAULT_IMAGE_BYTES : offered;
    return captureMap(sceneOf(world), earth, VIEWPORT, request, cap, () =>
      document.createElement('canvas'),
    );
  });

const context = document.modelContext;
// Twelve profile tools (no clock) and the two editing tools: fourteen.
const tools = [...createMapTools(world, { capture }), ...createMapEditTools(world)].map(logged);
if (context) {
  // Registration lasts as long as the page; aborting this would remove every tool.
  const registration = new AbortController();
  await Promise.all(
    tools.map((tool) => context.registerTool(tool, { signal: registration.signal })),
  );
  const registered = `${String(tools.length)} tools registered`;
  statusLine.textContent = `${registered}; not linked to a relay`;
  document.documentElement.dataset.tools = 'ready';
  attachToRelay(registered);
} else {
  statusLine.textContent = 'WebMCP is unavailable in this browser, so no tools are registered';
  document.documentElement.dataset.tools = 'unavailable';
}

/**
 * Links to the relay in ?relay once its visitor chooses it (connect.ts): a
 * trusted click on the Connect bar, or that same choice made earlier in this
 * tab; without ?relay, or with one the board's rules refuse, it offers the
 * Connect form. The policy is MAP_PAGE_POLICY with capture_view as its image
 * tool: reset_edits alone prompts, proposals stay off and invites at the
 * adapter's default, and nothing in the link changes that.
 */
function attachToRelay(registered: string): void {
  const protocol = window.location.protocol;
  const relay = relayFromQuery(new URLSearchParams(window.location.search), protocol);
  // A static host cannot send frame-ancestors, so any site can frame this
  // page and dress the widget up; the page never links inside a frame.
  const framed = window.top !== window.self;
  const store = tabStore();
  if (relay.kind !== 'ok') {
    if (relay.kind === 'invalid') {
      statusLine.textContent = `${registered}; not linked: ${relay.message}`;
    }
    if (!framed) {
      mountConnectForm(connectSlot, protocol, store, (href) => {
        window.location.assign(href);
      });
    }
    return;
  }
  if (framed) {
    statusLine.textContent = `${registered}; not linked: this page does not link to a relay inside a frame`;
    document.documentElement.dataset.link = 'refused';
    return;
  }
  const link = (): void => {
    const linked = attach({
      relay: relay.url,
      policy: {
        ...MAP_PAGE_POLICY,
        consequentialTools: [...MAP_PAGE_POLICY.consequentialTools],
        imageTools: ['capture_view'],
      },
    });
    dock = linked;
    publish = statePublisher(world, (state) => {
      linked.publishState(state);
    });
    // The status line names the relay, so the person at the tab can see where
    // it dials, and once a while has passed with no link, what to check.
    let everLinked = false;
    let stalled = false;
    const show = (): void => {
      if (linked.state.link === 'linked') everLinked = true;
      statusLine.textContent = linkStatus(
        registered,
        relay.host,
        linked.state.link,
        stalled && !everLinked,
        window.location.origin,
      );
    };
    linked.on('state', show);
    setTimeout(() => {
      stalled = true;
      show();
    }, LINK_HINT_MS);
    show();
    publish();
    document.documentElement.dataset.link = 'chosen';
  };
  if (wasChosen(store, relay.url)) {
    link();
    return;
  }
  statusLine.textContent = `${registered}; Tabdock relay ${relay.host}: waiting for you to connect`;
  document.documentElement.dataset.link = 'waiting';
  mountConnectBar(connectSlot, relay, store, link);
}
