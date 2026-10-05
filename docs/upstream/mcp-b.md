# Draft: feature request for `@mcp-b/webmcp-local-relay`

> **For the owner.** This is a draft (M5 decision D4, ADR 0031). The owner posts it, if he chooses, from his personal GitHub account through MCP-B's Feature Request form at github.com/WebMCP-org/npm-packages (blank issues are off); the build posts nothing, and nothing here has been posted. Every MCP-B fact was checked on 5 October 2026 against `6.0.0-beta.20261001010549` (still npm's `beta`; `latest` is 5.1.0) and is cited in `docs/mcp-b-comparison.md`; recheck against the current beta or release before posting, and fill in the repository link. The sections below follow the form's fields in order.

**Title:** `[webmcp-local-relay] Cancel in-flight invocations, then an opt-in remote profile`

## Package

`@mcp-b/webmcp-local-relay`

## Problem Statement

When an MCP client cancels a relayed tool call, the relay ignores it: the dynamic tool handler takes no abort signal, so the pending invocation stays until the page answers, the relay's 65 s invoke timeout fires, the page's socket closes or the relay stops. When the timeout fires, the relay drops the pending entry and answers the client with an error. In neither case is the page told: the relay-to-browser frames are `server-hello`, `hello/accepted`, `hello/rejected`, `invoke`, `ping` and `reload`, and the embed calls `executeTool(tool, args)` with no signal. So the page's handler keeps running: a timed-out "submit order" can still submit after the agent was told it failed. The pieces to stop it now exist. On the 6.0 polyfill, as on Chrome 155 and later, `executeTool(tool, input, { signal })` hands the handler the caller's signal; we measured a handler seeing the abort 100 ms in.

Separately, hosted MCP clients cannot spawn a stdio process, so they need a relay they can reach over the network; issue 158, "webmcp-server-relay", asks about one in a line, and we need one for pages shared by several people. Today's relay is not safe to expose, as its README says: `--widget-origin` defaults to `*`, a socket without an `Origin` header is judged by the origin it claims in `hello`, `webmcp-relay.v1` is refused only to sockets that send `Origin`, and the MCP side has no authentication, which is fine over stdio on one's own machine. The widget also refuses a relay host that is not loopback.

## Proposed Solution

**Part 1: a `cancel` frame (small, backward compatible).** Add a relay-to-browser frame `{ type: "cancel", callId, reason }`, with `reason` one of `client`, `timeout` or `shutdown`.

1. The relay sends it when the MCP request's signal aborts (the client cancelled), when the invoke timeout fires, and for every pending call when it stops. On the request's abort it also drops the pending entry and clears its timer, which is new, as the timeout and a stop already do; a late `result` for that `callId` is already ignored as unknown.
2. The widget passes it to the embed as a new `postMessage` type carrying the host request's id.
3. The embed keeps an `AbortController` per invocation, passes its signal to `executeTool(tool, args, { signal })`, and aborts it on `cancel`.

Embeds that predate it ignore the frame: both the 5.1.0 and the 6.0 widgets log "Ignoring unrecognized message type" at debug level and carry on. On a runtime that does not hand handlers the signal (the 5.x polyfill), the abort ends only the caller's wait, which is still better than today. A test: an MCP client cancels a call to a tool whose handler waits on its signal, and the handler sees the abort.

**Part 2: an opt-in remote profile, later, on its own subprotocol.** A relay a hosted client can reach needs a different trust model, so it should not be `webmcp.v1` with a flag. We propose `webmcp-remote.v1`, reusing `webmcp.v1`'s frames and adding only what a reachable relay needs, with local mode and its defaults unchanged. The profile must:

1. Take a page's origin only from the WebSocket `Origin` header, refuse a socket without one, and never fall back to `hello.origin`.
2. Refuse to start without an explicit list of page origins; `*` is not accepted.
3. Authenticate every MCP client: Streamable HTTP behind an auth hook (for example OAuth as the MCP authorization spec describes), no unauthenticated access.
4. Never accept `webmcp-relay.v1` or `webmcp-discovery.v1` off loopback.
5. Hold `hello/accepted`, and so the page's tools, until someone on the page approves, with a timeout that denies; then a `caller` on each `invoke` so the page can show who called.
6. Take an explicit `wss:` URL from the page (`data-relay-url`) instead of scanning ports, and add `cancel` from part 1 and a resume token, so a reload does not ask again.

A remote mode with the local defaults would let any web page publish tools and any caller run them, and we would not want to support one.

## Alternatives Considered

Page-side timeouts: the page cannot know when the MCP side gave up, and a client's cancel never reaches it. Closing the page's socket on timeout: it drops every tool and every other call of that tab. A `--remote` flag on `webmcp.v1`: a page could not tell which trust model it is talking to; a separate subprotocol makes page and relay agree explicitly. A separate project: Tabdock (Apache-2.0, <link to the Tabdock repository>) already links pages to a public relay with origin checks, an allowlist, signed-in users, approval on the page and cancellation, on its own `tabdock.v1`. We would rather converge than compete, and either side could adopt the other's frames.

## Example API / Usage

```typescript
// Part 1, relay side: one more frame in RelayToBrowserMessageSchema.
const RelayCancelMessageSchema = z.object({
  type: z.literal('cancel'),
  callId: z.string().min(1),
  reason: z.enum(['client', 'timeout', 'shutdown']).optional(),
});

// The dynamic tool handler passes the request's signal on.
this.mcpServer.registerTool(tool.name, registration, async (args, ctx) =>
  this.bridge.invokeTool(tool.name, args, { signal: ctx.mcpReq.signal }),
);

// Part 1, embed side: one controller per invocation.
const running = new Map<string, AbortController>();
async function invoke(requestId: string, tool: ModelContextTool, args: object) {
  const controller = new AbortController();
  running.set(requestId, controller);
  try {
    return await document.modelContext.executeTool(tool, args, { signal: controller.signal });
  } finally {
    running.delete(requestId);
  }
}
// On { type: 'webmcp.tools.invoke.cancel', requestId }: running.get(requestId)?.abort();
```

```html
<!-- Part 2, page side, illustrative: an explicit relay, no scan. -->
<script
  src="https://cdn.jsdelivr.net/npm/@mcp-b/webmcp-local-relay@7/dist/browser/embed.js"
  data-relay-url="wss://relay.example.com/webmcp"
></script>
```

The names, the signal accessor and the major version above are illustrative; the shape is the point.

## Additional Context

Issue 158, "webmcp-server-relay", is a one-line request filed against `@mcp-b/transports`; this is a concrete version for `@mcp-b/webmcp-local-relay`. Checked against `6.0.0-beta.20261001010549`. Questions for the maintainers: this package or a new one for part 2; where the approval UI should live, given the widget frame is hidden; tab suffixes or a page prefix for tool names on a shared relay; whether `webmcp.v1` gets a new version when payloads change, as the 5 to 6 input change did; and whether you would take part 1 as a pull request, following CONTRIBUTING (Conventional Commits with the package scope, a changeset).
