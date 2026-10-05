// A stand-in for the npm registry that serves packed tarballs the way
// registry.npmjs.org serves them once published, for pack-install.ts and its
// tests (ADR 0028's notes). The detail that matters is `_hasShrinkwrap`: the
// registry sets it on every version whose tarball holds npm-shrinkwrap.json,
// and npm then installs that package's dependencies from the shrinkwrap alone
// (Arborist skips such a node when it builds the tree and reads the file in
// its place), so a dependency the shrinkwrap leaves out is never installed.
// An install from local tarballs never sets it (pacote does not, for a file),
// which is how a relay missing @tabdock/protocol passed CI and would have
// failed `npx @tabdock/relay`. Each packument here reads `_hasShrinkwrap` from
// its tarball, so an install through this registry takes the path a person's
// does.
//
// It must be npm's default registry for an install, not a scoped one: npm
// rewrites a shrinkwrap's https://registry.npmjs.org/ URLs to the default
// registry (`replace-registry-host`), which is how the relay's pinned
// @tabdock/protocol tarball is fetched from here. Every other request is
// redirected to `upstream` when one is given, the real registry, and answered
// 404 otherwise. Nothing here publishes anything.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/** What a packument needs from a tarball's package.json; the rest is passed on as npm wrote it. */
const ManifestSchema = z.looseObject({
  name: z.string().regex(/^@[a-z0-9-]+\/[a-z0-9-]+$/),
  version: z.string(),
});

interface Served {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
  hasShrinkwrap: boolean;
  bytes: Buffer;
  /** The tarball's path on this registry, as registry.npmjs.org spells it. */
  path: string;
}

export interface LocalRegistry {
  /** The registry's base URL, with a trailing slash, as npm's `registry` setting takes it. */
  readonly url: string;
  /** Every path asked for, in order, for a check to read. */
  requests(): string[];
  close(): Promise<void>;
}

function read(tarball: string): Served {
  const listed = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`cannot list ${tarball}`);
  const manifestText = spawnSync('tar', ['-xzOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
  });
  if (manifestText.status !== 0) throw new Error(`${tarball} holds no package/package.json`);
  const manifest = ManifestSchema.parse(JSON.parse(manifestText.stdout));
  const scoped = manifest.name.slice(manifest.name.indexOf('/') + 1);
  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
    hasShrinkwrap: listed.stdout.split('\n').includes('package/npm-shrinkwrap.json'),
    bytes: readFileSync(tarball),
    path: `/${manifest.name}/-/${scoped}-${manifest.version}.tgz`,
  };
}

/** The registry's document for one package: every served version, newest last. */
function packument(base: string, versions: readonly Served[]): string {
  const latest = versions.at(-1);
  const now = new Date().toISOString();
  return JSON.stringify({
    _id: latest?.name,
    name: latest?.name,
    'dist-tags': { latest: latest?.version },
    versions: Object.fromEntries(
      versions.map((served) => [
        served.version,
        {
          ...served.manifest,
          _id: `${served.name}@${served.version}`,
          _hasShrinkwrap: served.hasShrinkwrap,
          dist: {
            tarball: `${base}${served.path}`,
            integrity: `sha512-${createHash('sha512').update(served.bytes).digest('base64')}`,
            shasum: createHash('sha1').update(served.bytes).digest('hex'),
          },
        },
      ]),
    ),
    time: {
      created: now,
      modified: now,
      ...Object.fromEntries(versions.map((served) => [served.version, now])),
    },
  });
}

/** Starts the registry on a free loopback port, serving `tarballs` and sending the rest to `upstream`. */
export async function startLocalRegistry(
  tarballs: readonly string[],
  upstream?: string,
): Promise<LocalRegistry> {
  const served = tarballs.map(read);
  const byName = new Map<string, Served[]>();
  for (const entry of served) byName.set(entry.name, [...(byName.get(entry.name) ?? []), entry]);
  const asked: string[] = [];
  let base = '';
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://registry.invalid');
    // npm asks for a scoped package's document as /@scope%2fname.
    const path = decodeURIComponent(url.pathname);
    asked.push(path);
    const tarball = served.find((entry) => entry.path === path);
    if (tarball !== undefined) {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': tarball.bytes.byteLength,
      });
      response.end(tarball.bytes);
      return;
    }
    const versions = byName.get(path.slice(1));
    if (versions !== undefined) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(packument(base, versions));
      return;
    }
    if (upstream !== undefined) {
      response.writeHead(302, {
        Location: `${upstream.replace(/\/$/, '')}${url.pathname}${url.search}`,
      });
      response.end();
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not found"}');
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, '127.0.0.1', resolveListen);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url: `${base}/`,
    requests: () => [...asked],
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => {
          resolveClose();
        });
      }),
  };
}

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command without blocking this process, which serves the registry it
 * installs from: spawnSync would hold the event loop, and npm would wait on a
 * registry that cannot answer.
 */
export function runAsync(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<Ran> {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 300_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveRun({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

/**
 * The environment for an npm or npx run that installs from `registry` alone,
 * with a cache and user configuration of its own, so nothing a developer's
 * machine has cached or configured stands in for what the registry serves.
 */
export function npmEnvFor(
  registry: LocalRegistry,
  scratch: { cache: string; userconfig: string },
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(
    Object.entries(base).filter(([name]) => !/^npm_config_/i.test(name)),
  );
  return {
    ...kept,
    // The proxy settings the machine gives npm stay, so the upstream is reachable.
    ...Object.fromEntries(
      Object.entries(base).filter(([name]) =>
        /^npm_config_(?:https_proxy|proxy|noproxy)$/i.test(name),
      ),
    ),
    npm_config_registry: registry.url,
    npm_config_cache: scratch.cache,
    npm_config_userconfig: scratch.userconfig,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_yes: 'true',
  };
}
