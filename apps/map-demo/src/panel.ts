// The words around the map: the line naming the view, the tour panel and the
// strip of recent tool calls. Everything here is set as text, never markup:
// a stop's title and text are whatever edit_stop last wrote, which any
// driver may set, and a call's arguments may be anyone's words, so the strip
// names only the tool and how it ended (S7).

import { GLOBE, type MapView, type MapWorld } from '@tabdock/sim-page/map';

/** Lines the call strip keeps. */
export const CALLS_SHOWN = 12;

const WHOLE = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });

function degrees(value: number, positive: string, negative: string): string {
  return `${Math.abs(value).toFixed(1)}° ${value >= 0 ? positive : negative}`;
}

/** The view in words, for the line under the map. */
export function viewLine(view: MapView): string {
  const kind = view.projection === GLOBE ? 'Globe' : 'Flat map';
  const across = `${WHOLE.format(view.widthM / 1000)} km across`;
  const parts = [
    `${kind}, centred on ${degrees(view.lat, 'N', 'S')}, ${degrees(view.lon, 'E', 'W')}`,
    across,
  ];
  if (view.altitudeM !== undefined) parts.push(`${WHOLE.format(view.altitudeM / 1000)} km up`);
  if (view.headingDeg !== 0) parts.push(`heading ${view.headingDeg.toFixed(0)}°`);
  return parts.join(', ');
}

export interface StopWords {
  readonly place: string;
  readonly title: string;
  readonly text: string;
}

/** The current stop of the tour, edits included, or words saying the camera has left it. */
export function stopWords(world: MapWorld, tourId: string): StopWords {
  const current = world.current;
  if (current?.walkthroughId !== tourId) {
    return { place: 'Tour', title: 'Pick a stop', text: 'Press Next stop to begin the tour.' };
  }
  const stop = world.stop(tourId, current.stopIndex);
  return {
    place: `Stop ${String(stop.index + 1)} of ${String(stop.stopCount)}`,
    title: stop.title,
    text: stop.text,
  };
}

export interface Panel {
  /** Shows the world as it stands; the page calls it on each change. */
  update(world: MapWorld): void;
  logCall(tool: string, outcome: 'ok' | 'error'): void;
}

function required<T extends Element>(
  root: ParentNode,
  selector: string,
  kind: abstract new () => T,
): T {
  const found = root.querySelector(selector);
  if (!(found instanceof kind)) throw new Error(`the map demo's markup is missing ${selector}`);
  return found;
}

export function mountPanel(root: ParentNode, tourId: string): Panel {
  const view = required(root, '[data-role="view"]', HTMLElement);
  const place = required(root, '[data-role="stop-place"]', HTMLElement);
  const title = required(root, '[data-role="stop-title"]', HTMLElement);
  const text = required(root, '[data-role="stop-text"]', HTMLElement);
  const calls = required(root, '[data-role="calls"]', HTMLOListElement);
  const previous = required(root, '[data-action="previous-stop"]', HTMLButtonElement);
  const next = required(root, '[data-action="next-stop"]', HTMLButtonElement);
  const projection = required(root, '[data-action="projection"]', HTMLButtonElement);
  return {
    update(world) {
      const shown = world.view();
      view.textContent = viewLine(shown);
      const words = stopWords(world, tourId);
      place.textContent = words.place;
      title.textContent = words.title;
      text.textContent = words.text;
      const current = world.current?.walkthroughId === tourId ? world.current.stopIndex : null;
      const count =
        world.walkthroughs().walkthroughs.find((entry) => entry.id === tourId)?.stopCount ?? 0;
      previous.disabled = current === null || current === 0;
      next.disabled = current !== null && current >= count - 1;
      projection.textContent = shown.projection === GLOBE ? 'Flat map' : 'Globe';
    },
    logCall(tool, outcome) {
      const line = document.createElement('li');
      line.textContent = `${tool}: ${outcome}`;
      if (outcome === 'error') line.className = 'error';
      calls.prepend(line);
      while (calls.children.length > CALLS_SHOWN) calls.lastElementChild?.remove();
    },
  };
}
