# 01: The walking skeleton

M1 is the first time Tabdock itself carries a call: a page dials the relay and shows a code, a client pairs with it, the person at the tab approves, and the client calls the page's tools. Everything runs on one machine with dev tokens.

![The demo board with the Tabdock widget open: pairing code, roster and badge](img/m1-board.png)

## What exists now

`packages/protocol` defines every frame between page and relay as a zod schema, plus the shared limits and timings. `packages/relay` is one Node process: [relay.ts](../../packages/relay/src/relay.ts) checks each page socket's `Origin` before upgrading and serves `/mcp` through the official SDK; [hub.ts](../../packages/relay/src/hub.ts) owns page sessions, pairing codes, attachments and calls; [mcp.ts](../../packages/relay/src/mcp.ts) defines the five fixed tools; [auth.ts](../../packages/relay/src/auth.ts) holds the dev-token plugin. `packages/adapter` is the page side: [core.ts](../../packages/adapter/src/core.ts) holds all the behaviour with no DOM, [widget.ts](../../packages/adapter/src/widget.ts) draws the badge and prompts in a closed shadow root, and `attach()` in [index.ts](../../packages/adapter/src/index.ts) returns the only control handle. `packages/sim-page` runs the same core in Node against a fake WebMCP that behaves like the polyfill or Chrome 154 or 156; most tests use it.

## One call, traced

```mermaid
sequenceDiagram
  participant C as Claude Code
  participant R as relay
  participant A as adapter (page)
  participant T as page tool
  C->>R: POST /mcp call_page_tool (Bearer token)
  R->>R: attached? awake? tool exists? role allows?
  R->>A: invoke frame over the page socket
  A->>A: role and consequential checks again
  A->>T: executeTool (string or object input)
  T-->>A: result as a string
  A-->>R: result frame
  R-->>C: untrusted header + text
```

Pairing came first: the widget showed `XXXXX-XXXXX`, Claude Code called `pair_page` with it, the relay matched it by hash (`secrets.ts`, `hub.ts` `pairPage`), consumed it, sent the page an `attach_request`, and the operator clicked Allow as driver in the widget.

Now Claude Code calls `call_page_tool` with `{ page, tool: 'add_item', arguments }`. The relay authenticates the bearer token with the dev-token plugin, and `createMcpFactory` in `mcp.ts` builds that user's tools. `callPageTool` in `hub.ts` checks, in order: the caller is attached (a stranger and an unknown page get the same `not_attached`, S13), the page is awake, the tool exists, and an observer may only run read-only tools (S5). It sends an `invoke` frame. In the page, `onInvoke` in `core.ts` records the call and arms its deadline. In M1 one function then did the rest; since M2 it is split, and today `admit` and `check` re-read the tool and repeat the role check against the roles the operator granted, `runWrite` takes writes one at a time, `proceed` applies the consequential policy (`clear_board` prompts; ADR 0002), and `execute` calls `executeTool`, as a JSON string or an object depending on what this browser accepts (ADR 0001). The demo's handler in `apps/demo/src/tools.ts` adds the item. The string result travels back in a `result` frame, `callResult` in `mcp.ts` puts `[tabdock: untrusted content from http://127.0.0.1:5173, tool add_item]` on top of the page's text, and the hub writes an audit record without the arguments (S7). M1 also sent it as `structuredContent`, which M5 dropped: a client may show its model that copy in place of the labelled text (ADR 0025's notes).

## Try it by hand

1. Run `pnpm dev`. No `.env` is needed: since M4 a relay with no settings runs in local mode (ADR 0022), with one user, `you`, whose token it keeps in a private file outside the repo. On macOS and Linux it prints a `claude mcp add-json --scope user tabdock-local` line whose header helper, `claude-headers` beside the token, Claude Code runs at each connection, so neither the command nor Claude Code's settings hold the token (ADR 0028); PowerShell gets the older `--header` line that reads the token file. Paste the line as printed and check it with `claude mcp list`. (In M1 `pnpm dev` needed `TABDOCK_DEV_TOKENS` in `.env`; dev tokens still work, and still win when set.) Open the board link it prints and click Connect to 127.0.0.1:8787, since the board dials only after your click (M5, ADR 0029). Ask Claude to pair with the code in the Tabdock widget (bottom right), click Allow as driver, and ask it to add an item.
2. Ask Claude to clear the board. The widget asks you first; click Deny and Claude gets `denied_by_operator`. Then reload the tab and ask for the view again: the attachment survives the reload (A1.3).
3. Ask Claude to detach from the page, pair again with the new code, and this time click Allow as observer. Now ask it to add an item: the relay answers `role_denied` before the page is even asked. Or give Claude a made-up code and watch it get `pairing_expired`.
