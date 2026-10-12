// The copied check's Playwright config (ADR 0041). Its specs' settings check,
// checkSettings in src/tabdock.ts, refuses CI_CHECK_PAGE_URL unset or empty,
// yet the page server once fell back to http://127.0.0.1:5180/ and waited out
// Playwright's server timeout on a URL nothing serves before any spec could
// say so. With the URL unset or empty, the page server's command now exits at
// once saying to set it, whatever CI_CHECK_PAGE_COMMAND holds; an unset
// repository variable reaches a workflow's env as an empty string. Playwright
// probes a server's URL before it runs the command, and a URL that answers
// stops the run as "already used", so the address the config falls back on
// must be one no page is served at: never a port guide page 17's workflow
// or this repository's own check serves the page or the relay on.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface WebServer {
  readonly name?: string;
  readonly command: string;
  readonly url?: string;
}

/** The config's page server, read afresh under these settings. */
async function pageServer(env: Record<string, string | undefined>): Promise<WebServer> {
  vi.resetModules();
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const { default: config } = await import('../playwright.config.ts');
  const servers = [config.webServer ?? []].flat() as WebServer[];
  const page = servers.find((server) => server.name === 'page');
  if (page === undefined) throw new Error('playwright.config.ts has no page server');
  return page;
}

/** The command as Playwright runs it, through a shell. */
function run(command: string): { status: number | null; stderr: string } {
  const ran = spawnSync('sh', ['-c', command], { encoding: 'utf8', timeout: 10_000 });
  return { status: ran.status, stderr: ran.stderr.trim() };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the copied check's page server", () => {
  for (const [what, url] of [
    ['unset', undefined],
    ['empty', ''],
  ] as const) {
    it(`stops at once saying to set CI_CHECK_PAGE_URL when it is ${what}, a page command or not`, async () => {
      for (const command of ['exit 0', undefined]) {
        const page = await pageServer({ CI_CHECK_PAGE_URL: url, CI_CHECK_PAGE_COMMAND: command });
        expect(run(page.command)).toEqual({ status: 1, stderr: 'set CI_CHECK_PAGE_URL' });
        // Playwright still needs an address to read; nothing is served there.
        expect(URL.canParse(page.url ?? '')).toBe(true);
      }
    });
  }

  it('falls back on an address no page or relay of the guide or this repository is served at', async () => {
    const fallback = new URL((await pageServer({ CI_CHECK_PAGE_URL: '' })).url ?? '');
    const guide = readFileSync(
      new URL('../../../docs/guide/17-check-from-ci.md', import.meta.url),
      'utf8',
    );
    // The guide's workflow: the page's --port and its URL, read so a new example is held too.
    const inGuide = [
      ...[...guide.matchAll(/--port (\d+)/g)].map((match) => match[1]),
      ...[...guide.matchAll(/https?:\/\/[\w.-]+:(\d+)/g)].map((match) => match[1]),
    ];
    expect(inGuide).toContain('5180');
    // pnpm ci-check's page (scripts/ci-check.ts), the map page's own default, and the relay's.
    const served = new Set([...inGuide, '5180', '5174', '8787']);
    expect(served.has(fallback.port)).toBe(false);
    // And nothing answers there now, so Playwright's probe finds it free and runs the command.
    const refused = await new Promise<string>((resolve) => {
      const socket = connect({ host: fallback.hostname, port: Number(fallback.port) });
      socket.once('connect', () => {
        socket.destroy();
        resolve('connected');
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        resolve(error.code ?? 'error');
      });
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  it('stops at once saying to set CI_CHECK_PAGE_COMMAND when only the URL is set', async () => {
    const page = await pageServer({
      CI_CHECK_PAGE_URL: 'http://127.0.0.1:5180/',
      CI_CHECK_PAGE_COMMAND: undefined,
    });
    expect(run(page.command)).toEqual({ status: 1, stderr: 'set CI_CHECK_PAGE_COMMAND' });
  });

  it('serves the page with the command and at the address given', async () => {
    const page = await pageServer({
      CI_CHECK_PAGE_URL: 'http://localhost:4173/map/',
      CI_CHECK_PAGE_COMMAND: 'pnpm --filter my-app preview',
    });
    expect(page).toMatchObject({
      command: 'pnpm --filter my-app preview',
      url: 'http://localhost:4173/map/',
    });
  });
});
