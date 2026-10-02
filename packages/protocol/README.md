# @tabdock/protocol

Message types and zod schemas for the page link between the adapter and the relay (SPEC.md section 6). Both sides validate every frame with these schemas, so this package is the single place the wire format is defined.

M0 holds only the fixed constants (subprotocol, size limits, error codes). M1 adds the frame schemas.
