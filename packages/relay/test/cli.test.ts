// The relay as a command (ADR 0028): which arguments it takes and how it
// refuses the rest, so a mistyped flag never starts a relay and a refusal
// never repeats an argument that may be a secret; the usage naming the
// command it runs under; the version from package.json; the .env rule, which
// the package never reads; the worker file the bundle names; and
// `--new-token`, which draws a token without reading the old file, replaces it
// only once the relay holds the token directory's lock and listens, whatever
// audit directory or port a relay already running beside it uses, and is
// refused by name outside local mode. The bundle itself is checked by the pack-install
// job (packages/relay/scripts/pack-install.ts), since PACKAGED is true only
// there.

import { mkdtempSync, readFileSync, realpathSync, rmSync, existsSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { workerEntry } from '../src/argument-checker.ts';
import { AUDIT_LOCK_NAME } from '../src/audit-file.ts';
import {
  checkoutEnvFile,
  type CommandContext,
  packageVersion,
  parseCommand,
  refusalText,
  relayUsage,
  runCommand,
  startRelay,
} from '../src/cli.ts';
import { headersHelperPath, OWNER_TOKEN_FILE } from '../src/local-token.ts';
import { PACKAGED } from '../src/packaged.ts';
import { TOKEN_LOCK_FILE } from '../src/token-lock.ts';
import type { Relay } from '../src/relay.ts';
import { startMain } from './helpers/main-process.ts';
import { leakIn } from './helpers/secrecy.ts';
import { rawRequest } from './helpers/tunnel.ts';

const POSIX = process.platform !== 'win32';
const ROOT = resolve(import.meta.dirname, '../../..');

const scratches: string[] = [];
const relays: Relay[] = [];
afterEach(async () => {
  for (const relay of relays.splice(0)) await relay.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-cli-')));
  scratches.push(dir);
  return join(dir, 'tabdock home');
}

/** A context that keeps what the command prints, with only the environment given. */
function context(
  env: NodeJS.ProcessEnv,
  packaged = false,
): CommandContext & { printed: string[]; errors: string[] } {
  const printed: string[] = [];
  const errors: string[] = [];
  return {
    packaged,
    env: { TABDOCK_PORT: '0', ...env },
    platform: process.platform,
    out: (line) => printed.push(line),
    err: (line) => errors.push(line),
    printed,
    errors,
  };
}

async function mcpStatus(mcpUrl: string, token: string): Promise<number> {
  const url = new URL(mcpUrl);
  const answer = await rawRequest(url.origin, url.pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return answer.status;
}

async function toolCount(mcpUrl: string, token: string): Promise<number> {
  const client = new Client({ name: 'cli-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

describe('the arguments', () => {
  it('takes nothing, --new-token, audit with its own options, --version and --help', () => {
    expect(parseCommand([])).toEqual({ kind: 'start', newToken: false });
    expect(parseCommand(['--new-token'])).toEqual({ kind: 'start', newToken: true });
    expect(parseCommand(['audit'])).toEqual({ kind: 'audit', args: [] });
    expect(parseCommand(['audit', '--verify', '--dir', '/x'])).toEqual({
      kind: 'audit',
      args: ['--verify', '--dir', '/x'],
    });
    for (const flag of ['--version', '-v'])
      expect(parseCommand([flag])).toEqual({ kind: 'version' });
    for (const flag of ['--help', '-h']) expect(parseCommand([flag])).toEqual({ kind: 'help' });
  });

  it('refuses anything else, naming a flag by its name and anything else only by its place', () => {
    const cases: [string[], string][] = [
      [['--new-tokn'], 'the option --new-tokn is not one this command takes'],
      [['--newtoken'], 'the option --newtoken is not one this command takes'],
      [['new-token'], 'argument 1 is not one this command takes'],
      [['start'], 'argument 1 is not one this command takes'],
      [
        ['--new-token', '--new-token'],
        '--new-token takes nothing after it, and the option --new-token is not one this command takes',
      ],
      [
        ['--version', 'now'],
        '--version takes nothing after it, and argument 2 is not one this command takes',
      ],
      [['Audit'], 'argument 1 is not one this command takes'],
      [[''], 'argument 1 is not one this command takes'],
    ];
    for (const [argv, reason] of cases) {
      expect(parseCommand(argv), JSON.stringify(argv)).toEqual({ kind: 'refused', reason });
    }
  });

  it('never repeats an argument that could be a secret pasted in the wrong place', () => {
    const token = `tabdock_${'s3cr3t'.repeat(7)}x`;
    for (const argv of [
      [token],
      ['--new-token', token],
      [`--header=Bearer ${token}`],
      ['-H', token],
    ]) {
      const parsed = parseCommand(argv);
      expect(parsed.kind).toBe('refused');
      expect(leakIn(JSON.stringify(parsed), token), JSON.stringify(argv.length)).toBeNull();
    }
  });

  it('answers a refusal with the usage and exit code 2, and starts nothing', async () => {
    const home = freshHome();
    const ran = context({ TABDOCK_HOME: home }, true);
    expect(await runCommand(['--new-tokn'], ran)).toBe(2);
    expect(ran.errors[0]).toBe(
      'tabdock-relay: the option --new-tokn is not one this command takes',
    );
    expect(ran.errors[1]).toBe(relayUsage(true));
    expect(ran.printed).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });
});

describe('what a refused start prints', () => {
  it("prints a node file error's call and code alone, since its message quotes a path a setting may have given", () => {
    const token = `tabdock_${'s3cr3t'.repeat(7)}x`;
    const path = `/${token}/audit/audit-2026-10-06-000000000001.jsonl`;
    const node = Object.assign(new Error(`EPERM: operation not permitted, open '${path}'`), {
      code: 'EPERM',
      syscall: 'open',
      path,
    });
    expect(refusalText(node)).toBe('open failed on a path the relay was given (EPERM)');
    const renamed = Object.assign(new Error(`EXDEV: cross-device link, rename 'a' -> '${path}'`), {
      code: 'EXDEV',
      syscall: 'rename',
      dest: path,
    });
    expect(refusalText(renamed)).toBe('rename failed on a path the relay was given (EXDEV)');
    // The relay's own refusals, which name settings and never their values, print as they are.
    expect(refusalText(new Error('TABDOCK_PORT must be a whole number'))).toBe(
      'TABDOCK_PORT must be a whole number',
    );
    expect(refusalText(token)).not.toContain(token);
  });
});

describe('the usage, the version and the audit subcommand', () => {
  it('names the command it runs under, and says where settings come from', () => {
    const packaged = relayUsage(true);
    expect(packaged.split('\n').slice(0, 3)).toEqual([
      'Usage: tabdock-relay [--new-token]',
      '       tabdock-relay audit [options]',
      '       tabdock-relay --version | --help',
    ]);
    expect(packaged).toContain('Settings come from the environment alone; no .env file is read.');
    expect(packaged).toContain('for its options:\n                tabdock-relay audit --help');
    const checkout = relayUsage(false);
    expect(checkout.split('\n')[0]).toBe('Usage: pnpm relay [--new-token]');
    expect(checkout).toContain("the checkout's .env");
    expect(checkout).toContain('                pnpm audit:log --help');
    for (const usage of [packaged, checkout]) {
      expect(
        usage.split('\n').every((line) => line.length <= 80),
        usage,
      ).toBe(true);
    }
  });

  it('prints the version in the package.json beside the code, and the usage for --help', async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { version: string };
    expect(packageVersion()).toBe(manifest.version);
    const version = context({});
    expect(await runCommand(['--version'], version)).toBe(0);
    expect(version.printed).toEqual([manifest.version]);
    const help = context({}, true);
    expect(await runCommand(['--help'], help)).toBe(0);
    expect(help.printed).toEqual([relayUsage(true)]);
  });

  it('runs the audit reader under its own name, with its options', async () => {
    const packaged = context({}, true);
    expect(await runCommand(['audit', '--help'], packaged)).toBe(0);
    expect(packaged.printed[0]?.split('\n')[0]).toBe('Usage: tabdock-relay audit [options]');
    const checkout = context({});
    expect(await runCommand(['audit', '--nope'], checkout)).toBe(2);
    expect(checkout.errors.join('\n')).toContain('Usage: pnpm audit:log [options]');
  });

  it('never repeats a token pasted after audit, as the rest of the command never does', async () => {
    const token = `tabdock_${'s3cr3t'.repeat(7)}x`;
    for (const argv of [
      ['audit', token],
      ['audit', `--${token}`],
      ['audit', '--verify', `--header=Bearer ${token}`],
    ]) {
      const ran = context({}, true);
      expect(await runCommand(argv, ran)).toBe(2);
      expect(ran.errors[0]).toMatch(/^argument \d is not one this reader takes/);
      expect(leakIn([...ran.printed, ...ran.errors].join('\n'), token)).toBeNull();
    }
  });
});

describe('what only the package does differently (ADR 0028)', () => {
  it('reads no .env file from the package, and the root .env from a checkout', () => {
    expect(checkoutEnvFile(true)).toBeNull();
    expect(checkoutEnvFile(false)).toBe(join(ROOT, '.env'));
    // These sources are a checkout's: only the bundle's build defines PACKAGED.
    expect(PACKAGED).toBe(false);
  });

  it('names the bundle’s worker file beside cli.js, and the source in a checkout', () => {
    const bundle = 'file:///opt/node_modules/@tabdock/relay/dist/cli.js';
    expect(workerEntry(true, bundle).href).toBe(
      'file:///opt/node_modules/@tabdock/relay/dist/argument-worker.js',
    );
    expect(workerEntry(false).href).toBe(
      new URL('../src/argument-worker.ts', import.meta.url).href,
    );
    expect(existsSync(workerEntry(false))).toBe(true);
  });
});

describe('--new-token (ADR 0028)', () => {
  it('replaces the token: the old one gets 401, the new one gets in, and the banner says so', async () => {
    const home = freshHome();
    const first = await startRelay(context({ TABDOCK_HOME: home }), { newToken: false });
    relays.push(first.relay);
    const tokenPath = join(home, OWNER_TOKEN_FILE);
    const old = readFileSync(tokenPath, 'latin1').trim();
    await first.relay.close();
    relays.length = 0;

    const second = await startRelay(context({ TABDOCK_HOME: home }), { newToken: true });
    relays.push(second.relay);
    const fresh = readFileSync(tokenPath, 'latin1').trim();
    expect(fresh === old).toBe(false);
    expect(/^tabdock_[A-Za-z0-9_-]{43}$/.test(fresh)).toBe(true);
    expect(await mcpStatus(second.relay.mcpUrl, old)).toBe(401);
    expect(await toolCount(second.relay.mcpUrl, fresh)).toBe(5);
    const text = second.lines.join('\n');
    expect(text).toContain(`Owner token:   ${tokenPath} (created just now)`);
    expect(text).toContain(
      POSIX ? "Claude Code's entry needs no change" : "replace Claude Code's entry",
    );
    expect(leakIn(text, fresh)).toBeNull();
    expect(leakIn(text, old)).toBeNull();
    if (POSIX) expect(existsSync(headersHelperPath(tokenPath))).toBe(true);
  }, 30_000);

  it('is refused by name outside local mode, before anything starts or is drawn', async () => {
    const home = freshHome();
    for (const env of [
      { TABDOCK_DEV_TOKENS: 'alice=alice-dev-token-6b1f0c9e4d2a7358' },
      { TABDOCK_ENV: 'production', TABDOCK_DEV_TOKENS: 'alice=alice-dev-token-6b1f0c9e4d2a7358' },
    ]) {
      const ran = context({ TABDOCK_HOME: home, ...env });
      expect(await runCommand(['--new-token'], ran)).toBe(1);
      expect(ran.errors.join('\n')).toMatch(
        /--new-token replaces local mode's owner token, and this relay is not in local mode/,
      );
      expect(ran.printed).toEqual([]);
    }
    expect(existsSync(home)).toBe(false);
  });

  it('beside a running relay that shares the directory, refuses on the audit lock and leaves the token as it was', async () => {
    const home = freshHome();
    const running = startMain({ TABDOCK_HOME: home });
    try {
      await running.port;
      const tokenPath = join(home, OWNER_TOKEN_FILE);
      const before = readFileSync(tokenPath);
      expect(existsSync(join(home, 'audit', AUDIT_LOCK_NAME))).toBe(true);
      const ran = context({ TABDOCK_HOME: home });
      expect(await runCommand(['--new-token'], ran)).toBe(1);
      expect(ran.errors.join('\n')).toMatch(/is in use by another relay/);
      expect(readFileSync(tokenPath).equals(before)).toBe(true);
      expect(ran.printed).toEqual([]);
    } finally {
      running.child.kill('SIGTERM');
      await running.exited;
    }
  }, 30_000);

  // The audit lock guards only relays that also share the audit directory, so
  // the token directory holds a lock of its own (ADR 0028's notes): a relay
  // left serving the old token after a rotation would keep it valid.
  for (const [where, port] of [
    ['on the same port', 'running'],
    ['on another port', '0'],
  ] as const) {
    it(`beside a running relay with its own audit directory ${where}, refuses on the token directory's lock and changes nothing`, async () => {
      const home = freshHome();
      const running = startMain({
        TABDOCK_HOME: home,
        TABDOCK_AUDIT_DIR: join(home, '..', 'audit elsewhere'),
      });
      try {
        const runningPort = await running.port;
        const tokenPath = join(home, OWNER_TOKEN_FILE);
        const before = readFileSync(tokenPath);
        const old = before.toString('latin1').trim();
        expect(existsSync(join(home, TOKEN_LOCK_FILE))).toBe(true);
        for (const argv of [['--new-token'], []]) {
          const ran = context({
            TABDOCK_HOME: home,
            TABDOCK_PORT: port === 'running' ? String(runningPort) : port,
          });
          expect(await runCommand(argv, ran)).toBe(1);
          // Named from TABDOCK_HOME, which gave the directory, never spelled out.
          expect(ran.errors.join('\n')).toMatch(
            /token directory, the path TABDOCK_HOME gives, is in use by another relay, pid \d+, which holds owner-token\.lock in the path TABDOCK_HOME gives; stop that relay first/,
          );
          expect(ran.errors.join('\n')).not.toContain(home);
          expect(readFileSync(tokenPath).equals(before)).toBe(true);
          expect(ran.printed).toEqual([]);
        }
        expect(await toolCount(`http://127.0.0.1:${String(runningPort)}/mcp`, old)).toBe(5);
      } finally {
        running.child.kill('SIGTERM');
        await running.exited;
      }
      // The lock goes with the relay, and the next start may rotate.
      expect(existsSync(join(home, TOKEN_LOCK_FILE))).toBe(false);
      const after = await startRelay(context({ TABDOCK_HOME: home }), { newToken: true });
      relays.push(after.relay);
    }, 30_000);
  }

  it('changes nothing when the start fails before it listens, on a port another program holds', async () => {
    const home = freshHome();
    const first = await startRelay(context({ TABDOCK_HOME: home }), { newToken: false });
    await first.relay.close();
    const tokenPath = join(home, OWNER_TOKEN_FILE);
    const before = readFileSync(tokenPath);
    const holder = createServer();
    await new Promise<void>((resolveListen) => holder.listen(0, '127.0.0.1', resolveListen));
    try {
      const { port } = holder.address() as AddressInfo;
      const ran = context({ TABDOCK_HOME: home, TABDOCK_PORT: String(port) });
      expect(await runCommand(['--new-token'], ran)).toBe(1);
      expect(ran.errors.join('\n')).toMatch(/EADDRINUSE/);
      expect(readFileSync(tokenPath).equals(before)).toBe(true);
      expect(existsSync(join(home, TOKEN_LOCK_FILE))).toBe(false);
    } finally {
      await new Promise((resolveClose) => holder.close(resolveClose));
    }
  }, 30_000);

  it('beside a relay of its own process that shares the directory, refuses the same way', async () => {
    const home = freshHome();
    const first = await startRelay(context({ TABDOCK_HOME: home }), { newToken: false });
    relays.push(first.relay);
    const tokenPath = join(home, OWNER_TOKEN_FILE);
    const before = readFileSync(tokenPath);
    await expect(startRelay(context({ TABDOCK_HOME: home }), { newToken: true })).rejects.toThrow(
      /audit directory .* is already open in this process/,
    );
    expect(readFileSync(tokenPath).equals(before)).toBe(true);
  }, 30_000);
});
