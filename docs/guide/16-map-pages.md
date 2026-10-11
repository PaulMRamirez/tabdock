# Map and globe pages

A map or globe page that registers the tools on this page can be driven the same way by every client, so a skill that teaches Claude to drive one map page works on the next. This is a profile, `tabdock.map.v1` (ADR 0038): a convention among pages, not protocol. The relay and the adapter never read these names, and a page that ignores the profile still works. Names, descriptions and results stay page text: a hostile page can register these names with any behaviour, so a client treats them as it treats any page content.

## Units and frames

Angles are in degrees. Latitude is planetocentric, from -90 to 90; longitude is east-positive, from -180 to 180. Distances are in metres, and every number with a unit other than these degrees carries it in its name: `widthM` is the ground distance across the view through its centre, `altitudeM` the camera's height above the body's mean radius, `headingDeg` the direction shown at the top of the view (0 to under 360, clockwise from north), `pitchDeg` the tilt (-90 looks straight down, 0 at the horizon) and `fovDeg` the horizontal field of view.

Times are ISO 8601 in UTC, ending in Z, to the millisecond at most. A clock's rate is simulated seconds per real second, and opacity runs from 0 to 1. Bodies are named by their lower-case English IAU names, such as `moon` or `mars`. A page for a body usually mapped west-positive or planetographic converts to these before it answers.

A view's bounds are `west`, `south`, `east` and `north`, with west greater than east when the view crosses the antimeridian (RFC 7946 section 5.2), and null when a globe's horizon is in view. A footprint is a GeoJSON Polygon or MultiPolygon of `[longitude, latitude]` positions, its exterior rings counterclockwise, cut into a MultiPolygon where it crosses the antimeridian, or null when unknown.

## The tools

| Group        | Tool                    | Annotation                   | Arguments                                                                          | Returns                                                                     |
| ------------ | ----------------------- | ---------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| view         | `get_view`              | read-only                    | none                                                                               | `MapView`                                                                   |
| view         | `set_view`              | write                        | any of the view's fields but profile and bounds; `widthM` or `altitudeM`, not both | the `MapView` it set                                                        |
| capture      | `capture_view`          | read-only, untrusted content | `maxWidthPx` 64 to 2048 (1024), format png or jpeg (png)                           | an image and the view as JSON, or that JSON with a one-line description     |
| clock        | `get_clock`             | read-only                    | none                                                                               | `MapClock`                                                                  |
| clock        | `set_clock`             | write                        | time, rate or playing                                                              | the `MapClock` it set                                                       |
| layers       | `list_layers`           | read-only, untrusted content | none                                                                               | `{ layers }`, each a `MapLayer`                                             |
| layers       | `set_layer`             | write                        | id, with visible or opacity; showing a base layer hides the other base layers      | id, visible and opacity                                                     |
| features     | `features_in_view`      | read-only, untrusted content | limit 1 to 200 (50), kind                                                          | `{ features, total, truncated }`, most prominent first, then nearest        |
| walkthroughs | `list_walkthroughs`     | read-only, untrusted content | none                                                                               | each `WalkthroughSummary`, and the current `walkthroughId` and `stopIndex`  |
| walkthroughs | `get_stop`              | read-only, untrusted content | `walkthroughId` and index, the current stop by default                             | `MapStop`                                                                   |
| walkthroughs | `go_to_stop`            | write                        | index, and `walkthroughId` unless the current one                                  | the stop's index and `stopCount`, the new view and clock, its observation   |
| observations | `list_observations`     | read-only, untrusted content | `walkthroughId`, from, to, limit 1 to 150 (100)                                    | `{ observations, total, truncated }`, each an `ObservationSummary`, by time |
| observations | `get_observation`       | read-only, untrusted content | id                                                                                 | `MapObservation`                                                            |
| observations | `view_from_observation` | write                        | id                                                                                 | the `observationId` and the new view, on the globe where the page has one   |

Every result is JSON text behind the relay's label, never structured content. A handler refuses by throwing, so the call ends as `tool_error`, and the schemas carry every fixed bound, so the relay names most mistakes itself as `invalid_arguments` before the page sees them. Rules that depend on state, such as an index past `stopCount` or a time outside the clock's start and end, are in the descriptions and readable from `list_walkthroughs` and `get_clock`. Each write resolves with the state it produced, and `get_view` reports the target view at once, even while the page still animates toward it. `go_to_stop` takes an index only, so a call repeated, or two accepted proposals, land on the same stop.

