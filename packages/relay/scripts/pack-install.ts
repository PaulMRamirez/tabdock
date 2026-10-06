// A5.5's pack-install check (ADRs 0028 and 0031), run in CI on Node 22.18
// and on .nvmrc's Node after release-pack.ts and release-check.ts:
//   node packages/relay/scripts/pack-install.ts [<dir of tarballs>]
//
// The packaged mark exists only in the bundle, where unit tests on the
// sources never run, so this runs the packed relay the way a person would get
// it: `npx --yes @tabdock/relay@<version>` with a fresh npm cache, through
// local-registry.ts, which serves the three tarballs as the npm registry will
// once they are published, `_hasShrinkwrap` and all, and sends every other
// request to the real registry. npm then installs the relay's dependencies
// from its npm-shrinkwrap.json alone, as it does for an install from npm, so a
// package the shrinkwrap leaves out fails here as it would for everyone (ADR
// 0028's notes); an install from local tarballs never takes that path. It
// checks npx printed the version and that every package the shrinkwrap pins
// is installed at its version. Then it runs the installed `tabdock-relay`
// from inside a git work tree, with nothing in its environment but PATH, a
// HOME and a TABDOCK_HOME in a scratch directory. Each .env a relay could find
// (the work tree's, the install's, and the one a checkout's relative path
// would name from the bundle) sets dev tokens and a port, so reading any of
// them would leave local mode or fail. It checks: the token file 0600 outside
// the work tree; a TABDOCK_HOME inside the work tree refused, nothing made
// there; no .env read; claude-headers 0700 and holding no token; an MCP
// client connecting with exactly the header the banner's add-json line makes
// the helper print; the argument worker starting, from the relay and on its
// own; --new-token; --version, --help, a refused argument and the audit
// subcommand; and the published types and modules, installed from the same
// registry, loading in a consumer. Nothing printed may hold a token. It
// prints what it checked and exits 1 on any failure.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { privateTempRoot } from '../test/helpers/private-tmp.ts';
import { leakIn } from '../test/helpers/secrecy.ts';
import { type LocalRegistry, npmEnvFor, runAsync, startLocalRegistry } from './local-registry.ts';

const ROOT = resolve(import.meta.dirname, '../../..');
const TARBALLS = resolve(process.argv[2] ?? join(ROOT, 'dist', 'packages'));
const DEPLOY_GUIDE = 'https://github.com/PaulMRamirez/tabdock/blob/main/docs/deploy.md';
const DEV_TOKENS = 'alice=pack-install-dev-token-0123456789';
/** Where every package but the three comes from, as for anyone installing them. */
const UPSTREAM = 'https://registry.npmjs.org';

const failures: string[] = [];
const tokens: string[] = [];
const printed: string[] = [];

function check(ok: boolean, what: string): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv },
): { status: number | null; stdout: string; stderr: string } {
  const ran = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  printed.push(ran.stdout, ran.stderr);
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

/**
 * The helper's command through sh, as Claude Code runs it, with no
 * environment at all. Its output is the header, so it is the one output kept
 * out of the scan for tokens.
 */
function runHelper(command: string, cwd: string): { status: number | null; stdout: string } {
  const ran = spawnSync('sh', ['-c', command], { cwd, env: {}, encoding: 'utf8' });
  printed.push(ran.stderr);
  return { status: ran.status, stdout: ran.stdout };
}

interface Started {
  child: ChildProcess;
  stdout(): string;
  stderr(): string;
  exited: Promise<number | null>;
  closed(): boolean;
}

function startRelay(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Started {
  const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  const state = { closed: false };
  const exited = new Promise<number | null>((resolveExit) => {
    child.on('close', (code) => {
      state.closed = true;
      printed.push(out, err);
      resolveExit(code);
    });
  });
  return { child, stdout: () => out, stderr: () => err, exited, closed: () => state.closed };
}

async function waitFor(relay: Started, text: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!relay.stdout().includes(text)) {
    if (relay.closed() || Date.now() > deadline) return false;
    await new Promise((wait) => setTimeout(wait, 50));
  }
  return true;
}

async function stop(relay: Started): Promise<number | null> {
  relay.child.kill('SIGTERM');
  return relay.exited;
}

/** The add-json line's JSON, as the shell would hand it to claude. */
function addJsonConfig(stdout: string): { url: string; headersHelper: string } | null {
  const line = /^ {2}claude mcp add-json --scope user tabdock-local '(.*)'$/m.exec(stdout)?.[1];
  if (line === undefined) return null;
  return JSON.parse(line.replaceAll(`'\\''`, "'")) as { url: string; headersHelper: string };
}

async function toolCount(url: string, authorization: string): Promise<number> {
  const client = new Client({ name: 'pack-install', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorization } },
    }),
  );
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

