# Changelog

`@tabdock/protocol`, `@tabdock/adapter` and `@tabdock/relay` share one version, so this one file covers all three, one entry per release, each tagged `v<version>` (ADR 0028). `docs/release.md` says how a release is made. Versions follow semantic versioning; while they start with 0, a minor version may change the page link, the relay's settings or the packages' API.

## Unreleased: 0.1.0

The first published release, from the work of milestones M0 to M5.

**Added.** `npx @tabdock/relay` runs the relay as one command, `tabdock-relay`, with Node 22.18 or later: with no settings it runs local mode for this computer only, keeps a private owner token outside any git work tree and prints a `claude mcp add-json` command whose header helper reads the token at each connection, so the token is in neither the command nor Claude Code's settings (ADRs 0022 and 0028). `tabdock-relay --new-token` replaces the token in one rename, and `tabdock-relay audit` reads the hash-chained audit log (ADR 0019). The relay serves MCP clients on revisions 2025-03-26 to 2026-07-28 over Streamable HTTP (ADR 0027), several clients and people on one page with the operator approving each (S4), observers and drivers, invites for guests at a public URL (ADRs 0016 and 0017), and, behind `TABDOCK_FIRST_CLASS_TOOLS`, each attached page's tools listed by name (ADR 0025). `@tabdock/adapter` links a page's WebMCP tools to a relay, enforces roles and consequential-call prompts again on the page, and shows the operator's widget; a page may let member drivers confirm consequential calls in their own clients (ADR 0026). Its script-tag build, `dist/tabdock-adapter.js`, is one self-contained file under 150,000 bytes for pages without a build step. `@tabdock/protocol` holds the page link's types and `zod/mini` schemas, which both sides validate every frame with.

**Security.** SPEC section 9's rules S1 to S13 hold, each with its tests; the threat model is `docs/threat-model.md`.