Only MCP-B 5.1 passes a handler's words on, after its own sentence. Native WebMCP keeps only that sentence, and MCP-B 6 answers `Tool execution failed` to every refusal (page 03), so there a client learns why from the descriptions and from the relay's `invalid_arguments`, which names a broken bound before the page sees the call.

## Shapes

```ts
type MapStopView = Omit<MapView, 'profile' | 'bounds'>;

interface MapView {
  profile: 'tabdock.map.v1';
  body: string;
  projection: string; // 'globe' for a 3D globe; any other name is a 2D map
  lon: number;
  lat: number;
  widthM: number;
  headingDeg: number;
  pitchDeg: number;
  altitudeM?: number; // present exactly on a globe
  fovDeg?: number; // present exactly on a globe
  bounds: { west: number; south: number; east: number; north: number } | null;
}

interface MapClock {
  time: string;
  rate: number;
  playing: boolean;
  start: string | null;
  end: string | null;
}

interface MapLayer {
  id: string;
  title: string;
  kind: 'base' | 'overlay';
  visible: boolean;
  opacity: number;
}

interface MapFeature {
  id: string;
  name: string;
  kind: string;
  lon: number;
  lat: number;
}

interface WalkthroughSummary {
  id: string;
  title: string;
  stopCount: number;
}

interface MapStop {
  walkthroughId: string;
  index: number;
  stopCount: number;
  title: string;
  text: string;
  view: MapStopView;
  clock: { time: string; rate: number; playing: boolean } | null;
  observationId: string | null;
}

interface ObservationSummary {
  id: string;
  title: string;
  kind: string;
  time: string;
  walkthroughId: string | null;
}

interface MapViewpoint {
  body: string;
  lon: number;
  lat: number;
  altitudeM: number;
  headingDeg: number;
  pitchDeg: number;
  fovDeg: number;
}

interface MapObservation {
  id: string;
  title: string;
  kind: string;
  time: string;
  walkthroughId: string | null;
  viewpoint: MapViewpoint;
  footprint: { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown[] } | null;
  source: { name: string; url: string | null; credit: string | null };
  notes: string[];
  onScreen: boolean;
}

interface MapPageState {
  view: MapView;
  clock: MapClock | null;
  walkthrough: { id: string; stopIndex: number } | null;
  observationId: string | null;
}
```

## Groups and the profile marker

`get_view` and `set_view` are the core. Capture, clock, layers, features, walkthroughs and observations are optional groups, each registered whole or not at all, so a client that finds `list_walkthroughs` in `list_page_tools` can rely on `go_to_stop`, and a static 2D map with no clock simply has no clock group. `get_view` carries `profile: 'tabdock.map.v1'`, since a name alone cannot prove a page follows the profile. A page may add result fields and optional arguments within v1; any change of meaning makes v2. Each description is one ASCII line of at most 200 characters, so a first-class listing shows it whole.

## Consequential tools

The profile marks no tool consequential: a camera, clock, layer or stop move by an approved driver is reversible. But MCP-B 5.x and Chrome 153 drop `consequentialHint`, and there a page that names no consequential tool has every write prompt (ADR 0034), so the operator would be asked at every camera move. Name your irreversible tools in `consequentialTools`, never an empty list, which names none; `consequential: 'allow'` is only for a page that has none.

```ts
import { attach } from '@tabdock/adapter';

attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['reset_edits'], imageTools: ['capture_view'] },
});
```

## capture_view

A page that names `capture_view` in `imageTools` returns ADR 0039's envelope, `{ image: { mimeType, data }, text }`, with the view, `visibleLayers`, `observationId`, `widthPx` and `heightPx` as JSON in its text. A page that does not returns that JSON with a description, as text.

The text beside an image stays within 1,800 characters, so no adapter cuts it: where the visible layers' ids would not fit, the list stops and `visibleLayersOmitted` counts the rest, which `list_layers` names. Capture only the page's own canvas, never the tab, which shows the pairing code, with `toDataURL` and `image/png` or `image/jpeg`. A WebGL canvas captures in the same task as its render, or keeps `preserveDrawingBuffer`; tiles from another origin need CORS, or the canvas cannot be read at all. Refuse a `"data:,"` result, or one of another type than you asked for. `maxWidthPx` lets a client retry smaller when a capture is refused as too large.

