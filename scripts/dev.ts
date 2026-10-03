// pnpm dev and pnpm dev:public: the relay and the demo page together, for
// working by hand. Settings come from the repo-root .env (see .env.example).
//
// pnpm dev runs on this machine with dev tokens, and refuses to start without
// TABDOCK_DEV_TOKENS, saying how to make them. pnpm dev:public (--public) runs
// public URL mode (ADR 0014) for Claude on the phone: it names every missing
// setting at once, then prints the connector URL and what to enter at the
// identity provider, never a secret. pnpm dev with TABDOCK_PUBLIC_URL set
// starts public URL mode too, since the relay reads the same .env.
// Workspace packages export their TypeScript sources, so the root package
// imports them by path rather than listing them as dependencies.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startDemoServer, type DemoServer } from '../apps/demo/scripts/server.ts';
import {
  attachSpikeConsole,
  createRelay,
  loadConfigFromEnv,
  parseOAuthUsers,
  type Relay,
  SPIKE_CONSOLE_HELP,
} from '../packages/relay/src/index.ts';
import {
  missingPublicSettings,
  missingSettingsMessage,
  providerLines,
  providerValues,
} from './public-mode.ts';

const envFile = resolve(import.meta.dirname, '../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const asked = process.argv.slice(2).includes('--public');
const command = asked ? 'pnpm dev:public' : 'pnpm dev';
const isPublic = asked || (process.env.TABDOCK_PUBLIC_URL?.trim() ?? '') !== '';

function fail(message: string): never {
  process.stderr.write(message.endsWith('\n') ? message : `${message}\n`);
  process.exit(1);
}

const demoPort = Number(process.env.DEMO_PORT?.trim() || 5173);
if (!Number.isInteger(demoPort) || demoPort < 0 || demoPort > 65_535) {
  fail(`${command}: DEMO_PORT must be an integer from 0 to 65535`);
}
// The demo server listens on 127.0.0.1, so this is the Origin its page sends.
const expectedDemoOrigin = `http://127.0.0.1:${String(demoPort)}`;

if (isPublic) {
  const missing = missingPublicSettings(process.env, expectedDemoOrigin);
  if (missing.length > 0) {
    fail(missingSettingsMessage(command, missing, process.env, expectedDemoOrigin));
  }
} else if ((process.env.TABDOCK_DEV_TOKENS?.trim() ?? '') === '') {
  fail(
    [
      'pnpm dev needs TABDOCK_DEV_TOKENS: one user=token pair per person, tokens of 24 or more random characters.',
      'Create .env from .env.example and fill it in, for example:',
      '',
      '  cp .env.example .env',
      `  node -e "console.log('TABDOCK_DEV_TOKENS=alice=' + require('node:crypto').randomBytes(24).toString('base64url'))" >> .env`,
      '',
      'Then run pnpm dev again. Keep .env to yourself; it is ignored by git.',
      'For Claude on a phone, pnpm dev:public runs the relay behind a public https URL instead.',
      '',
    ].join('\n'),
  );
}

let relay: Relay | undefined;
let demo: DemoServer | undefined;
let allowedOrigins: readonly string[] | undefined;
try {
  // Config errors name the variable at fault, never its value, so they are safe to print.
  const config = loadConfigFromEnv(process.env);
  allowedOrigins = config.allowedOrigins;
  relay = await createRelay(config);
  demo = await startDemoServer({ port: demoPort, watch: true });
} catch (error) {
  await relay?.close();
  fail(`${command}: ${error instanceof Error ? error.message : String(error)}`);
}

const demoOrigin = new URL(demo.url).origin;
if (allowedOrigins && !allowedOrigins.includes(demoOrigin)) {
  process.stderr.write(
    `${command}: TABDOCK_ALLOWED_ORIGINS does not list ${demoOrigin}, so the relay will refuse the demo board's socket.\n`,
  );
}
// Readable rather than percent-encoded; browsers read the parameter the same way.
const demoLink = `${demo.url}?relay=${relay.pageUrl}`;

function localLines(live: Relay): string[] {
  return [
    'Tabdock dev: relay and demo board',
    '',
    `  Demo board linked to the relay: ${demoLink}`,
    `  MCP endpoint:                   ${live.mcpUrl}`,
    `  Page socket:                    ${live.pageUrl}`,
    '',
    'Add the relay to Claude Code with a token from TABDOCK_DEV_TOKENS:',
    `  claude mcp add --transport http tabdock ${live.mcpUrl} --header "Authorization: Bearer <your token>"`,
    'then ask it to pair with the code in the Tabdock widget, and approve the request on the page.',
  ];
}

function publicLines(live: Relay, publicUrl: string): string[] {
  const values = providerValues(publicUrl);
  const issuer = process.env.TABDOCK_OAUTH_ISSUER?.trim() ?? '';
  // User ids and display names only: a subject at the provider is nobody else's business.
  const people = parseOAuthUsers(process.env.TABDOCK_OAUTH_USERS ?? '')
    .map((user) => `${user.userId} (${user.displayName})`)
    .join(', ');
  return [
    'Tabdock dev, public URL mode (ADR 0014): relay and demo board',
    '',
    `  Connector URL for Claude:       ${values.connectorUrl}`,
    `  QR pairing page:                ${values.pairPage}`,
    `  Demo board linked to the relay: ${demoLink}`,
    `  Relay on this machine:          ${live.url}  (point the tunnel's https address here)`,
    '',
    ...providerLines(values, issuer),
    '',
    `Accounts allowed (TABDOCK_OAUTH_USERS): ${people}`,
    `Page origins allowed (TABDOCK_ALLOWED_ORIGINS): ${(allowedOrigins ?? []).join(', ')}`,
    'Dev tokens are refused in this mode, and pages attach only from this machine.',
    '',
    'Add the connector URL in Claude as a custom connector and sign in with an allowed account.',
    'Then ask Claude to pair with the code in the Tabdock widget, or scan its QR code with the',
    'phone, sign in and tap Join; either way, approve the request on the page.',
  ];
}

const summary = relay.publicUrl === null ? localLines(relay) : publicLines(relay, relay.publicUrl);
process.stdout.write(
  [...summary, 'Relay logs follow as JSON lines; Ctrl-C stops both.', ''].join('\n'),
);

// TABDOCK_SPIKE=1: the spike's marker tool is added and removed from this terminal (ADR 0014).
if (relay.spike) {
  process.stdout.write(`${SPIKE_CONSOLE_HELP}\n\n`);
  attachSpikeConsole(relay.spike, process.stdin, (line) => {
    process.stdout.write(`${line}\n`);
  });
}

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
