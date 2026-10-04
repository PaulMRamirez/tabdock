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
| Root of trust | The tab. Whoever can click on the page approves each attachment and sets its role, at the time or in advance through an invite minted on that page, which reaches observer only (ADR 0016) | One rule covers both multi-client cases |
| Tool registration | WebMCP `document.modelContext`, native or MCP-B polyfill. No new registration API | Standard exists; the same registration serves in-browser agents |
| Connector shape | One stable relay URL. Pages pair to the user, not the client to the page | Claude connects from Anthropic's cloud; connectors cannot be edited in place |
| Tool surface | Five fixed tools first. Page tools as first-class entries in M5 | Fixed tools work on every client |
| Stack | TypeScript everywhere, Node 22+, pnpm workspace. Any Python helper uses uv | Shared protocol types; matches MCP-B |
| Relay trust | The relay sees plaintext calls and results, and so does a tunnel or host edge that terminates TLS in front of it (ADRs 0014 and 0018). Self-host first | Stock connectors cannot do end-to-end encryption to a page |
| Default setup | Local mode: with no settings the relay binds loopback, keeps an owner token in a private per-user file and prints a ready Claude Code command. Public URL mode, the identity provider and the host are the user's choice; the project's own hosted relay is a reference deployment (ADR 0022) | Owner's call: Tabdock does not dictate how people run infrastructure |
| Upstream | Stay close to MCP-B's page protocol ideas and propose a remote relay mode there | Avoid a competing project |

## 3. Facts verified on 2 and 3 October 2026 (re-verify before relying on them)

These standards and packages are moving. Check current docs before coding against any of them, and log what you checked in `docs/notes/verified.md`.

