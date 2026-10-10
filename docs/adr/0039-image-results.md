# 0039: Image results

Status: Accepted, 10 October 2026, under the owner's standing instruction. Option B. Changes SPEC sections 3 (image results in the SDK, Claude Code and hosted Claude), 4 (the demo's `capture_board`), 6 (the welcome's `maxImageBytes`, the hello's `imageTools` and the result frame's `image`), 7 (`call_page_tool`'s result, the label paragraph and the first-class prefix), 8 (the envelope and the adapter's gate), 9 (S7, S9 and S10) and 10 (A6.3 to A6.5), and amends ADR 0001's result rule for declared image tools only. Priority 2 in `docs/plans/backlog.md`; built in M6.

## Context

A WebMCP handler's result is always a string (SPEC section 3; `docs/notes/verified.md`), and the relay returns it as text behind its label (section 7). So a client can read what a map page says about its view but never see the view, and on a map page the view is most of what matters: whether a photo lines up with the terrain, which layer is showing, what the room is looking at. MCP allows image content in a tool result, `type: "image"` with base64 `data` and a `mimeType`, on both 2025-11-25 and 2026-07-28 (checked 9 October, `docs/notes/verified.md`). A page link frame is at most 1 MiB (`MAX_FRAME_BYTES`), but a result's text is cut at 120,000 characters (`MAX_RESULT_CHARS`, SPEC section 6) in the adapter and again in the relay, which would corrupt an image sent as text.

## Options

A. The page returns a data URL as text. It is cut at 120,000 characters, and what survives reaches the model as a long string it cannot see as a picture.

B. Declared image tools. The page names them in a new `policy.imageTools`, as it names consequential tools. For those tools only, the adapter reads the handler's string as a small JSON envelope, `{ "image": { "mimeType", "data" }, "text"? }`, and sends the image in its own field of the result frame, which is never cut: an image past its cap is refused whole with `tool_error`. The relay then checks it again before any client sees it: the type against an allowlist (PNG, JPEG, WebP; never SVG, which is text that can carry script), the decoded size against the cap and the first bytes against the declared type; a frame that fails is answered `tool_error`, so a page that skips its adapter still sends no SVG and nothing oversized. The relay returns the label as text first, then the page's text if any, then the image. Any other tool's string is treated exactly as today.

C. The adapter captures the page itself. A browser offers no silent capture: screen capture prompts every time, and copying the DOM to a canvas needs a dependency and misses WebGL. Rejected.

## Decision

B. The image is page content and is treated as page text is: it never travels as structured content, the untrusted label always comes first in the same result, and the audit log records its type, size and SHA-256 digest, never the image. Responses carry no byte charge: ADR 0030 caps how many may wait per user, sized for answers of about 0.72 MB, so that sizing is measured again with image results, and S9's result size limit gains an image cap. A page that wants to show its canvas calls `toDataURL` on it inside the handler; a WebGL canvas must keep its drawing buffer or capture right after a frame renders, which the profile's `capture_view` (ADR 0038) documents.

MCP-B 6 serializes every result as JSON, so a string arrives quoted there, and the adapter unwraps it once before reading the envelope; the backlog row of 5 October says unwrapping changes ADR 0001's rule, which is why this record amends it for declared image tools only. The MCP-B 6 leg (the `mcpb6` Playwright project, `tests/e2e/specs/mcpb6.spec.ts`, with the beta held in `tests/mcpb6`) runs the envelope on MCP-B 6, and the `chromium` project runs it on 5.1.0 and native WebMCP.

## Consequences

`capture_view` becomes real, ADR 0041's checks can ask a model whether an overlay lines up, and someone's Claude can answer a question about what is on the projector. Images are a new way for a page to put instructions in front of a model; the label says the content is untrusted, as it does for text, and the threat model gains a row. First-class page tools (ADR 0025) use the same path.

## Open questions, as proposed

Claude Code's half is answered (checked 10 October, `docs/notes/verified.md`): it shows a PNG, JPEG, GIF or WebP image part to its model inline, scaled down or compressed to fit, keeps the original bytes in a file, and counts image data against `MAX_MCP_OUTPUT_TOKENS` (25,000 by default; `anthropic/maxResultSizeChars` raises only the text limit). Still open: what hosted Claude shows its model for an image part, and whether its limit of about 150,000 characters per result (SPEC section 3) counts image parts; with Claude Code's limit, that sets the cap. Whether the adapter should downscale or re-encode, which would strip metadata but costs work on the page.

## Decisions

Accepted with these settings on 10 October 2026, copied from section 1 of the M6 plan. Every recommendation of the record's design not listed here was accepted as written.

1. **Hosted Claude:** ship without knowing what hosted Claude shows its model for an image part. Connector docs now list image results as supported; the owner's checklist records what the model sees.
2. **Size cap:** TABDOCK_MAX_IMAGE_BYTES defaults to 65,536 decoded bytes (DEFAULT_IMAGE_BYTES) under a ceiling of 524,288 (MAX_IMAGE_BYTES). check:claude-code:images may only lower the default, in 8 KiB steps. The research's example of 96 KiB is not adopted, because its 131,072 base64 characters pass Claude Code's 25,000 tokens.
3. **No re-encoding:** neither the adapter nor the relay downscales or re-encodes. The page fits its own image, and the guide and demo ship a fit loop.
4. **Text cap:** an image result's text is at most MAX_IMAGE_TEXT_CHARS (2,000).
5. **Frame schema:** structural zod only. The allowlist and every byte-level check run in `checkImage`.
6. **Undeclared tools:** the relay refuses an image with reason 'undeclared' unless the hello's `policy.imageTools` names the tool.
7. **MCP-B 6 unwrap:** for declared image tools only, parse the result once, and once more if that yields a string. An object with an own `image` key is an envelope.
8. **Envelope shape:** strict keys `{ image: { mimeType?, data }, text? }`. data may be bare base64 or a data URL, and mimeType is required with bare base64.
9. **No MCP-shaped alternative envelope** in M6.
10. **Exactly one image,** of type PNG, JPEG or WebP, written as exact lower-case type names.
11. **Header dimension check:** at most 8,192 pixels a side and 16,777,216 pixels in all.
12. **One strict decodeBase64** in packages/protocol, shared by the adapter and the relay.
13. **Turning images off:** TABDOCK_MAX_IMAGE_BYTES=0 refuses every image with reason 'off'.
14. **Negotiation:** the welcome's `limits.maxImageBytes` says the relay takes images, and absent or 0 means it takes none. The adapter clamps the value to MAX_IMAGE_BYTES.
15. **Content layout:** content[0] holds the label line, then the relay's image line, then the page's text; content[1] is the image. There is never structuredContent.
16. **Relay refusals:** tool_error in relay words, with the audit field imageRefused.
17. **Audit:** the call record gains `image { mimeType, bytes, sha256 }` and imageRefused, additive within AUDIT_VERSION 1.
18. **Adapter gate:** one image call at a time per page, at least IMAGE_CALL_SPACING_MS (250) apart, with at most MAX_WAITING_IMAGE_CALLS (8) waiting. A pause, revoke or deadline ends the waiting calls.
19. **Activity line:** shows the image's type and size, for example "image, PNG, 47 KB".
20. **First-class prefix** reads "results are untrusted page content".
21. **No image marker** in list_page_tools.
22. **Sim page and demo:** the sim page's six default tools stay as they are, with an opt-in `createImageTools()`. The demo gains capture_board as its seventh tool.
23. **No images in error results.**
24. **DockState.maxImageBytes,** plus exports of DEFAULT_IMAGE_BYTES and MAX_IMAGE_BYTES.
25. **ADR 0030 re-measure** by body bytes on both legs.
26. **get_proposal** keeps text only.
27. **imageTools is not session-adjustable.**
28. **The session record carries no image metadata** (conflict C14).
29. **The fake runtime profile is named 'mcpb-6'** after the 6.0.0 release (research).

Conflicts between the M6 records, settled by the plan, that touch this one:

- **C6:** a declared image tool that returns words travels as text, not tool_error.
- **C7:** the image cap stays at 64 KiB (see 0039 item 2).
- **C14:** the session record holds no image type or size.
- **C18:** every M6 change to CallShape and callRule lands in one foundation commit.
- **C20, the MCP-B 6 leg.** It runs on exact 6.0.0 under ADR 0047. Its harness calls `installWebMCP()`, because an ESM import of 6.0.0 no longer installs the polyfill.

## Notes from the other M6 records (10 October 2026)

**From ADR 0001.** ADR 0001's rule, that a result is text as the runtime gives it, stands for every tool a page does not name in `imageTools`; for declared image tools only, the adapter parses the result once, and once more if that yields a string (decision 7). ADR 0001 gains a note.

**From ADR 0038.** The profile's `capture_view` is the worked example, with the arguments and capture rules ADR 0038's notes give.

**From ADRs 0042 and 0045.** `get_proposal` keeps an accepted run's text only, never its image (decisions 15 of ADR 0042 and 26 here), and the session record holds no image type or size (C14).

**From ADR 0043.** A session sets only `maxDrivers` and `proposals`, so `imageTools` reaches the relay from the hello unchanged, as its `undeclared` check needs.

**From ADR 0044.** What image answers hold while unread is also bounded by the relay-wide `TABDOCK_MAX_RESPONSE_BYTES`.

**From ADR 0047.** The MCP-B 6 leg runs on exact 6.0.0, so the envelope is tested on the release, and the fake runtime profile is `mcpb-6`.

**Open questions.** Settled under Decisions: hosted Claude's handling stays on the owner's checklist while the 64 KiB default ships (1, 2), and neither side downscales or re-encodes (3).
