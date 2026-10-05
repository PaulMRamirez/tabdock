# Baseline: WebMCP runtimes and MCP-B's local relay

Measured on 2 October 2026 with `pnpm --filter @tabdock/e2e baseline` (probes in `tests/e2e/src/measure-page.ts`, relay timing in `tests/e2e/src/baseline.ts`), headless on Linux, Node 22.22. Five runtimes: the MCP-B polyfill 5.1.0 in Chromium 141, which has no native WebMCP (the demo runs on this today), and native WebMCP in Chrome for Testing 153.0.8010.12, 154.0.8037.92 (current Stable), 155.0.8059.12 (Stable from 6 October) and 156.0.8078.5 (Beta), launched with `--enable-features=WebMCPTesting`. Every number below comes from the raw files beside this one: `baseline.raw.json` for the polyfill and `baseline.raw.chrome153.json` to `baseline.raw.chrome156.json`. Rerun with `CHROMIUM_EXECUTABLE=<path> BASELINE_LABEL=<name>` to add a browser. Ports in the raw files are ephemeral. On 5 October MCP-B's 6.0 beta was measured beside a fresh 5.1.0 run, with two new probes; that section comes after the relay's.

## getTools()

Asynchronous everywhere, about 1 ms, and sorted by name rather than registration order. Each entry has `name`, `title`, `description`, `inputSchema`, `origin`, `window` and `annotations`. The polyfill's entry for `clear_board`:

```json
{
  "name": "clear_board",
  "title": "Clear board",
  "description": "Remove every item from the board. This cannot be undone.",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
  "origin": "http://127.0.0.1:36991",
  "window": "[Window]",
  "annotations": { "readOnlyHint": false, "untrustedContentHint": false }
}
```

Two fields vary. `inputSchema` is a JSON string on Chrome 153 and 154 and an object on the polyfill and Chrome 155 and 156. Annotations: the polyfill and Chrome 153 keep only `readOnlyHint` and `untrustedContentHint`, so the demo's `consequentialHint: true` on `clear_board` is lost; Chrome 154 and 155 return it; Chrome 156 also adds `debugging`.

## executeTool(tool, input, { signal })

The result is always a string. The input format flipped between Chrome 154 and 155.

| Probe                        | Polyfill 5.1.0                               | Chrome 153 and 154                 | Chrome 155 and 156                |
| ---------------------------- | -------------------------------------------- | ---------------------------------- | --------------------------------- |
| Input as JSON string         | runs                                         | runs                               | `TypeError` (not an object)       |
| Input as object              | `UnknownError` (cannot parse)                | `UnknownError` (cannot parse)      | runs                              |
| Input omitted                | `UnknownError`                               | `TypeError` (2 arguments required) | runs with `{}`                    |
| Input violates `inputSchema` | handler runs                                 | handler runs                       | handler runs                      |
| Tool given by name only      | `TypeError`                                  | `TypeError`                        | `TypeError`                       |
| Handler throws               | `UnknownError`, handler message appended     | `UnknownError`, fixed text only    | `UnknownError`, fixed text only   |
| Abort after 100 ms           | caller rejects at 100 ms; handler never told | rejects; handler's `signal` fires  | rejects; handler's `signal` fires |

Return encodings were identical everywhere: an object comes back as its JSON, the string `plain text` comes back unquoted, `42` as `"42"`, `undefined` as `"undefined"`, and an MCP `CallToolResult` as its JSON. Nothing validates arguments against `inputSchema`; the page handler must. The polyfill calls `execute(input)` with no second argument, so a page tool cannot observe cancellation there; native Chrome passes `{ signal }`.

## toolchange

A plain `Event` with no payload, fired at `document.modelContext` once per registration and once per removal (aborting the registration signal). Five registrations in one turn produced five events; nothing coalesces. On every runtime the event fired before `registerTool()` resolved (the probe records the order, not just timestamps that tie at clock resolution): 0.1 ms after the call on the polyfill, then 0.4, 0.6, 0.3 and 1.5 ms on Chrome 153 to 156. Removal took 4.2 ms on the polyfill and 0.5 to 0.7 ms natively. A duplicate name rejects with `InvalidStateError`.

## Through MCP-B's local relay

The chain is MCP client (official SDK 2.2.0 over stdio), relay 5.1.0, WebSocket on 127.0.0.1, a hidden iframe injected by `embed.js`, then the page. The relay advertises `tools.listChanged`. All six tools were listed 158 to 262 ms after navigation (polling `tools/list` every 5 ms), with one `tools/list_changed` per registration. A tool registered later produced `list_changed` after 22 to 24 ms and appeared in `tools/list` after 23 to 29 ms. Fifty `get_view` calls took p50 1.9 ms and p95 5.4 ms on the polyfill, p50 2.7 and p95 4.6 ms on Chrome 153, and p50 2.6 and p95 3.9 ms on Chrome 154.

`executeTool` hands `embed.js` a string; the embed, inside the page, parses it and builds the MCP result, so a call returns `{ content: [{ type: "text", text: "<json>" }], structuredContent: <object>, isError: false }`, and a handler error returns `isError: true` with the runtime's error text. On its MCP side the relay checks arguments against `inputSchema` itself and answers `Input validation error: ...` without reaching the page. It prefixes each description with `[WebMCP <tab id> • <page title>]`, where the tab id is a UUID the embed keeps in `sessionStorage`, and forwards only `readOnlyHint`, dropping `untrustedContentHint` and `consequentialHint` even when the page supplies them. On Chrome 155 and 156 all fifty calls failed, because `embed.js` 5.1.0 always sends a JSON string; MCP-B's 6.0 beta, published 1 October, sends objects.

