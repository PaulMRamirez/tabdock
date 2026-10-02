// node packages/relay/src/main.ts: starts the relay from the environment, after
// loading the repo-root .env when there is one. Prints where to connect and
// nothing secret; JSON log lines go to stderr.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigFromEnv } from './config.ts';
import { createRelay } from './relay.ts';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  const relay = await createRelay(loadConfigFromEnv(process.env));
  process.stdout.write(
    [
      `Tabdock relay on ${relay.url}`,
      `  MCP endpoint (bearer token from TABDOCK_DEV_TOKENS): ${relay.mcpUrl}`,
      `  Page socket for the adapter: ${relay.pageUrl}`,
      '',
    ].join('\n'),
  );
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
