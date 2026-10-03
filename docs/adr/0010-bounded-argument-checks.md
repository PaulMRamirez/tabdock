# 0010: The argument check runs off the main thread with a time limit

Status: Accepted by the owner, 3 October 2026. Amends ADR 0008; no SPEC change.

## Context

ADR 0008 removed every regex from the relay's copy of a page schema so that no page could stall a relay other pages share. The M2 review showed that regexes were not the only way. A 1.5 KB schema whose references fan out costs the validator 2^n steps (one call with `{}` arguments blocked the relay for 39 s), a wide `anyOf` costs schema width times argument size, and `uniqueItems` compares every pair of a client's array, so any attached user, an observer included, could block the relay for minutes with an ordinary schema. While the check ran, every page and client stalled. The owner chose this over removing the check or bounding it with a cost model, which the reviewers showed could be gamed.

## Decision

The relay never runs the validator on its main thread. One worker thread (Node's built-in `worker_threads`, no new dependency) compiles each tool's prepared schema, caches the result by a hash of that schema, and runs the checks. Each check has about 50 ms; a check that runs longer, or cannot start promptly because the worker is busy, lets the call through unchecked, and an overrunning worker is replaced. The check stays advisory, as ADR 0008 already says. The relay's copy also drops `uniqueItems`, loosening its parents as for the removed regexes, so ordinary schemas stay fast. Everything else in ADR 0008 holds: CfWorker, never Ajv; regexes and `format` removed; relay-written error text.

## Consequences

No page schema and no client argument can hold up the relay's main loop for more than the cost of handing a message to the worker. Under attack, checks for other users may be skipped, never blocked. A call waits at most about 100 ms for its check.

## Notes after the build

The worker lives in `packages/relay/src/argument-worker.ts`, driven from the main thread by `argument-checker.ts`; `cfworker.ts` is the only module that loads the validator, and only the worker imports it. The budget is `timings.argumentCheckMs` (50 ms): up to that long to start and as long again to run. An overrun replaces the worker at once; a second failure in a row (an overrun, a crash, a failed start or a malformed reply) restarts it with backoff from 250 ms up to 30 s, during which calls go unchecked at once. Compiled checks are cached in the worker by a hash of the prepared schema (at most 256, or 8 Mi characters), the worker's heap is capped at 256 MB, and every message across the thread boundary is checked with zod (`check-messages.ts`, relay-internal like the other relay schemas). After the check, the call's access, tool and role are checked again, so a revoke or demotion made meanwhile still wins. A very large tool whose compile and check together pass the budget simply goes unchecked, which is the advisory behaviour this record chose. The relay now waits for its first worker before it listens, about 100 ms at start.
