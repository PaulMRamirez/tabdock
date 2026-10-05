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
// This module must be evaluated before any schema is built, so every protocol
// module imports it first. The setting is process wide (every zod 4 copy keeps
// it on globalThis), so the relay's own schemas, and any other library's built
// after this runs, take the interpreted path too.
// A frame parse costs a microsecond or a few more that way (measured on Node
// 22.22, mean of 20,000 parses: a 1 KB result frame 4.3 against 4.1 us, an
// invoke 4.7 against 3.3 us, a six-tool frame 23 against 17 us), far below a
// network round trip.
//
// The protocol is built on zod/mini (ADR 0028), which, unlike classic zod,
// registers no message locale: without one every issue reads "Invalid input",
// and the relay's logs and the adapter's frame refusals would lose what they
// say today. So English is set here, but only where no locale is set yet, as
// classic zod does on its first schema, so a page that chose its own keeps it.
// Classic zod also installs a memoizer that mini leaves out; it acts only on
// recursive schemas and takes itself out of every other, and the protocol has
// none, so leaving it out changes no result.

import { config } from 'zod/mini';
import { en } from 'zod/locales';

config({ jitless: true });
if (config().localeError === undefined) config(en());
