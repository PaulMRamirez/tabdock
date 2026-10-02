# 0008: Checking call arguments at the relay

Status: Accepted by the owner, 2 October 2026. No SPEC change; refines how `invalid_arguments` (ADR 0007) is produced.

## Context

Neither native WebMCP nor the MCP-B polyfill checks arguments against a tool's `inputSchema` (`docs/notes/baseline.md`), so M2 has the relay check them before forwarding, as the owner decided during M1. The MCP SDK bundles two validators. Its Ajv-based one is unsafe for page-supplied schemas: an `$async` schema crashes the process with an unhandled rejection, schemas sharing an `$id` share one compiled validator, its cache never shrinks, and large schemas take seconds to compile. The CfWorker-based one has none of these problems. Both run a schema's regex keywords, and a regex such as `^(a+)+$` takes exponential time, so a hostile page could stall a relay that other pages share (measured on 2 October 2026; `docs/notes/verified.md`).

## Decision

The relay uses the SDK's `CfWorkerJsonSchemaValidator` and never Ajv for page schemas. It compiles one validator per tool when the page's `tools` frame arrives, from the page's own schema rather than the cut copy shown to clients, so long enum values still match. Before compiling it removes every regex the page wrote: `pattern` keywords, and `patternProperties`, loosening `additionalProperties` and `unevaluatedProperties` beside it so the check never rejects arguments the page's schema accepts. A schema the validator cannot compile, or a check that throws, skips the relay's check for that tool and logs once without page text. A failed check returns `invalid_arguments` with text the relay writes (where in the arguments, and which rule), never text from the schema.

## Consequences

Clients get a clear error for wrong arguments before the page sees them, and no page schema can make the relay run a regex. The relay's check is looser than the page's schema wherever regexes are involved; the page still receives the raw arguments and can check them itself.
