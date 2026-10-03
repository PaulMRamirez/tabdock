// M3 with the real Claude Code CLI, headless and offline from any real provider:
//   pnpm --filter @tabdock/e2e check:claude-code:m3
// Needs `claude` and `openssl` on PATH. It spends no model calls.
//
// The relay runs here in public URL mode for https://relay.test against the
// stand-in provider (oauth2-mock-server), exactly as the demo and the
// Playwright specs run it. Claude Code is a separate program, so the
// in-process stand-in tunnel cannot carry it; instead this script plays the
// tunnel and its TLS: a certificate for relay.test made with the openssl CLI
// for this run only, a TLS front that forwards to the loopback relay with the
// public Host, and a CONNECT proxy that sends relay.test (and nothing else)
// there. Claude Code gets the proxy and the certificate through
// HTTPS_PROXY and NODE_EXTRA_CA_CERTS, in a throwaway HOME, so the owner's
// own configuration is never read or changed. The relay is not changed at all.
//
// Steps: `claude mcp add` with the connector URL; `claude mcp login` with
// --no-browser in a pseudo-terminal (script(1)), where this script plays the
// browser at the stand-in provider and pastes the redirect back; and
// `claude mcp list`, whose health check must then connect with the token.
// Before that it records what Claude Code says for a plain loopback URL,
// the shape the relay's own tests use, which it cannot sign in through.

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { createOAuthAuth, createRelay, type Relay } from '@tabdock/relay';
import {
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN } from '@tabdock/relay/test/tunnel';

const SERVER = 'tabdock-m3';
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).hostname;
const say = (text: string): void => {
  console.log(text);
};

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve(portOf(server));
    });
  });
}

/** Forwards each request to the relay with the public Host, as the tunnel does. */
function forwardTo(relay: Relay): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    const out = httpRequest(
      new URL(request.url ?? '/', relay.url),
      { method: request.method, headers: { ...request.headers, host: PUBLIC_HOST } },
      (back) => {
        response.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(response);
      },
    );
    out.on('error', () => {
      response.destroy();
    });
    request.pipe(out);
  };
}

/** A certificate for relay.test, valid for a day, made by the openssl CLI; nothing is hand-rolled. */
function makeCertificate(dir: string): { key: string; cert: string } {
  const key = join(dir, 'relay.test.key');
  const cert = join(dir, 'relay.test.crt');
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:P-256',
      '-nodes',
      '-days',
      '1',
      '-subj',
      `/CN=${PUBLIC_HOST}`,
      '-addext',
      `subjectAltName=DNS:${PUBLIC_HOST}`,
      '-keyout',
      key,
      '-out',
      cert,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (made.status !== 0)
    throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  return { key, cert };
}

/**
 * A CONNECT proxy that tunnels relay.test:443 to the TLS front and refuses
 * every other host, so this run cannot reach anything but the stand-ins.
 */
