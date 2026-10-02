# 0002: Consequential tools when the runtime drops the hint

Status: Accepted by the owner (option C), 2 October 2026. SPEC sections 5 and 8 updated.

## Context

S6 says consequential tools prompt on the page by default, but the spec never says how a tool is classed as consequential; section 3 lists `consequentialHint` among the WebMCP annotations, and the natural reading is to trust it. The M0 baseline measured that the MCP-B polyfill 5.1.0 and Chrome 153 drop that hint: `getTools()` returns `clear_board` without it, so an adapter that trusts the hint would run the demo's one consequential tool with no prompt. Chrome 154 to 156 keep it, and so does MCP-B's 6.0 beta according to the checks in `docs/notes/verified.md`. The runtime's annotations object tells us which case we are in: when hints are present but `consequentialHint` is absent, the runtime does not support it.

## Options

A. Trust the hint only, the natural reading of the spec today. Simple, but on the affected runtimes S6 silently fails open.

B. When the runtime cannot report the hint, treat every tool that is not read-only as consequential. Safe, but on the polyfill every `add_item` prompts the operator, which makes the demo and most real pages tiresome.

C. Add `policy.consequentialTools: string[]` to `attach()`. On runtimes that report the hint, a tool is consequential if the hint or the list says so. On runtimes that cannot report it, the list is authoritative when the page supplies one, and option B applies when it does not, with a one-line notice in the widget explaining how to fix it.

## Recommendation

C. It keeps S6 fail-safe on every runtime, gives page authors a one-line fix that also documents intent, and costs one optional field. The demo would pass `consequentialTools: ['clear_board']`. A2.5 gains a case on the polyfill with and without the list.
