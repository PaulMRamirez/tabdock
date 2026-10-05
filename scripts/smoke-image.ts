// node scripts/smoke-image.ts <image>: runs the relay's container image the
// way a host would, against a stand-in identity provider, and checks what CI
// must prove before an image is published (.github/workflows/image.yml):
// the relay's user (uid 65532) owns nothing under /app and cannot write
// there even on a writable root file system, as Fly runs it, so it can never
// swap its own code; the image starts in hosted mode with a read-only root
// file system, no capabilities and only its audit volume writable; /healthz answers 200 for
// any Host, as a platform's health check sends; /mcp answers 401 naming its
// resource_metadata for the public host and 403 for any other; SIGTERM ends it
// within 5 s with exit code 0; and its audit log, read back by the image's own
// pnpm audit:log, holds relay_start and relay_stop with an intact chain. The
// volume starts owned by root, as a host's may, and is handed to uid 65532 by
// the same one-off chown docs/deploy.md describes. Needs Docker and the
// workspace's dev dependencies (for the stand-in provider); prints no secret.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIR_CLIENT, startProvider } from '../packages/relay/test/helpers/provider.ts';

const image = process.argv[2];
if (image === undefined || image.startsWith('-')) {
  process.stderr.write('usage: node scripts/smoke-image.ts <image>\n');
  process.exit(2);
}

const PUBLIC_HOST = 'relay.smoke.test';
const STOP_WITHIN_MS = 5000;
const START_WITHIN_MS = 30_000;
const run = `tabdock-smoke-${String(process.pid)}`;
const volume = `${run}-audit`;

/**
 * Run inside the image by its own user, on a root file system left writable
 * as Fly leaves it (no --read-only): every path from /app down, links not
 * followed, and those the relay's user owns; then a write into /app and one
 * into the relay's sources, each of which must fail. Owning /app alone would
 * let that user move a root-owned tree aside and copy it back as its own,
 * with any file changed, such as the audit reader the owner runs as root.
 */
const APP_PROBE = `
const fs = require('node:fs');
const owned = [];
let paths = 0;
function walk(path) {
  const stat = fs.lstatSync(path);
  paths += 1;
  if (stat.uid === 65532) owned.push(path);
  if (stat.isDirectory()) for (const name of fs.readdirSync(path)) walk(path + '/' + name);
}
walk('/app');
const writes = [];
for (const attempt of [
  () => fs.writeFileSync('/app/smoke-probe.js', ''),
  () => fs.writeFileSync('/app/packages/relay/src/smoke-probe.ts', ''),
]) {
  try {
    attempt();
    writes.push('written');
  } catch (error) {
    writes.push(error.code);
  }
}
process.stdout.write(JSON.stringify({ uid: process.getuid(), paths, owned, writes }) + '\\n');
`;

