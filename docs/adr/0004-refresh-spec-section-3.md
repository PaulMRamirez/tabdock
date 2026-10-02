# 0004: Refresh SPEC section 3 with the facts verified on 2 October

Status: Accepted by the owner, 2 October 2026. SPEC section 3 updated.

## Context

SPEC section 3 asks for every moving fact to be re-verified before use. The M0 check (`docs/notes/verified.md`, with each discrepancy confirmed by a second, independent agent) found the table already behind on the day it was written. These are corrections of fact; the design decisions they force live in ADRs 0001 and 0002 and in ADRs still to come for M1 to M5.

## Decision

Replace these rows of SPEC section 3:

WebMCP: `document.modelContext` in secure contexts, origin trial M149 to M156 (extension to M162 requested). `executeTool` takes a JSON string on Chrome 153 and 154 and MCP-B 5.x, an object on Chrome 155+ and MCP-B 6, and always resolves to a string. `getTools()` entries carry `window` and `origin` and include same-origin iframe tools. Annotations are `readOnlyHint`, `untrustedContentHint`, `consequentialHint` and `debugging`; Chrome 153 and MCP-B 5.1.0 drop `consequentialHint`.

MCP-B: 5.1.0 is `latest`; 6.0 is in beta and its documentation is already live. `webmcp-types` 0.1.10 belongs to the WebML Community Group, not MCP-B.

MCP: revision 2026-07-28 is final (blog.modelcontextprotocol.io/posts/2026-07-28/). `clientInfo` in `_meta` is a SHOULD and unauthenticated; `list_changed` travels only over a client-opened `subscriptions/listen` stream. SDK: server, client and core 2.3.0, node adapter 2.1.1, v1 at 1.32.0.

Claude: fixed request headers on custom connectors are a beta for a limited set of organizations; connector egress is 160.79.104.0/21. Claude Code times out an HTTP tool call after 60 s without a first byte and caps results at 25,000 tokens unless the server says otherwise.

Versions: Node 22.18 or later.

## Consequences

The spec stays honest about what was checked and when. Three of the corrected rows reach beyond M0 and need their own decisions before the milestone that meets them: how `pair_page` waits inside Claude Code's 60 s timer (M1), how clients are attributed when `clientInfo` is optional (M2), and how M3 authenticates if request-header connectors are unavailable on the owner's account.
