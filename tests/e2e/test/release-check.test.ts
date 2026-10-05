// The release check (ADR 0028, scripts/release-check.ts) on tarballs made
// here: three well-formed ones pass at 0.0.0, and each rule refuses the one
// thing it is there to catch, so a pack that slips a test, a .env, a token, a
// source file, an install script, a second bin or a stray dependency into a
// package, ships a shrinkwrap npm would install an incomplete tree from, or
// documents an import the package does not export never reaches the stage
// job (ADR 0028's notes). Since the A5.6 review it also refuses a dependency
// the allowlist does not name, an optional, peer or bundled one, a bin on a
// library, and a shrinkwrap entry not fetched from its own registry URL with
// a whole sha512, or that runs a script on install. The real tarballs are
// checked in CI by the pack-install job.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkRelease,
  type PackageName,
  PACKAGES,
  readmeProblems,
  REPOSITORY_URL,
  ROOT,
  RUNTIME_DEPENDENCIES,
  tarballName,
} from '../../../scripts/release-check.ts';

type Json = Record<string, unknown>;

/** A well-formed sha512 integrity, as npm writes one, standing for a package's tarball. */
function sha512(of: string): string {
  return `sha512-${createHash('sha512').update(of).digest('base64')}`;
}

interface Shrinkwrap {
  packages: Record<string, Record<string, unknown>>;
}

/** Changes the relay fixture's shrinkwrap in place. */
function editShrinkwrap(f: Record<PackageName, Fixture>, change: (s: Shrinkwrap) => void): void {
  const shrinkwrap = JSON.parse(String(f.relay.files['npm-shrinkwrap.json'])) as Shrinkwrap;
  change(shrinkwrap);
  f.relay.files['npm-shrinkwrap.json'] = JSON.stringify(shrinkwrap);
}

interface Fixture {
  files: Record<string, string | Buffer>;
  manifest: Json;
}

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const LICENSE = readFileSync(join(ROOT, 'LICENSE'));
const NOTICE = readFileSync(join(ROOT, 'NOTICE'));

function common(name: PackageName, version: string): Json {
  return {
    name: `@tabdock/${name}`,
    version,
    license: 'Apache-2.0',
    repository: { type: 'git', url: REPOSITORY_URL, directory: `packages/${name}` },
    type: 'module',
    publishConfig: { access: 'public' },
  };
}

function library(name: 'protocol' | 'adapter', version: string): Json {
  return {
    ...common(name, version),
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    types: './dist/index.d.ts',
    dependencies:
      name === 'adapter'
        ? { '@tabdock/protocol': version, 'qrcode-generator': '2.0.4', zod: '4.6.5' }
        : { zod: '4.6.5' },
  };
}

/** Three packages as release-pack.ts makes them, small enough to build in a test. */
function wellFormed(version = '0.0.0'): Record<PackageName, Fixture> {
  const base = { 'README.md': '# readme\n', LICENSE, NOTICE };
  const relayDependencies = { '@tabdock/protocol': version, ws: '8.22.0', zod: '4.6.5' };
  return {
    protocol: {
      manifest: library('protocol', version),
      files: {
        ...base,
        'dist/index.js': 'export {};\n',
        'dist/index.d.ts': 'export {};\n',
        'dist/zod-config.js': 'export {};\n',
      },
    },
    adapter: {
      manifest: library('adapter', version),
      files: {
        ...base,
        'dist/index.js': 'export {};\n',
        'dist/index.d.ts': 'export {};\n',
        'dist/tabdock-adapter.js': '(()=>{})();\n',
        'dist/tabdock-adapter.js.map': '{}\n',
      },
    },
    relay: {
      manifest: {
        ...common('relay', version),
        engines: { node: '>=22.18' },
        exports: { './package.json': './package.json' },
        bin: { 'tabdock-relay': './dist/cli.js' },
        dependencies: relayDependencies,
        scripts: { start: 'node src/main.ts' },
      },
      files: {
        ...base,
        'dist/cli.js': '#!/usr/bin/env node\nconsole.log(1);\n',
        'dist/argument-worker.js': 'export {};\n',
        'dist/pair-page/pair.html': '<!doctype html>\n',
        'dist/pair-page/invite.html': '<!doctype html>\n',
        'npm-shrinkwrap.json': JSON.stringify({
          name: '@tabdock/relay',
          version,
          lockfileVersion: 3,
          packages: {
            '': { name: '@tabdock/relay', version, dependencies: relayDependencies },
            // pack() puts the packed protocol's integrity in place of the mark.
            'node_modules/@tabdock/protocol': {
              version,
              resolved: `https://registry.npmjs.org/@tabdock/protocol/-/protocol-${version}.tgz`,
              integrity: PROTOCOL_INTEGRITY,
              dependencies: { zod: '4.6.5' },
            },
            'node_modules/ws': {
              version: '8.22.0',
              resolved: 'https://registry.npmjs.org/ws/-/ws-8.22.0.tgz',
              integrity: sha512('ws'),
            },
            'node_modules/zod': {
              version: '4.6.5',
              resolved: 'https://registry.npmjs.org/zod/-/zod-4.6.5.tgz',
              integrity: sha512('zod'),
            },
          },
        }),
      },
    },
  };
}