| Fact | Where it came from |
| --- | --- |
| WebMCP is a Chrome origin trial (M149 to M156, extension to M162 requested). The API is `document.modelContext`, in secure contexts only, with `registerTool`, `getTools`, `executeTool(tool, input, {signal})` and a `toolchange` event. `input` is a JSON string on Chrome 153 and 154 and MCP-B 5.x and an object on Chrome 155+ and MCP-B 6; the result is always a string. `getTools()` entries carry `window` and `origin` and include same-origin iframe tools. Annotations: `readOnlyHint`, `consequentialHint`, `untrustedContentHint`, `debugging`; Chrome 153 and MCP-B 5.1.0 drop `consequentialHint` | developer.chrome.com/docs/ai/webmcp/imperative-api, webmachinelearning.github.io/webmcp, `docs/notes/baseline.md` |
| MCP-B ships a polyfill and runtime. `latest` is 5.1.0 for `@mcp-b/global`, `@mcp-b/webmcp-polyfill`, `@mcp-b/webmcp-ts-sdk` and `@mcp-b/webmcp-local-relay`; 6.0 is in beta and docs.mcp-b.ai already describes it. `webmcp-types` 0.1.10 is the WebML Community Group's types package, not MCP-B's | npm registry, docs.mcp-b.ai |
| MCP revision 2026-07-28 is final and stateless: no initialize handshake, no session id, `server/discover`, multi round trip via `input_required`, `ttlMs` with `cacheScope` on list results. Client info in `_meta` is a SHOULD and unauthenticated; `list_changed` travels only over a client-opened `subscriptions/listen` stream | blog.modelcontextprotocol.io/posts/2026-07-28/ |
| MCP SDK packages: `@modelcontextprotocol/server`, `client` and `core` 2.3.0 with `@modelcontextprotocol/node` 2.1.1 (v2 line, serves 2026-07-28 and 2025-era clients), `@modelcontextprotocol/sdk` 1.32.0 (v1 line, 2025-era only) | npm registry |
| Claude reaches custom connectors from Anthropic's cloud (160.79.104.0/21, IPv4) on every client. It supports Streamable HTTP, OAuth, fixed request headers (a beta for a limited set of organizations) or no auth, tools, prompts and resources. No resource subscriptions, sampling or draft capabilities. Hosted limits: 240 s per tool call, about 150,000 characters per result | support.claude.com article 11175166, claude.com/docs/connectors/building |
| Claude Code supports `list_changed` and HTTP servers with custom headers. It fails an HTTP tool call after 60 s without a first byte and caps results at 25,000 tokens unless the server says otherwise | code.claude.com/docs/en/mcp |
| Hosted Claude follows the 2025-03-26, 2025-06-18 and 2025-11-25 MCP authorization specs, while 2026-07-28 deprecates dynamic client registration in favour of client ID metadata documents. A connector's auth settings cannot be edited after it is added. Installing connectors on mobile is a beta: a connector is added on the web or desktop first and then appears on the phone | `docs/notes/m3/`, `docs/notes/verified.md` (3 October) |
| WorkOS, the reference deployment's provider: environments are separate, staging and production sharing no keys, client ids, users or redirect URIs, so a move changes every `sub`. Production needs a card and costs $0 up to a million monthly users without SSO, a custom domain or Radar; WorkOS's shared Google and GitHub credentials work only in staging; production redirect URIs are https apart from `http://127.0.0.1`. Connect access tokens carry `iss`, `aud`, `sub`, `client_id`, `org_id`, `sid`, `scope`, `jti`, `exp` and `iat`, with no email and no `typ`; their lifetime, key rotation, and whether revocation ends issued tokens are undocumented. One JWT template per environment renders into them, with `user.email` and `user.email_verified` in its context and at most 3,072 bytes of output | workos.com/docs: authkit/environments, authkit/connect/token-claims, authkit/jwt-templates; `docs/notes/verified.md` (3 October, M4) |
| Claude needs a connector's hostname to have a public IPv4 `A` record and refuses private, CGNAT and loopback answers, mixed public and private answers, and AAAA-only answers. A 2025-era MCP client starts a new session when its session id gets a 404, so a relay restart costs it one re-initialize | claude.com/docs/connectors/building/troubleshooting; modelcontextprotocol.io 2025-06-18 basic/transports |
| Fly.io, the reference deployment's host, sets `Fly-Client-IP` from what its proxy sees and replaced a forged one in a live probe; a volume makes Fly run one Machine and refuse the `bluegreen` and `canary` strategies | docs.fly.io: networking/request-headers, apps/app-availability, volumes/overview; curl probe |
| Node 22 is in maintenance until its end of life on 30 April 2027; Node 24 is supported until 30 April 2028 (maintenance from 20 October 2026). `node:sqlite` is still experimental on Node 22 and prints an `ExperimentalWarning` without a flag | github.com/nodejs/Release; nodejs.org api/sqlite (v22, v24); local probe |
| Other versions: `ws` 8.22.0, `hono` 4.13.12, `qrcode-generator` 2.0.4, Node 22.18 or later (it runs `.ts` files directly), `jose` 6.2.12, `openid-client` 6.8.8 and `oauth4webapi` 3.8.8 (still latest on 3 October) | npm registry, nodejs.org |

Rows refreshed by ADRs 0004, 0015 and 0021 from `docs/notes/verified.md`. Unverified until the owner's M3 and M4 runs (`docs/notes/spike.md`, `docs/checklists/M4.md`): whether hosted Claude refreshes a changing tool list during a conversation; how a JWT template renders `email_verified`; the production access-token lifetime; and whether WorkOS production accepts Claude Code's `localhost` redirect.

## 4. Architecture and repo layout

```
packages/protocol   Message types and zod schemas shared by relay and adapter
packages/relay      Node service: page WebSocket endpoint, MCP endpoint, pairing, auth plugins, audit log
packages/adapter    Browser library: link to relay, widget UI, policy, lifecycle
packages/sim-page   Node stand-in for a page (fake document.modelContext) used by automated tests
apps/demo           A small visual, stateful page with WebMCP tools
tests/e2e           End-to-end tests: MCP client, relay, sim page; Playwright for the real adapter
docs/               adr/, notes/, tour/ (explainers for the owner), checklists/
deploy/             The reference deployment: one folder per documented host (fly/ for Fly.io); the image's Dockerfile at the root names no host
```

