// A4.4 from the command line (ADR 0022): `pnpm relay` and `pnpm dev`, run as
// children the way the owner runs them, with no settings but a throwaway
// TABDOCK_HOME. The first start draws the token into a private file and the
// next keeps it byte for byte; the printed `claude mcp add-json` line hands
// Claude Code the header helper beside the token (ADR 0028), which prints the
// header a client then connects with; only the owner token gets in, and only
// from this machine; and nothing either command prints, on stdout or stderr
// (where the relay's log lines go), holds the token, its digest or any
// 8-character run of its random part.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createRelay, loadConfigFromEnv, quotePosix } from '@tabdock/relay';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { rawRequest } from '@tabdock/relay/test/tunnel';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort } from '../src/harness.ts';
import {
  blankEnv,
  listsConnected,
  readBanner,
  ROOT,
  type Run,
  runPnpm,
} from '../src/local-harness.ts';

const scratches: string[] = [];
const runs: Run[] = [];

/** The fixed tools a member sees on a relay with no page attached: M4's five and M6's four. */
const FIXED_TOOL_COUNT = 9;

/** The step every local mode banner prints for an older tabdock-local entry in Claude Code. */
const REMOVE_FIRST =
  'If Claude Code says tabdock-local already exists, remove the old entry first: claude mcp remove --scope user tabdock-local';

afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A TABDOCK_HOME whose path holds a space, as many home directories do. */
function freshHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-e2e-local-')));
  scratches.push(dir);
  return join(dir, 'tabdock home');
}

function start(args: string[], home: string): Run {
  const run = runPnpm(args, {
    ...blankEnv(),
    TABDOCK_HOME: home,
    TABDOCK_PORT: '0',
    DEMO_PORT: '0',
  });
  runs.push(run);
  return run;
}

/**
 * The add-json line a POSIX banner prints for this relay and token directory
 * (ADR 0028): the helper's path in double quotes, since every home here holds
 * a space.
 */
function addJsonLine(mcpUrl: string, home: string): string {
  const json = JSON.stringify({
    type: 'http',
    url: mcpUrl,
    headersHelper: `"${join(home, 'claude-headers')}"`,
  });
  return `claude mcp add-json --scope user tabdock-local ${quotePosix(json)}`;
}

/** The Authorization header the printed line's helper gives, run through sh as Claude Code runs it. */
function helperHeader(command: string): string {
  const quoted = /'(.*)'$/s.exec(command)?.[1] ?? '';
  const config = JSON.parse(quoted.replaceAll(`'\\''`, "'")) as { headersHelper: string };
  const ran = spawnSync('sh', ['-c', config.headersHelper], { env: {}, encoding: 'utf8' });
  expect(ran.status, ran.stderr).toBe(0);
  const headers = JSON.parse(ran.stdout) as { Authorization?: string };
  return headers.Authorization ?? '';
}

async function stopAndScan(run: Run, token: string): Promise<void> {
  await run.stop();
  expect(leakIn(run.stdout(), token), 'stdout').toBeNull();
  expect(leakIn(run.stderr(), token), 'stderr').toBeNull();
}

