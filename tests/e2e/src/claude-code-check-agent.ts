// An agent token (ADR 0044, A6.23) with the real Claude Code CLI, headless,
// spending no model calls:
//   pnpm --filter @tabdock/e2e check:claude-code:agent
// Needs `claude` and `openssl` on the PATH; without either the check skips
// and says so, since Claude Code is not a repo dependency.
//
// The relay runs in public URL mode for https://relay.test with invites and
// TABDOCK_AGENT_TOKENS on, against the relay tests' stand-in provider, beside
// the sim page, whose scripted operator answers the prompt an agent token's
// first request raises (via 'agent'). Alice, a member, pairs to sponsor it;
// the page mints a token and gets the `claude mcp add` command the widget
// shows once. Claude Code is a separate program, so, as check:claude-code:m3
// does, this script plays the tunnel and its TLS: a certificate for
// relay.test made with the openssl CLI for this run only, a TLS front that
// forwards to the loopback relay with the public Host, and a CONNECT proxy
// that sends relay.test (and nothing else) there, given to Claude Code
// through HTTPS_PROXY and NODE_EXTRA_CA_CERTS in a throwaway HOME, so the
// owner's own configuration is never read or changed.
//
// Steps: the printed command runs through sh -c exactly as printed; `claude
// mcp list` connects with it, which raises the prompt, naming the token's
// label and Claude Code as the client, and the operator allows it as
// observer; the page's Cancel then closes the token, and the next `claude mcp
// list` fails to connect, since /g/mcp answers 404. Every line the relay
// logged is checked against the token, which this script never prints.

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
import { type AddressInfo, connect } from 'node:net';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { PendingRequest } from '@tabdock/adapter';
import { createOAuthAuth, createRelay, type Relay } from '@tabdock/relay';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import {
  MOCK_SUBJECT,
  PAIR_CLIENT,
  startProvider,
  type TestProvider,
} from '@tabdock/relay/test/provider';
import { PUBLIC_MCP_URL, PUBLIC_ORIGIN, tunnelFetch } from '@tabdock/relay/test/tunnel';
import { DEFAULT_SIM_ORIGIN, type SimPage, startSimPage } from '@tabdock/sim-page';
import { AGENT_COMMAND, AGENT_URL } from './agent-harness.ts';
import { listsConnected } from './local-harness.ts';

const LABEL = 'Lab computer';
const PUBLIC_HOST = new URL(PUBLIC_ORIGIN).hostname;
const say = (text: string): void => {
  console.log(text);
};

for (const [tool, args] of [
  ['claude', ['--version']],
  ['openssl', ['version']],
] as const) {
  const found = spawnSync(tool, args, { encoding: 'utf8' });
  if (found.error !== undefined || found.status !== 0) {
    say(
      `check:claude-code:agent skipped: no \`${tool}\` on the PATH. Claude Code is not a repo dependency, so the M6 checklist keeps this check for a run by hand.`,
    );
    process.exit(0);
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as AddressInfo).port);
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
  if (made.status !== 0) {
    throw new Error(`openssl could not make a certificate: ${made.stderr.toString()}`);
  }
  return { key, cert };
}

/** A CONNECT proxy that tunnels relay.test:443 to the TLS front and refuses every other host. */
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

/** Runs a program with `env` in `cwd` and returns its exit code and everything it printed. */
function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 90_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: stripVTControlCharacters(output).replace(/\r/g, '\n') });
    });
  });
}

/** Pairs Alice, a member, as driver through the in-process tunnel, so she sponsors the token. */
async function attachAlice(relay: Relay, provider: TestProvider, sim: SimPage): Promise<Client> {
  const token = await provider.token({ sub: MOCK_SUBJECT, aud: PUBLIC_MCP_URL });
  const client = new Client({ name: 'agent-check-setup', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(PUBLIC_MCP_URL), {
      authProvider: { token: () => Promise.resolve(token) },
      fetch: tunnelFetch(relay.url),
    }),
  );
  const state = await sim.waitFor((s) => s.link === 'linked' && s.pairing !== null);
  const pending = client.callTool({
    name: 'pair_page',
    arguments: { code: state.pairing?.code ?? '' },
  });
  const asked = await sim.waitFor((s) => s.pendingRequests.some((r) => r.via !== 'agent'));
  const request = asked.pendingRequests.find((r) => r.via !== 'agent');
  if (!request || !sim.dock.approve(request.requestId, 'driver')) {
    throw new Error('the operator could not approve Alice');
  }
  const outcome = await pending;
  if (outcome.isError === true) throw new Error('Alice could not pair');
  return client;
}

/** The line `claude mcp list` prints for `server`, or a note that it printed none. */
function lineFor(output: string, server: string): string {
  return (
    output
      .split('\n')
      .find((line) => line.includes(server))
      ?.trim() ?? '(no line for the server)'
  );
}

