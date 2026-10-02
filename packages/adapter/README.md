# @tabdock/adapter

The browser library a page loads to join Tabdock: it reads the page's tools from `document.modelContext`, keeps a WebSocket to the relay, enforces role and policy locally, and shows the operator's widget (SPEC.md section 8). It never registers tools of its own.

Arrives in M1, shaped by the measurements in `docs/notes/baseline.md`. Until then this directory holds only this note.