## Published state

A map page that shares its state with `publishState()` (ADR 0040) publishes `MapPageState`: the view and clock as `get_view` and `get_clock` return them, the current walkthrough and stop, and the observation on screen, with no titles or text. It publishes on discrete changes only, a write, a drag or a stop, never per animation frame, so while the clock plays the published time is as of the last change, and a follower that needs the exact time calls `get_clock`.

```json
{
  "view": {
    "profile": "tabdock.map.v1",
    "body": "moon",
    "projection": "globe",
    "lon": -11.36,
    "lat": -43.31,
    "widthM": 419676.9,
    "headingDeg": 180,
    "pitchDeg": -60,
    "altitudeM": 450000,
    "fovDeg": 50,
    "bounds": { "west": -21.5, "south": -47.2, "east": -1.2, "north": -39 }
  },
  "clock": {
    "time": "2026-01-01T12:00:00.000Z",
    "rate": 60,
    "playing": false,
    "start": "2026-01-01T00:00:00.000Z",
    "end": "2026-01-02T00:00:00.000Z"
  },
  "walkthrough": { "id": "flyby", "stopIndex": 3 },
  "observationId": "obs-4"
}
```

## Limits

Titles, names, notes, texts and URLs hold no control character but tab and line breaks, so JSON at most doubles them. At these caps every answer stays under the relay's 120,000 character result cap, and the published state under 2 KB.

| Limit                                        | Value                   | Constant                                                                               |
| -------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| A tool description                           | 200 characters          | `MAP_MAX_DESCRIPTION_CHARS`                                                            |
| Features in one answer, and unless asked     | 200, 50                 | `MAP_MAX_FEATURES`, `MAP_DEFAULT_FEATURES`                                             |
| Observations in one answer, and unless asked | 150, 100                | `MAP_MAX_OBSERVATIONS`, `MAP_DEFAULT_OBSERVATIONS`                                     |
| Layers                                       | 100                     | `MAP_MAX_LAYERS`                                                                       |
| Walkthroughs, and stops in each              | 50, 1,000               | `MAP_MAX_WALKTHROUGHS`, `MAP_MAX_STOPS`                                                |
| An id, a kind, and a title or name           | 64, 40, 200 characters  | `MAP_MAX_ID_CHARS`, `MAP_MAX_KIND_CHARS`, `MAP_MAX_TITLE_CHARS`                        |
| A stop's text                                | 4,000 characters        | `MAP_MAX_TEXT_CHARS`                                                                   |
| Positions in one footprint                   | 1,000                   | `MAP_MAX_FOOTPRINT_POSITIONS`                                                          |
| Notes on an observation, and each note       | 10, 500 characters      | `MAP_MAX_NOTES`, `MAP_MAX_NOTE_CHARS`                                                  |
| A capture's width: least, unless asked, most | 64, 1,024, 2,048 pixels | `MAP_MIN_CAPTURE_WIDTH_PX`, `MAP_DEFAULT_CAPTURE_WIDTH_PX`, `MAP_MAX_CAPTURE_WIDTH_PX` |
| The JSON beside a captured image             | 1,800 characters        | `MAP_MAX_CAPTURE_TEXT_CHARS`                                                           |

## Worked examples

The profile's names, schemas and limits are in `packages/sim-page/src/map/profile.ts`, as zod schemas that both check a handler's arguments and become the JSON Schema clients see. `packages/sim-page/src/map/tools.ts` registers the fourteen tools over a map world of the Moon with `createMapTools()`, beside two editing tools that are not part of the profile: `edit_stop`, a write, and `reset_edits`, the one consequential tool. `startMapSimPage()` runs them on the sim page for relay tests.

[tests/map-page](../../tests/map-page/README.md) is a canvas page with no map library, the same tools in a browser, which `pnpm dev:map` serves at http://127.0.0.1:5174/ and tests serve with `startMapPageServer()`. It reads nothing from its URL, and dials a relay only on a click on its Connect button or from its own script, as the tests connect it.

To teach a client the profile, one line will do: "this page follows the Tabdock map profile, `tabdock.map.v1`", with this page beside it. An observation's source URL is page text too, so a client should not fetch it on a page's say-so alone.

Back to [the guide's index](README.md).
