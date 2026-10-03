# 0008: Checking call arguments at the relay

Status: Accepted by the owner, 2 October 2026; amended by ADR 0010 (the check runs off the main thread with a time limit). No SPEC change; refines how `invalid_arguments` (ADR 0007) is produced.

## Context

Neither native WebMCP nor the MCP-B polyfill checks arguments against a tool's `inputSchema` (`docs/notes/baseline.md`), so M2 has the relay check them before forwarding, as the owner decided during M1. The MCP SDK bundles two validators. Its Ajv-based one is unsafe for page-supplied schemas: an `$async` schema crashes the process with an unhandled rejection, schemas sharing an `$id` share one compiled validator, its cache never shrinks, and large schemas take seconds to compile. The CfWorker-based one has none of these problems. Both run a schema's regex keywords, and a regex such as `^(a+)+$` takes exponential time, so a hostile page could stall a relay that other pages share (measured on 2 October 2026; `docs/notes/verified.md`).

## Decision

The relay uses the SDK's `CfWorkerJsonSchemaValidator` and never Ajv for page schemas. It compiles one validator per tool when the page's `tools` frame arrives, from the page's own schema rather than the cut copy shown to clients, so long enum values still match. Before compiling it removes every regex the page wrote: `pattern` keywords, and `patternProperties`, loosening `additionalProperties` and `unevaluatedProperties` beside it so the check never rejects arguments the page's schema accepts. A schema the validator cannot compile, or a check that throws, skips the relay's check for that tool and logs once without page text. A failed check returns `invalid_arguments` with text the relay writes (where in the arguments, and which rule), never text from the schema.

## Consequences

Clients get a clear error for wrong arguments before the page sees them, and no page schema can make the relay run a regex. The relay's check is looser than the page's schema wherever regexes are involved; the page still receives the raw arguments and can check them itself.

## Notes after the build

The validator's own `format` checks run regexes too, and its `url` check backtracks exponentially on input a client controls (`http://` and 28 letters took 950 ms; 100 KB never finished), while every other format stayed at 10 ms or less on 100 KB. The relay's copy therefore drops `format` as well. Keeping the check from rejecting what the page's schema accepts took more loosening than the decision lists: `not` is dropped, `if`, `then` and `else` go together, `oneOf` becomes `anyOf`, `maxContains` goes, `unevaluatedProperties` and `unevaluatedItems` go everywhere once anything they depend on was removed, and a `$ref` counts as loosened once anything was. A unit test checks these against the validator run on the page's original schema. The validator's own error text quotes schema values (enum entries, constants, required names), so the relay keeps only error locations that name keys in the caller's own arguments and maps the rule to fixed wording.

A client can sometimes make the validator throw on purpose (a key holding a lone surrogate, for one), which skips the check for that call, as decided. The relay's check is therefore advisory: pages must still check their own arguments, which the M4 threat model will say.
