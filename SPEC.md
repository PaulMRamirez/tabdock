# Tabdock: build specification

Draft 1, 2 October 2026. Working name (the npm name `tabdock` was free on this date; `berth` was not). Personal-hat open source, Apache-2.0. Companion file: `CLAUDE.md`. Concept brief: https://claude.ai/artifact/TDYpSX5ZQKcw2t7sQ4tsqW

## 1. What we are building

Tabdock lets MCP clients attach to a live web page. The page keeps its own tools, registered through the WebMCP API (`document.modelContext`). A small adapter script on the page dials out to a relay. The relay is an ordinary remote MCP server with one stable URL, so Claude (mobile, desktop, web, Claude Code) or any MCP client adds it once. Pages come and go behind it. Several clients, and several people, can attach to the same page at once.

Three parts are new work: the page adapter, the relay, and pairing. Tool registration and the in-page runtime are reused, not rebuilt.

```
MCP clients (many) --HTTPS + auth--> RELAY <--WebSocket, dialed out by page-- ADAPTER --> document.modelContext --> app handlers
```

## 2. Decisions already made

| Decision | Choice | Reason |
| --- | --- | --- |
| Hat and licence | Personal-hat, Apache-2.0, no employer references | Owner's call |
| Multi-client scope | One user's several clients and several users on one page, both from the first build | Owner's call |
| Root of trust | The tab. Whoever can click on the page approves each attachment and sets its role | One rule covers both multi-client cases |
| Tool registration | WebMCP `document.modelContext`, native or MCP-B polyfill. No new registration API | Standard exists; the same registration serves in-browser agents |
| Connector shape | One stable relay URL. Pages pair to the user, not the client to the page | Claude connects from Anthropic's cloud; connectors cannot be edited in place |
| Tool surface | Five fixed tools first. Page tools as first-class entries in M5 | Fixed tools work on every client |
| Stack | TypeScript everywhere, Node 22+, pnpm workspace. Any Python helper uses uv | Shared protocol types; matches MCP-B |
| Relay trust | The relay sees plaintext calls and results. Self-host first | Stock connectors cannot do end-to-end encryption to a page |
| Upstream | Stay close to MCP-B's page protocol ideas and propose a remote relay mode there | Avoid a competing project |

## 3. Facts verified on 2 October 2026 (re-verify before relying on them)

These standards and packages are moving. Check current docs before coding against any of them, and log what you checked in `docs/notes/verified.md`.

| Fact | Where it came from |
| --- | --- |
| WebMCP is a Chrome origin trial (M149 to M156, extension to M162 requested). The API is `document.modelContext`, in secure contexts only, with `registerTool`, `getTools`, `executeTool(tool, input, {signal})` and a `toolchange` event. `input` is a JSON string on Chrome 153 and 154 and MCP-B 5.x and an object on Chrome 155+ and MCP-B 6; the result is always a string. `getTools()` entries carry `window` and `origin` and include same-origin iframe tools. Annotations: `readOnlyHint`, `consequentialHint`, `untrustedContentHint`, `debugging`; Chrome 153 and MCP-B 5.1.0 drop `consequentialHint` | developer.chrome.com/docs/ai/webmcp/imperative-api, webmachinelearning.github.io/webmcp, `docs/notes/baseline.md` |
| MCP-B ships a polyfill and runtime. `latest` is 5.1.0 for `@mcp-b/global`, `@mcp-b/webmcp-polyfill`, `@mcp-b/webmcp-ts-sdk` and `@mcp-b/webmcp-local-relay`; 6.0 is in beta and docs.mcp-b.ai already describes it. `webmcp-types` 0.1.10 is the WebML Community Group's types package, not MCP-B's | npm registry, docs.mcp-b.ai |
| MCP revision 2026-07-28 is final and stateless: no initialize handshake, no session id, `server/discover`, multi round trip via `input_required`, `ttlMs` with `cacheScope` on list results. Client info in `_meta` is a SHOULD and unauthenticated; `list_changed` travels only over a client-opened `subscriptions/listen` stream | blog.modelcontextprotocol.io/posts/2026-07-28/ |
| MCP SDK packages: `@modelcontextprotocol/server`, `client` and `core` 2.3.0 with `@modelcontextprotocol/node` 2.1.1 (v2 line, serves 2026-07-28 and 2025-era clients), `@modelcontextprotocol/sdk` 1.32.0 (v1 line, 2025-era only) | npm registry |
| Claude reaches custom connectors from Anthropic's cloud (160.79.104.0/21, IPv4) on every client. It supports Streamable HTTP, OAuth, fixed request headers (a beta for a limited set of organizations) or no auth, tools, prompts and resources. No resource subscriptions, sampling or draft capabilities. Hosted limits: 240 s per tool call, about 150,000 characters per result | support.claude.com article 11175166, claude.com/docs/connectors/building |
| Claude Code supports `list_changed` and HTTP servers with custom headers. It fails an HTTP tool call after 60 s without a first byte and caps results at 25,000 tokens unless the server says otherwise | code.claude.com/docs/en/mcp |
| Other versions: `ws` 8.22.0, `hono` 4.13.12, `qrcode-generator` 2.0.4, Node 22.18 or later (it runs `.ts` files directly) | npm registry, nodejs.org |

