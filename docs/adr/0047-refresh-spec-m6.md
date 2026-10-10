# 0047: Refresh SPEC section 3 for M6, and move the MCP-B 6 leg to 6.0.0

Status: Accepted, 10 October 2026, under the owner's standing instruction. Changes SPEC's dated line, section 3 (its heading, the WebMCP, MCP-B, MCP SDK, Claude, Claude Code, WorkOS and Fly rows, the sentence under the table and the unverified paragraph) and section 4 (the `tests/mcpb6` line). Amends ADR 0031's decision D4 for the test leg only, and adds a note to ADR 0001. The research is the set of `docs/notes/verified.md` rows dated 10 October.

## Context

SPEC section 3 was last refreshed on 8 October (ADR 0037). M6's research of 10 October re-checked the facts its eight ADRs lean on. Most hold; four have moved.

MCP-B 6.0.0 became npm `latest` for all seven `@mcp-b` packages on 8 October, with a GitHub release, a changelog and `@6` CDN URLs that answer. ADR 0031 kept the demo on 5.1.0 while 6.0 was a beta and ran the adapter on the beta in `tests/mcpb6`, saying the demo moves "the day 6.x becomes npm `latest`". 6.0.0's polyfill differs from the beta in three small places and serializes results the same way, but an ESM import of it no longer installs the polyfill: a page must call `installWebMCP()`. Its changelog asks pages not ready to move to pin `@5`.

The WebMCP draft, now dated 9 October, serializes a handler's result to a JSON string, which quotes a plain string, and names its errors `OperationError`; Chrome 154 to 156 pass a string through unquoted and throw `UnknownError`. Chrome Stable is 155 since 6 October. Hosted Claude's connector docs now list image tool results as supported, while still not saying whether an image counts toward its result limit or what the model is shown. Claude Code's MCP page adds a 16 MB cap on a response body and gives the model only the text of an `isError` result. ADR 0044 needs facts section 3 lacks: Google cannot be an MCP authorization server for the relay, WorkOS production needs the owner's own Google client, and Fly's shared-cpu-1x has a 6.25% baseline.

## Decision

**MCP-B.** `tests/mcpb6` moves from the beta to exact 6.0.0, and its harness calls `installWebMCP()` itself, since importing the module no longer installs it. The fake runtime profile for it is named `mcpb-6`. The demo and the canvas map page (`tests/map-page`, ADR 0038) stay on exact 5.1.0, so the hint-dropping runtime keeps its coverage; the demo's move keeps its own backlog row, which now names 6.0.0 as `latest`. If 6.0.0 breaks the leg, the beta pin stays and this record says why, and A6.26 names the beta. The adapter needs no change: 6.0.0 behaves as the beta did, and ADR 0001's rule and ADR 0039's single unwrap cover a quoted result.

**Section 3.** Its heading becomes "## 3. Facts verified on 2, 3, 5, 8 and 10 October 2026 (re-verify before relying on them)". The WebMCP row gains the 9 October draft's serialization and error name, Chrome's behaviour beside it, and Stable 155. The MCP-B row says 6.0.0 is `latest`, what changed from the beta and that an import no longer installs the polyfill. The MCP SDK row says the pins are still `latest` and that the SDK accepts malformed base64 and any image type, after which a client drops the whole result, which is why the relay checks images itself (ADR 0039). The Claude connector row lists image results as supported, one custom connector on the Free plan, and request headers as an organization's credential for up to four headers. The Claude Code row gains its image handling, its 16 MB body cap, its text-only `isError` results, and `claude mcp add --header` at local scope with `${VAR}` expansion in `.mcp.json`. The WorkOS row gains Google as an upstream with the owner's own client and why Google cannot be the relay's issuer, and the Fly row the CPU baseline. The sentence under the table names ADR 0047, and the unverified paragraph names what hosted Claude shows for an image part and whether it counts one, and how Claude Code counts image data.

**SPEC wording.** The dated line reads "Draft 1, 2 October 2026; last amended 10 October 2026 by ADRs 0038 to 0048." Section 4's `tests/mcpb6` line says it holds MCP-B 6.0.0.

## Consequences

The 6 leg tests the release pages will meet, not a beta, and the demo still shows the runtime most pages run today. If Chrome starts quoting results as the draft says, every string result from every page would arrive quoted; ADR 0001's rule passes it through and the image unwrap already handles it, and a Chrome Canary leg joins the owner's checklist to catch it. Section 3 stays a dated record that each milestone refreshes from `verified.md`.
