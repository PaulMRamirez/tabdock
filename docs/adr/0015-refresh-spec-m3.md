# 0015: Refresh SPEC sections 3 and 12 with the facts verified for M3

Status: Proposed, 3 October 2026. Changes SPEC sections 3 and 12 if accepted.

## Context

SPEC section 3 records facts verified on 2 October (ADR 0004). The M3 research on 3 October found facts that section lacks and that M3 depends on (`docs/notes/verified.md`), and section 12 still lists the identity provider as an M4 choice although ADR 0006 moved it into M3 and ADR 0013 made it.

## Decision

Section 3 gains: hosted Claude follows the 2025-03-26, 2025-06-18 and 2025-11-25 MCP authorization specs, while 2026-07-28 deprecates dynamic registration in favour of client ID metadata documents; a connector's auth settings cannot be edited after it is added; installing connectors on mobile is a beta, and a connector is added on the web or desktop before it appears on the phone. Section 12 drops "the identity provider for M4".

## Consequences

The spec's facts match what M3 builds on. No design changes.