/** Stands for the packed protocol's integrity in a fixture's shrinkwrap until pack() knows it. */
const PROTOCOL_INTEGRITY = 'sha512-the-packed-protocol';

/**
 * Writes each fixture as a tarball, package/ and all, as npm and pnpm pack
 * them: the protocol first, as release-pack.ts does, so the relay's
 * shrinkwrap can pin that tarball's integrity.
 */
function pack(fixtures: Record<PackageName, Fixture>): string {
  const out = mkdtempSync(join(tmpdir(), 'tabdock-release-check-'));
  scratches.push(out);
  for (const name of PACKAGES) {
    const fixture = fixtures[name];
    const stage = join(out, `stage-${name}`);
    const shrinkwrap = fixture.files['npm-shrinkwrap.json'];
    if (typeof shrinkwrap === 'string' && shrinkwrap.includes(PROTOCOL_INTEGRITY)) {
      const protocolVersion = String(fixtures.protocol.manifest.version);
      const protocol = readFileSync(join(out, tarballName('protocol', protocolVersion)));
      fixture.files['npm-shrinkwrap.json'] = shrinkwrap.replace(
        PROTOCOL_INTEGRITY,
        `sha512-${createHash('sha512').update(protocol).digest('base64')}`,
      );
    }
    const files = { ...fixture.files, 'package.json': JSON.stringify(fixture.manifest, null, 2) };
    for (const [path, contents] of Object.entries(files)) {
      const file = join(stage, 'package', path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, contents);
    }
    const version = typeof fixture.manifest.version === 'string' ? fixture.manifest.version : '';
    const made = spawnSync('tar', [
      '-czf',
      join(out, tarballName(name, version)),
      '-C',
      stage,
      'package',
    ]);
    expect(made.status).toBe(0);
    rmSync(stage, { recursive: true, force: true });
  }
  return out;
}

function problemsWith(
  change: (fixtures: Record<PackageName, Fixture>) => void,
  tag?: string,
): string[] {
  const fixtures = wellFormed();
  change(fixtures);
  return checkRelease(pack(fixtures), { tag });
}