The relay is one process with an in-memory store, run as exactly one instance. Besides local mode's owner token (ADR 0022), only the audit log persists, as JSON Lines files on disk; a restart ends every page session, attachment, pairing ticket and invite, and pages pair again (ADRs 0018 and 0019). The relay never executes page tools itself; it only routes.

The demo page should make state visible: a canvas board with items and a viewport. Tools: `get_view` and `list_items` (read-only), `add_item`, `move_view` and `highlight_item` (mutating), `clear_board` (consequential).

## 5. Identity, roles and the trust rule

| Entity | Fields | Notes |
| --- | --- | --- |
| User | `userId`, `displayName`, `kind` (member or invitee) | Comes from the auth plugin; an invitee's id is `g_` plus a digest of its `sub`, and its name is its verified email or `unverified account` (ADR 0017) |
| Client | MCP client name and version taken from each request | Attribution only. All of a user's clients share that user's attachments |
| PageSession | `pageId`, `origin`, `title`, `url`, `tools`, `state` (awake, asleep, gone), `resumeToken` | `origin` is read from the WebSocket `Origin` header, never from page-supplied text |
| Attachment | `pageId`, `userId`, `role`, `grantedAt`, `lastUsedAt`, `expiresAt`, `inviteId?`, `endsAt?` | Created by an operator approval, under `autoApprove: 'observer'`, or by a live watch invite; an invite-made one ends at `endsAt` |
| PairingTicket | `code`, `nonce`, `pageId`, `expiresAt` | Single use, 120 s life, rotates after use |
| Invite | `inviteId`, `pageId`, `role`, `label`, `uses`, `expiresAt`, `secretHash`, `sponsor` | Minted in the widget from M4; 128-bit secret, link carries it only in the fragment; watch invites approve in advance, control invites prompt on redemption (ADR 0016); at most 24 hours and 20 uses (control: 1), 10 live per page; the sponsor is the member attached longest at minting (ADR 0017) |
| AttachRequest | `requestId`, `pageId`, `userId`, `via` (code, qr or invite), `expiresAt` | 60 s to approve, default deny. At most one pending per user per page; a second `pair_page` from that user waits on it (ADR 0007) |

Trust rule: no attachment exists without an approval made on the page, unless the page set `autoApprove: 'observer'` or the person redeemed a live watch invite minted on that page (ADR 0016). Anonymous means no account, never no identity: there is no relay-wide unauthenticated access and no anonymous driver. The first approval sets a user's role; later approvals and denials for an attached user change nothing, because role changes and withdrawals go through `set_role` and `revoke`. The adapter keeps its own record of these grants and runs a call only under the least privileged of that record, the relay's roster and the role the invoke claims; a user missing from the roster has no role (ADR 0007).

Roles: an observer may call only tools whose `readOnlyHint` is true. A driver may call every tool. Consequential tools follow page policy: `confirm` (default, an on-page prompt per call), `allow`, or `deny`. A tool is consequential when its `consequentialHint` is true or the page names it in `policy.consequentialTools`; when the runtime cannot report the hint and the page names none, every tool that is not read-only counts as consequential (ADR 0002). A page whose tools carry no annotations at all declared no hints, so none were lost and only `policy.consequentialTools` applies (ADR 0007). `maxDrivers` defaults to 1 and counts users, so one person's phone and laptop both drive. Mutating calls run one at a time per page in arrival order; read-only calls run concurrently. The one exception: on the MCP-B polyfill, which cannot report a handler's end once the page unregisters its tool mid-call, the page waits until that call's deadline plus 2 s and then lets the next write run (ADR 0012).

## 6. Page link protocol (adapter to relay)

