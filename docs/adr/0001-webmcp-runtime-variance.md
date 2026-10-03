# 0001: Tolerate WebMCP runtime differences in the adapter

Status: Accepted by the owner, 2 October 2026. SPEC sections 3 and 8 updated.

## Context

SPEC section 3 records `executeTool(tool, argsObject, {signal})`. The M0 baseline (`docs/notes/baseline.md`, raw files beside it) measured five runtimes that disagree. Chrome 153 and 154 and the MCP-B polyfill 5.1.0 take the input as a JSON string and reject an object; Chrome 155 and later take an object and reject a string. Chrome 155 reaches Stable on 6 October 2026, while MCP-B's stable line stays on strings until its 6.0 release (in beta since 1 October, per `docs/notes/verified.md`). `getTools()` returns `inputSchema` as a string on Chrome 153 and 154. Every runtime returns the tool's result as a string. Native Chrome hides a handler's error message behind a fixed `UnknownError` text. The polyfill 5.1.0 never passes the handler an `AbortSignal`, so cancelling a call there stops the caller waiting but does not stop the handler.

## Decision

The adapter feature-detects instead of trusting a version number. On the first call to a page it tries an object, falls back to a JSON string when the runtime rejects the object with its parse error, and remembers the answer for that page session. It parses `inputSchema` when it arrives as a string. It treats every result as text, attempts `JSON.parse` to recover structured content, and forwards the text unchanged when parsing fails. Handler errors travel to the relay as whatever message the runtime exposes.

Cancellation in S8 is defined at the boundary Tabdock controls: on `cancel`, revoke or deadline, the adapter aborts the `executeTool` signal, reports the call finished, and drops any late result; the relay answers the client at once. Whether the page's handler also stops depends on the runtime; tests assert the handler's signal only where the runtime provides one.

## Consequences

Tabdock works on today's Stable, on 155 next week and on the polyfill without configuration. SPEC section 3's `executeTool` row should read "input is a JSON string on Chrome 153 and 154 and MCP-B 5.x, an object on Chrome 155+ and MCP-B 6". The adapter carries one extra probe call per page session, and a mutating call can still finish its side effects after a revoke on the polyfill, which the activity log will show.

## Notes after M2

M2 runs writes one at a time on the page, which means a write the relay has already given up on (a client cancel, its deadline, a revoke) must keep the page until its handler really ends. Native WebMCP hands the handler the abort signal, so the adapter aborts it. The MCP-B polyfill 5.1 never passes the signal to the handler and only races `executeTool` against it, so aborting would end the call while the handler kept changing the page. On that runtime, which the adapter recognises by the `__isWebMCPPolyfill` property the polyfill sets on its context (in its code, not its README; `docs/notes/verified.md`), the adapter leaves a running write's signal alone and waits for the handler. A handler that never ends therefore holds later writes until the operator pauses, revokes or reloads; they time out at their own deadlines. The polyfill also races the handler against the tool's own registration: if the page unregisters a tool while its write runs, `executeTool` rejects with "Tool unregistered" and the handler runs on unseen. The adapter then holds the page until that call's deadline plus 2 s, the only bound it has, and logs that it let the next write go. Re-check the marker and both races when the demo moves to MCP-B 6.