async function status(url: string, authorization: string): Promise<number> {
  const answer = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: authorization,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  await answer.body?.cancel();
  return answer.status;
}

/** The installed worker on its own: it must start and check one call. */
async function workerAnswers(file: string): Promise<boolean> {
  const worker = new Worker(pathToFileURL(file));
  try {
    return await new Promise<boolean>((resolveAnswer) => {
      const timer = setTimeout(() => {
        resolveAnswer(false);
      }, 15_000);
      worker.on('error', () => {
        clearTimeout(timer);
        resolveAnswer(false);
      });
      worker.on('message', (message: { t?: string; id?: number; result?: { kind?: string } }) => {
        if (message.t === 'ready') {
          const schema = JSON.stringify({
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
          });
          worker.postMessage({
            t: 'check',
            id: 1,
            tool: 'count',
            hash: createHash('sha256').update(schema).digest('hex'),
            schema,
            args: JSON.stringify({ n: 'not a number' }),
          });
        } else if (message.t === 'result' && message.id === 1) {
          clearTimeout(timer);
          resolveAnswer(message.result?.kind === 'invalid');
        }
      });
    });
  } finally {
    await worker.terminate();
  }
}

// Not the shared temporary directory, where local mode refuses its token (ADR 0028's notes).
const scratch = realpathSync(mkdtempSync(join(privateTempRoot(), 'tabdock-pack-install-')));
const relays: Started[] = [];
let registry: LocalRegistry | null = null;
try {
  console.log(`Node ${process.version}; tarballs from ${TARBALLS}`);
  const tarballs = readdirSync(TARBALLS)
    .filter((file) => /^tabdock-(?:protocol|adapter|relay)-.+\.tgz$/.test(file))
    .map((file) => join(TARBALLS, file));
  check(tarballs.length === 3, 'three tarballs to install');

  // The relay's shrinkwrap and version, read from its tarball.
  const relayTarball = tarballs.find((file) => file.includes('tabdock-relay-')) ?? '';
  const fromTarball = (file: string): string =>
    spawnSync('tar', ['-xzOf', relayTarball, `package/${file}`], { encoding: 'utf8' }).stdout;
  const shrinkwrap = JSON.parse(fromTarball('npm-shrinkwrap.json') || '{"packages":{}}') as {
    packages: Record<string, { version?: string }>;
  };
  const pinned = Object.entries(shrinkwrap.packages).filter(([path]) => path !== '');
  check(pinned.length > 0, 'the relay tarball carries its npm-shrinkwrap.json');
  const manifest = JSON.parse(fromTarball('package.json') || '{"version":""}') as {
    version: string;
  };

  // The registry the packages will be on once published, and a cache nothing else filled.
  registry = await startLocalRegistry(tarballs, UPSTREAM);
  writeFileSync(join(scratch, 'npmrc'), '');
  const npmEnv = npmEnvFor(registry, {
    cache: join(scratch, 'npm-cache'),
    userconfig: join(scratch, 'npmrc'),
  });
  const npxCwd = join(scratch, 'npx');
  mkdirSync(npxCwd);
  const viaNpx = await runAsync(
    'npx',
    ['--yes', `@tabdock/relay@${manifest.version}`, '--version'],
    {
      cwd: npxCwd,
      env: npmEnv,
    },
  );
  printed.push(viaNpx.stdout, viaNpx.stderr);
  check(
    viaNpx.status === 0 && viaNpx.stdout.trim() === manifest.version,
    `npx @tabdock/relay@${manifest.version} --version, from a registry, prints ${manifest.version}${viaNpx.status === 0 ? '' : `:\n${viaNpx.stderr}`}`,
  );
  const npxRoot = join(scratch, 'npm-cache', '_npx');
  const npxInstall = (existsSync(npxRoot) ? readdirSync(npxRoot) : [])
    .map((hash) => join(npxRoot, hash))
    .find((dir) => existsSync(join(dir, 'node_modules', '@tabdock', 'relay', 'package.json')));
  check(npxInstall !== undefined, 'npx installed @tabdock/relay in its cache');
  const install = npxInstall ?? join(npxRoot, 'missing');
  const relayDir = join(install, 'node_modules', '@tabdock', 'relay');
  const bin = join(install, 'node_modules', '.bin', 'tabdock-relay');
  check(existsSync(bin), 'the install links one bin, tabdock-relay');
  // npm put each package where the shrinkwrap says, under the relay itself.
  const drift = pinned
    .filter(([path, entry]) => {
      const file = join(relayDir, path, 'package.json');
      if (!existsSync(file)) return true;
      return (
        (JSON.parse(readFileSync(file, 'utf8')) as { version: string }).version !== entry.version
      );
    })
    .map(([path]) => path);
  check(
    drift.length === 0,
    `every package the shrinkwrap pins is installed at its version${drift.length === 0 ? '' : `: ${drift.join(', ')}`}`,
  );
  check(
    registry.requests().includes(`/@tabdock/protocol/-/protocol-${manifest.version}.tgz`),
    'npm fetched the protocol the shrinkwrap pins, by its registry URL',
  );

  // A git work tree to stand in, and a .env wherever a relay could look for one.
  const work = join(scratch, 'work');
  mkdirSync(work);
  const initialized = run('git', ['init', '-q'], { cwd: work });
  check(initialized.status === 0 && existsSync(join(work, '.git')), 'a git work tree to run from');
  const poison = `TABDOCK_DEV_TOKENS=${DEV_TOKENS}\nTABDOCK_PORT=1\n`;
  for (const dir of [work, npxCwd, install, join(install, 'node_modules'), relayDir]) {
    if (existsSync(dir)) writeFileSync(join(dir, '.env'), poison);
  }
  const home = join(scratch, 'home');
  mkdirSync(home);
  const tabdockHome = join(scratch, 'tabdock home');
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    TABDOCK_HOME: tabdockHome,
    TABDOCK_PORT: '0',
  };

  const version = run(bin, ['--version'], { cwd: work, env });
  check(
    version.status === 0 && version.stdout.trim() === manifest.version,
    `tabdock-relay --version prints ${manifest.version}`,
  );
  const help = run(bin, ['--help'], { cwd: work, env });
  check(
    help.status === 0 &&
      help.stdout.startsWith('Usage: tabdock-relay [--new-token]') &&
      help.stdout.includes('no .env file is read'),
    'tabdock-relay --help names the command and reads no .env',
  );
  const refused = run(bin, ['--new-tokn'], { cwd: work, env });
  check(
    refused.status === 2 &&
      refused.stderr.includes('the option --new-tokn is not one this command takes') &&
      !existsSync(tabdockHome),
    'a mistyped flag is refused with the usage, and starts nothing',
  );

  // The relay, from inside the work tree.
  const relay = startRelay(bin, [], work, env);
  relays.push(relay);
  const up = await waitFor(relay, 'claude mcp list');
  check(up, `tabdock-relay started${up ? '' : `:\n${relay.stderr()}`}`);
  const out = relay.stdout();
  check(
    out.includes('Local mode: this relay serves MCP clients on this computer only'),
    'it runs local mode, so no .env was read',
  );
  const tokenPath = join(tabdockHome, 'owner-token');
  const token = readFileSync(tokenPath, 'latin1').trim();
  tokens.push(token);
  check(/^tabdock_[A-Za-z0-9_-]{43}$/.test(token), 'it drew an owner token');
  check((lstatSync(tokenPath).mode & 0o777) === 0o600, 'the token file is 0600');
  check(relative(work, tokenPath).startsWith('..'), 'the token file lies outside the work tree');
  const helper = join(tabdockHome, 'claude-headers');
  check(
    existsSync(helper) && (lstatSync(helper).mode & 0o777) === 0o700,
    'claude-headers is beside it, 0700',
  );
  check(leakIn(readFileSync(helper, 'utf8'), token) === null, 'claude-headers holds no token');
  check(
    out.includes(`see ${DEPLOY_GUIDE}: a tunnel or a host.`),
    'the banner sends Claude in the cloud to the deploy guide by URL',
  );
  const config = addJsonConfig(out);
  check(
    config !== null && config.headersHelper === `"${helper}"`,
    'the banner prints claude mcp add-json with the helper',
  );
  if (config !== null) {
    const header = runHelper(config.headersHelper, home);
    const authorization =
      (JSON.parse(header.stdout || '{}') as { Authorization?: string }).Authorization ?? '';
    check(
      header.status === 0 && authorization === `Bearer ${token}`,
      'the helper prints the header for the token',
    );
    check(
      (await toolCount(config.url, authorization)) === 5,
      'an MCP client connects with what the helper prints',
    );
    check(
      (await status(config.url, `Bearer ${DEV_TOKENS.slice('alice='.length)}`)) === 401,
      'the .env dev token gets 401',
    );
  }
  await new Promise((wait) => setTimeout(wait, 500));
  check(
    !relay.stderr().includes('unchecked until another starts'),
    'the argument worker started from the bundle',
  );
  check(
    await workerAnswers(join(relayDir, 'dist', 'argument-worker.js')),
    'the installed worker starts and checks a call on its own',
  );
  check((await stop(relay)) === 0, 'SIGTERM closes it cleanly');

  // --new-token: the same helper, a new token.
  const replaced = startRelay(bin, ['--new-token'], work, env);
  relays.push(replaced);
  check(await waitFor(replaced, 'claude mcp list'), 'tabdock-relay --new-token started');
  const fresh = readFileSync(tokenPath, 'latin1').trim();
  tokens.push(fresh);
  check(
    fresh !== token && replaced.stdout().includes('(created just now)'),
    '--new-token drew a new token',
  );
  const again = addJsonConfig(replaced.stdout());
  if (again !== null) {
    const header = runHelper(again.headersHelper, home);
    const authorization =
      (JSON.parse(header.stdout || '{}') as { Authorization?: string }).Authorization ?? '';
    check(authorization === `Bearer ${fresh}`, 'the unchanged helper now prints the new token');
    check((await status(again.url, `Bearer ${token}`)) === 401, 'the old token gets 401');
  }
  await stop(replaced);

  const audit = run(bin, ['audit', '--verify'], { cwd: work, env });
  check(
    audit.status === 0 && audit.stderr.includes('verify: chain intact'),
    'tabdock-relay audit --verify reads the audit log',
  );
  const auditHelp = run(bin, ['audit', '--help'], { cwd: work, env });
  check(
    auditHelp.stdout.startsWith('Usage: tabdock-relay audit [options]'),
    'the audit usage names tabdock-relay audit',
  );

  // A TABDOCK_HOME inside the work tree, and a home that is itself a work tree.
  const inside = join(work, '.tabdock');
  const insideRun = startRelay(bin, [], work, { ...env, TABDOCK_HOME: inside });
  relays.push(insideRun);
  const insideCode = await insideRun.exited;
  check(
    insideCode === 1 &&
      insideRun.stderr().includes('refuses the path TABDOCK_HOME gives') &&
      insideRun.stderr().includes('lies inside a git work tree') &&
      // A refusal never repeats the setting's value, which could be a token.
      !insideRun.stderr().includes(work) &&
      !existsSync(inside),
    'a TABDOCK_HOME inside the work tree is refused, and nothing is made there',
  );
  const dotfiles = startRelay(bin, [], home, {
    PATH: process.env.PATH,
    HOME: work,
    TABDOCK_PORT: '0',
  });
  relays.push(dotfiles);
  check(
    (await dotfiles.exited) === 1 &&
      dotfiles.stderr().includes('set TABDOCK_HOME to an absolute path outside every repository'),
    'the default directory under a home that is a work tree is refused, naming TABDOCK_HOME',
  );
  // A TABDOCK_HOME in the shared temporary directory, which another account
  // could make again once it is gone, with a header helper of its own in it.
  const shared = realpathSync(tmpdir());
  if ((lstatSync(shared).mode & 0o002) !== 0) {
    const sharedHome = join(shared, `tabdock-pack-install-${String(process.pid)}`, 'tabdock');
    const sharedRun = startRelay(bin, [], work, { ...env, TABDOCK_HOME: sharedHome });
    relays.push(sharedRun);
    check(
      (await sharedRun.exited) === 1 &&
        sharedRun.stderr().includes('refuses the path TABDOCK_HOME gives') &&
        sharedRun.stderr().includes('above it can be written by other accounts') &&
        !sharedRun.stderr().includes(sharedHome) &&
        !existsSync(join(shared, `tabdock-pack-install-${String(process.pid)}`)),
      `a TABDOCK_HOME under ${shared} is refused, and nothing is made there`,
    );
  }

  // A consumer of the libraries, installed from the registry: Node loads the
  // protocol, tsc takes both packages' types.
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'pack-install-consumer', version: '0.0.0', private: true })}\n`,
  );
  const libraries = await runAsync(
    'npm',
    ['install', `@tabdock/protocol@${manifest.version}`, `@tabdock/adapter@${manifest.version}`],
    { cwd: consumer, env: npmEnv },
  );
  printed.push(libraries.stdout, libraries.stderr);
  check(
    libraries.status === 0,
    `npm install of @tabdock/protocol and @tabdock/adapter from the registry${libraries.status === 0 ? '' : `:\n${libraries.stderr}`}`,
  );
  const loaded = run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "const p = await import('@tabdock/protocol'); if (p.SUBPROTOCOL !== 'tabdock.v1') process.exit(1);",
    ],
    { cwd: consumer },
  );
  check(
    loaded.status === 0,
    `Node imports @tabdock/protocol from its dist${loaded.status === 0 ? '' : `:\n${loaded.stderr}`}`,
  );
  writeFileSync(
    join(consumer, 'consumer.ts'),
    [
      "import { attach, type AttachOptions } from '@tabdock/adapter';",
      "import { SUBPROTOCOL, type PolicyInput } from '@tabdock/protocol';",
      "const policy: PolicyInput = { consequentialTools: ['clear_board'] };",
      "const options: AttachOptions = { relay: 'ws://127.0.0.1:8787/page', policy };",
      'export const start = (): unknown => attach(options);',
      'export const subprotocol: string = SUBPROTOCOL;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        types: [],
      },
      files: ['consumer.ts'],
    }),
  );
  const tsc = run(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', consumer],
    { cwd: consumer },
  );
  check(
    tsc.status === 0,
    `a NodeNext consumer typechecks against both packages${tsc.status === 0 ? '' : `:\n${tsc.stdout}`}`,
  );

  const everything = printed.join('\n');
  const leaks = tokens.map((t) => leakIn(everything, t)).filter((leak) => leak !== null);
  check(leaks.length === 0, 'nothing the relay or npm printed holds a token');
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
  console.log(`FAIL ${failures.at(-1) ?? ''}`);
} finally {
  for (const relay of relays) relay.child.kill('SIGKILL');
  await registry?.close();
  rmSync(scratch, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.log(`\npack-install: ${String(failures.length)} checks failed`);
  process.exitCode = 1;
} else {
  console.log(
    '\npack-install: the packed relay installs, starts local mode and keeps every A5.5 rule',
  );
}