/** Status of an unauthenticated-or-not MCP request with these headers. */
async function mcpStatus(mcpUrl: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(mcpUrl);
  const answer = await rawRequest(url.origin, url.pathname, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  return answer.status;
}

async function toolNames(mcpUrl: string, token: string): Promise<string[]> {
  const client = new Client({ name: 'local-mode-e2e', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
  }
}

// POSIX only: the run is stopped through its process group, and the file modes are checked.
describe.skipIf(process.platform === 'win32')('local mode from a clean checkout', () => {
  it('pnpm relay draws a private token, prints a line that reads it, keeps it on the next start, and lets only it in', async () => {
    const home = freshHome();
    const first = start(['relay'], home);
    await first.waitFor('claude mcp list');
    const banner = readBanner(first.stdout());
    expect(first.stdout()).toContain('serves MCP clients on this computer only');
    expect(banner.created).toBe(true);
    expect(banner.tokenPath).toBe(join(home, 'owner-token'));
    expect(banner.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(banner.command).toBe(addJsonLine(banner.mcpUrl, home));
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
    expect(lstatSync(banner.tokenPath).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(banner.tokenPath);
    const token = bytes.toString('latin1').trim();
    expect(/^tabdock_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    // The helper holds no token, and what it prints is the header that gets in.
    const helper = join(home, 'claude-headers');
    expect(lstatSync(helper).mode & 0o777).toBe(0o700);
    expect(leakIn(readFileSync(helper, 'utf8'), token)).toBeNull();
    expect(helperHeader(banner.command) === `Bearer ${token}`).toBe(true);

    expect(await mcpStatus(banner.mcpUrl, {})).toBe(401);
    expect(
      await mcpStatus(banner.mcpUrl, { Authorization: `Bearer tabdock_${'x'.repeat(43)}` }),
    ).toBe(401);
    expect(
      await mcpStatus(banner.mcpUrl, { Authorization: 'Bearer alice-dev-token-6b1f0c9e4d2a7358' }),
    ).toBe(401);
    expect(
      await mcpStatus(banner.mcpUrl, {
        Authorization: `Bearer ${token}`,
        'X-Forwarded-For': '203.0.113.9',
      }),
    ).toBe(403);
    expect(await toolNames(banner.mcpUrl, token)).toEqual([
      'call_page_tool',
      'detach_page',
      'get_page_state',
      'get_proposal',
      'list_page_tools',
      'list_pages',
      'pair_page',
      'wait_for_page_state',
      'withdraw_proposal',
    ]);
    await stopAndScan(first, token);

    const second = start(['relay'], home);
    await second.waitFor('claude mcp list');
    const again = readBanner(second.stdout());
    expect(again.created).toBe(false);
    expect(second.stdout()).toContain('(kept from an earlier start)');
    expect(second.stdout()).toContain(REMOVE_FIRST);
    expect(readFileSync(again.tokenPath).equals(bytes)).toBe(true);
    expect(await toolNames(again.mcpUrl, token)).toHaveLength(FIXED_TOOL_COUNT);
    await stopAndScan(second, token);

    // pnpm relay --new-token (ADR 0028): the same command and helper, a new token.
    const third = start(['relay', '--new-token'], home);
    await third.waitFor('claude mcp list');
    const replaced = readBanner(third.stdout());
    expect(replaced.created).toBe(true);
    expect(replaced.command).toBe(addJsonLine(replaced.mcpUrl, home));
    expect(third.stdout()).toContain("Claude Code's entry needs no change");
    const newToken = readFileSync(replaced.tokenPath, 'latin1').trim();
    expect(newToken === token).toBe(false);
    expect(helperHeader(replaced.command) === `Bearer ${newToken}`).toBe(true);
    expect(await mcpStatus(replaced.mcpUrl, { Authorization: `Bearer ${token}` })).toBe(401);
    expect(await toolNames(replaced.mcpUrl, newToken)).toHaveLength(FIXED_TOOL_COUNT);
    await stopAndScan(third, newToken);
    expect(leakIn(third.stdout() + third.stderr(), token)).toBeNull();
  }, 90_000);

  it('a first start that cannot listen keeps the token it drew, and the next says how to replace an older entry', async () => {
    const home = freshHome();
    // Another relay, or one still closing after a rotation, holds the port.
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
    const address = busy.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    let failed: Run;
    try {
      failed = runPnpm(['relay'], {
        ...blankEnv(),
        TABDOCK_HOME: home,
        TABDOCK_PORT: String(port),
      });
      runs.push(failed);
      expect(await failed.exited).toBe(1);
    } finally {
      await new Promise((resolve) => busy.close(resolve));
    }
    expect(failed.stderr()).toContain('EADDRINUSE');
    expect(failed.stdout()).not.toContain('claude mcp add');
    // Left in place: a start racing this one may already serve it.
    const bytes = readFileSync(join(home, 'owner-token'));
    const token = bytes.toString('latin1').trim();

    const next = start(['relay'], home);
    await next.waitFor('claude mcp list');
    const banner = readBanner(next.stdout());
    expect(banner.created).toBe(false);
    // No start served this token before, so Claude Code may hold an older one
    // under tabdock-local, which claude mcp add will not overwrite.
    expect(next.stdout()).toContain(REMOVE_FIRST);
    expect(readFileSync(banner.tokenPath).equals(bytes)).toBe(true);
    expect(await toolNames(banner.mcpUrl, token)).toHaveLength(FIXED_TOOL_COUNT);
    expect(leakIn(failed.stdout(), token), 'stdout').toBeNull();
    expect(leakIn(failed.stderr(), token), 'stderr').toBeNull();
    await stopAndScan(next, token);
  }, 60_000);

  it('pnpm dev adds the demo board, with the same banner and nothing secret', async () => {
    const home = freshHome();
    const run = start(['dev'], home);
    await run.waitFor('Relay logs follow');
    const printed = run.stdout();
    const banner = readBanner(printed);
    expect(banner.created).toBe(true);
    expect(banner.command).toBe(addJsonLine(banner.mcpUrl, home));
    const demoLink = /Demo board linked to the relay: (\S+)/.exec(printed)?.[1] ?? '';
    expect(new URL(demoLink).searchParams.get('relay')).toBe(banner.pageUrl);
    expect((await fetch(demoLink)).status).toBe(200);
    // The board dials only once its visitor clicks (ADR 0029), so the line
    // under its link says so, naming the host the Connect bar names.
    const lines = printed.split('\n');
    const linkLine = lines.findIndex((line) => line.includes('Demo board linked to the relay:'));
    expect(lines[linkLine + 1]?.trim()).toBe(
      `(it dials the relay once you click Connect to ${new URL(banner.pageUrl).host} on it)`,
    );
    const token = readFileSync(banner.tokenPath, 'latin1').trim();
    expect(helperHeader(banner.command) === `Bearer ${token}`).toBe(true);
    expect(await toolNames(banner.mcpUrl, token)).toHaveLength(FIXED_TOOL_COUNT);
    expect(
      await mcpStatus(banner.mcpUrl, {
        Authorization: `Bearer ${token}`,
        Forwarded: 'for=203.0.113.9',
      }),
    ).toBe(403);
    await stopAndScan(run, token);
  }, 60_000);

  it('pnpm spike:latency reads the owner token from its file, and never creates one', async () => {
    const home = freshHome();
    const latency = (mcpUrl: string): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            join(ROOT, 'scripts/spike/latency.ts'),
            '--url',
            mcpUrl,
            '--warmup',
            '0',
            '--calls',
            '1',
          ],
          {
            cwd: ROOT,
            env: { ...blankEnv(), TABDOCK_HOME: home },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let output = '';
        child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
        child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
        child.on('error', reject);
        child.on('close', (code) => {
          resolve({ code, output });
        });
      });
    const before = await latency(`http://127.0.0.1:${String(await freePort())}/mcp`);
    expect(before.code).toBe(1);
    expect(before.output).toContain('no owner token yet: start the relay with pnpm relay');
    expect(existsSync(home)).toBe(false);

    const lines: string[] = [];
    const relay = await createRelay({
      ...loadConfigFromEnv({ TABDOCK_HOME: home, TABDOCK_PORT: '0' }),
      logSink: (line) => {
        lines.push(line);
      },
    });
    try {
      const token = readFileSync(join(home, 'owner-token'), 'latin1').trim();
      const after = await latency(relay.mcpUrl);
      // Signed in as you, it found no page to time: the token from the file got it in.
      expect(after.code).toBe(1);
      expect(after.output).toContain('this user has 0 awake pages attached');
      expect(lines.join('\n')).not.toContain('mcp request refused');
      expect(leakIn(after.output, token)).toBeNull();
    } finally {
      await relay.close();
    }
  }, 60_000);
});

describe('reading claude mcp list, as check:claude-code:local does', () => {
  it('sees a connected server whatever mark the terminal gets, and nothing else as connected', () => {
    const line = (status: string): string =>
      `tabdock-local: http://127.0.0.1:8787/mcp (HTTP) - ${status}`;
    // U+2714 under TERM=xterm-256color and U+221A under TERM=linux, as
    // Claude Code 2.1.288 printed them in the sandbox; U+2713 besides.
    for (const mark of ['\u2714', '\u221a', '\u2713']) {
      expect(listsConnected(line(`${mark} Connected`)), mark).toBe(true);
    }
    for (const status of [
      '\u2718 Failed to connect',
      '\u00d7 Failed to connect',
      '! Needs authentication',
      'Connected',
    ]) {
      expect(listsConnected(line(status)), status).toBe(false);
    }
    expect(listsConnected('(no line for the server)')).toBe(false);
  });
});
