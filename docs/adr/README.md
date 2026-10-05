# Architecture decision records

Short records of decisions that change or refine `SPEC.md`, or that a future contributor would otherwise have to rediscover. A record starts as Proposed; the owner accepts or rejects it, and only an accepted record may change the spec. Number them in order and never reuse a number.

| ADR                                              | Title                                                           | Status   |
| ------------------------------------------------ | --------------------------------------------------------------- | -------- |
| [0001](0001-webmcp-runtime-variance.md)          | Tolerate WebMCP runtime differences in the adapter              | Accepted |
| [0002](0002-consequential-tools-without-hint.md) | Consequential tools when the runtime drops the hint             | Accepted |
| [0003](0003-toolchain.md)                        | Toolchain pins and running TypeScript without a build           | Accepted |
| [0004](0004-refresh-spec-section-3.md)           | Refresh SPEC section 3 with the facts verified on 2 October     | Accepted |
| [0005](0005-pair-wait-and-sdk-mode.md)           | How long pair_page waits, and how the relay speaks MCP in M1    | Accepted |
| [0006](0006-oauth-in-m3.md)                      | Sign in through OAuth from M3                                   | Accepted |
| [0007](0007-contract-clarifications-m1.md)       | Contract clarifications from M1                                 | Accepted |
| [0008](0008-argument-validation.md)              | Checking call arguments at the relay                            | Accepted |
| [0009](0009-sessions-limits-expiry.md)           | MCP sessions, section 9 limits and idle expiry in M2            | Accepted |
| [0010](0010-bounded-argument-checks.md)          | The argument check runs off the main thread with a time limit   | Accepted |
| [0011](0011-one-approval-per-page.md)            | One approval covers one page                                    | Accepted |
| [0012](0012-contract-clarifications-m2.md)       | Contract clarifications from the M2 review                      | Accepted |
| [0013](0013-oauth-shape-m3.md)                   | OAuth in M3: WorkOS issues tokens, the relay checks them        | Accepted |
| [0014](0014-public-url-mode.md)                  | Public URL mode for the M3 spike                                | Accepted |
| [0015](0015-refresh-spec-m3.md)                  | Refresh SPEC sections 3 and 12 with the facts verified for M3   | Accepted |
| [0016](0016-invites-and-guest-access.md)         | Invites and guest access                                        | Accepted |
| [0017](0017-invite-wire-format.md)               | Invite wire format and clarifications of ADR 0016               | Accepted |
| [0018](0018-hosted-relay.md)                     | The relay on a host behind a TLS-terminating edge               | Accepted |
| [0019](0019-audit-log-and-restart.md)            | The persistent audit log, and what a restart keeps              | Accepted |
| [0020](0020-production-sign-in.md)               | Production sign-in                                              | Accepted |
| [0021](0021-refresh-spec-m4.md)                  | Refresh SPEC sections 3, 10, 11 and 12 for M4                   | Accepted |
| [0022](0022-local-mode-by-default.md)            | Local mode by default                                           | Accepted |
| [0023](0023-page-frames-that-change-nothing.md)  | Page frames that change nothing                                 | Accepted |
| [0024](0024-a-page-that-stops-reading.md)        | A page that stops reading                                       | Accepted |
| [0025](0025-first-class-page-tools.md)           | First-class page tools                                          | Accepted |
| [0026](0026-confirmation-in-the-client.md)       | Consequential confirmation in the caller's client               | Accepted |
| [0027](0027-revisions-and-origin.md)             | MCP revisions served, the conformance suite, and Origin on /mcp | Accepted |
| [0028](0028-packaging-and-release.md)            | Packaging and the 0.1.0 release                                 | Accepted |
| [0029](0029-tour-on-pages.md)                    | The tour on GitHub Pages and the demo's choice of relay         | Accepted |
| [0030](0030-limits-from-the-m4-hunt.md)          | Limits and fixes from the last M4 review                        | Accepted |
| [0031](0031-refresh-spec-m5.md)                  | Refresh SPEC sections 3, 10 and 12 for M5                       | Accepted |
