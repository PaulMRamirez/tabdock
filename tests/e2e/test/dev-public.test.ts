// pnpm dev:public (scripts/dev.ts --public): it names every missing setting at
// once, and with them all in place it starts the relay in public URL mode and
// the demo board, printing the connector URL and what the owner enters at the
// provider, and never a secret, a client id or a subject. Run as a child
// process, the way the owner runs it, against the stand-in provider.

import { type ChildProcess, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAIR_CLIENT, startProvider, type TestProvider } from '@tabdock/relay/test/provider';
import { rawRequest } from '@tabdock/relay/test/tunnel';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SCRIPT = fileURLToPath(new URL('../../../scripts/dev.ts', import.meta.url));
const PUBLIC_URL = 'https://tabdock-owner.example';
const SUBJECT = 'user_01SUBJECTOFALICE';

/**
 * Every setting .env.example names, blank, so an .env on this machine (which
 * the script loads, but which never overrides a variable already set) cannot
 * change what a test sees.
 */
function blankEnv(): NodeJS.ProcessEnv {
  const names = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8')
    .split('\n')
    .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith('TABDOCK_') && name !== 'DEMO_PORT') env[name] = value;
  }
  for (const name of names) env[name] = '';
  return env;
}

interface Run {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function run(env: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, [SCRIPT, '--public'], {
    cwd: ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      resolve(code);
    });
  });
  return { child, stdout: () => out, stderr: () => err, exited };
}

let provider: TestProvider | undefined;
let running: Run | undefined;

afterEach(async () => {
  if (running && running.child.exitCode === null) {
    running.child.kill('SIGTERM');
    await running.exited;
  }
  running = undefined;
  await provider?.stop();
  provider = undefined;
});

describe('pnpm dev:public', () => {
  it('names every missing setting at once and starts nothing', async () => {
    const env = { ...blankEnv(), TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret };
    running = run(env);
    expect(await running.exited).toBe(1);
    const said = running.stderr();
    for (const name of [
      'TABDOCK_PUBLIC_URL',
      'TABDOCK_OAUTH_ISSUER',
      'TABDOCK_OAUTH_USERS',
      'TABDOCK_PAIR_CLIENT_ID',
      'TABDOCK_ALLOWED_ORIGINS',
    ]) {
      expect(said).toContain(name);
    }
    // Set, so not named as missing, and its value never shown.
    expect(said).not.toContain('TABDOCK_PAIR_CLIENT_SECRET ');
    expect(said).not.toContain(PAIR_CLIENT.clientSecret);
    expect(running.stdout()).toBe('');
  });

  it('with only the public URL, already says what to register at the provider', async () => {
    running = run({ ...blankEnv(), TABDOCK_PUBLIC_URL: PUBLIC_URL });
    expect(await running.exited).toBe(1);
    const said = running.stderr();
    expect(said).toContain(
      `Resource Indicator (the audience of access tokens):  ${PUBLIC_URL}/mcp`,
    );
    expect(said).toContain(
      `Redirect URI of the /pair client:                    ${PUBLIC_URL}/pair/callback`,
    );
    expect(said).not.toMatch(/^\s+TABDOCK_PUBLIC_URL\s/m);
  });

  it('refuses a public URL that is not https, quoting the rule and not the value', async () => {
    running = run({ ...blankEnv(), TABDOCK_PUBLIC_URL: 'http://tabdock-owner.example' });
    expect(await running.exited).toBe(1);
    expect(running.stderr()).toMatch(/TABDOCK_PUBLIC_URL\) must be an https URL/);
    expect(running.stderr()).not.toContain('tabdock-owner.example');
  });

  it('starts relay and demo in public URL mode and prints the connector and provider values, never a secret', async () => {
    provider = await startProvider();
    const env = {
      ...blankEnv(),
      TABDOCK_PORT: '0',
      DEMO_PORT: '0',
      TABDOCK_PUBLIC_URL: PUBLIC_URL,
      TABDOCK_OAUTH_ISSUER: provider.issuer,
      TABDOCK_OAUTH_USERS: `${SUBJECT}=alice:Alice`,
      TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
      TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
      TABDOCK_ALLOWED_ORIGINS: 'http://127.0.0.1:5173',
    };
    const started = run(env);
    running = started;
    const deadline = Date.now() + 30_000;
    while (!started.stdout().includes('Relay logs follow')) {
      if (started.child.exitCode !== null || Date.now() > deadline) {
        throw new Error(`dev:public did not start: ${started.stderr()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const printed = started.stdout();
    expect(printed).toContain('public URL mode');
    expect(printed).toContain(`Connector URL for Claude:       ${PUBLIC_URL}/mcp`);
    expect(printed).toContain(`QR pairing page:                ${PUBLIC_URL}/pair`);
    expect(printed).toContain(`At your identity provider (${provider.issuer}), enter:`);
    expect(printed).toContain(`${PUBLIC_URL}/pair/callback`);
    expect(printed).toMatch(/Relay on this machine: +http:\/\/127\.0\.0\.1:\d+ /);
    expect(printed).toContain('Accounts allowed (TABDOCK_OAUTH_USERS): alice (Alice)');
    expect(printed).toContain(
      'Page origins allowed (TABDOCK_ALLOWED_ORIGINS): http://127.0.0.1:5173',
    );
    for (const secret of [PAIR_CLIENT.clientSecret, PAIR_CLIENT.clientId, SUBJECT]) {
      expect(printed).not.toContain(secret);
      expect(started.stderr()).not.toContain(secret);
    }
    // The relay really is public: an unsigned request to /mcp through the public host is challenged.
    const relayUrl = /Relay on this machine: +(http:\/\/127\.0\.0\.1:\d+)/.exec(printed)?.[1] ?? '';
    const challenged = await rawRequest(relayUrl, '/mcp', {
      method: 'POST',
      host: new URL(PUBLIC_URL).host,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: '{}',
    });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toContain(
      `resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource/mcp"`,
    );
    started.child.kill('SIGTERM');
    expect(await started.exited).toBe(0);
  });
});
