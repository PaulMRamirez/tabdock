// The relay as its container image starts it, checked without Docker (CI's
// image job runs the image itself, read-only, through scripts/smoke-image.ts):
// main.ts in hosted mode from the environment alone, as on a host, serves
// /healthz and the 401 challenge naming its metadata, writes its audit files
// and nothing else in its directory, and exits 0 within 5 s of SIGTERM. Node's
// permission model cannot stand in for a read-only file system here: it
// disables fdatasync and fchmod outright, and production will not start
// without syncing relay_start, so the read-only proof stays with Docker.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditLines, verifyAuditLines } from '../src/index.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { rawRequest } from './helpers/tunnel.ts';

const MAIN = resolve(import.meta.dirname, '../src/main.ts');
const PUBLIC_HOST = 'relay.readonly.test';

let child: ChildProcess | undefined;
let provider: TestProvider | undefined;
const scratches: string[] = [];

afterEach(async () => {
  child?.kill('SIGKILL');
  child = undefined;
  await provider?.stop();
  provider = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolvePort(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

describe('main.ts in hosted mode, as the image runs it', () => {
  it('serves in hosted mode, writes only audit files, and stops within 5 s of SIGTERM', async () => {
    provider = await startProvider();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-hosted-main-')));
    scratches.push(scratch);
    const auditDir = join(scratch, 'audit');
    const port = await freePort();
    const output: string[] = [];
    child = spawn(process.execPath, ['--max-old-space-size=192', MAIN], {
      // Only what the image's environment would hold; no inherited TABDOCK_HOME or .env settings matter.
      env: {
        PATH: process.env.PATH,
        NODE_ENV: 'production',
        TABDOCK_ENV: 'production',
        TABDOCK_HOST: '0.0.0.0',
        TABDOCK_PORT: String(port),
        TABDOCK_PUBLIC_URL: `https://${PUBLIC_HOST}`,
        TABDOCK_OAUTH_ISSUER: provider.issuer,
        TABDOCK_OAUTH_USERS: 'sub-ro=ro:Read Only',
        TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
        TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
        TABDOCK_ALLOWED_ORIGINS: 'https://demo.readonly.test',
        TABDOCK_CLIENT_ADDRESS_HEADER: 'fly-client-ip',
        TABDOCK_AUDIT_DIR: auditDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
    const exited = new Promise<number | null>((resolveExit) => {
      child?.once('exit', (code) => {
        resolveExit(code);
      });
    });
    const base = `http://127.0.0.1:${String(port)}`;
    const until = Date.now() + 20_000;
    let healthy = false;
    while (!healthy && Date.now() < until) {
      healthy = await rawRequest(base, '/healthz').then(
        (answer) => answer.status === 200,
        () => false,
      );
      if (!healthy) await new Promise((wait) => setTimeout(wait, 100));
    }
    expect(healthy, output.join('')).toBe(true);
    const challenge = await rawRequest(base, '/mcp', {
      method: 'POST',
      host: PUBLIC_HOST,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(
      `resource_metadata="https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp"`,
    );
    const stopping = Date.now();
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(Date.now() - stopping).toBeLessThan(5000);
    child = undefined;
    // Nothing but the audit directory was written.
    expect(readdirSync(scratch)).toEqual(['audit']);
    const report = verifyAuditLines(readAuditLines(auditDir));
    expect(report).toMatchObject({ records: 2, problems: [] });
    expect(output.join('')).not.toContain(PAIR_CLIENT.clientSecret);
  }, 30_000);
});