function connectProxy(tlsPort: number, refused: string[]): Server {
  const proxy = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on('connect', (request, socket, head) => {
    const target = request.url ?? '';
    if (target !== `${PUBLIC_HOST}:443`) {
      refused.push(target);
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    const upstream = connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return proxy;
}

interface Ran {
  code: number | null;
  output: string;
}

/** Runs claude with `env`, in `cwd`, and returns its exit code and everything it printed. */
function claude(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Terminal output as text: Node's own stripping of escape sequences, carriage returns as line ends. */
function plain(text: string): string {
  return stripVTControlCharacters(text).replace(/\r/g, '\n');
}

/**
 * claude mcp login --no-browser inside script(1), so it has the terminal it
 * asks for. When it prints the sign-in URL, `browse` plays the browser and
 * returns the URL the provider redirected to, which is pasted back.
 */
function loginInTerminal(
  cwd: string,
  env: NodeJS.ProcessEnv,
  browse: (url: string) => Promise<string>,
  timeoutMs = 60_000,
): Promise<Ran & { signIn: string | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'script',
      ['-q', '-e', '-c', `claude mcp login ${SERVER} --no-browser`, '/dev/null'],
      { cwd, env: { ...env, COLUMNS: '400', LINES: '50' }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let raw = '';
    let signIn: string | null = null;
    const onData = (chunk: Buffer): void => {
      raw += chunk.toString('utf8');
      if (signIn !== null) return;
      const found = /(https?:\/\/127\.0\.0\.1:\d+\/authorize\?[^\s"'<>]+)/.exec(plain(raw));
      if (!found?.[1]) return;
      signIn = found[1];
      browse(signIn).then(
        (redirect) => {
          child.stdin.write(`${redirect}\r`);
        },
        (error: unknown) => {
          raw += `\n[browser stand-in failed: ${error instanceof Error ? error.message : String(error)}]\n`;
          child.kill('SIGTERM');
        },
      );
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: plain(raw), signIn });
    });
  });
}

/** The provider signs in whoever it is told to and redirects; this follows that one hop. */
async function signInAtProvider(url: string): Promise<string> {
  const answer = await fetch(url, { redirect: 'manual' });
  const location = answer.headers.get('location');
  if (answer.status < 300 || answer.status >= 400 || location === null) {
    throw new Error(`the provider answered ${String(answer.status)} without a redirect`);
  }
  return location;
}

/** Hides anything that looks like a code, state or token in a URL before it is printed. */
function maskUrl(text: string): string {
  return text.replace(/([?&](?:code|state|code_challenge|nonce)=)[^&\s]+/g, '$1***');
}

const dir = await mkdtemp(join(tmpdir(), 'tabdock-cc-m3-'));
const home = join(dir, 'home');
const work = join(dir, 'work');
let provider: TestProvider | undefined;
let relay: Relay | undefined;
const servers: Server[] = [];
let passed = false;
try {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (version.status !== 0) throw new Error('claude is not on PATH');
  say(`Claude Code ${version.stdout.trim()}`);
  await mkdir(home);
  await mkdir(work);

  provider = await startProvider();
  relay = await createRelay({
    auth: createOAuthAuth({
      issuer: provider.issuer,
      resource: PUBLIC_MCP_URL,
      users: [{ sub: MOCK_SUBJECT, userId: 'alice', displayName: 'Alice' }],
    }),
    publicUrl: PUBLIC_ORIGIN,
    pairClient: PAIR_CLIENT,
    allowedOrigins: ['http://127.0.0.1:5173'],
    port: 0,
    logSink: () => undefined,
  });
  say(
    `Relay on ${relay.url} in public URL mode for ${PUBLIC_ORIGIN}; stand-in provider at ${provider.issuer}.`,
  );

  // Only what Claude Code needs, and a home of its own.
  const baseEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
  };

  // 1. The plain loopback shape: a forwarder with the public Host, no TLS.
  const forwarder = createServer(forwardTo(relay));
  servers.push(forwarder);
  const forwarderPort = await listen(forwarder);
  const loopbackUrl = `http://127.0.0.1:${String(forwarderPort)}/mcp`;
  say(
    `\n1. A plain loopback URL, ${loopbackUrl}, forwarding to the relay with Host ${PUBLIC_HOST}:`,
  );
  const loopbackHome = join(dir, 'home-loopback');
  await mkdir(loopbackHome);
  const loopbackEnv = { ...baseEnv, HOME: loopbackHome, USERPROFILE: loopbackHome };
  const addedLoopback = await claude(
    ['mcp', 'add', '--transport', 'http', SERVER, loopbackUrl],
    work,
    loopbackEnv,
  );
  say(`   claude mcp add: exit ${String(addedLoopback.code)}`);
  const listedLoopback = await claude(['mcp', 'list'], work, loopbackEnv);
  const loopbackLine = plain(listedLoopback.output)
    .split('\n')
    .find((line) => line.includes(SERVER));
  say(`   claude mcp list: ${loopbackLine?.trim() ?? '(no line for the server)'}`);
  say(
    `   The relay's challenge names ${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp, and its tokens must be`,
  );
  say(
    `   for ${PUBLIC_MCP_URL}; a client given a loopback URL cannot sign in for that, and the relay is not changed to allow it.`,
  );

  // 2. The tunnel's shape: https://relay.test through a CONNECT proxy and a TLS front.
  const { key, cert } = makeCertificate(dir);
  const front = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    forwardTo(relay),
  );
  servers.push(front);
  const frontPort = await listen(front);
  const refused: string[] = [];
  const proxy = connectProxy(frontPort, refused);
  servers.push(proxy);
  const proxyUrl = `http://127.0.0.1:${String(await listen(proxy))}`;
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NODE_EXTRA_CA_CERTS: cert,
  };
  say(
    `\n2. ${PUBLIC_MCP_URL} as the connector URL, through a stand-in tunnel with its own TLS certificate:`,
  );
  const added = await claude(
    ['mcp', 'add', '--transport', 'http', SERVER, PUBLIC_MCP_URL],
    work,
    env,
  );
  say(
    `   claude mcp add: exit ${String(added.code)}; ${plain(added.output).split('\n')[0]?.trim() ?? ''}`,
  );
  const before = await claude(['mcp', 'list'], work, env);
  const beforeLine = plain(before.output)
    .split('\n')
    .find((line) => line.includes(SERVER));
  say(`   claude mcp list before sign-in: ${beforeLine?.trim() ?? '(no line for the server)'}`);

  const login = await loginInTerminal(work, env, signInAtProvider);
  say(`   claude mcp login --no-browser: exit ${String(login.code)}`);
  if (login.signIn !== null) {
    const asked = new URL(login.signIn).searchParams;
    say(
      `   it asked the provider for resource=${asked.get('resource') ?? '(none)'}, client_id=${asked.get('client_id') ?? '(none)'},`,
    );
    say(
      `   PKCE ${asked.get('code_challenge_method') ?? '(none)'}, redirect ${maskUrl(asked.get('redirect_uri') ?? '(none)')}`,
    );
  }
  for (const line of login.output
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-6)) {
    say(`   | ${maskUrl(line.trim()).slice(0, 200)}`);
  }
  const after = await claude(['mcp', 'list'], work, env);
  const afterLine = plain(after.output)
    .split('\n')
    .find((line) => line.includes(SERVER));
  say(`   claude mcp list after sign-in: ${afterLine?.trim() ?? '(no line for the server)'}`);
  if (refused.length > 0) {
    say(
      `   the proxy refused, since this run reaches only the stand-ins: ${[...new Set(refused)].join(', ')}`,
    );
  }
  passed =
    login.code === 0 &&
    afterLine !== undefined &&
    /connected/i.test(afterLine) &&
    !/fail/i.test(afterLine);
  say(
    passed
      ? '\nM3 Claude Code PASS: Claude Code signed in through the stand-in provider and connected to the public relay.'
      : '\nM3 Claude Code: not completed here; the output above says where it stopped.',
  );
} catch (error) {
  say(`M3 Claude Code check stopped: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await relay?.close();
  await provider?.stop();
  await rm(dir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