describe('the release check', () => {
  it('passes three well-formed packages at 0.0.0, and with their tag', () => {
    expect(checkRelease(pack(wellFormed()))).toEqual([]);
    expect(checkRelease(pack(wellFormed('0.1.0')), { tag: 'v0.1.0' })).toEqual([]);
  });

  const cases: [string, (f: Record<PackageName, Fixture>) => void, RegExp, string?][] = [
    [
      'a version that differs between packages',
      (f) => {
        f.relay.manifest.version = '0.0.1';
        f.relay.manifest.name = '@tabdock/relay';
      },
      /package\.json says "0\.0\.1"/,
    ],
    [
      'a tag that is not the version',
      () => undefined,
      /the tag v0\.1\.0 is not v0\.0\.0/,
      'v0.1.0',
    ],
    [
      'a test file',
      (f) => {
        f.protocol.files['dist/page-link.test.js'] = 'x';
      },
      /holds dist\/page-link\.test\.js, a test file/,
    ],
    [
      'a test directory',
      (f) => {
        f.adapter.files['test/core.js'] = 'x';
      },
      /holds test\/core\.js, a test directory/,
    ],
    [
      'a .env file',
      (f) => {
        f.relay.files['.env'] = 'TABDOCK_DEV_TOKENS=x';
      },
      /holds \.env, a \.env file/,
    ],
    [
      'an owner token',
      (f) => {
        f.relay.files['owner-token'] = 'tabdock_x';
      },
      /holds owner-token, an owner token/,
    ],
    [
      'a header helper',
      (f) => {
        f.relay.files['dist/claude-headers'] = '#!/bin/sh';
      },
      /holds dist\/claude-headers, a header helper/,
    ],
    [
      'TypeScript source',
      (f) => {
        f.relay.files['src/cli.ts'] = 'x';
      },
      /holds src\/cli\.ts, TypeScript source/,
    ],
    [
      'a file the allowlist does not name',
      (f) => {
        f.relay.files['dist/extra.js'] = 'x';
      },
      /holds dist\/extra\.js, which its allowlist does not name/,
    ],
    [
      'a missing NOTICE',
      (f) => {
        delete f.adapter.files.NOTICE;
      },
      /@tabdock\/adapter lacks NOTICE/,
    ],
    [
      'a NOTICE that is not the repository’s',
      (f) => {
        f.protocol.files.NOTICE = 'Someone else\n';
      },
      /@tabdock\/protocol's NOTICE is not the repository's/,
    ],
    [
      'another repository URL',
      (f) => {
        f.relay.manifest.repository = { type: 'git', url: 'https://github.com/someone/tabdock' };
      },
      /@tabdock\/relay's repository\.url is "https:\/\/github\.com\/someone\/tabdock"/,
    ],
    [
      'a workspace: specifier left behind',
      (f) => {
        f.adapter.manifest.dependencies = { '@tabdock/protocol': 'workspace:*' };
      },
      /still holds a workspace: specifier/,
    ],
    [
      'a range instead of an exact pin',
      (f) => {
        f.protocol.manifest.dependencies = { zod: '^4.6.5' };
      },
      /depends on zod "\^4\.6\.5", not an exact version/,
    ],
    [
      'a script npm runs on install',
      (f) => {
        f.relay.manifest.scripts = { postinstall: 'node x.js' };
      },
      /has a postinstall script/,
    ],
    [
      'a private package',
      (f) => {
        f.protocol.manifest.private = true;
      },
      /@tabdock\/protocol is marked private/,
    ],
    [
      'a second bin',
      (f) => {
        f.relay.manifest.bin = { 'tabdock-relay': './dist/cli.js', tabdock: './dist/cli.js' };
      },
      /exactly one bin, tabdock-relay/,
    ],
    [
      'a library entry point in the relay',
      (f) => {
        f.relay.manifest.exports = { '.': './dist/cli.js', './package.json': './package.json' };
      },
      /exports a library entry point/,
    ],
    [
      'a shrinkwrap that takes a package from elsewhere',
      (f) => {
        const shrinkwrap = JSON.parse(String(f.relay.files['npm-shrinkwrap.json'])) as {
          packages: Record<string, Record<string, string>>;
        };
        shrinkwrap.packages['node_modules/ws'] = {
          version: '8.22.0',
          resolved: 'file:../ws.tgz',
          integrity: 'sha512-x',
        };
        f.relay.files['npm-shrinkwrap.json'] = JSON.stringify(shrinkwrap);
      },
      /takes node_modules\/ws from "file:\.\.\/ws\.tgz", not https:\/\/registry\.npmjs\.org\/ws\/-\/ws-8\.22\.0\.tgz/,
    ],
    [
      'a shrinkwrap that leaves out @tabdock/protocol, which npm would then never install',
      (f) => {
        const shrinkwrap = JSON.parse(String(f.relay.files['npm-shrinkwrap.json'])) as {
          packages: Record<string, unknown>;
        };
        delete shrinkwrap.packages['node_modules/@tabdock/protocol'];
        f.relay.files['npm-shrinkwrap.json'] = JSON.stringify(shrinkwrap);
      },
      /npm-shrinkwrap\.json leaves out @tabdock\/protocol, which @tabdock\/relay depends on, so npm would never install it/,
    ],
    [
      'a shrinkwrap that leaves out what a package in its tree depends on',
      (f) => {
        const shrinkwrap = JSON.parse(String(f.relay.files['npm-shrinkwrap.json'])) as {
          packages: Record<string, Record<string, unknown>>;
        };
        const ws = shrinkwrap.packages['node_modules/ws'] ?? {};
        ws.dependencies = { 'not-in-the-tree': '1.0.0' };
        f.relay.files['npm-shrinkwrap.json'] = JSON.stringify(shrinkwrap);
      },
      /leaves out not-in-the-tree, which node_modules\/ws depends on/,
    ],
    [
      'a shrinkwrap that pins a protocol other than the one packed beside the relay',
      (f) => {
        f.relay.files['npm-shrinkwrap.json'] = String(f.relay.files['npm-shrinkwrap.json']).replace(
          PROTOCOL_INTEGRITY,
          'sha512-another-protocol',
        );
      },
      /pins node_modules\/@tabdock\/protocol with an integrity other than the packed @tabdock\/protocol's/,
    ],
    [
      'a shrinkwrap that takes the protocol from anywhere but its registry URL',
      (f) => {
        f.relay.files['npm-shrinkwrap.json'] = String(f.relay.files['npm-shrinkwrap.json']).replace(
          'https://registry.npmjs.org/@tabdock/protocol/-/protocol-0.0.0.tgz',
          'file:../tabdock-protocol-0.0.0.tgz',
        );
      },
      /takes node_modules\/@tabdock\/protocol from "file:\.\.\/tabdock-protocol-0\.0\.0\.tgz", not https:\/\/registry\.npmjs\.org\/@tabdock\/protocol\/-\/protocol-0\.0\.0\.tgz/,
    ],
    [
      'a runtime dependency the allowlist does not name, such as a dev-only suite',
      (f) => {
        const conformance = { '@modelcontextprotocol/conformance': '0.2.0-alpha.12' };
        f.relay.manifest.dependencies = {
          ...(f.relay.manifest.dependencies as Json),
          ...conformance,
        };
        editShrinkwrap(f, (shrinkwrap) => {
          const root = shrinkwrap.packages[''] ?? {};
          root.dependencies = { ...(root.dependencies as Json), ...conformance };
          shrinkwrap.packages['node_modules/@modelcontextprotocol/conformance'] = {
            version: '0.2.0-alpha.12',
            resolved:
              'https://registry.npmjs.org/@modelcontextprotocol/conformance/-/conformance-0.2.0-alpha.12.tgz',
            integrity: sha512('conformance'),
          };
        });
      },
      /@tabdock\/relay depends on @modelcontextprotocol\/conformance, which its allowlist of runtime dependencies does not name/,
    ],
    [
      "a dependency another package may have but this one's allowlist does not name",
      (f) => {
        f.protocol.manifest.dependencies = { zod: '4.6.5', ws: '8.22.0' };
      },
      /@tabdock\/protocol depends on ws, which its allowlist of runtime dependencies does not name/,
    ],
    [
      'optional dependencies, which npm installs when it can',
      (f) => {
        f.adapter.manifest.optionalDependencies = { '@mcp-b/webmcp-polyfill': '^6.0.0-beta' };
      },
      /@tabdock\/adapter has optionalDependencies/,
    ],
    [
      'optional dependencies on the relay, an SDK range among them',
      (f) => {
        f.relay.manifest.optionalDependencies = { '@modelcontextprotocol/sdk': '^1.29.0' };
      },
      /@tabdock\/relay has optionalDependencies/,
    ],
    [
      'peer dependencies, which npm 7 and later install',
      (f) => {
        f.adapter.manifest.peerDependencies = { '@modelcontextprotocol/sdk': '*' };
      },
      /@tabdock\/adapter has peerDependencies/,
    ],
    [
      'peer dependency metadata',
      (f) => {
        f.protocol.manifest.peerDependenciesMeta = { zod: { optional: true } };
      },
      /@tabdock\/protocol has peerDependenciesMeta/,
    ],
    [
      'bundled dependencies',
      (f) => {
        f.adapter.manifest.bundleDependencies = ['zod'];
      },
      /@tabdock\/adapter has bundleDependencies/,
    ],
    [
      'bundled dependencies by their other spelling',
      (f) => {
        f.relay.manifest.bundledDependencies = ['ws'];
      },
      /@tabdock\/relay has bundledDependencies/,
    ],
    [
      "a bin on a library, which would shadow node and npm in a consumer's node_modules/.bin",
      (f) => {
        f.adapter.manifest.bin = { node: './dist/index.js', npm: './dist/index.js' };
      },
      /@tabdock\/adapter has a bin; only @tabdock\/relay may/,
    ],
    [
      'a bin on the protocol, given as a string',
      (f) => {
        f.protocol.manifest.bin = './dist/index.js';
      },
      /@tabdock\/protocol has a bin; only @tabdock\/relay may/,
    ],
    [
      'a bin directory, which npm links file by file as bins',
      (f) => {
        f.relay.manifest.directories = { bin: './dist' };
      },
      /@tabdock\/relay names a bin directory/,
    ],
    [
      "a shrinkwrap entry fetched from another package's registry URL",
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const ws = shrinkwrap.packages['node_modules/ws'] ?? {};
          ws.resolved =
            'https://registry.npmjs.org/some-other-package/-/some-other-package-9.9.9.tgz';
        });
      },
      /takes node_modules\/ws from "https:\/\/registry\.npmjs\.org\/some-other-package\/-\/some-other-package-9\.9\.9\.tgz", not https:\/\/registry\.npmjs\.org\/ws\/-\/ws-8\.22\.0\.tgz/,
    ],
    [
      "a shrinkwrap entry fetched from another version's registry URL",
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const zod = shrinkwrap.packages['node_modules/zod'] ?? {};
          zod.resolved = 'https://registry.npmjs.org/zod/-/zod-3.0.0.tgz';
        });
      },
      /takes node_modules\/zod from "https:\/\/registry\.npmjs\.org\/zod\/-\/zod-3\.0\.0\.tgz", not https:\/\/registry\.npmjs\.org\/zod\/-\/zod-4\.6\.5\.tgz/,
    ],
    [
      'a shrinkwrap entry with a truncated sha512',
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const ws = shrinkwrap.packages['node_modules/ws'] ?? {};
          ws.integrity = 'sha512-x';
        });
      },
      /pins node_modules\/ws without a whole sha512 integrity/,
    ],
    [
      'a shrinkwrap entry with a sha512 of the wrong length',
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const ws = shrinkwrap.packages['node_modules/ws'] ?? {};
          ws.integrity = 'sha512-AAAA';
        });
      },
      /pins node_modules\/ws without a whole sha512 integrity/,
    ],
    [
      'a shrinkwrap entry that runs a script on install',
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const ws = shrinkwrap.packages['node_modules/ws'] ?? {};
          ws.hasInstallScript = true;
        });
      },
      /pins node_modules\/ws, which runs a script on install/,
    ],
    [
      'a shrinkwrap root with optional dependencies',
      (f) => {
        editShrinkwrap(f, (shrinkwrap) => {
          const root = shrinkwrap.packages[''] ?? {};
          root.optionalDependencies = { '@modelcontextprotocol/sdk': '1.29.0' };
        });
      },
      /npm-shrinkwrap\.json's root has optionalDependencies/,
    ],
    [
      'a script-tag build at the ceiling',
      (f) => {
        f.adapter.files['dist/tabdock-adapter.js'] = Buffer.alloc(150_000, 0x20);
      },
      /dist\/tabdock-adapter\.js is 150000 bytes, not under 150000/,
    ],
    [
      'a sideEffects false that would drop zod-config.ts',
      (f) => {
        f.protocol.manifest.sideEffects = false;
      },
      /declares sideEffects false/,
    ],
    [
      'an export that points at nothing',
      (f) => {
        delete f.protocol.files['dist/index.d.ts'];
      },
      /@tabdock\/protocol points at \.\/dist\/index\.d\.ts, which it does not hold/,
    ],
  ];

  const readmeCases: [string, PackageName, string, RegExp][] = [
    [
      'a README that names a subpath the package does not export',
      'adapter',
      '`src/core.ts` (exported as `@tabdock/adapter/core`)',
      /@tabdock\/adapter's README names @tabdock\/adapter\/core, which the packed @tabdock\/adapter does not export/,
    ],
    [
      "a README that names another package's subpath it does not export",
      'relay',
      'The helpers are also exported as `@tabdock/relay/test/secrecy`.',
      /@tabdock\/relay's README names @tabdock\/relay\/test\/secrecy, which the packed @tabdock\/relay does not export/,
    ],
    [
      'a README that imports a package with no library entry point',
      'protocol',
      "```ts\nimport { createRelay } from '@tabdock/relay';\n```",
      /@tabdock\/protocol's README imports @tabdock\/relay, which the packed @tabdock\/relay does not export/,
    ],
  ];
  for (const [what, name, text, expected] of readmeCases) {
    it(`refuses ${what}`, () => {
      const problems = problemsWith((f) => {
        f[name].files['README.md'] = `# readme\n\n${text}\n`;
      });
      expect(
        problems.some((problem) => expected.test(problem)),
        problems.join('\n'),
      ).toBe(true);
    });
  }

  it('passes a README naming only what the packages export, a CDN path and the package.json', () => {
    const fixtures = wellFormed();
    fixtures.adapter.files['README.md'] = [
      "import { attach } from '@tabdock/adapter';",
      'https://cdn.jsdelivr.net/npm/@tabdock/adapter@0.1.0/dist/tabdock-adapter.js',
      "const p = await import('@tabdock/protocol');",
      '`@tabdock/relay/package.json`, then `npx @tabdock/relay`.',
      '',
    ].join('\n');
    expect(checkRelease(pack(fixtures))).toEqual([]);
  });

  it("holds this repository's READMEs to what each package publishes", () => {
    const exportsOf = new Map(
      PACKAGES.map((name) => {
        const manifest = JSON.parse(
          readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'),
        ) as { publishConfig?: { exports?: unknown } };
        return [name, manifest.publishConfig?.exports] as const;
      }),
    );
    for (const name of PACKAGES) {
      const readme = readFileSync(join(ROOT, 'packages', name, 'README.md'), 'utf8');
      expect(
        readmeProblems(name, readme, (other) => exportsOf.get(other)),
        name,
      ).toEqual([]);
    }
  });

  it("holds this repository's runtime dependencies to the allowlist", () => {
    // So a dependency added to a package fails here, on its pull request,
    // and not first on release day.
    for (const name of PACKAGES) {
      const manifest = JSON.parse(
        readFileSync(join(ROOT, 'packages', name, 'package.json'), 'utf8'),
      ) as { dependencies?: Record<string, string> };
      for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        expect(RUNTIME_DEPENDENCIES[name], `@tabdock/${name}`).toContain(dependency);
      }
    }
  });

  for (const [what, change, expected, tag] of cases) {
    it(`refuses ${what}`, () => {
      const problems = problemsWith(change, tag);
      expect(
        problems.some((problem) => expected.test(problem)),
        problems.join('\n'),
      ).toBe(true);
    });
  }
});
