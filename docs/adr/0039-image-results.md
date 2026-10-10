# 0039: Image results

Status: Proposed, 9 October 2026. Priority 2 in `docs/plans/backlog.md`, for the target scenario in `docs/plans/map-classroom.md`. Would change SPEC sections 6 (the result frame), 7 (`call_page_tool`'s result), 8 (adapter policy) and 9 (S9 and S10), and amends ADR 0001's result rule for declared image tools only.

## Context

A WebMCP handler's result is always a string (SPEC section 3; `docs/notes/verified.md`), and the relay returns it as text behind its label (section 7). So a client can read what a map page says about its view but never see the view, and on a map page the view is most of what matters: whether a photo lines up with the terrain, which layer is showing, what the room is looking at. MCP allows image content in a tool result, `type: "image"` with base64 `data` and a `mimeType`, on both 2025-11-25 and 2026-07-28 (checked 9 October, `docs/notes/verified.md`). A page link frame is at most 1 MiB (`MAX_FRAME_BYTES`), but a result's text is cut at 120,000 characters (`MAX_RESULT_CHARS`, SPEC section 6) in the adapter and again in the relay, which would corrupt an image sent as text.

## Options

A. The page returns a data URL as text. It is cut at 120,000 characters, and what survives reaches the model as a long string it cannot see as a picture.

B. Declared image tools. The page names them in a new `policy.imageTools`, as it names consequential tools. For those tools only, the adapter reads the handler's string as a small JSON envelope, `{ "image": { "mimeType", "data" }, "text"? }`, and sends the image in its own field of the result frame, which is never cut: an image past its cap is refused whole with `tool_error`. The relay then checks it again before any client sees it: the type against an allowlist (PNG, JPEG, WebP; never SVG, which is text that can carry script), the decoded size against the cap and the first bytes against the declared type; a frame that fails is answered `tool_error`, so a page that skips its adapter still sends no SVG and nothing oversized. The relay returns the label as text first, then the page's text if any, then the image. Any other tool's string is treated exactly as today.

C. The adapter captures the page itself. A browser offers no silent capture: screen capture prompts every time, and copying the DOM to a canvas needs a dependency and misses WebGL. Rejected.

## Decision

B. The image is page content and is treated as page text is: it never travels as structured content, the untrusted label always comes first in the same result, and the audit log records its type, size and SHA-256 digest, never the image. Responses carry no byte charge: ADR 0030 caps how many may wait per user, sized for answers of about 0.72 MB, so that sizing is measured again with image results, and S9's result size limit gains an image cap. A page that wants to show its canvas calls `toDataURL` on it inside the handler; a WebGL canvas must keep its drawing buffer or capture right after a frame renders, which the profile's `capture_view` (ADR 0038) documents.

MCP-B 6 serializes every result as JSON, so a string arrives quoted there, and the adapter unwraps it once before reading the envelope; the backlog row of 5 October says unwrapping changes ADR 0001's rule, which is why this record amends it for declared image tools only. The MCP-B 6 test leg (`tests/mcpb6`) runs the envelope on both runtimes.

## Consequences

`capture_view` becomes real, ADR 0041's checks can ask a model whether an overlay lines up, and someone's Claude can answer a question about what is on the projector. Images are a new way for a page to put instructions in front of a model; the label says the content is untrusted, as it does for text, and the threat model gains a row. First-class page tools (ADR 0025) use the same path.

## Open questions

What Claude Code and hosted Claude show their model for an image part in a tool result, which is not yet checked and decides the value of this record. Whether hosted Claude's limit of about 150,000 characters per result and Claude Code's 25,000 token cap (SPEC section 3) count image parts, which sets the cap. Whether the adapter should downscale or re-encode, which would strip metadata but costs work on the page.
