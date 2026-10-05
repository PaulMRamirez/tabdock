// Why the relay's shrinkwrap must hold @tabdock/protocol (ADR 0028's notes),
// shown with npm itself: a package from a registry that marks it
// `_hasShrinkwrap` gets its dependencies from its npm-shrinkwrap.json alone,
// so one the file leaves out is never installed, and `npx` fails to import
// it. Two tiny packages stand in for the relay and the protocol, served by
// scripts/local-registry.ts, the registry pack-install.ts installs the real
// tarballs through, so nothing here reaches the network. The same tree with
// the protocol pinned by its registry URL and integrity installs and runs,
// and release-check's rule finds exactly the entry the failing tree lacks.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { missingFromShrinkwrap } from '../../../scripts/release-check.ts';
import {
  type LocalRegistry,
  npmEnvFor,
  runAsync,
  startLocalRegistry,
} from '../scripts/local-registry.ts';

const scratches: string[] = [];
const registries: LocalRegistry[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) await registry.close();
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tabdock-shrinkwrap-install-')));
  scratches.push(dir);
  return dir;
}

/** A tarball of `files` under package/, as npm and pnpm pack one. */
function tarball(out: string, name: string, files: Record<string, string>): string {
  const stage = join(out, `stage-${name}`);
  for (const [path, contents] of Object.entries(files)) {
    const file = join(stage, 'package', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
  const file = join(out, `tabdock-${name}-0.0.0.tgz`);
  expect(spawnSync('tar', ['-czf', file, '-C', stage, 'package']).status).toBe(0);
  rmSync(stage, { recursive: true, force: true });
  return file;
}

type Packages = Record<string, Record<string, unknown>>;

/** The stand-in protocol, and a relay whose shrinkwrap pins the protocol or leaves it out. */
function packed(out: string, pinProtocol: boolean): { files: string[]; packages: Packages } {
  const protocol = tarball(out, 'protocol', {
    'package.json': JSON.stringify({
      name: '@tabdock/protocol',
      version: '0.0.0',
      type: 'module',
      exports: './index.js',
    }),
    'index.js': "export const SUBPROTOCOL = 'tabdock.v1';\n",
  });
  const packages: Packages = {
    '': {
      name: '@tabdock/relay',
      version: '0.0.0',
      bin: { 'tabdock-relay': './cli.js' },
      dependencies: { '@tabdock/protocol': '0.0.0' },
    },
  };
  if (pinProtocol) {
    packages['node_modules/@tabdock/protocol'] = {
      version: '0.0.0',
      resolved: 'https://registry.npmjs.org/@tabdock/protocol/-/protocol-0.0.0.tgz',
      integrity: `sha512-${createHash('sha512').update(readFileSync(protocol)).digest('base64')}`,
    };
  }
  const relay = tarball(out, 'relay', {
    'package.json': JSON.stringify({
      name: '@tabdock/relay',
      version: '0.0.0',
      type: 'module',
      bin: { 'tabdock-relay': './cli.js' },
      dependencies: { '@tabdock/protocol': '0.0.0' },
    }),
    'cli.js':
      "#!/usr/bin/env node\nimport { SUBPROTOCOL } from '@tabdock/protocol';\nconsole.log(SUBPROTOCOL);\n",
    'npm-shrinkwrap.json': JSON.stringify({
      name: '@tabdock/relay',
      version: '0.0.0',
      lockfileVersion: 3,
      requires: true,
      packages,
    }),
  });
  return { files: [protocol, relay], packages };
}

/** `npx @tabdock/relay@0.0.0` through the registry, with a cache and configuration of its own. */
async function npx(
  base: string,
  registry: LocalRegistry,
): Promise<{ status: number | null; out: string }> {
  const cwd = join(base, 'cwd');
  mkdirSync(cwd);
  writeFileSync(join(base, 'npmrc'), '');
  const env = npmEnvFor(registry, { cache: join(base, 'cache'), userconfig: join(base, 'npmrc') });
  const ran = await runAsync('npx', ['--yes', '@tabdock/relay@0.0.0'], {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  return { status: ran.status, out: `${ran.stdout}\n${ran.stderr}` };
}

describe('a shrinkwrapped package from a registry (ADR 0028)', () => {
  it('serves the shrinkwrap mark from each tarball, as the npm registry does', async () => {
    const out = scratch();
    const { files } = packed(out, true);
    const registry = await startLocalRegistry(files);
    registries.push(registry);
    const relay = (await (await fetch(`${registry.url}@tabdock%2frelay`)).json()) as {
      versions: Record<string, { _hasShrinkwrap: boolean; dist: { tarball: string } }>;
    };
    expect(relay.versions['0.0.0']?._hasShrinkwrap).toBe(true);
    expect(relay.versions['0.0.0']?.dist.tarball).toBe(
      `${registry.url}@tabdock/relay/-/relay-0.0.0.tgz`,
    );
    const protocol = (await (await fetch(`${registry.url}@tabdock%2fprotocol`)).json()) as {
      versions: Record<string, { _hasShrinkwrap: boolean }>;
    };
    expect(protocol.versions['0.0.0']?._hasShrinkwrap).toBe(false);
    expect((await fetch(`${registry.url}zod`)).status).toBe(404);
  });

  it('never installs a dependency its shrinkwrap leaves out, so npx cannot import it', async () => {
    const out = scratch();
    const { files, packages } = packed(out, false);
    const registry = await startLocalRegistry(files);
    registries.push(registry);
    const ran = await npx(out, registry);
    expect(ran.status, ran.out).not.toBe(0);
    expect(ran.out).toContain("Cannot find package '@tabdock/protocol'");
    expect(registry.requests()).not.toContain('/@tabdock/protocol/-/protocol-0.0.0.tgz');
    // release-check refuses this tree, naming what npm would leave out.
    expect(missingFromShrinkwrap(packages as Parameters<typeof missingFromShrinkwrap>[0])).toEqual([
      'npm-shrinkwrap.json leaves out @tabdock/protocol, which @tabdock/relay depends on, so npm would never install it',
    ]);
  }, 150_000);

  it('installs and runs with the protocol pinned by its registry URL and integrity', async () => {
    const out = scratch();
    const { files, packages } = packed(out, true);
    const registry = await startLocalRegistry(files);
    registries.push(registry);
    const ran = await npx(out, registry);
    expect(ran.status, ran.out).toBe(0);
    expect(ran.out.trim().split('\n')[0]).toBe('tabdock.v1');
    // npm took the pinned registry URL to the registry it was given.
    expect(registry.requests()).toContain('/@tabdock/protocol/-/protocol-0.0.0.tgz');
    expect(missingFromShrinkwrap(packages as Parameters<typeof missingFromShrinkwrap>[0])).toEqual(
      [],
    );
  }, 150_000);
});
