// node packages/relay/src/main.ts (pnpm relay at the root): starts the relay
// from the environment, after loading the repo-root .env when there is one.
// With no settings at all it runs local mode (ADR 0022). Prints where to
// connect and nothing secret: in local mode the owner token's path and a
// command that reads it, never the token. JSON log lines go to stderr.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfigFromEnv } from './config.ts';
import { localModeLines, shellFor } from './local-banner.ts';
import { createRelay } from './relay.ts';
import { attachSpikeConsole, SPIKE_CONSOLE_HELP } from './spike.ts';

const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

try {
  const options = loadConfigFromEnv(process.env);
  const relay = await createRelay(options);
  // Before the banner, so whoever reads it (a test, a supervisor) knows a
  // SIGTERM from then on closes the relay and its audit log cleanly.
  const stop = (): void => {
    relay.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const local = options.localMode;
  const lines =
    relay.publicMcpUrl !== null
      ? [
          `Tabdock relay on ${relay.url}, public URL ${relay.publicUrl ?? ''}`,
          `  Connector URL (OAuth sign-in through TABDOCK_OAUTH_ISSUER): ${relay.publicMcpUrl}`,
          `  QR pairing page, signing phones in with TABDOCK_PAIR_CLIENT_ID: ${relay.publicUrl ?? ''}/pair`,
          // Hosted mode takes pages through the edge (ADR 0018); a tunnelled relay only from this machine.
          options.clientAddressHeader === undefined
            ? `  Page socket for the adapter, on this machine only: ${relay.pageUrl}`
            : `  Page socket for the adapter, through the host edge: ${(relay.publicUrl ?? '').replace(/^https:/, 'wss:')}/page`,
          ...((process.env.TABDOCK_DEV_TOKENS?.trim() ?? '') === ''
            ? []
            : [
                '  TABDOCK_DEV_TOKENS is ignored: a relay with a public URL accepts only OAuth tokens',
              ]),
        ]
      : local !== undefined
        ? [
            `Tabdock relay on ${relay.url}`,
            ...localModeLines({
              mcpUrl: relay.mcpUrl,
              pageUrl: relay.pageUrl,
              tokenPath: local.tokenPath,
              created: local.created,
              shell: shellFor(process.platform),
            }),
          ]
        : [
            `Tabdock relay on ${relay.url}`,
            `  MCP endpoint (bearer token from TABDOCK_DEV_TOKENS): ${relay.mcpUrl}`,
            `  Page socket for the adapter: ${relay.pageUrl}`,
          ];
  process.stdout.write(`${lines.join('\n')}\n`);
  // The spike's marker is controlled from this terminal and nowhere else (spike.ts).
  if (relay.spike) {
    process.stdout.write(`${SPIKE_CONSOLE_HELP}\n`);
    attachSpikeConsole(relay.spike, process.stdin, (line) => {
      process.stdout.write(`${line}\n`);
    });
  }
} catch (error) {
  // Config and owner token errors name variables and paths, never their secrets, so this is safe to print.
  process.stderr.write(
    `tabdock relay: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
