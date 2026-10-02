# @tabdock/adapter

The browser library a page loads to join Tabdock (SPEC.md section 8). It reads the page's tools from `document.modelContext`, keeps a WebSocket to the relay, enforces role and consequential policy again on the page, and shows the operator's widget. It never registers tools of its own.

```ts
import { attach } from '@tabdock/adapter';

const dock = attach({
  relay: 'ws://127.0.0.1:8787/page',
  policy: { consequentialTools: ['clear_board'] },
});
dock.on('state', (state) => console.log(state.link, state.pairing?.code));
```

`attach()` returns the only control handle (`approve`, `deny`, `confirm`, `rotatePairing`, `close`); with `ui: false` no widget is mounted and the handle answers prompts. Without a script, `pnpm --filter @tabdock/adapter build` writes `dist/tabdock-adapter.js`, which reads `data-relay`, `data-auto-approve`, `data-max-drivers`, `data-consequential` and `data-consequential-tools` from its own script tag.

`src/core.ts` (exported as `@tabdock/adapter/core`) holds all behaviour and touches no browser global, so the Node sim page runs the same code; `src/index.ts` wires it to the page and `src/widget.ts` renders the badge and panel in a closed shadow root. The runtime differences it absorbs are recorded in `docs/notes/baseline.md` and ADRs 0001 and 0002.