Transport: WebSocket at `/page`, subprotocol `tabdock.v1`, JSON text frames shaped `{ "t": "<type>", ... }`. Both sides validate every frame with zod. The first frame must be `hello`; any other closes the socket with 1008. After it, unknown types are ignored and logged: the lines of frames that change nothing, unknown types among them, are written up to a budget per socket and per address and past it counted in one line per address each minute, and such frames never close a socket (ADR 0023). Frames are capped at 1 MB. Tool results over 120,000 characters are truncated with a visible marker.

| Direction | Type | Payload | Meaning |
| --- | --- | --- | --- |
| page to relay | `hello` | `v`, `resumeToken?`, `title`, `url`, `adapterVersion`, `policy` | First frame. A valid `resumeToken` resumes a session after a reload of the same page (same origin and path; ADR 0011) |
| relay to page | `welcome` | `pageId`, `resumeToken`, `resumed`, `pairing`, `roster`, `limits` | Session accepted; `resumed` says whether the resume token was honoured |
| page to relay | `tools` | `tools[]` with `name`, `description`, `inputSchema`, `annotations` | Full replacement on every change |
| relay to page | `attach_request` | `requestId`, `user`, `account`, `via`, `invite?`, `client?`, `expiresAt` | Someone wants to attach |
| page to relay | `attach_decision` | `requestId`, `allow`, `role?` | Operator's answer |
| relay to page | `roster` | `attachments[]`, each with `kind`, `inviteId` and `endsAt` | Sent on every change |
| page to relay | `set_role`, `revoke` | `userId`, `role` or `userId` or `"*"` | Operator controls; `revoke "*"` also cancels every live invite |
| page to relay | `rotate_pairing` | none | Ask for a fresh code |
| relay to page | `pairing` | `code`, `url`, `expiresAt` | New pairing ticket |
| page to relay | `invite_create` | `inviteId`, `role`, `label`, `uses`, `expiresAt`, `secretHash` | Mint an invite; the relay keeps only the hash |
| page to relay | `invite_cancel` | `inviteId` | Cancel one invite |
| relay to page | `invites` | `linkBase`, `invites[]`, `refused?` | After each welcome and on every change |
| relay to page | `invoke` | `callId`, `tool`, `arguments`, `caller` (`userId`, `displayName`, `client`, `role`), `deadlineMs` | Run a tool |
| page to relay | `result` | `callId`, `ok`, `content` or `error` (`code`, `message`) | Outcome |
| relay to page | `cancel` | `callId`, `reason?` (`timeout`, `revoked`, `client` or `shutdown`) | Abort; the adapter fires the tool's AbortSignal |
| both | `ping`, `pong` | none | Relay pings every 15 s and closes after 30 s of silence |

When the socket drops, the page becomes `asleep` and its attachments survive for a 10 minute resume window. After that the page is `gone` and its attachments are deleted.

