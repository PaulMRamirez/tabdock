# Baseline: WebMCP runtimes and MCP-B's local relay

Measured on 2 October 2026 with `pnpm --filter @tabdock/e2e baseline` (probes in `tests/e2e/src/measure-page.ts`, relay timing in `tests/e2e/src/baseline.ts`), headless on Linux, Node 22.22. Three runtimes: the MCP-B polyfill 5.1.0 in Chromium 141, which has no native WebMCP (this is what the demo runs on today); native WebMCP in Chrome for Testing 154.0.8037.92 (current Stable); and 156.0.8078.5 (Beta), both launched with `--enable-features=WebMCPTesting`. Raw output lives beside this file in `baseline.raw.json`, `baseline.raw.chrome154.json` and `baseline.raw.chrome156.json`; rerun with `CHROMIUM_EXECUTABLE=<path> BASELINE_LABEL=<name>` to add another browser.

## getTools()

Asynchronous everywhere, under 1 ms, and sorted by name rather than registration order. Each entry has `name`, `title`, `description`, `inputSchema`, `origin`, `window` and `annotations`. The polyfill's entry for `clear_board`:

```json
{
  "name": "clear_board",
  "title": "Clear board",
  "description": "Remove every item from the board. This cannot be undone.",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
  "origin": "http://127.0.0.1:45555",
  "window": "[Window]",
  "annotations": { "readOnlyHint": false, "untrustedContentHint": false }
}
```

Two fields vary by runtime. `inputSchema` is a JSON string in Chrome 154 and an object in the polyfill and Chrome 156. Annotations: the polyfill keeps only `readOnlyHint` and `untrustedContentHint`, so the demo's `consequentialHint: true` on `clear_board` is lost; Chrome 154 returns it; Chrome 156 also adds `debugging`.

## executeTool(tool, input, { signal })

The result is always a string. The input format flipped between Chrome 154 and 155.

| Probe                        | Polyfill 5.1.0                               | Chrome 154                         | Chrome 156                        |
| ---------------------------- | -------------------------------------------- | ---------------------------------- | --------------------------------- |
| Input as JSON string         | runs                                         | runs                               | `TypeError` (not an object)       |
| Input as object              | `UnknownError` (cannot parse)                | `UnknownError`                     | runs                              |
| Input omitted                | `UnknownError`                               | `TypeError` (2 arguments required) | runs with `{}`                    |
| Input violates `inputSchema` | handler runs                                 | handler runs                       | handler runs                      |
| Tool given by name only      | `TypeError`                                  | `TypeError`                        | `TypeError`                       |
| Handler throws               | `UnknownError`, handler message appended     | `UnknownError`, fixed text only    | `UnknownError`, fixed text only   |
| Abort after 100 ms           | caller rejects at 100 ms; handler never told | rejects; handler's `signal` fires  | rejects; handler's `signal` fires |

Return encodings were identical in all three: an object comes back as its JSON, the string `plain text` comes back unquoted, `42` as `"42"`, `undefined` as `"undefined"`, and an MCP `CallToolResult` as its JSON. Nothing validates arguments against `inputSchema`; the page handler must. The polyfill calls `execute(input)` with no second argument, so a page tool cannot observe cancellation there.

## toolchange

A plain `Event` with no payload, fired at `document.modelContext` once per registration and once per removal (aborting the registration signal). Five registrations in one turn produced five events; nothing coalesces. The event fires before `registerTool()` resolves: 0.1 ms after the call on the polyfill, 1.1 ms on Chrome 154, 0.4 ms on Chrome 156; removal took 4.2, 0.4 and 0.5 ms. A duplicate name rejects with `InvalidStateError`.

## Through MCP-B's local relay

The chain is MCP client (official SDK 2.2.0 over stdio), relay 5.1.0, WebSocket on 127.0.0.1, a hidden iframe injected by `embed.js`, then the page. The relay advertises `tools.listChanged`. All six tools were listed 284 to 382 ms after navigation, with one `tools/list_changed` per registration. A tool registered later produced `list_changed` after 22 ms and appeared in `tools/list` after 109 ms. Fifty `get_view` calls took p50 2.1 ms and p95 3.5 ms on the polyfill (3.0 and 4.0 ms on Chrome 154).

A successful call returns `{ content: [{ type: "text", text: "<json>" }], structuredContent: <object>, isError: false }`; a handler error returns `isError: true` with the runtime's error text. The relay checks arguments against `inputSchema` itself and answers `Input validation error: ...` without reaching the page. It prefixes each description with `[WebMCP <source id> • <page title>]` and forwards only `readOnlyHint`, dropping `untrustedContentHint` and `consequentialHint` even when the page supplies them. Its `--widget-origin` allowlist works on the WebSocket `Origin` header: the same page loaded from `localhost` instead of `127.0.0.1` never appeared (`specs/mcpb-relay.spec.ts`). Under Chrome 156 every page tool call failed, because `embed.js` 5.1.0 always sends a JSON string; MCP-B's 6.0 beta, published 1 October, switches to objects.

## What this means for Tabdock

The adapter has to detect the input format once per page (try an object, fall back to a string on `UnknownError` about parsing), accept `inputSchema` as a string or an object, treat results as text and recover structure with `JSON.parse`, and expect opaque errors on native runtimes, so a page that wants an agent to read an error should return it as a result. It cannot rely on `consequentialHint` (ADR 0002) or on a handler honouring cancellation (ADR 0001). `toolchange` is dependable but carries nothing, so every event means a fresh `getTools()`; the 2 s poll stays as a fallback. The relay should validate arguments against `inputSchema` before forwarding, as MCP-B's does.
