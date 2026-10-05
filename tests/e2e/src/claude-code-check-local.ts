// A4.4 with the real Claude Code CLI, headless, spending no model calls:
//   pnpm --filter @tabdock/e2e check:claude-code:local
// Needs `claude` on the PATH; without it the check skips and says so, since
// Claude Code is not a repo dependency, and docs/checklists/M4.md keeps the
// run by hand.
//
// `pnpm relay` starts here as the owner starts it, with no settings but a
// throwaway TABDOCK_HOME whose path holds a space and a quote. The `claude mcp
// add-json` line it prints (ADR 0028) runs through sh -c exactly as printed,
// in a throwaway HOME so the owner's own Claude Code configuration is never
// read or changed, until `claude mcp list` shows the relay connected through
// the header helper; Claude Code's configuration must then hold the helper
// and no token, and `claude mcp get`, safe now, must print none. Then the
// rotation the docs describe: stop the relay, start it with --new-token, and
// see the same entry connect with the new token, the old one refused. Every
// line the relay and Claude Code print, and the configuration file, is checked
// against both tokens, which this script reads only to compare and never
// prints.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { freePort } from './harness.ts';
import { blankEnv, listsConnected, readBanner, type Run, runPnpm } from './local-harness.ts';

const SERVER = 'tabdock-local';
const say = (text: string): void => {
  console.log(text);
};

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error !== undefined || version.status !== 0) {
  say(
    'check:claude-code:local skipped: no `claude` on the PATH. Claude Code is not a repo dependency, so docs/checklists/M4.md keeps this check for a run by hand: pnpm relay, paste the printed claude mcp add-json line, then claude mcp list.',
  );
  process.exit(0);
}

interface Ran {
  code: number | null;
  output: string;
}

/** Runs a command line through sh -c, or claude itself, and returns everything it printed. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: stripVTControlCharacters(output) });
    });
  });
}

const dir = await mkdtemp(join(tmpdir(), 'tabdock-cc-local-'));
const home = join(dir, 'home');
const work = join(dir, 'work');
const tabdockHome = join(dir, "owner's tabdock");
const tokens: string[] = [];
const printed: string[] = [];
const relays: Run[] = [];
let passed = false;

/** Keeps what was printed for the final scan, and shows it unless it holds a token. */
function show(prefix: string, text: string): void {
  printed.push(text);
  for (const line of text.split('\n').filter((l) => l.trim() !== '')) {
    const leaked = tokens.some((token) => leakIn(line, token) !== null);
    say(`${prefix}${leaked ? '[withheld: this line held the token]' : line.trim()}`);
  }
}

