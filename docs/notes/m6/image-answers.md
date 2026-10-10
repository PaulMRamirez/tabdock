# Image answers on the wire (ADR 0030 re-measured for ADR 0039)

Measured on 10 October 2026 by `packages/relay/test/image-answers.test.ts`, which runs in `pnpm test` and fails should either side of the comparison change.

ADR 0030 sized what waiting `/mcp` answers may hold on a text answer of `MAX_RESULT_CHARS` (120,000 characters), about 0.72 MB on the wire at worst, and responses carry no byte charge of their own. ADR 0039's decision 25 asks that an image answer be measured the same way and never be larger. The test sends, through the real relay to an SDK-free client, an image of `MAX_IMAGE_BYTES` (524,288 decoded bytes, 699,052 base64 characters) beside `MAX_IMAGE_TEXT_CHARS` (2,000) characters of U+0001, which JSON writes as a six-byte escape (no UTF-16 unit takes more; a lone surrogate takes the same), and a text answer of 120,000 such characters. It reads the HTTP body each leg returns: an event stream on a 2025-11-25 session, and JSON on 2026-07-28.

| Leg        | Image answer (bytes) | Text answer (bytes) |
| ---------- | -------------------- | ------------------- |
| 2025-11-25 | 711,400              | 720,170             |
| 2026-07-28 | 711,492              | 720,262             |

So the largest image answer is about 8,800 bytes, 1.2%, under the largest text answer on each leg, and ADR 0030's sizing of eight waiting answers per member holds unchanged with image results. The default cap, `DEFAULT_IMAGE_BYTES` of 65,536, gives answers of about 100 KB. With `MAX_IMAGE_TEXT_CHARS` raised to 4,000 the image answer grew to 723,400 bytes and the test failed, as it should.

What the measure leaves out: the A5.6 pipelining probe was not re-run with image answers, since a response's size, not its kind, is what the per-user cap counts, and the body bytes above bound that size. W1-F's relay-wide `TABDOCK_MAX_RESPONSE_BYTES` (ADR 0044) bounds image answers as it bounds text ones.
