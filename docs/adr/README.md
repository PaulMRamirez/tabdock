# Architecture decision records

Short records of decisions that change or refine `SPEC.md`, or that a future contributor would otherwise have to rediscover. A record starts as Proposed; the owner accepts or rejects it, and only an accepted record may change the spec. Number them in order and never reuse a number.

| ADR                                              | Title                                                         | Status   |
| ------------------------------------------------ | ------------------------------------------------------------- | -------- |
| [0001](0001-webmcp-runtime-variance.md)          | Tolerate WebMCP runtime differences in the adapter            | Accepted |
| [0002](0002-consequential-tools-without-hint.md) | Consequential tools when the runtime drops the hint           | Accepted |
| [0003](0003-toolchain.md)                        | Toolchain pins and running TypeScript without a build         | Accepted |
| [0004](0004-refresh-spec-section-3.md)           | Refresh SPEC section 3 with the facts verified on 2 October   | Accepted |
| [0005](0005-pair-wait-and-sdk-mode.md)           | How long pair_page waits, and how the relay speaks MCP in M1  | Accepted |
| [0006](0006-oauth-in-m3.md)                      | Sign in through OAuth from M3                                 | Accepted |
| [0007](0007-contract-clarifications-m1.md)       | Contract clarifications from M1                               | Accepted |
| [0008](0008-argument-validation.md)              | Checking call arguments at the relay                          | Accepted |
| [0009](0009-sessions-limits-expiry.md)           | MCP sessions, section 9 limits and idle expiry in M2          | Accepted |
| [0010](0010-bounded-argument-checks.md)          | The argument check runs off the main thread with a time limit | Accepted |
| [0011](0011-one-approval-per-page.md)            | One approval covers one page                                  | Accepted |
| [0012](0012-contract-clarifications-m2.md)       | Contract clarifications from the M2 review                    | Accepted |
