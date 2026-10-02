# @tabdock/relay

The Node service at the centre of Tabdock: a WebSocket endpoint at `/page` that pages dial out to, a Streamable HTTP MCP endpoint at `/mcp` for clients, pairing, auth plugins and the audit log (SPEC.md sections 4, 6 and 7). It only routes calls; it never runs page tools itself.

Arrives in M1. Until then this directory holds only this note.