Origins: `--widget-origin` compares against the WebSocket `Origin` header when the browser sends one, and the same page loaded from `localhost` instead of `127.0.0.1` never appeared (`tests/e2e/specs/mcpb-relay.spec.ts`). It is weaker than Tabdock's S1 in two ways. A connection with no `Origin` header, which any local process can open, is judged by the origin it claims in its own hello, and any local process can join as a relay client and call every page tool, with arguments passed to the page unchecked. Normally `embed.js` loads the widget as a `blob:` document under the host page's origin, but `widget.html` framed directly by URL runs with the origin that served it, so a foreign page that frames the demo's copy gets its own tools listed under the demo's origin. The demo server now sends `frame-ancestors 'self'`, the static build leaves MCP-B's files out, and two tests in the same spec file check the headers and prove the injection fails.

## MCP-B 6.0 beta (5 October 2026)

`BASELINE_MCPB=6 pnpm --filter @tabdock/e2e baseline` runs the same probes on `@mcp-b/webmcp-polyfill` and `@mcp-b/webmcp-local-relay` at `6.0.0-beta.20261001010549` (M5 decision D4), reached through `@tabdock/mcpb6` only. The beta polyfill's script-tag build runs as an init script before the demo's own scripts (`tests/e2e/src/mcpb6-page.ts`), so the demo's 5.1.0 initializer finds a context and steps aside, as it does for native Chrome; the run refuses to record if a context was there first. The relay leg starts the beta relay and serves the beta's `embed.js` and `widget.html` where the demo serves 5.1.0's, since embed and runtime must share a major. Two probes are new (`tests/e2e/src/measure-lifecycle.ts`): the page unregisters a tool 100 ms into a 300 ms handler, and calls a tool unregistered before the call. 5.1.0 was re-measured the same hour with `BASELINE_LABEL=mcpb5`, so both columns below come from runs of the same script in Chromium 141.0.7390.37: `baseline.raw.mcpb6-beta.json` and `baseline.raw.mcpb5.json`.

| Probe                                   | Polyfill 5.1.0                                    | 6.0 beta                                                    |
| --------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| `__isWebMCPPolyfill` on the context     | `true`                                            | absent                                                      |
| `navigator.modelContext` alias          | the same object                                   | absent                                                      |
| Input as JSON string                    | runs                                              | `TypeError: inputObject must be an object`                  |
| Input as object                         | `UnknownError` (cannot parse)                     | runs                                                        |
| Input omitted                           | `UnknownError` (cannot parse)                     | runs with `{}`                                              |
| Annotations of a tool given all four    | `readOnlyHint`, `untrustedContentHint` only       | all four, `consequentialHint` kept                          |
| Handler throws                          | `UnknownError`, handler message appended          | `UnknownError: Tool execution failed`, nothing more         |
| Returns the string `plain text`         | `plain text`                                      | `"plain text"`, quoted                                      |
| Returns `undefined`                     | the string `undefined`                            | fails: `UnknownError: Tool execution failed`                |
| Abort after 100 ms                      | rejects at 100 ms; handler never told             | rejects at 100 ms; handler's `{ signal }` fires             |
| Unregister 100 ms into a 300 ms handler | rejects `Tool unregistered` at 100 ms, handler on | resolves `"finished"` at 301 ms, when the handler ends      |
| Tool unregistered before the call       | `UnknownError: Tool not found: <name>`            | `UnknownError: Tool execution failed`                       |
| Duplicate name                          | `InvalidStateError: Tool already registered: ...` | `InvalidStateError: A tool named ... is already registered` |

Through the beta relay, numbers otherwise match 5.1.0's: a tool registered later produced `list_changed` after 22 ms and was listed after 26 ms (25 and 30 on 5.1.0), and fifty `get_view` calls took p50 2.3 ms and p95 4.1 ms (1.9 and 3.6). All six demo tools were listed 742 ms after navigation against 255 ms on 5.1.0; later `getTools()` calls with the embed's frame in the page took 0.1 to 0.2 ms, so the cost is not there, and the cause was not measured further. Both relays forward only `readOnlyHint` of the page's annotations, check arguments against `inputSchema` themselves, and turn the page's text back into a value, so `late_tool`'s plain `late` reached the MCP client unquoted on both, as text and as `structuredContent` `{ "result": "late" }`. A handler error reached it as `Tool execution failed` on 6.

So 6 takes input, reports errors and hands handlers their signal as Chrome 155 and 156 do, but serializes every result as JSON, as the draft of 2 October prescribes, where Chrome 153 to 156 passed a handler's text as it was and turned `undefined` into a string. The rows match ADR 0001's notes: no marker, so the adapter treats 6 as native; an object input taken at once; `consequentialHint` reported; the caller's signal handed to the handler; no race against the tool's registration, so ADR 0012's hold cannot arise; and opaque errors, an `undefined` result among them. Tabdock forwards a result's text as the runtime gives it, so on 6 a plain string reaches clients quoted, where MCP-B's own relay unquotes it. `tests/e2e/specs/mcpb6.spec.ts` holds the adapter to these rows in a real browser (A5.4).

## What this means for Tabdock

The adapter has to detect the input format once per page (try an object, fall back to a string on `UnknownError` about parsing), accept `inputSchema` as a string or an object, treat results as text and recover structure with `JSON.parse`, and expect opaque errors on native runtimes, so a page that wants an agent to read an error should return it as a result. It cannot rely on `consequentialHint` (ADR 0002) or on a handler honouring cancellation (ADR 0001). `toolchange` is dependable but carries nothing, so every event means a fresh `getTools()`; the 2 s poll stays as a fallback. The relay should validate arguments against `inputSchema` before forwarding every call, which MCP-B does only on its MCP side, reject header-less page sockets (S1), and any page that hosts Tabdock's prompts must refuse to be framed.