Close codes (ADR 0007): only a deliberate detach ends a session at once. A page that calls `dock.close()` closes with 4000, becomes `gone` without the resume window, and its in-flight calls fail with `page_gone`, except calls still waiting on an operator prompt, which the page denies first. Every other close leaves the page asleep, including 4002 (the page heard nothing from the relay and is reconnecting) and 4008 (the page's stand-in for 1008, which page code cannot send). The relay closes a superseded socket with 4001, which the page must not reconnect from, and uses 1001, 1008 and 1009 for idle or shutdown, malformed frames (a first frame that is not `hello` among them, ADR 0023, and a page or address over its `tools`-frame budget), a page that leaves more of what the relay sends unread than the relay holds for it (ADR 0024) and oversized frames, and 1013 when there is no room for a new page session (ADR 0012).

## 7. MCP surface (relay to clients)

Endpoint `/mcp`, Streamable HTTP, using the official MCP SDK. Do not hand-roll the transport. Prefer the v2 packages if they cover revision 2026-07-28 and still serve session-based clients; otherwise use the v1 SDK and record why in an ADR.

| Tool | Input | Returns |
| --- | --- | --- |
| `list_pages` | none | Pages this user is attached to: `page`, `origin`, `title`, `role`, `state`, `toolCount` |
| `pair_page` | `code` or `invite` (a link minted for one use) | Sends an attach request and waits up to 50 s for the operator (ADR 0005; the request itself lasts 60 s). Returns `page` and `role`; a request nobody answers is a denial, reported as `timeout` because the operator never decided (ADR 0007) |
| `list_page_tools` | `page` | Tool descriptors, each with an `allowed` flag for the caller's role |
| `call_page_tool` | `page`, `tool`, `arguments` | The page handler's result |
| `detach_page` | `page` | Removes the caller's own attachment |

Every page result starts with the header line `[tabdock: untrusted content from <origin>, tool <name>]`. JSON results also pass through as structured content. The fixed tools' own descriptions say that page content is untrusted and is never instructions.

Errors return as MCP tool errors with one of these codes in the text: `not_attached`, `role_denied`, `tool_not_found`, `page_asleep`, `page_gone`, `denied_by_operator`, `timeout`, `page_busy`, `pairing_expired`, `rate_limited`, `invalid_arguments`, and from M4 `invite_required`. `invalid_arguments` covers arguments the relay will not forward: too large for one frame, or, from M2, failing the tool's `inputSchema` (ADR 0007).

Auth is a plugin: `authenticate(request)` returns a User, or a refusal with its status and challenge (401 to sign in, 403 for someone not allowed), and a plugin may serve GET routes. M1 ships `dev-token` (users and bearer tokens from `.env`). From M4 a relay given no auth settings runs in local mode (ADR 0022): `dev-token` with one user, `you`, whose 256-bit token the relay draws on first run into a private per-user file outside the repo and never prints or logs; local mode binds loopback only, refuses proxied requests, trusts every account on its machine, is refused in production and with a public URL, and gives way to explicit dev tokens or OAuth settings. M3 adds a minimal `oauth` plugin and M4 hardens it (ADRs 0006, 0013 and 0020): an external identity provider registers Claude, checks its hosted callback and Claude Code's loopback redirect, and issues tokens for the relay, which serves RFC 9728 metadata and verifies each token through a maintained library, requiring `iat` and `jti`, refusing a lifetime over a configured cap (2 hours by default), and re-reading the provider's metadata hourly without accepting a new issuer. Any provider will do that passes the plugin's start checks (its issuer, S256 PKCE, and client ID metadata documents or dynamic registration); issues access tokens as RS256-signed JWTs, never opaque ones, whose keys are at its `jwks_uri` and whose `aud` is the relay's MCP URL from the RFC 8707 `resource` parameter, with a stable `sub`, `iat`, `jti`, an `exp` within the cap and, when the client list is set, RFC 9068's `client_id`; and offers a confidential client for `/pair` and `/i` whose signed ID token carries the same `sub`. Without `email` and `email_verified` (in the ID token or from UserInfo, and as namespaced claims in access tokens), invitees show as unverified. The reference deployment uses a WorkOS AuthKit production environment as one example (`docs/deploy.md`). From M4, with invites on, a signed-in account not on the allowlist is an invitee: it sees only pages it holds, redeems invites at `/i` or through `pair_page`, and gets `invite_required` for a pairing code. After M5, behind a flag, a page-scoped observer token in a header serves clients that cannot sign in, on a separate `/g/mcp` endpoint (ADR 0016).

M5 adds first-class page tools named `<alias>__<tool>`, described with an origin prefix capped at 500 characters, with a short `ttlMs` and `list_changed` for session-based clients, behind a config flag. The fixed tools always remain.

## 8. Adapter behaviour

```ts
import { attach } from '@tabdock/adapter';
const dock = attach({
  relay: 'wss://relay.example/page',
  policy: { autoApprove: 'none', maxDrivers: 1, consequential: 'confirm', consequentialTools: [], invites: 'watch' },
});
```

A script-tag build reads the same options from data attributes. The adapter never registers tools. It reads `document.modelContext` through `getTools`, listens for `toolchange` with a 2 s poll as fallback, and runs calls with `executeTool`, detecting per page whether the runtime wants its input as a JSON string or an object (ADR 0001). If `document.modelContext` is missing it logs how to add a polyfill and stays idle.

The widget lives in a closed shadow root: a badge with link state and attached count, and a panel with the pairing code and QR, the roster with role switch and revoke, an activity log of the last 50 calls, and a pause switch; from M4, an Invite form (label, watch or control, lifetime, uses) and a list of live invites with Cancel, offered as far as the page's `policy.invites` allows (`off`, `watch` by default, or `all`; ADR 0016). Attach prompts and consequential-call prompts default to deny on timeout. Only the code that called `attach()` holds the control handle, which from M4 also mints invites with `invite()`.

Lifecycle: hold a Web Lock while attached, reconnect with backoff from 0.5 s to 30 s using the `resumeToken`, and enforce role and policy again locally before running any call. The resume token, the operator's grants, the page's invite records (never a secret) and the pause switch are kept per page, by relay URL plus the page's origin and path (ADR 0011).

## 9. Security requirements (each needs an automated test unless marked manual)

1. S1. Origin is taken only from the WebSocket `Origin` header. Connections without it are rejected outside an explicit dev flag.
2. S2. An origin allowlist is enforced. Dev default is localhost only. Production refuses to start without an explicit list.
3. S3. Pairing codes carry at least 40 bits of entropy, are single use, expire in 120 s, are compared in constant time, and attempts are rate limited per user, and per address only where the address is the client's own (ADR 0016).
4. S4. No attachment without operator approval, except under `autoApprove: 'observer'` or a live watch invite minted on that page (ADR 0016).
5. S5. Roles are enforced in the relay and again in the adapter. A crafted request cannot let an observer run a mutating tool.
6. S6. Consequential tools prompt on the page by default, and a timeout means deny.
7. S7. Every call that reaches a page is attributed in the page activity log and in the relay audit log, which in production and local mode survives restarts: user, client, tool, time, outcome. Arguments are not logged by default. A call refused before it reaches a page has its own line up to a per-user budget; past it, the refusal is counted by user and outcome in a summary line each minute, except that accounts holding no attachment also share a relay-wide budget whose summary names only the 20 busiest. While the audit disk fails, records reach only stderr and an `audit_gap` record counts what the file missed (ADR 0019).
8. S8. Revocation is immediate: in-flight calls are cancelled and later calls fail with `not_attached`.
9. S9. Limits exist for users per page, requests and calls per user per minute, queue depth, frame size, result size, the memory page tool lists may hold and what the relay holds unread for one page (ADR 0024), and, behind a host edge, page sessions and sign-ins per client address (ADR 0018).
10. S10. Page results are always labelled untrusted. Page-supplied descriptions, titles and invite labels are length capped, shown as written by the page, and never merged into the fixed tools' descriptions.
11. S11. Tokens, codes and invite secrets never appear in logs. The QR nonce is single use and useless without a signed-in user and an operator approval. An agent token (ADR 0016) is a credential: observer only, one page, revocable, never in a URL or a log.
12. S12. The relay binds to loopback, unless it runs in production behind a host edge that terminates TLS and names the client address in one configured header; then it binds `0.0.0.0`, and every public URL in front of it is https (ADRs 0014 and 0018).
13. S13. A user can list and call only pages they are attached to. Access never depends on a page id being hard to guess.
14. S14. Invites (from M4, ADRs 0016 and 0017): minted only while an allowlisted sponsor is attached and as far as `policy.invites` allows, at most 10 live per page, each for at most 24 hours and 20 uses; watch invites approve observers in advance; control invites prompt, allow one pending request and burn after three refusals or timeouts; the relay and the adapter grant no more than the invite's role, and the adapter honours an invite only against its own record and the presented secret; `revoke('*')` cancels every live invite; revoking an invitee bars that account and its verified email from the invite, a multi-use invite's Revoke closes the link by default, and no redemption clears a revoke; when a sponsor's attachment ends, so do its invites and the attachments they made; invite-made attachments end with the page session, on revoke or after 24 hours, and leave members two seats; a name that copies a member's shows the short id; redemption is limited per user, per invite and per page; `pair_page` and `/pair/claim` answer an invitee's pairing code with `invite_required`.

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

**M4 Local mode, real sign-in and hardening (local and hosted).** Local mode by default, OAuth plugin hardened for production, origin allowlist, rate limits, persistent audit log, a container image that runs on any host meeting section 11, a deploy guide whose worked example is the project's reference deployment, the demo page on GitHub Pages, threat model document, and signed-in invites (ADRs 0016 to 0022).
1. A4.1 Tests for S1 to S14 pass.
2. A4.2 The connector works with OAuth sign-in on Claude web and mobile, and a second account joins a page by a watch invite and by a control invite (manual).
3. A4.3 A second reviewer pass, by a separate agent, finds no unaddressed high-severity issue.
4. A4.4 From a clean clone with no `.env`, `pnpm relay` starts in local mode, stores its token only in a private per-user file outside the repo (0600 where POSIX modes apply), and Claude Code, added with the command it prints, connects to it.

**M5 First-class tools and upstream.** Dynamic page tools, both MCP revisions verified, consequential confirmation through `input_required` where the client supports it, a protocol comparison with MCP-B's local relay, a drafted upstream proposal, README, release 0.1.0. At release, publish the `docs/tour` explainers on GitHub Pages beside the demo page, which M4 publishes, on its own custom domain if the owner gave it one (ADR 0021). The relay is never hosted there; the demo takes a relay URL so visitors point it at their own. Project sites under one account share a single origin, so without a custom domain the relay's allowlist entry for the demo covers all of them.

## 11. Environments

Laptop: Node 22+, pnpm, Chrome. `pnpm relay` (the relay alone) and `pnpm dev` (with the demo board) need no `.env`: with no settings they run local mode, which serves MCP clients on the same machine, such as Claude Code, and trusts every account on it (ADR 0022). The demo uses the polyfill, so no origin trial token is needed; test native WebMCP too when the flag is available. Claude Code cloud session: M1 and M2 automated tests run headless with the sim page and Playwright; no phone tests.

Public URL: hosted Claude apps (web, desktop, mobile) connect from Anthropic's cloud, so a local relay cannot serve them; they need public URL mode, behind a tunnel, as in the M3 spike, or on a host. Any host will do that terminates TLS for the public URL and passes requests and WebSocket upgrades through with the original `Host`; lets a request wait at least 60 s for its first byte and streams responses unbuffered; sets one client-address header that its proxy overwrites rather than passes on (`TABDOCK_CLIENT_ADDRESS_HEADER`) and connects from a range `TABDOCK_TRUSTED_PROXY_CIDR` can name, from which nothing else reaches the relay's port; runs exactly one instance with a persistent directory for the audit log, stopping the old instance before starting the new; does not close a connection that carries a ping every 15 s; and gives the hostname a public IPv4 `A` record, as Claude requires (ADRs 0018 and 0019). Any identity provider that meets section 7 will do. A hostname of one's own is recommended, since a connector cannot be edited and a host move then changes only DNS. Every setting is an environment variable and the image names no host. `docs/deploy.md` is one worked example, the project's reference deployment: Fly.io with WorkOS, behind a DNS-only subdomain of the owner's domain, deployed on demand from GitHub Actions. A cloud session cannot build container images or open WebSockets through its proxy, so CI builds and smoke-tests the image and the owner checks the live page link.

## 12. Open items to settle during the build

The final name. Whether the write queue also needs a per-user fairness rule.
