// Writes packages/relay/npm-shrinkwrap.json for the published relay (ADR
// 0028), so `npx @tabdock/relay` installs the dependency tree this workspace
// tested, as npm recommends for a command-line tool. It is made at pack time
// and never committed: release-pack.ts packs the protocol, writes this, packs
// the relay, and removes it.
//   node packages/relay/scripts/shrinkwrap.ts <packed @tabdock/protocol tarball>
//
// npm writes the file, not this script: in a scratch directory it resolves
// the relay's dependencies with `npm install --package-lock-only`, every
// package pinned through `overrides` to the version pnpm resolved here, and
// the result is then checked package by package against pnpm's tree, so a
// version npm would pick differently stops the release instead of shipping.
//
// The shrinkwrap must hold every package the relay needs, @tabdock/protocol
// included: npm installs a registry package that carries a shrinkwrap from
// that file alone and never resolves anything it leaves out, so a relay
// without the protocol in it fails to start from npx (ADR 0028's notes). The
// protocol is not published yet when this runs, so npm resolves it from the
// tarball release-pack.ts has just packed, the very file the stage job
// publishes, and its entry then names the registry URL that tarball will
// have, with npm's own sha512 of it, so an install fetches exactly those
// bytes or fails. The root entry is made to match the packed package.json.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';

const RELAY_DIR = resolve(import.meta.dirname, '..');
export const SHRINKWRAP_FILE = join(RELAY_DIR, 'npm-shrinkwrap.json');

const ManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z.string(),
  dependencies: z.record(z.string(), z.string()),
  engines: z.record(z.string(), z.string()).optional(),
  publishConfig: z.object({ bin: z.record(z.string(), z.string()).optional() }).optional(),
});

interface ListedNode {
  version: string;
  dependencies?: Record<string, ListedNode> | undefined;
}
const ListedNodeSchema: z.ZodType<ListedNode> = z.lazy(() =>
  z.object({
    version: z.string(),
    dependencies: z.record(z.string(), ListedNodeSchema).optional(),
  }),
);
const ListedSchema = z.array(
  z.object({
    name: z.literal('@tabdock/relay'),
    dependencies: z.record(z.string(), ListedNodeSchema),
  }),
);

const LockSchema = z.object({
  lockfileVersion: z.literal(3),
  packages: z.record(
    z.string(),
    z.looseObject({
      version: z.string().optional(),
      resolved: z.string().optional(),
      integrity: z.string().optional(),
    }),
  ),
});

