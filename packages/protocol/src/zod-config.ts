// zod 4 compiles a fast path for each object schema with `new Function`, and
// before the first one it probes whether eval works by running
// `new Function('')` in a try block. On a page that enforces Trusted Types that
// probe is refused, and the refusal is still reported as a CSP violation, so
// merely loading the adapter put a violation in the host page's reports. The
// adapter runs on pages whose CSP it does not control, so the protocol turns
// the compiler off for every schema, on both sides of the link: zod reads the
// setting when each object schema is built, and with it set never runs the
// probe at all (zod 4.6.5, v4/core/util.js allowsEval).
//
// This module must be evaluated before any schema is built, so page-link.ts
// imports it first. The setting is process wide (every zod 4 copy keeps it on
// globalThis), so the relay's own schemas, and any other library's built after
// this runs, take the interpreted path too.
// A frame parse costs a microsecond or a few more that way (measured on Node
// 22.22, mean of 20,000 parses: a 1 KB result frame 4.3 against 4.1 us, an
// invoke 4.7 against 3.3 us, a six-tool frame 23 against 17 us), far below a
// network round trip.

import { z } from 'zod';

z.config({ jitless: true });
