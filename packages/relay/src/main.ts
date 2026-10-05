// node packages/relay/src/main.ts (pnpm relay at the root): the relay command
// of cli.ts as a checkout runs it, after loading the repo-root .env when there
// is one. With no settings at all it runs local mode (ADR 0022);
// `pnpm relay --new-token` draws a new owner token first (ADR 0028). The
// container image runs this file too, from its own copy of the sources, with
// its settings in the environment and no .env. It prints where to connect and
// nothing secret: in local mode the owner token's path and a command that
// never holds the token. JSON log lines go to stderr.

import { loadCheckoutEnv, processContext, runCommand } from './cli.ts';

loadCheckoutEnv(false);
const code = await runCommand(process.argv.slice(2), processContext(false));
if (code !== null) process.exitCode = code;
