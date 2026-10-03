# @tabdock/adapter

The browser library a page loads to join Tabdock (SPEC.md section 8). It reads the page's tools from `document.modelContext`, keeps a WebSocket to the relay, enforces role and consequential policy again on the page, and shows the operator's widget. It never registers tools of its own.

```ts
import { attach } from '@tabdock/adapter';

const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['clear_board'] },
});
const status = document.querySelector('#tabdock-status');
dock.on('state', (state) => {
  if (status) status.textContent = `Tabdock: ${state.link}, ${state.roster.length} attached`;
});
```

The pairing code shows in the widget for the operator to read out; never log it, print it or send it anywhere else, and the same goes for resume tokens (SPEC.md section 9, S11). Anyone who sees a live code can ask to attach.

`attach()` returns the only control handle (`approve`, `deny`, `confirm`, `rotatePairing`, `setRole`, `revoke`, `pause`, `close`); with `ui: false` no widget is mounted and the handle answers prompts. `setRole(userId, role)` works for users the roster lists and records the operator's choice before telling the relay, which may still hold a driver at `maxDrivers`; calls always run under the lesser of that choice, the relay's roster and the role the call claims. `revoke(userId)` (or `'*'` for everyone) drops the grant, denies that user's pending request and prompts, cancels their calls in flight and tells the relay. `pause(true)` answers every new call with `page_busy` while calls already running finish; it is stored beside the grants, so a reload stays paused, and only `pause(false)` resumes. The resume token, grants and pause belong to one page, its origin and path, so another page of the site in the same tab starts its own session and is approved anew (ADR 0011). `state.activity` holds the last 50 calls, newest first, with user, client, tool, outcome and duration, never the arguments. Writes (any tool the page does not mark read-only) run one at a time in arrival order on the page even if a relay sends several at once; reads run beside them.

The widget shows the pairing code, the prompts, a roster row per user (role, clients, expiry, a role switch and Revoke), Revoke all, the activity log and a pause switch whose state also shows on the badge. Prompt boxes, roster rows and the pause switch take a click only once they have held still for half a second, and wait again whenever they move or their buttons change meaning. Without a script, `pnpm --filter @tabdock/adapter build` writes `dist/tabdock-adapter.js`, which reads `data-relay`, `data-auto-approve`, `data-max-drivers`, `data-consequential` and `data-consequential-tools` from its own script tag.

`src/core.ts` (exported as `@tabdock/adapter/core`) holds all behaviour and touches no browser global, so the Node sim page runs the same code; `src/index.ts` wires it to the page and `src/widget.ts` renders the badge and panel in a closed shadow root. The runtime differences it absorbs are recorded in `docs/notes/baseline.md` and ADRs 0001 and 0002.
