# 0038: A tool set for map and globe pages

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B now, with its worked examples in the sim page and a private canvas test page, `tests/map-page`; option C, a published schema package, stays deferred until a real map page has used B. Changes SPEC section 4 (layout lines for `tests/map-page` and the sim page's map example) and section 10 (A6.1 and A6.2), though it was proposed as changing none. Priority 1 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`; built in M6 (`docs/plans/M6.md`).

## Context

Tabdock carries whatever tools a page registers and has no opinion about their names. The target scenario is a map and globe viewer, and map pages share one vocabulary: a camera view over a body, a clock, layers, named features, guided walkthroughs, and observations such as photos that have a time, a viewpoint and a footprint. If every map page names these its own way, a client skill that teaches Claude to drive one page has to be rewritten for the next. A shared set is a convention, not a protocol change: a page that ignores it still works.

## Options

A. No set. Each page names its own tools, and the guide says nothing more.

B. A written profile: tool names, argument and result shapes, annotations, units and frames, with worked examples. A page adopts it by registering those tools through WebMCP as it registers any other.

C. B plus a small package that exports the profile's zod schemas and a helper that registers the tools from a page's handlers. zod is on CLAUDE.md's list; the package is a new entry in SPEC section 4's layout.

## Decision

B now, C once one real map page has used B and the shapes held. The profile, names provisional:

| Group        | Tool                    | Annotation | What it does                                                                   |
| ------------ | ----------------------- | ---------- | ------------------------------------------------------------------------------ |
| View         | `get_view`              | read-only  | Body, centre, altitude or zoom, heading, pitch, field of view, projection      |
| View         | `set_view`              | write      | Moves the camera; any subset of `get_view`'s fields                            |
| View         | `capture_view`          | read-only  | An image of the view (ADR 0039); until then, a text description                |
| Clock        | `get_clock`             | read-only  | Time, rate, playing or paused                                                  |
| Clock        | `set_clock`             | write      | Any subset of the same                                                         |
| Layers       | `list_layers`           | read-only  | Id, title, kind, visible, opacity                                              |
| Layers       | `set_layer`             | write      | Visibility and opacity of one layer                                            |
| Features     | `features_in_view`      | read-only  | Named features in view with positions, capped                                  |
| Walkthroughs | `list_walkthroughs`     | read-only  | Id, title, stop count                                                          |
| Walkthroughs | `get_stop`              | read-only  | One stop by index, the current one by default: title, text, its view and clock |
| Walkthroughs | `go_to_stop`            | write      | Moves the page to a stop                                                       |
| Observations | `list_observations`     | read-only  | Photos or other observations: id, title, time, filtered by walkthrough or time |
| Observations | `get_observation`       | read-only  | One observation's viewpoint, footprint polygon, source and quality notes       |
| Observations | `view_from_observation` | write      | Moves the camera to an observation's viewpoint, for a photo and render compare |

Units and frames are fixed so a client never guesses: angles in degrees, latitude planetocentric and longitude east-positive, distances in metres, times in ISO 8601 UTC, the body named in every view, and polygons as arrays of `[longitude, latitude]` pairs in GeoJSON order. Results are JSON text behind the relay's label, since page text never travels as structured content (S10). A map page that publishes state (ADR 0040) publishes the view as `get_view` returns it, the clock as `get_clock` returns it, the current walkthrough and stop index, and the id of the observation on screen, if any. A page that edits its own content (captions, stops) keeps those tools beside the set. "Walkthrough" is used rather than "tour", which already names the owner's explainers in `docs/tour/`.

Consequential tools: the set marks none, but on runtimes that drop the hint (MCP-B 5.x, Chrome 153) a page that names no consequential tool has every write prompt (ADR 0034), which would prompt the teacher on every camera move. So a map page names its consequential tools in `policy.consequentialTools` or, if it has none, sets `consequential: 'allow'`.

The worked examples ship twice: in the sim page as the profile's tools over in-memory map state, for relay tests, and in a browser test page that draws a plain canvas map with no map library, for ADR 0041's checks, since a library would be a new dependency (CLAUDE.md).

## Consequences

A client skill can teach "drive a map page" once. The profile is the target for ADR 0041's checks and the shape ADR 0040's published state mirrors. Published as a guide page, its camelCase names and calls must occur in the source (`doc-pointers.test.ts`, ADR 0035), so it ships with or after the code it names.

## Open questions, as proposed

The final names, and whether walkthroughs and observations belong in the core set or in optional groups. Whether a 2D map and a globe need different view fields, or one shape with optional fields. Whether `features_in_view` should page its results or cap them.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Names:** the table's fourteen tool names, in snake case with no prefix. get_view's result carries `profile: 'tabdock.map.v1'` (MAP_PROFILE).
2. **Core and groups:** the core is get_view and set_view. Capture, Clock, Layers, Features, Walkthroughs and Observations are optional groups, each registered whole or not at all.
3. **One view shape** for 2D maps and globes. altitudeM and fovDeg are present exactly when the projection is 'globe'. set_view takes widthM or altitudeM, never both.
4. **features_in_view:** capped with no cursor. limit runs from 1 to 200 with a default of 50, and the result is `{ features, total, truncated }`.
5. **Where it lives:** packages/sim-page/src/map/, exported as `@tabdock/sim-page/map`. Nothing goes in packages/protocol, and the relay and adapter never read profile names.
6. **Schemas:** zod classic 4.6.5 is the single source. They convert with `z.toJSONSchema(schema, { io: 'input' })` with $schema dropped, and use only keywords valid in both draft 2019-09 and 2020-12.
7. **Canvas page:** a private package at tests/map-page (`@tabdock/map-page`).
8. **How the canvas page dials:** only on a trusted click on its Connect form, or when page script calls `window.__tabdockMapPage.connect(relayUrl, policy?)`. It never dials from its URL and never exposes the Dock.
9. **Consequential tools:** the profile marks no tool consequential. `MAP_PAGE_POLICY = { consequentialTools: ['reset_edits'] }`, and the canvas page adds `imageTools: ['capture_view']`.
10. **Editing tools beside the set:** edit_stop (a write, not consequential) and reset_edits (consequential).
11. **Footprints:** a GeoJSON Polygon or MultiPolygon with at most 1,000 positions, or null.
12. **Units:** as the design lists them. Longitude runs from -180 to 180, times are UTC ISO strings ending in Z, and units ride in field names.
13. **go_to_stop:** by index only.
14. **Writes:** each resolves with the state it produced, and get_view reports the target view at once.
15. **Refusals:** handlers throw, so the call ends as tool_error, and schemas carry every fixed bound.
16. **Descriptions:** one ASCII line of at most 200 characters. The first-class prefix's word change to "content" (0039) still leaves about 207 characters.
17. **untrustedContentHint:** set on the seven tools the design names.
18. **Published state:** MapPageState is `{ view, clock, walkthrough: { id, stopIndex } | null, observationId }`. The page publishes on discrete changes only, never per animation frame.
19. **capture_view arguments:** maxWidthPx from 64 to 2048 (default 1024) and format 'png' or 'jpeg'.
20. **capture_view checks (added from research):** it captures in the same task as the render, and throws on `"data:,"` or on a data URL whose type differs from the one it asked for.
21. **Versioning:** additive changes stay within v1, and any change of meaning makes v2.
22. **Guide page number:** 16 rather than 13 (conflict C9).
23. **Polyfill:** the canvas page may use the MCP-B polyfill as a test-only dependency at exact 5.1.0. It is recorded in this plan beside CLAUDE.md's allowance for the demo page.
24. **Declared image tool that returns words:** they travel as text, under ADR 0039's rule (conflict C6).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C3, how the canvas page dials.** 0041 wanted it to attach from its URL. ADR 0038's rule wins: the page never dials from its URL. tests/ci-check's fixture connects through `page.evaluate` of the connect hook inside one exported function, `connectPage()`, which the README names as the one place a copier changes.
- **C4, one walker.** It lives in `tests/ci-check/src/walk.ts`. ADR 0038's `tests/e2e/src/map-walk.ts` is dropped. tests/e2e takes `@tabdock/ci-check` as a workspace devDependency. A test holds the copyable schemas in `tests/ci-check/src/profile.ts` equal, as JSON Schema, to `@tabdock/sim-page/map`'s.
- **C5, ports.** `tests/map-page/scripts/server.ts` takes `--port`, else MAP_PAGE_PORT, else 5174. scripts/ci-check.ts passes `--port 5180`.
- **C6:** a declared image tool that returns words travels as text, not tool_error.
- **C9, guide numbering.** The new pages are:
  - 13: The control handle (moved from page 04)
  - 14: Settings for rooms, images and state
  - 15: Limits for rooms, images and state
  - 16: Map and globe pages
  - 17: Check a page from CI
  - 18: Images and page state
  - 19: Lessons, proposals and records
  - 20: Larger rooms, members and agents

## Notes from the other M6 records (10 October 2026)

**From ADR 0039.** `capture_view` returns ADR 0039's envelope, with `maxWidthPx` from 64 to 2048 (1024 unless set) and `format` `'png'` or `'jpeg'`. A WebGL canvas captures in the same task as its render, or keeps `preserveDrawingBuffer`; tiles drawn from another origin need CORS, or the canvas cannot be read; and a `"data:,"` result, or one of another type than asked, is refused. The guide page is `docs/guide/16-map-pages.md`.

**From ADR 0040.** A map page publishes `MapPageState`, `{ view, clock, walkthrough: { id, stopIndex } | null, observationId }`, as `get_view` and `get_clock` return them, on discrete changes only, never per animation frame, so a playing clock does not spend the state budget.

**From ADR 0041.** A write that moves the camera resolves once the camera has arrived, so a walker reads the view it asked for. The one walker is `tests/ci-check/src/walk.ts`, and the design's `tests/e2e/src/map-walk.ts` is dropped (C4).

**Open questions.** Each is settled under Decisions: the names (1), the groups (2), one view shape (3) and a capped `features_in_view` (4).
