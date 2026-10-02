# 0002: Consequential tools when the runtime drops the hint

Status: Proposed, 2 October 2026. Needs the owner's choice before M2. Changes SPEC section 8 (attach options) if accepted.

## Context

S6 says consequential tools prompt on the page by default, and SPEC section 5 identifies them by `consequentialHint`. The M0 baseline found that the MCP-B polyfill 5.1.0 and Chrome 153 drop that hint: `getTools()` returns `clear_board` without it, so an adapter that trusts the hint would run the demo's one consequential tool with no prompt. Chrome 154 and later and MCP-B's 6.0 beta keep it. The runtime's annotations object tells us which case we are in: when hints are present but `consequentialHint` is absent, the runtime does not support it.

## Options

A. Trust the hint only, as the spec reads today. Simple, but on the affected runtimes S6 silently fails open.

B. When the runtime cannot report the hint, treat every tool that is not read-only as consequential. Safe, but on the polyfill every `add_item` prompts the operator, which makes the demo and most real pages tiresome.

C. Add `policy.consequentialTools: string[]` to `attach()`. On runtimes that report the hint, a tool is consequential if the hint or the list says so. On runtimes that cannot report it, the list is authoritative when the page supplies one, and option B applies when it does not, with a one-line notice in the widget explaining how to fix it.

## Recommendation

C. It keeps S6 fail-safe on every runtime, gives page authors a one-line fix that also documents intent, and costs one optional field. The demo would pass `consequentialTools: ['clear_board']`. A2.5 gains a case on the polyfill with and without the list.