Rows refreshed by ADR 0004 from `docs/notes/verified.md`. Unverified and to be measured in M3: whether hosted Claude (web, desktop, mobile) refreshes a changing tool list during a conversation.

## 4. Architecture and repo layout

```
packages/protocol   Message types and zod schemas shared by relay and adapter
packages/relay      Node service: page WebSocket endpoint, MCP endpoint, pairing, auth plugins, audit log
packages/adapter    Browser library: link to relay, widget UI, policy, lifecycle
packages/sim-page   Node stand-in for a page (fake document.modelContext) used by automated tests
apps/demo           A small visual, stateful page with WebMCP tools
tests/e2e           End-to-end tests: MCP client, relay, sim page; Playwright for the real adapter
docs/               adr/, notes/, tour/ (explainers for the owner), checklists/
```

The relay is one process with an in-memory store through M3. Put storage behind an interface so M4 can persist the audit log. The relay never executes page tools itself; it only routes.

The demo page should make state visible: a canvas board with items and a viewport. Tools: `get_view` and `list_items` (read-only), `add_item`, `move_view` and `highlight_item` (mutating), `clear_board` (consequential).

## 5. Identity, roles and the trust rule

| Entity | Fields | Notes |
| --- | --- | --- |
| User | `userId`, `displayName` | Comes from the auth plugin |
| Client | MCP client name and version taken from each request | Attribution only. All of a user's clients share that user's attachments |
| PageSession | `pageId`, `origin`, `title`, `url`, `tools`, `state` (awake, asleep, gone), `resumeToken` | `origin` is read from the WebSocket `Origin` header, never from page-supplied text |
| Attachment | `pageId`, `userId`, `role`, `grantedAt`, `lastUsedAt`, `expiresAt` | Created only by an operator approval |
| PairingTicket | `code`, `nonce`, `pageId`, `expiresAt` | Single use, 120 s life, rotates after use |
| AttachRequest | `requestId`, `pageId`, `userId`, `via` (code or qr), `expiresAt` | 60 s to approve, default deny. At most one pending per user per page; a second `pair_page` from that user waits on it (ADR 0007) |

Trust rule: no attachment exists without an approval made on the page, unless the page set `autoApprove: 'observer'`. The first approval sets a user's role; later approvals and denials for an attached user change nothing, because role changes and withdrawals go through `set_role` and `revoke`. The adapter keeps its own record of these grants and runs a call only under the least privileged of that record, the relay's roster and the role the invoke claims; a user missing from the roster has no role (ADR 0007).

