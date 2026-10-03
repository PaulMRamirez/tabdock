// node packages/relay/src/main.ts: starts the relay from the environment, after
// loading the repo-root .env when there is one. Prints where to connect and
// nothing secret; JSON log lines go to stderr.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigFromEnv } from './config.ts';
import { createRelay } from './relay.ts';
import { attachSpikeConsole, SPIKE_CONSOLE_HELP } from './spike.ts';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  const relay = await createRelay(loadConfigFromEnv(process.env));
  const lines =
    relay.publicMcpUrl === null
      ? [
          `Tabdock relay on ${relay.url}`,
          `  MCP endpoint (bearer token from TABDOCK_DEV_TOKENS): ${relay.mcpUrl}`,
          `  Page socket for the adapter: ${relay.pageUrl}`,
        ]
      : [
          `Tabdock relay on ${relay.url}, public URL ${relay.publicUrl ?? ''}`,
          `  Connector URL (OAuth sign-in through TABDOCK_OAUTH_ISSUER): ${relay.publicMcpUrl}`,
          `  Page socket for the adapter, on this machine only: ${relay.pageUrl}`,
          ...((process.env.TABDOCK_DEV_TOKENS?.trim() ?? '') === ''
            ? []
            : [
                '  TABDOCK_DEV_TOKENS is ignored: a relay with a public URL accepts only OAuth tokens',
              ]),
        ];
  process.stdout.write(`${lines.join('\n')}\n`);
  // The spike's marker is controlled from this terminal and nowhere else (spike.ts).
  if (relay.spike) {
    process.stdout.write(`${SPIKE_CONSOLE_HELP}\n`);
    attachSpikeConsole(relay.spike, process.stdin, (line) => {
      process.stdout.write(`${line}\n`);
    });
  }
  const stop = (): void => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  // Config errors name variables, never their values, so this is safe to print.
  process.stderr.write(
    `tabdock relay: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