/** The tabdock-local line of claude mcp list, polled until `want` matches it or time runs out. */
async function listUntil(env: NodeJS.ProcessEnv, want: (line: string) => boolean): Promise<string> {
  const deadline = Date.now() + 30_000;
  let line = '';
  while (Date.now() < deadline) {
    const listed = await run('claude', ['mcp', 'list'], work, env);
    printed.push(listed.output);
    line =
      listed.output
        .split('\n')
        .find((l) => l.includes(SERVER))
        ?.trim() ?? '(no line for the server)';
    if (want(line)) return line;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return line;
}

try {
  say(`Claude Code ${version.stdout.trim()}`);
  await mkdir(home);
  await mkdir(work);
  const port = await freePort();
  const relayEnv = { ...blankEnv(), TABDOCK_HOME: tabdockHome, TABDOCK_PORT: String(port) };
  // Only what Claude Code needs, and a home of its own.
  const claudeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };

  say('\n1. pnpm relay with no settings, TABDOCK_HOME holding a space and a quote:');
  const first = runPnpm(['relay'], relayEnv);
  relays.push(first);
  await first.waitFor('claude mcp list');
  const banner = readBanner(first.stdout());
  const token = (await readFile(banner.tokenPath, 'latin1')).trim();
  tokens.push(token);
  show('   | ', first.stdout().slice(first.stdout().indexOf('Local mode')));

  say('\n2. The printed line, through sh -c, then claude mcp list:');
  const usesHelper = banner.command.startsWith('claude mcp add-json ');
  say(
    `   the line is ${usesHelper ? 'claude mcp add-json with the header helper' : 'NOT add-json'}`,
  );
  const added = await run('sh', ['-c', banner.command], work, claudeEnv);
  show('   add: ', `exit ${String(added.code)}; ${added.output}`);
  const line = await listUntil(claudeEnv, listsConnected);
  say(`   list: ${line}`);
  const configText = await readFile(join(home, '.claude.json'), 'utf8');
  printed.push(configText);
  const config = JSON.parse(configText) as {
    mcpServers?: Record<
      string,
      { type?: string; url?: string; headers?: Record<string, string>; headersHelper?: string }
    >;
  };
  const entry = config.mcpServers?.[SERVER];
  const helper = join(tabdockHome, 'claude-headers');
  const throughHelper = entry?.headersHelper === `"${helper}"` && entry.headers === undefined;
  const mode = (await stat(join(home, '.claude.json'))).mode & 0o777;
  say(
    `   ~/.claude.json (mode ${mode.toString(8)}): user scope ${entry ? 'holds' : 'lacks'} ${SERVER} at ${entry?.url ?? '(none)'}, ${throughHelper ? 'with the header helper and no stored header' : 'WITHOUT the helper, or with a stored header'}`,
  );
  // With no stored header, claude mcp get has nothing secret to print.
  const got = await run('claude', ['mcp', 'get', SERVER], work, claudeEnv);
  show('   get: ', `exit ${String(got.code)}; ${got.output}`);
  const firstOk =
    usesHelper &&
    added.code === 0 &&
    listsConnected(line) &&
    throughHelper &&
    entry.url === banner.mcpUrl &&
    got.code === 0;

  say('\n3. Rotation: stop the relay and start it with --new-token on the same port:');
  await first.stop();
  const second = runPnpm(['relay', '--new-token'], relayEnv);
  relays.push(second);
  await second.waitFor('claude mcp list');
  const rotated = readBanner(second.stdout());
  const newToken = (await readFile(rotated.tokenPath, 'latin1')).trim();
  tokens.push(newToken);
  say(
    `   the relay says the token was ${rotated.created ? 'created just now' : 'KEPT, which is wrong'}`,
  );
  // The same entry, untouched, now sends the new token through the helper.
  const fresh = await listUntil(claudeEnv, listsConnected);
  say(`   list with the same entry: ${fresh}`);
  const oldRefused =
    (
      await fetch(rotated.mcpUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    ).status === 401;
  say(`   the old token ${oldRefused ? 'gets 401' : 'is NOT refused'}`);
  printed.push(await readFile(join(home, '.claude.json'), 'utf8'));
  await second.stop();
  const rotationOk = rotated.created && newToken !== token && listsConnected(fresh) && oldRefused;

  const everything = [...relays.flatMap((r) => [r.stdout(), r.stderr()]), ...printed].join('\n');
  const leaks = tokens
    .map((t) => leakIn(everything, t))
    .filter((leak): leak is string => leak !== null);
  say(
    leaks.length === 0
      ? "\nNo line the relay or Claude Code printed, and nothing in Claude Code's configuration, holds either token, its digest or any 8 characters of it."
      : `\nA printed line or Claude Code's configuration held ${leaks.join(', ')}.`,
  );
  passed = firstOk && rotationOk && leaks.length === 0;
  say(
    passed
      ? "\nA4.4 Claude Code PASS: the add-json line pnpm relay printed added the local relay through its header helper, claude mcp list showed it connected, Claude Code's configuration holds no token, and --new-token rotated it with the entry unchanged."
      : '\nA4.4 Claude Code FAIL: the output above says where it stopped.',
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  say(
    `check:claude-code:local stopped: ${tokens.some((t) => leakIn(message, t) !== null) ? '[withheld]' : message}`,
  );
} finally {
  for (const relay of relays) await relay.stop();
  await rm(dir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
