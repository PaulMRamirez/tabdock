// pnpm dev: the relay and the demo page together, for working by hand.
// Settings come from the repo-root .env (see .env.example); the relay refuses
// to start without TABDOCK_DEV_TOKENS, and this script says how to make them.
// Workspace packages export their TypeScript sources, so the root package
// imports them by path rather than listing them as dependencies.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDemoServer, type DemoServer } from '../apps/demo/scripts/server.ts';
import { createRelay, loadConfigFromEnv, type Relay } from '../packages/relay/src/index.ts';

const envFile = resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

if ((process.env.TABDOCK_DEV_TOKENS?.trim() ?? '') === '') {
  process.stderr.write(
    [
      'pnpm dev needs TABDOCK_DEV_TOKENS: one user=token pair per person, tokens of 24 or more random characters.',
      'Create .env from .env.example and fill it in, for example:',
      '',
      '  cp .env.example .env',
      `  node -e "console.log('TABDOCK_DEV_TOKENS=alice=' + require('node:crypto').randomBytes(24).toString('base64url'))" >> .env`,
      '',
      'Then run pnpm dev again. Keep .env to yourself; it is ignored by git.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

let relay: Relay | undefined;
let demo: DemoServer | undefined;
let allowedOrigins: readonly string[] | undefined;
try {
  const demoPort = Number(process.env.DEMO_PORT?.trim() || 5173);
  if (!Number.isInteger(demoPort) || demoPort < 0 || demoPort > 65_535) {
    throw new Error('DEMO_PORT must be an integer from 0 to 65535');
  }
  // Config errors name the variable at fault, never its value, so they are safe to print.
  const config = loadConfigFromEnv(process.env);
  allowedOrigins = config.allowedOrigins;
  relay = await createRelay(config);
  demo = await startDemoServer({ port: demoPort, watch: true });
} catch (error) {
  process.stderr.write(`pnpm dev: ${error instanceof Error ? error.message : String(error)}\n`);
  await relay?.close();
  process.exit(1);
}

const demoOrigin = new URL(demo.url).origin;
if (allowedOrigins && !allowedOrigins.includes(demoOrigin)) {
  process.stderr.write(
    `pnpm dev: TABDOCK_ALLOWED_ORIGINS does not list ${demoOrigin}, so the relay will refuse the demo board's socket.\n`,
  );
}
// Readable rather than percent-encoded; browsers read the parameter the same way.
const demoLink = `${demo.url}?relay=${relay.pageUrl}`;
process.stdout.write(
  [
    'Tabdock dev: relay and demo board',
    '',
    `  Demo board linked to the relay: ${demoLink}`,
    `  MCP endpoint:                   ${relay.mcpUrl}`,
    `  Page socket:                    ${relay.pageUrl}`,
    '',
    'Add the relay to Claude Code with a token from TABDOCK_DEV_TOKENS:',
    `  claude mcp add --transport http tabdock ${relay.mcpUrl} --header "Authorization: Bearer <your token>"`,
    'then ask it to pair with the code the board shows, and approve the request on the page.',
    'Relay logs follow as JSON lines; Ctrl-C stops both.',
    '',
  ].join('\n'),
);

const running = { relay, demo };
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  Promise.all([running.relay.close(), running.demo.close()]).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
