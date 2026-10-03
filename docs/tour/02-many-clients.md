# 02: Many clients, many users

M2 lets several people, each with several MCP clients, share one tab. The operator sees who is attached through which clients, changes roles, revokes, pauses and watches every call, while the relay runs changes to the page one at a time and keeps any one client or page from hogging it.

![The demo board with the widget open: Alice with two clients, Bob as observer, roster controls and the activity list](img/m2-board.png)

## What exists now

`relay.ts` now splits `/mcp`: 2025-era clients go to `sessions.ts`, one SDK transport per session, bound to its user so anyone else presenting the id gets 404 (the SDK alone would let them in; ADR 0009). 2026-07-28 clients, Claude Code among them, stay stateless. Either way `mcp.ts` names the client for the roster and the audit. `hub.ts` gains a write queue per page, the section 9 limits, 8-hour idle expiry and argument checks through `validate.ts` (ADR 0008). In `packages/adapter`, the `Dock` handle gains `setRole`, `revoke` and `pause`; `core.ts` also runs writes one at a time and keeps the last 50 calls; `widget.ts` adds roster rows with a role switch and Revoke, Revoke all, the activity list and Pause.

## One write, traced

Alice's laptop is adding an item when Bob's tablet asks to move the view.

```mermaid
sequenceDiagram
  participant B as Bob's client
  participant R as relay
  participant A as adapter (page)
  B->>R: call_page_tool move_view (session id, token)
  R->>R: session owner, access, rate, role, arguments
  R->>R: queue behind Alice's add_item
  A-->>R: result for add_item
  R->>A: invoke move_view (deadline left)
  A->>A: role and prompt checks, then executeTool
  A-->>R: result
  R-->>B: untrusted header + content
```

Bob's 2025-era client sends its token and `Mcp-Session-Id`; `McpSessions.handle` checks the session is Bob's before the SDK sees it. `#call` in `hub.ts` checks, in order: Bob is attached and not expired (`#access`), under his call limit, the tool exists, an observer is not asking for a write (S5), the arguments fit the schema (`#checkArguments`, `invalid_arguments` otherwise, never running a regex the page wrote), and the queue has room. `move_view` is not read-only, so it joins the page's queue and the relay logs `call queued`. When Alice's call ends, `#pump` takes the next one and `#dispatch` checks access and role again, since either may have changed, then sends the `invoke` with what is left of its deadline.

On the page, `onInvoke` in `core.ts` logs a running entry, `admit` and `pump` keep writes to one at a time, `proceed` applies the least of grant, roster and claimed role and any consequential prompt, and `execute` runs the tool. The entry settles as `ok` and the result travels back as in M1.

Had the operator clicked Revoke on Bob's row, `Dock.revoke` would drop his grant and send `revoke`, and `#revoke` in `hub.ts` would cancel his running call, empty his queued ones and answer each `not_attached` (S8).

## Try it by hand

1. Put two users in `.env` (`TABDOCK_DEV_TOKENS=alice=...,bob=...`), run `pnpm dev`, and add the relay to Claude Code with Alice's token as `pnpm dev` prints. In a second folder, add it again with Bob's token and start a second Claude Code there. Pair both, allow Alice as driver and Bob as observer, and watch the roster name both clients. Ask Bob's Claude to add an item: `role_denied`.
2. Ask Alice's Claude to add five items quickly, and watch the activity list run them one by one. Click Revoke on Alice's row mid-way: the rest end `not_attached`. Click Pause and ask Bob's Claude for the view: `page_busy` until you click Resume.
3. Run `pnpm demo:m2` to see two users, three clients, a burst of queued writes, a revoke and a denied `clear_board` narrated, with the page's activity log and the relay's audit at the end. The limits and idle times are set by `TABDOCK_*` variables listed in `packages/relay/README.md`.
