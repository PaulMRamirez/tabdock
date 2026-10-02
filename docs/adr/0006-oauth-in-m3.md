# 0006: Sign in through OAuth from M3

Status: Accepted by the owner, 2 October 2026. Changes SPEC sections 7 and 10.

## Context

M3 planned a Claude custom connector that carries a fixed bearer token in a request header, with OAuth arriving in M4. Claude's request-header option is a beta for a limited set of organizations (`docs/notes/verified.md`), and the owner's account does not show the Request headers section in the Add custom connector dialog. Without it the M3 phone spike would need a connector with no sign-in at all, which leaves the relay unable to tell users apart.

## Decision

M3 ships a minimal `oauth` auth plugin that delegates sign-in to an external identity provider through a maintained library and accepts Claude's hosted callback and Claude Code's loopback redirect, enough for the owner and a second test user. `dev-token` stays for local work and tests. M4 hardens the plugin for production (token lifetimes, revocation, the threat model), as the spec already planned.

## Consequences

The phone spike runs with real per-user identity, so the multi-user rules from M2 hold on the phone too. M3 grows, and two choices come to the owner with the M3 plan before work starts: the identity provider (already open in SPEC section 12) and the OAuth library, which is a runtime dependency outside CLAUDE.md's pre-approved list.