Roles: an observer may call only tools whose `readOnlyHint` is true. A driver may call every tool. Consequential tools follow page policy: `confirm` (default, an on-page prompt per call), `allow`, or `deny`. A tool is consequential when its `consequentialHint` is true or the page names it in `policy.consequentialTools`; when the runtime cannot report the hint and the page names none, every tool that is not read-only counts as consequential (ADR 0002). A page whose tools carry no annotations at all declared no hints, so none were lost and only `policy.consequentialTools` applies (ADR 0007). `maxDrivers` defaults to 1 and counts users, so one person's phone and laptop both drive. Mutating calls run one at a time per page in arrival order; read-only calls run concurrently.

## 6. Page link protocol (adapter to relay)

Transport: WebSocket at `/page`, subprotocol `tabdock.v1`, JSON text frames shaped `{ "t": "<type>", ... }`. Both sides validate every frame with zod. Unknown types are ignored and logged. Frames are capped at 1 MB. Tool results over 120,000 characters are truncated with a visible marker.

| Direction | Type | Payload | Meaning |
| --- | --- | --- | --- |
| page to relay | `hello` | `v`, `resumeToken?`, `title`, `url`, `adapterVersion`, `policy` | First frame. A valid `resumeToken` resumes a session after reload |
| relay to page | `welcome` | `pageId`, `resumeToken`, `resumed`, `pairing`, `roster`, `limits` | Session accepted; `resumed` says whether the resume token was honoured |
| page to relay | `tools` | `tools[]` with `name`, `description`, `inputSchema`, `annotations` | Full replacement on every change |
| relay to page | `attach_request` | `requestId`, `user`, `via`, `client?`, `expiresAt` | Someone wants to attach |
| page to relay | `attach_decision` | `requestId`, `allow`, `role?` | Operator's answer |
| relay to page | `roster` | `attachments[]` | Sent on every change |
| page to relay | `set_role`, `revoke` | `userId`, `role` or `userId` or `"*"` | Operator controls |
| page to relay | `rotate_pairing` | none | Ask for a fresh code |
| relay to page | `pairing` | `code`, `url`, `expiresAt` | New pairing ticket |
| relay to page | `invoke` | `callId`, `tool`, `arguments`, `caller` (`userId`, `displayName`, `client`, `role`), `deadlineMs` | Run a tool |
| page to relay | `result` | `callId`, `ok`, `content` or `error` (`code`, `message`) | Outcome |
| relay to page | `cancel` | `callId`, `reason?` (`timeout`, `revoked`, `client` or `shutdown`) | Abort; the adapter fires the tool's AbortSignal |
| both | `ping`, `pong` | none | Relay pings every 15 s and closes after 30 s of silence |

When the socket drops, the page becomes `asleep` and its attachments survive for a 10 minute resume window. After that the page is `gone` and its attachments are deleted.