const dir = await mkdtemp(join(privateTempRoot(), 'tabdock-cc-agent-'));
const home = join(dir, 'home');
const work = join(dir, 'work');
const relayLogs: string[] = [];
/** The agent requests the scripted operator was asked about, as the prompt names them. */
const asked: PendingRequest[] = [];
let provider: TestProvider | undefined;
let relay: Relay | undefined;
let sim: SimPage | undefined;
let alice: Client | undefined;
const servers: Server[] = [];
let passed = false;
try {
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
    allowedOrigins: [DEFAULT_SIM_ORIGIN],
    port: 0,
    logLevel: 'debug',
    logSink: (line) => {
      relayLogs.push(line);
    },
    invites: true,
    agentTokens: true,
  });
  const live = relay;
  // The scripted operator: an agent token's request whose label is this page's own is allowed as observer.
  sim = await startSimPage({
    relayUrl: live.pageUrl,
    operator: {
      askAttach(request) {
        if (request.via !== 'agent') return undefined;
        asked.push(request);
        return request.agent?.label === LABEL ? 'observer' : 'deny';
      },
    },
  });
  alice = await attachAlice(live, provider, sim);
  await sim.waitFor((s) => s.agentsOffered?.endpoint === AGENT_URL);
  const minted = await sim.dock.agentToken({ label: LABEL, lifetime: '1h' });
  if (!minted.ok) throw new Error(`the page could not mint a token: ${minted.reason}`);
  const shape = AGENT_COMMAND.exec(minted.command);
  if (!shape) throw new Error('the command is not shaped as the widget shows it');
  const server = `tabdock-${shape[1] ?? ''}`;
  say(
    `Relay on ${live.url} in public URL mode for ${PUBLIC_ORIGIN}, agent tokens on; a token minted for "${LABEL}".`,
  );
  say(`The command, token masked: ${minted.command.replace(minted.token, 'tda_***')}`);

  const { key, cert } = makeCertificate(dir);
  const front = createHttpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    forwardTo(live),
  );
  servers.push(front);
  const refused: string[] = [];
  const proxy = connectProxy(await listen(front), refused);
  servers.push(proxy);
  const proxyUrl = `http://127.0.0.1:${String(await listen(proxy))}`;
  // Only what Claude Code needs, a home of its own, and the stand-in tunnel.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'xterm-256color',
    NO_PROXY: 'localhost,127.0.0.1,::1',
    no_proxy: 'localhost,127.0.0.1,::1',
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    NODE_EXTRA_CA_CERTS: cert,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };

  // 1. The printed command, through sh -c exactly as printed.
  const added = await run('sh', ['-c', minted.command], work, env);
  say(`\n1. The printed command: exit ${String(added.code)}`);
  const config = await readFile(join(home, '.claude.json'), 'utf8').catch(() => '');
  const stored = (() => {
    try {
      const parsed = JSON.parse(config) as {
        projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
      };
      return parsed.projects?.[work]?.mcpServers?.[server] !== undefined;
    } catch {
      return false;
    }
  })();
  say(`   stored at local scope, for this project only: ${stored ? 'yes' : 'no'}`);

  // 2. Claude Code connects: its first request raises the prompt, which the operator allows.
  const first = await run('claude', ['mcp', 'list'], work, env);
  const firstLine = lineFor(first.output, server);
  say(`\n2. claude mcp list: ${firstLine}`);
  const prompt = asked[0];
  say(
    prompt === undefined
      ? '   no prompt reached the operator'
      : `   the prompt named the label "${prompt.agent?.label ?? ''}" and the client "${prompt.client?.name ?? '(none)'}", via ${prompt.via}`,
  );
  const allowed = await sim.waitFor(
    (s) => s.roster.some((entry) => entry.inviteId === minted.tokenId && entry.role === 'observer'),
    10_000,
  );
  say(`   the page lists the agent as observer: ${allowed.roster.length > 1 ? 'yes' : 'no'}`);
  const again = await run('claude', ['mcp', 'list'], work, env);
  const againLine = lineFor(again.output, server);
  say(`   claude mcp list once allowed: ${againLine}`);

  // 3. Cancel on the page closes the token, and Claude Code can no longer connect.
  sim.dock.cancelAgent(minted.tokenId);
  await sim.waitFor((s) => s.agents.length === 0 && s.roster.length === 1);
  const after = await run('claude', ['mcp', 'list'], work, env);
  const afterLine = lineFor(after.output, server);
  say(`\n3. After Cancel, claude mcp list: ${afterLine}`);
  if (refused.length > 0) {
    say(
      `   the proxy refused, as this run reaches only the stand-ins: ${[...new Set(refused)].join(', ')}`,
    );
  }

  const printed = [added.output, first.output, again.output, after.output].join('\n');
  const leaked = relayLogs.join('\n').includes(minted.token) || printed.includes(minted.token);
  say(`   the token in the relay's log or Claude Code's output: ${leaked ? 'YES' : 'no'}`);
  passed =
    added.code === 0 &&
    stored &&
    prompt?.agent?.label === LABEL &&
    prompt.client !== null &&
    listsConnected(againLine) &&
    !listsConnected(afterLine) &&
    !leaked;
  say(
    passed
      ? '\nAgent token Claude Code PASS: the printed command connected, the prompt named the label and the client, and Cancel ended it.'
      : '\nAgent token Claude Code: not completed here; the output above says where it stopped.',
  );
} catch (error) {
  say(
    `Agent token Claude Code check stopped: ${error instanceof Error ? error.message : String(error)}`,
  );
} finally {
  for (const server of servers) {
    server.closeAllConnections();
    server.close();
  }
  await alice?.close().catch(() => undefined);
  await sim?.close();
  await relay?.close();
  await provider?.stop();
  await rm(dir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
