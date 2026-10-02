# Carried-forward decisions

Decisions the owner made for later milestones, so each milestone plan picks them up.

| Decided | For | Decision |
| --- | --- | --- |
| 2 October 2026 | M2 | The relay checks `call_page_tool` arguments against the page tool's `inputSchema` before forwarding, using the JSON Schema validator that ships in the official MCP SDK (no new dependency). Native WebMCP and the polyfill do not check them (`docs/notes/baseline.md`). |
| 2 October 2026 | M2 | Per-client attribution for 2025-era clients through the SDK's sessionful route, with session caps and idle expiry (ADR 0005). |
| 2 October 2026 | M3 | A minimal OAuth plugin replaces the request-header connector; the identity provider and OAuth library come to the owner with the M3 plan (ADR 0006). |
| 2 October 2026 | M5 | The adapter's script-tag bundle (213 KiB minified in M1, mostly zod) is slimmed before 0.1.0 by moving the protocol schemas to zod's tree-shakable `zod/mini` API. |
| 2 October 2026 | M5 | Re-run the WebMCP baseline against MCP-B 6.0 once it is stable, then move the demo to it. |
