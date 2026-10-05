// A5.2's manual half (ADR 0027) with the real Claude Code CLI, headless:
//   pnpm --filter @tabdock/e2e check:claude-code:m5
// Needs `claude` on the PATH and signed in; without it the check skips and
// says so, since Claude Code is not a repo dependency. It spends a few model
// calls, so it stays out of CI, and its results go in docs/notes/verified.md.
//
// A relay with first-class tools on (ADR 0025) and a throwaway dev token, the
// sim page running the real adapter core, and a recording proxy in front of
// /mcp (mcp-proxy.ts) that records each request as it arrives, since the relay
// holds back a GET stream's head until its first bytes. Alice is attached to
// the page as a driver before Claude Code starts, so its first tools/list
// already holds the page's first-class names. Then Claude Code runs twice in a
// throwaway HOME, so the owner's own configuration is never read or changed:
// once by default, where it must speak 2026-07-28 (server/discover first, the
// envelope on every request, no session) and open a subscriptions/listen
// stream; and once with MCP_PROTOCOL_NEGOTIATION=legacy, where it must
// initialize at 2025-11-25 on a session and open that session's GET stream.
// Each run calls call_page_tool and a first-class name, and the relay's audit,
// its `mcp client` line and the page's roster must name claude-code. The token
// reaches Claude Code only through its environment, which its configuration
// names, and no line anything printed may hold it.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDevTokenAuth, createRelay, type DevTokenUser, type Relay } from '@tabdock/relay';
import { privateTempRoot } from '@tabdock/relay/test/private-tmp';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { type SimPage, startSimPage } from '@tabdock/sim-page';
import { type McpProxy, type RecordedRequest, startMcpProxy } from './mcp-proxy.ts';

const SERVER = 'tabdock';
const CLIENT = 'claude-code';
/** Claude Code expands ${VAR} in headers, so the token reaches it through the environment and never touches disk. */
const TOKEN_VARIABLE = 'TABDOCK_M5_CHECK_TOKEN';
const say = (text: string): void => {
  console.log(text);
};

const version = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (version.error !== undefined || version.status !== 0) {
  say(
    'check:claude-code:m5 skipped: no `claude` on the PATH. Claude Code is not a repo dependency, so docs/checklists/M5.md keeps this check for a run by hand.',
  );
  process.exit(0);
}

