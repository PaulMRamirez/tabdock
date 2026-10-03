// A4.4 from the command line (ADR 0022): `pnpm relay` and `pnpm dev`, run as
// children the way the owner runs them, with no settings but a throwaway
// TABDOCK_HOME. The first start draws the token into a private file and the
// next keeps it byte for byte; the printed `claude mcp add` line reads that
// file; only the owner token gets in, and only from this machine; and nothing
// either command prints, on stdout or stderr (where the relay's log lines go),
// holds the token, its digest or any 8-character run of its random part.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { claudeAddCommand, createRelay, loadConfigFromEnv } from '@tabdock/relay';
import { leakIn } from '@tabdock/relay/test/secrecy';
import { rawRequest } from '@tabdock/relay/test/tunnel';
import { afterEach, describe, expect, it } from 'vitest';
import { freePort } from '../src/harness.ts';
import { blankEnv, readBanner, ROOT, type Run, runPnpm } from '../src/local-harness.ts';

const scratches: string[] = [];
const runs: Run[] = [];

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
    expect(banner.command).toBe(claudeAddCommand('posix', banner.mcpUrl, banner.tokenPath));
    expect(lstatSync(home).mode & 0o777).toBe(0o700);
    expect(lstatSync(banner.tokenPath).mode & 0o777).toBe(0o600);
    const bytes = readFileSync(banner.tokenPath);
    const token = bytes.toString('latin1').trim();
    expect(/^tabdock_[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);

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
      'list_page_tools',
      'list_pages',
      'pair_page',
    ]);
    await stopAndScan(first, token);

    const second = start(['relay'], home);
    await second.waitFor('claude mcp list');
    const again = readBanner(second.stdout());
    expect(again.created).toBe(false);
    expect(second.stdout()).toContain('(kept from an earlier start)');
    expect(second.stdout()).not.toContain('claude mcp remove');
    expect(readFileSync(again.tokenPath).equals(bytes)).toBe(true);
    expect(await toolNames(again.mcpUrl, token)).toHaveLength(5);
    await stopAndScan(second, token);
  }, 60_000);

  it('pnpm dev adds the demo board, with the same banner and nothing secret', async () => {
    const home = freshHome();
    const run = start(['dev'], home);
    await run.waitFor('Relay logs follow');
    const printed = run.stdout();
    const banner = readBanner(printed);
    expect(banner.created).toBe(true);
    expect(banner.command).toBe(claudeAddCommand('posix', banner.mcpUrl, banner.tokenPath));
    const demoLink = /Demo board linked to the relay: (\S+)/.exec(printed)?.[1] ?? '';
    expect(new URL(demoLink).searchParams.get('relay')).toBe(banner.pageUrl);
    expect((await fetch(demoLink)).status).toBe(200);
    const token = readFileSync(banner.tokenPath, 'latin1').trim();
    expect(await toolNames(banner.mcpUrl, token)).toHaveLength(5);
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
