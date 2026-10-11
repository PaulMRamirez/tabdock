// A stand-in for pnpm in the ci-check runner's signal test. Named so that
// scripts/ci-check.ts starts it through npm_execpath as it starts pnpm, in a
// process group of its own; it writes its process id and the TABDOCK_HOME it
// was given to the file CI_CHECK_STAND_IN names, then waits, as a Playwright
// run with its relay and browser would, until a signal ends it.

import { writeFileSync } from 'node:fs';

writeFileSync(
  process.env.CI_CHECK_STAND_IN ?? '',
  JSON.stringify({ pid: process.pid, home: process.env.TABDOCK_HOME ?? '' }),
);
setInterval(() => undefined, 60_000);