interface Ran {
  code: number | null;
  output: string;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGTERM'), 240_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** Pairs alice with the page through an SDK client of her own, the operator allowing a driver. */
async function attachAlice(relay: Relay, alice: DevTokenUser, sim: SimPage): Promise<string> {
  const client = new Client({ name: 'm5-check-setup', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(relay.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${alice.token}` } },
    }),
  );
  try {
    const state = await sim.waitFor((s) => s.link === 'linked' && s.pairing !== null);
    if (!state.pairing) throw new Error('the page shows no pairing code');
    const pending = client.callTool({ name: 'pair_page', arguments: { code: state.pairing.code } });
    const asked = await sim.waitFor((s) => s.pendingRequests.length > 0);
    const request = asked.pendingRequests[0];
    if (!request || !sim.dock.approve(request.requestId, 'driver')) {
      throw new Error('the operator could not approve the attach request');
    }
    const outcome = await pending;
    const page = (outcome.structuredContent as { page?: unknown } | undefined)?.page;
    if (outcome.isError === true || typeof page !== 'string') throw new Error('pair_page failed');
    return page;
  } finally {
    await client.close();
  }
}

interface RunReport {
  label: string;
  checks: [string, boolean][];
  printed: string;
}

const dir = await mkdtemp(join(privateTempRoot(), 'tabdock-cc-m5-'));
const alice: DevTokenUser = {
  userId: 'alice',
  displayName: 'Alice',
  token: `alice-${randomBytes(24).toString('base64url')}`,
};
const relayLogs: string[] = [];
let relay: Relay | undefined;
let sim: SimPage | undefined;
const proxies: McpProxy[] = [];
let passed = false;

try {
  say(`Claude Code ${version.stdout.trim()}`);
  const home = join(dir, 'home');
  const work = join(dir, 'work');
  await mkdir(home);
  await mkdir(work);
  relay = await createRelay({
    auth: createDevTokenAuth([alice]),
    port: 0,
    allowMissingOrigin: false,
    firstClassTools: true,
    logLevel: 'debug',
    logSink: (line) => {
      relayLogs.push(line);
    },
    // A GET stream's head goes out with its first bytes; a short keep-alive sends them soon.
    timings: { sseKeepAliveMs: 1000 },
  });
  sim = await startSimPage({ relayUrl: relay.pageUrl });
  const pageId = await attachAlice(relay, alice, sim);
  say(
    `Alice is attached to the sim page as a driver; page tools are listed first-class as ${pageId}__<tool>.`,
  );

  const reports: RunReport[] = [];
  for (const legacy of [false, true]) {
    const label = legacy ? 'MCP_PROTOCOL_NEGOTIATION=legacy' : 'default negotiation';
    const proxy = await startMcpProxy({ upstream: relay.url, record: true });
    proxies.push(proxy);
    const configPath = join(dir, `mcp-${legacy ? 'legacy' : 'default'}.json`);
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          [SERVER]: {
            type: 'http',
            url: proxy.url,
            headers: { Authorization: `Bearer \${${TOKEN_VARIABLE}}` },
          },
        },
      }),
    );
    const marker = `claude-code M5 check, ${label}`;
    const firstClass = `${pageId}__set_value`;
    const prompt = [
      `You are connected to Tabdock through the MCP server "${SERVER}". Do these steps with its tools and nothing else:`,
      '1. Call list_pages.',
      `2. Call call_page_tool with page "${pageId}", tool "get_value" and arguments {}.`,
      `3. Call the tool mcp__${SERVER}__${firstClass} with arguments {"value": "${marker}"}.`,
      '4. Call call_page_tool with the same page, tool "get_value" and arguments {} again.',
      'Finish with one line: what the second get_value returned.',
    ].join('\n');
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.startsWith('TABDOCK_') && name !== 'MCP_PROTOCOL_NEGOTIATION') env[name] = value;
    }
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      [TOKEN_VARIABLE]: alice.token,
      NO_PROXY: ['localhost', '127.0.0.1', '::1', process.env.NO_PROXY].filter(Boolean).join(','),
      no_proxy: ['localhost', '127.0.0.1', '::1', process.env.no_proxy].filter(Boolean).join(','),
      ...(legacy ? { MCP_PROTOCOL_NEGOTIATION: 'legacy' } : {}),
    });
    say(`\n${reports.length + 1}. claude -p, ${label}:`);
    const auditBefore = relay.audit.records().length;
    const ran = await run(
      work,
      [
        '-p',
        prompt,
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--allowedTools',
        ['list_pages', 'call_page_tool', firstClass]
          .map((name) => `mcp__${SERVER}__${name}`)
          .join(','),
        '--permission-mode',
        'dontAsk',
        '--max-turns',
        '10',
        '--output-format',
        'json',
      ],
      env,
    );
    // Claude Code may hold its stream a moment after it answers; the record is read once it has gone.
    await new Promise((wait) => setTimeout(wait, 500));
    const wire = proxy.requests();
    const posts = wire.filter((r) => r.method === 'POST');
    const messages = posts.flatMap((r) => r.messages);
    const methods = (r: RecordedRequest): (string | null)[] => r.messages.map((m) => m.method);
    let answer = '';
    try {
      answer = (JSON.parse(ran.output) as { result?: string }).result ?? '';
    } catch {
      answer = ran.output.slice(-500);
    }
    say(
      `   exit ${String(ran.code)}; Claude said: ${answer.trim().split('\n').slice(-1)[0] ?? ''}`,
    );
    say(
      `   requests as they arrived: ${wire
        .map(
          (r) =>
            `${r.method} ${methods(r).join('+') || '-'}${r.session === null ? '' : ` [${r.session}]`} ${String(r.status)}`,
        )
        .join(', ')}`,
    );
    const records = relay.audit.records().slice(auditBefore);
    const byClaude = records.filter(
      (record) => record.client?.name === CLIENT && record.outcome === 'ok',
    );
    const line = relayLogs
      .map((text) => JSON.parse(text) as Record<string, unknown>)
      .find(
        (entry) =>
          entry.msg === 'mcp client' &&
          entry.client === CLIENT &&
          entry.leg === (legacy ? 'session' : 'strict'),
      );
    const checks: [string, boolean][] = [];
    if (legacy) {
      const first = posts[0];
      checks.push(
        [
          'initialize first, asking 2025-11-25',
          first !== undefined &&
            methods(first)[0] === 'initialize' &&
            first.messages[0]?.version === '2025-11-25',
        ],
        [
          'the relay answered 2025-11-25 and opened a session',
          first?.negotiated === '2025-11-25' && first.openedSession !== null,
        ],
        [
          'every later request named that session',
          wire.slice(1).every((r) => r.session !== null && r.session === first?.openedSession),
        ],
        [
          'no server/discover reached the relay',
          !messages.some((m) => m.method === 'server/discover'),
        ],
        [
          "its GET stream opened within the relay's bounds (200)",
          wire.some((r) => r.method === 'GET' && r.status === 200),
        ],
      );
    } else {
      const first = posts[0];
      checks.push(
        [
          'server/discover first, at 2026-07-28',
          first !== undefined &&
            methods(first)[0] === 'server/discover' &&
            first.versionHeader === '2026-07-28',
        ],
        [
          'no initialize and no session',
          !messages.some((m) => m.method === 'initialize') &&
            wire.every((r) => r.session === null && r.openedSession === null),
        ],
        [
          'every request carried 2026-07-28 in its header and envelope',
          posts.every(
            (r) =>
              r.versionHeader === '2026-07-28' &&
              r.messages.filter((m) => m.request).every((m) => m.version === '2026-07-28'),
          ),
        ],
        [
          "its subscriptions/listen stream opened within the relay's bounds (200)",
          posts.some((r) => methods(r).includes('subscriptions/listen') && r.status === 200),
        ],
      );
    }
    checks.push(
      ['no request refused 429', !wire.some((r) => r.status === 429)],
      ['no request carried an Origin', !wire.some((r) => r.origin)],
      [
        'every message named its client claude-code',
        messages.filter((m) => m.client !== null).every((m) => m.client === CLIENT),
      ],
      [
        `the mcp client line: ${legacy ? 'session, 2025-11-25' : 'strict, 2026-07-28'}, form elicitation`,
        line?.revision === (legacy ? '2025-11-25' : '2026-07-28') && line.formElicitation === true,
      ],
      [
        'call_page_tool get_value ran for claude-code',
        byClaude.some((record) => record.tool === 'get_value'),
      ],
      [
        `the first-class ${firstClass} ran for claude-code`,
        byClaude.some((record) => record.tool === 'set_value'),
      ],
      ['the page holds the value Claude set', sim.store.value === marker],
    );
    for (const [name, ok] of checks) say(`   ${ok ? 'ok  ' : 'FAIL'} ${name}`);
    reports.push({ label, checks, printed: ran.output });
    await proxy.close();
  }

  const roster = sim.state.roster.find((entry) => entry.userId === 'alice');
  const rosterNamesClaude =
    roster?.role === 'driver' && roster.clients.some((client) => client.name === CLIENT);
  say(
    `\nThe page's roster lists Alice as ${String(roster?.role)} with ${roster?.clients.map((c) => `${c.name} ${c.version}`).join(', ') ?? 'no client'}.`,
  );
  const everything = [...relayLogs, ...reports.map((report) => report.printed)].join('\n');
  const leak = leakIn(everything, alice.token);
  say(
    leak === null
      ? 'No relay log line and nothing Claude Code printed holds the token or any 8 characters of it.'
      : `The token leaked: ${leak}.`,
  );
  passed =
    reports.every((report) => report.checks.every(([, ok]) => ok)) &&
    rosterNamesClaude &&
    leak === null;
  say(
    passed
      ? '\nM5 Claude Code check PASS: Claude Code called a page tool through call_page_tool and by its first-class name on 2026-07-28 without a session and on 2025-11-25 with one, its listen and GET streams opened, and the roster names claude-code.'
      : '\nM5 Claude Code check FAIL: the output above says where it stopped.',
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  say(
    `check:claude-code:m5 stopped: ${leakIn(message, alice.token) === null ? message : '[withheld]'}`,
  );
} finally {
  for (const proxy of proxies) await proxy.close();
  await sim?.close();
  await relay?.close();
  await rm(dir, { recursive: true, force: true });
  process.exitCode = passed ? 0 : 1;
}