/** pnpm as this script was run with, when it was, else whatever `pnpm` is on the PATH. */
function pnpm(args: string[], cwd: string): string {
  const execPath = process.env.npm_execpath ?? '';
  const [command, prefix] = basename(execPath).startsWith('pnpm')
    ? [process.execPath, [execPath]]
    : ['pnpm', []];
  const ran = spawnSync(command, [...prefix, ...args], { cwd, encoding: 'utf8' });
  if (ran.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed:\n${ran.stderr}`);
  return ran.stdout;
}

/** Every package in the relay's production tree, by name, with the one version pnpm resolved. */
function pnpmVersions(): Map<string, string> {
  const listed = ListedSchema.parse(
    JSON.parse(
      pnpm(
        ['--filter', '@tabdock/relay', 'list', '--prod', '--depth', 'Infinity', '--json'],
        RELAY_DIR,
      ),
    ),
  );
  const versions = new Map<string, Set<string>>();
  const walk = (dependencies: Record<string, ListedNode>): void => {
    for (const [name, node] of Object.entries(dependencies)) {
      if (!name.startsWith('@tabdock/')) {
        const seen = versions.get(name) ?? new Set<string>();
        seen.add(node.version);
        versions.set(name, seen);
      }
      walk(node.dependencies ?? {});
    }
  };
  for (const root of listed) walk(root.dependencies);
  const single = new Map<string, string>();
  for (const [name, seen] of versions) {
    const [only, ...others] = [...seen];
    if (only === undefined || others.length > 0) {
      throw new Error(
        `${name} resolves to more than one version (${[...seen].join(', ')}); the shrinkwrap pins one per package, so pin it in the workspace first`,
      );
    }
    single.set(name, only);
  }
  return single;
}

/** Where a published @tabdock package's tarball lives on the npm registry. */
export function registryTarballUrl(name: string, version: string): string {
  return `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`;
}

/** The sha512 integrity of a tarball's bytes, as npm records and checks it. */
export function tarballIntegrity(bytes: Buffer): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

/**
 * Makes the shrinkwrap; returns its path. Needs the npm registry. `siblings`
 * names the packed tarball of each @tabdock package the relay depends on,
 * which this release publishes beside it.
 */
export function writeShrinkwrap(siblings: Readonly<Record<string, string>>): string {
  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(join(RELAY_DIR, 'package.json'), 'utf8')),
  );
  const versions = pnpmVersions();
  const ours = Object.keys(manifest.dependencies).filter((name) => name.startsWith('@tabdock/'));
  const unpacked = ours.filter((name) => siblings[name] === undefined);
  if (unpacked.length > 0) {
    throw new Error(
      `the relay depends on ${unpacked.join(', ')}, whose packed tarball the shrinkwrap needs`,
    );
  }
  const direct = Object.fromEntries(
    Object.entries(manifest.dependencies).filter(([name]) => !name.startsWith('@tabdock/')),
  );
  const overrides = Object.fromEntries(
    [...versions].filter(([name]) => !(name in direct)).sort(([a], [b]) => a.localeCompare(b)),
  );
  const tarballs = new Map(ours.map((name) => [name, resolve(siblings[name] ?? '')]));
  const scratch = mkdtempSync(join(tmpdir(), 'tabdock-shrinkwrap-'));
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      `${JSON.stringify(
        {
          name: manifest.name,
          version: manifest.version,
          private: true,
          dependencies: {
            ...direct,
            ...Object.fromEntries([...tarballs].map(([name, file]) => [name, `file:${file}`])),
          },
          overrides,
        },
        null,
        2,
      )}\n`,
    );
    const ran = spawnSync(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--lockfile-version=3',
      ],
      { cwd: scratch, encoding: 'utf8', shell: process.platform === 'win32' },
    );
    if (ran.status !== 0) throw new Error(`npm install --package-lock-only failed:\n${ran.stderr}`);
    const lock = LockSchema.parse(
      JSON.parse(readFileSync(join(scratch, 'package-lock.json'), 'utf8')),
    );
    const found = new Set<string>();
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (path === '') continue;
      const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const tarball = tarballs.get(name);
      if (tarball !== undefined) {
        // npm took it from the packed file; the published copy is those bytes at the registry.
        const integrity = tarballIntegrity(readFileSync(tarball));
        if (
          path !== `node_modules/${name}` ||
          entry.version !== manifest.version ||
          entry.integrity !== integrity
        ) {
          throw new Error(
            `npm placed ${name}@${entry.version ?? '?'} at ${path}, not the packed ${name}@${manifest.version} beside the relay`,
          );
        }
        entry.resolved = registryTarballUrl(name, manifest.version);
        found.add(name);
        continue;
      }
      const want = versions.get(name);
      if (want === undefined || entry.version !== want) {
        throw new Error(
          `npm placed ${name}@${entry.version ?? '?'} at ${path}, which pnpm's tree does not hold`,
        );
      }
      if (
        !entry.resolved?.startsWith('https://registry.npmjs.org/') ||
        entry.integrity === undefined
      ) {
        throw new Error(`${path} is not pinned to a registry tarball with its integrity`);
      }
      found.add(name);
    }
    const missing = [...versions.keys(), ...tarballs.keys()].filter((name) => !found.has(name));
    if (missing.length > 0)
      throw new Error(`npm left out ${missing.join(', ')}, which pnpm's tree holds`);
    const bin = manifest.publishConfig?.bin;
    lock.packages[''] = {
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      ...(bin === undefined ? {} : { bin }),
      dependencies: Object.fromEntries(
        Object.entries(manifest.dependencies).map(([name, spec]) => [
          name,
          spec.startsWith('workspace:') ? manifest.version : spec,
        ]),
      ),
      ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    };
    const shrinkwrap = {
      name: manifest.name,
      version: manifest.version,
      ...lock,
      packages: lock.packages,
    };
    writeFileSync(SHRINKWRAP_FILE, `${JSON.stringify(shrinkwrap, null, 2)}\n`);
    return SHRINKWRAP_FILE;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const protocol = process.argv[2];
  if (protocol === undefined) {
    throw new Error('give the packed @tabdock/protocol tarball: node shrinkwrap.ts <tarball>');
  }
  console.log(writeShrinkwrap({ '@tabdock/protocol': protocol }));
}