function docker(
  args: string[],
  options: { check?: boolean } = {},
): { status: number; out: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  const out = `${result.stdout}${result.stderr}`;
  if ((options.check ?? true) && result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ''} failed (${String(result.status)}): ${out.trim()}`);
  }
  return { status: result.status ?? -1, out };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

function http(
  port: number,
  path: string,
  options: { method?: string; host: string; headers?: Record<string, string>; body?: string },
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: { Host: options.host, ...options.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

function check(condition: boolean, what: string): void {
  if (!condition) throw new Error(`smoke check failed: ${what}`);
  process.stdout.write(`ok: ${what}\n`);
}

const scratch = mkdtempSync(join(tmpdir(), 'tabdock-smoke-'));
const provider = await startProvider();
let failed = false;
try {
  // The image's own user, no --read-only and no volume: what the relay could change on Fly's root.
  const probe = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    '/nodejs/bin/node',
    image,
    '-e',
    APP_PROBE,
  ]);
  const app = JSON.parse(probe.out.trim().split('\n').at(-1) ?? '{}') as {
    uid?: number;
    paths?: number;
    owned: string[];
    writes: string[];
  };
  check(
    app.uid === 65532 && app.owned.length === 0,
    `uid 65532 owns none of the ${String(app.paths ?? 0)} paths under /app, /app included${
      app.owned.length === 0 ? '' : ` (it owns ${app.owned.slice(0, 5).join(', ')})`
    }`,
  );
  check(
    app.writes.every((code) => code === 'EACCES'),
    `uid 65532 cannot write into /app or the relay's sources on a writable root (${app.writes.join(', ')})`,
  );

  const port = await freePort();
  // Settings go in through a file, never a command line; the secret is the stand-in provider's.
  const envFile = join(scratch, 'relay.env');
  writeFileSync(
    envFile,
    [
      'TABDOCK_ENV=production',
      'TABDOCK_HOST=0.0.0.0',
      `TABDOCK_PORT=${String(port)}`,
      `TABDOCK_PUBLIC_URL=https://${PUBLIC_HOST}`,
      `TABDOCK_OAUTH_ISSUER=${provider.issuer}`,
      'TABDOCK_OAUTH_USERS=smoke-sub=smoke:Smoke',
      `TABDOCK_PAIR_CLIENT_ID=${PAIR_CLIENT.clientId}`,
      `TABDOCK_PAIR_CLIENT_SECRET=${PAIR_CLIENT.clientSecret}`,
      'TABDOCK_ALLOWED_ORIGINS=https://demo.smoke.test',
      'TABDOCK_CLIENT_ADDRESS_HEADER=fly-client-ip',
      'TABDOCK_AUDIT_DIR=/data/audit',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  docker(['volume', 'create', volume]);
  // A fresh volume belongs to root, as a host's may; the fallback chown hands it to the relay's user.
  docker([
    'run',
    '--rm',
    '--user',
    '0:0',
    '--network',
    'none',
    '-v',
    `${volume}:/data`,
    '--entrypoint',
    '/nodejs/bin/node',
    image,
    '-e',
    "require('node:fs').chownSync('/data', 65532, 65532)",
  ]);

  docker([
    'run',
    '-d',
    '--name',
    run,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--network',
    'host',
    '--env-file',
    envFile,
    '-v',
    `${volume}:/data`,
    image,
  ]);

  const started = Date.now();
  let healthy = false;
  while (!healthy && Date.now() - started < START_WITHIN_MS) {
    healthy = await http(port, '/healthz', { host: 'tabdock-smoke.fly.dev' }).then(
      (answer) => answer.status === 200,
      () => false,
    );
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check(healthy, '/healthz answers 200 for the platform name');

  const challenge = await http(port, '/mcp', {
    method: 'POST',
    host: PUBLIC_HOST,
    headers: { 'Content-Type': 'application/json', 'fly-client-ip': '203.0.113.7' },
    body: '{}',
  });
  const authenticate = String(challenge.headers['www-authenticate'] ?? '');
  check(challenge.status === 401, '/mcp answers 401 without a token');
  check(
    authenticate.includes(
      `resource_metadata="https://${PUBLIC_HOST}/.well-known/oauth-protected-resource/mcp"`,
    ),
    '/mcp names its resource_metadata',
  );
  const metadata = await http(port, '/.well-known/oauth-protected-resource/mcp', {
    host: PUBLIC_HOST,
  });
  const document =
    metadata.status === 200 ? (JSON.parse(metadata.body) as Record<string, unknown>) : {};
  check(
    document.resource === `https://${PUBLIC_HOST}/mcp` &&
      Array.isArray(document.authorization_servers) &&
      document.authorization_servers.includes(provider.issuer),
    'the protected resource metadata names the connector URL and the issuer',
  );
  const other = await http(port, '/mcp', {
    method: 'POST',
    host: 'tabdock-smoke.fly.dev',
    body: '{}',
  });
  check(other.status === 403, '/mcp answers 403 to the platform name');

  const stopping = Date.now();
  docker(['kill', '--signal', 'SIGTERM', run]);
  const waited = docker(['wait', run]);
  const stoppedIn = Date.now() - stopping;
  check(waited.out.trim() === '0', 'the relay exits with code 0 on SIGTERM');
  check(
    stoppedIn <= STOP_WITHIN_MS,
    `the relay stops within 5 s of SIGTERM (${String(stoppedIn)} ms)`,
  );

  const logs = docker(['logs', run]).out;
  check(!logs.includes(PAIR_CLIENT.clientSecret), 'no log line holds the /pair client secret');

  const verify = docker(
    [
      'run',
      '--rm',
      '--read-only',
      '--network',
      'none',
      '-v',
      `${volume}:/data`,
      image,
      'packages/relay/src/audit-cli.ts',
      '--dir',
      '/data/audit',
      '--verify',
    ],
    { check: false },
  );
  check(verify.status === 0, 'pnpm audit:log --verify finds the chain intact');
  check(
    / relay_start\b/.test(verify.out) && / relay_stop\b/.test(verify.out),
    'the audit log holds relay_start and relay_stop',
  );
} catch (error) {
  failed = true;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  const logs = docker(['logs', run], { check: false }).out;
  if (logs.trim() !== '') process.stderr.write(`relay logs:\n${logs}\n`);
} finally {
  docker(['rm', '-f', run], { check: false });
  docker(['volume', 'rm', '-f', volume], { check: false });
  await provider.stop();
  rmSync(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
