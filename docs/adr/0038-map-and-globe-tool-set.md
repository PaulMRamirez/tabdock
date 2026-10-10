# 0038: A tool set for map and globe pages

Status: Proposed, 9 October 2026. Priority 1 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Changes nothing in SPEC as proposed; option C would change section 4 (a new package).

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

## Open questions

The final names, and whether walkthroughs and observations belong in the core set or in optional groups. Whether a 2D map and a globe need different view fields, or one shape with optional fields. Whether `features_in_view` should page its results or cap them.
