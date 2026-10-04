// The relay as its container image starts it, checked without Docker (CI's
// image job runs the image itself, read-only, through scripts/smoke-image.ts):
// main.ts in hosted mode from the environment alone, as on a host, serves
// /healthz and the 401 challenge naming its metadata, writes its audit files
// and nothing else in its directory, and exits 0 within 5 s of SIGTERM. Node's
// permission model cannot stand in for a read-only file system here: it
// disables fdatasync and fchmod outright, and production will not start
// without syncing relay_start, so the read-only proof stays with Docker. The
// relay picks its own port and the test reads it from its listening line, so
// no other test's relay can answer in its place; every expectation shows the
// child's output when it fails.

import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAuditLines, verifyAuditLines } from '../src/index.ts';
import { type MainProcess, startMain } from './helpers/main-process.ts';
import { PAIR_CLIENT, startProvider, type TestProvider } from './helpers/provider.ts';
import { rawRequest } from './helpers/tunnel.ts';

const PUBLIC_HOST = 'relay.readonly.test';

let main: MainProcess | undefined;
let provider: TestProvider | undefined;
const scratches: string[] = [];

afterEach(async () => {
  main?.child.kill('SIGKILL');
  main = undefined;
  await provider?.stop();
  provider = undefined;
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('main.ts in hosted mode, as the image runs it', () => {
  it('serves in hosted mode, writes only audit files, and stops within 5 s of SIGTERM', async () => {
    provider = await startProvider();
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-hosted-main-')));
    scratches.push(scratch);
    const auditDir = join(scratch, 'audit');
    const running = startMain(
      {
        NODE_ENV: 'production',
        TABDOCK_ENV: 'production',
        TABDOCK_HOST: '0.0.0.0',
        TABDOCK_PUBLIC_URL: `https://${PUBLIC_HOST}`,
        TABDOCK_OAUTH_ISSUER: provider.issuer,
        TABDOCK_OAUTH_USERS: 'sub-ro=ro:Read Only',
        TABDOCK_PAIR_CLIENT_ID: PAIR_CLIENT.clientId,
        TABDOCK_PAIR_CLIENT_SECRET: PAIR_CLIENT.clientSecret,
        TABDOCK_ALLOWED_ORIGINS: 'https://demo.readonly.test',
        TABDOCK_CLIENT_ADDRESS_HEADER: 'fly-client-ip',
        TABDOCK_AUDIT_DIR: auditDir,
      },
      ['--max-old-space-size=192'],
    );
    main = running;
    const port = await running.port;
    expect(running.output(), 'hosted mode').toContain('"mode":"hosted"');
    const base = `http://127.0.0.1:${String(port)}`;
    const health = await rawRequest(base, '/healthz');
    expect(health.status, running.output()).toBe(200);
    const challenge = await rawRequest(base, '/mcp', {
      method: 'POST',
      host: PUBLIC_HOST,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(challenge.status, running.output()).toBe(401);
    expect(challenge.headers.get('www-authenticate'), running.output()).toContain(
      `resource_metadata="https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp"`,
    );
    const stopping = Date.now();
    running.child.kill('SIGTERM');
    expect(await running.exited, running.output()).toEqual({ code: 0, signal: null });
    expect(Date.now() - stopping, running.output()).toBeLessThan(5000);
    main = undefined;
    // Nothing but the audit directory was written, and nothing but audit files stay in it.
    expect(readdirSync(scratch)).toEqual(['audit']);
    expect(readdirSync(auditDir).every((name) => /^audit-.*\.jsonl$/.test(name))).toBe(true);
    const report = verifyAuditLines(readAuditLines(auditDir));
    expect(report, running.output()).toMatchObject({ records: 2, problems: [] });
    expect(running.output()).not.toContain(PAIR_CLIENT.clientSecret);
  }, 30_000);
});
