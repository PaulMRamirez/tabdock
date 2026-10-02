# 0005: How long pair_page waits, and how the relay speaks MCP in M1

Status: Proposed, 2 October 2026. Refines SPEC section 7 if accepted.

## Context

SPEC section 7 says `pair_page` waits up to 60 s for the operator, and section 5 says attach requests last 60 s. Claude Code fails an HTTP tool call that sends no first byte for 60 s (`docs/notes/verified.md`), so a full 60 s wait would end as a client timeout instead of Tabdock's own `timeout` error. Separately, the MCP SDK v2 serves 2025-era clients (which is what Claude and Claude Code speak today) in a stateless mode by default: no session id, no client name after `initialize`, and no unsolicited `list_changed`.

## Decision

`pair_page` waits at most 50 s. If the operator has not answered by then it returns `timeout` and says the request stays open on the page; an approval inside the 60 s request lifetime still creates the attachment, which then shows up in `list_pages`. The attach request itself keeps its 60 s lifetime and its deny-on-silence default.

M1 mounts the SDK's `createMcpHandler` in its default mode, which serves both the 2026-07-28 protocol and 2025-era clients from one endpoint. Attribution in M1 therefore records the user always and the client only when the request carries it (2026-07-28 clients do on every request). M2, which needs per-client attribution for its roster (A2.1), adds the SDK's documented sessionful route for 2025-era clients, with session caps and idle expiry.

## Consequences

Pairing works in Claude Code without raising its timeout, at the cost of an operator having 50 s instead of 60 s before the client stops waiting. Until M2 the roster shows users but not always which of their clients called.