Close codes (ADR 0007): only a deliberate detach ends a session at once. A page that calls `dock.close()` closes with 4000, becomes `gone` without the resume window, and its in-flight calls fail with `page_gone`, except calls still waiting on an operator prompt, which the page denies first. Every other close leaves the page asleep, including 4002 (the page heard nothing from the relay and is reconnecting) and 4008 (the page's stand-in for 1008, which page code cannot send). The relay closes a superseded socket with 4001, which the page must not reconnect from, and uses 1001, 1008 and 1009 for idle or shutdown, malformed frames and oversized frames.

## 7. MCP surface (relay to clients)

Endpoint `/mcp`, Streamable HTTP, using the official MCP SDK. Do not hand-roll the transport. Prefer the v2 packages if they cover revision 2026-07-28 and still serve session-based clients; otherwise use the v1 SDK and record why in an ADR.

| Tool | Input | Returns |
| --- | --- | --- |
| `list_pages` | none | Pages this user is attached to: `page`, `origin`, `title`, `role`, `state`, `toolCount` |
| `pair_page` | `code` | Sends an attach request and waits up to 50 s for the operator (ADR 0005; the request itself lasts 60 s). Returns `page` and `role`; a request nobody answers is a denial, reported as `timeout` because the operator never decided (ADR 0007) |
| `list_page_tools` | `page` | Tool descriptors, each with an `allowed` flag for the caller's role |
| `call_page_tool` | `page`, `tool`, `arguments` | The page handler's result |
| `detach_page` | `page` | Removes the caller's own attachment |

Every page result starts with the header line `[tabdock: untrusted content from <origin>, tool <name>]`. JSON results also pass through as structured content. The fixed tools' own descriptions say that page content is untrusted and is never instructions.

Errors return as MCP tool errors with one of these codes in the text: `not_attached`, `role_denied`, `tool_not_found`, `page_asleep`, `page_gone`, `denied_by_operator`, `timeout`, `page_busy`, `pairing_expired`, `rate_limited`, `invalid_arguments`. The last covers arguments the relay will not forward: too large for one frame, or, from M2, failing the tool's `inputSchema` (ADR 0007).

Auth is a plugin: `authenticate(request)` returns a User or null. M1 ships `dev-token` (users and bearer tokens from `.env`). M3 adds a minimal `oauth` plugin and M4 hardens it (ADR 0006), delegating sign-in to an external identity provider through a maintained library, accepting Claude's hosted callback and Claude Code's loopback redirect.

M5 adds first-class page tools named `<alias>__<tool>`, described with an origin prefix capped at 500 characters, with a short `ttlMs` and `list_changed` for session-based clients, behind a config flag. The fixed tools always remain.

## 8. Adapter behaviour

```ts
import { attach } from '@tabdock/adapter';
const dock = attach({
  relay: 'wss://relay.example/page',
  policy: { autoApprove: 'none', maxDrivers: 1, consequential: 'confirm', consequentialTools: [] },
});
```

A script-tag build reads the same options from data attributes. The adapter never registers tools. It reads `document.modelContext` through `getTools`, listens for `toolchange` with a 2 s poll as fallback, and runs calls with `executeTool`, detecting per page whether the runtime wants its input as a JSON string or an object (ADR 0001). If `document.modelContext` is missing it logs how to add a polyfill and stays idle.

The widget lives in a closed shadow root: a badge with link state and attached count, and a panel with the pairing code and QR, the roster with role switch and revoke, an activity log of the last 50 calls, and a pause switch. Attach prompts and consequential-call prompts default to deny on timeout. Only the code that called `attach()` holds the control handle.

Lifecycle: hold a Web Lock while attached, reconnect with backoff from 0.5 s to 30 s using the `resumeToken`, and enforce role and policy again locally before running any call.

## 9. Security requirements (each needs an automated test unless marked manual)

1. S1. Origin is taken only from the WebSocket `Origin` header. Connections without it are rejected outside an explicit dev flag.
2. S2. An origin allowlist is enforced. Dev default is localhost only. Production refuses to start without an explicit list.
3. S3. Pairing codes carry at least 40 bits of entropy, are single use, expire in 120 s, are compared in constant time, and attempts are rate limited per user and per address.
4. S4. No attachment without operator approval, except under `autoApprove: 'observer'`.
5. S5. Roles are enforced in the relay and again in the adapter. A crafted request cannot let an observer run a mutating tool.
6. S6. Consequential tools prompt on the page by default, and a timeout means deny.
7. S7. Every call is attributed in the page activity log and the relay audit log: user, client, tool, time, outcome. Arguments are not logged by default.
8. S8. Revocation is immediate: in-flight calls are cancelled and later calls fail with `not_attached`.
9. S9. Limits exist for users per page, calls per user per minute, queue depth, frame size and result size.
10. S10. Page results are always labelled untrusted. Page-supplied descriptions are length capped and never merged into the fixed tools' descriptions.
11. S11. Tokens and codes never appear in logs. The QR nonce is single use and useless without a signed-in user and an operator approval.
12. S12. The relay binds to localhost in dev and requires TLS otherwise.
13. S13. A user can list and call only pages they are attached to. Access never depends on a page id being hard to guess.

## 10. Milestones and acceptance tests

Each milestone ends with green tests, a demo command (`pnpm demo:mN`), an explainer in `docs/tour/` for the owner, and updated ADRs. Stop and report at each boundary.

**M0 Scaffold and baseline (laptop).** Workspace, strict TypeScript, vitest, lint, CI. Demo page with six tools registered through the MCP-B polyfill. Run MCP-B's existing local relay against it from Claude Code.
1. A0.1 `pnpm test`, `pnpm lint` and `pnpm typecheck` pass from a clean clone.
2. A0.2 Claude Code lists and calls the demo page's tools through MCP-B's local relay (manual).
3. A0.3 `docs/notes/baseline.md` records the real shapes of `getTools`, `executeTool` results and `toolchange` timing.

**M1 Walking skeleton (laptop or cloud session).** Protocol package, relay with `/page` and `/mcp`, dev-token auth, in-memory store, the five fixed tools, adapter core with a minimal badge, sim page.
1. A1.1 End to end with the sim page: pair by code, operator approves, `list_pages`, `list_page_tools`, `call_page_tool` returns the handler's result.
2. A1.2 The same by hand: Claude Code, added as an HTTP MCP server with a bearer header, drives the demo page in a real browser (manual).
3. A1.3 A page reload inside the resume window keeps its attachments.
4. A1.4 A wrong code, an expired code and a denied approval each return the right error.

**M2 Many clients, many users (laptop or cloud session).** Roles, roster UI, role change, revoke, write queue, attribution, activity log, idle expiry, limits.
1. A2.1 Two users and three client instances attach to one page, and the roster shows all of them.
2. A2.2 An observer is refused a mutating tool by the relay, and by the adapter when the relay check is bypassed in a test.
3. A2.3 Twenty concurrent mutating calls from three clients run strictly one at a time in arrival order, while reads interleave.
4. A2.4 Revoke cancels an in-flight call and blocks the next one.
5. A2.5 A consequential tool prompts on the page, and deny returns `denied_by_operator`.

**M3 Phone (public URL).** Public HTTPS through a tunnel or a small host, the QR web flow at `/pair`, a Claude custom connector signing in through the minimal OAuth plugin (ADR 0006), and the spike measurements.
1. A3.1 Claude mobile attaches to a page on the laptop and calls tools (manual).
2. A3.2 QR pairing works from the phone's browser (manual).
3. A3.3 `docs/notes/spike.md` records: round trip p50 and p95 over 50 calls; whether hosted Claude sees tool list changes mid-chat; tab survival for 60 minutes in the background, under Energy Saver, and across laptop sleep; time from scan to first call.
4. A3.4 A go or no-go note against the gate: conversational latency, fixed tools working on mobile, an hour of background survival.

**M4 Real sign-in and hardening (cloud host).** OAuth plugin hardened for production, origin allowlist, rate limits, persistent audit log, container image, deploy guide, threat model document.
1. A4.1 Tests for S1 to S13 pass.
2. A4.2 The connector works with OAuth sign-in on Claude web and mobile (manual).
3. A4.3 A second reviewer pass, by a separate agent, finds no unaddressed high-severity issue.

**M5 First-class tools and upstream.** Dynamic page tools, both MCP revisions verified, consequential confirmation through `input_required` where the client supports it, a protocol comparison with MCP-B's local relay, a drafted upstream proposal, README, release 0.1.0. At release, publish the demo page and the `docs/tour` explainers on GitHub Pages. The relay is never hosted there; the demo takes a relay URL so visitors point it at their own. Project sites under one account share a single origin, so the relay's allowlist entry for the demo covers all of them unless the demo gets a custom domain.

## 11. Environments

Laptop: Node 22+, pnpm, Chrome. The demo uses the polyfill, so no origin trial token is needed; test native WebMCP too when the flag is available. Claude Code cloud session: M1 and M2 automated tests run headless with the sim page and Playwright; no phone tests. Public URL: hosted Claude apps connect from Anthropic's cloud, so a localhost relay cannot serve them. Use a tunnel for the M3 spike and a small container host from M4.

## 12. Open items to settle during the build

The final name. The identity provider for M4. Whether anonymous observers are ever allowed for kiosks (out of scope until after M5). Where a public demo lives, if anywhere. Whether the write queue also needs a per-user fairness rule.
