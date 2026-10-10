// Checks the three packed tarballs before anything is published (ADR 0028):
//   node scripts/release-check.ts [<dir>] [--tag v0.1.0]
// <dir> holds what release-pack.ts wrote (default dist/packages). It reads
// each tarball's file list and manifest and refuses, listing every problem:
// versions that differ from each other or from the tag; a file outside the
// package's allowlist, or one it needs missing; tests, sources, a .env, an
// owner token or a header helper; a repository URL other than the one
// trusted publishing compares; LICENSE and NOTICE other than the root's; a
// dependency left on workspace:, not pinned exactly, or not on the package's
// allowlist, or a sibling not pinned to the shared version; an optional, peer
// or bundled dependency; a script npm would run on install; a bin on the
// protocol or the adapter, or a bin directory anywhere; and for the relay, a
// second bin, a library entry point, or a shrinkwrap that pins anything but
// each package's own registry tarball with a whole sha512, that holds a
// package npm would run a script for on install, that leaves out a package its
// tree needs, or that pins a sibling other than the very tarball packed beside
// it; and a README, which npm shows as the package's page, that names an
// import the packed manifests would refuse with ERR_PACKAGE_PATH_NOT_EXPORTED,
// or links or names a repository path npm cannot open.
// CI runs it on every pack (the pack-install job) and publish.yml before
// staging.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { registryTarballUrl, tarballIntegrity } from '../packages/relay/scripts/shrinkwrap.ts';

export const ROOT = resolve(import.meta.dirname, '..');
export const DEFAULT_OUT = join(ROOT, 'dist', 'packages');

/** The repository exactly as trusted publishing compares it with package.json's repository.url. */
export const REPOSITORY_URL = 'git+https://github.com/PaulMRamirez/tabdock.git';

/**
 * Over this, the script-tag build fails the size test and the release: ADR
 * 0028's 150,000 bytes, raised for M6 by ADR 0048, whose per-wave checkpoints
 * docs/plans/M6.md records at each wave's merge.
 */
export const SCRIPT_TAG_LIMIT_BYTES = 200_000;

export const PACKAGES = ['protocol', 'adapter', 'relay'] as const;
export type PackageName = (typeof PACKAGES)[number];

interface Rules {
  /** Every file the tarball may hold, as paths under package/. */
  allowed: RegExp[];
  /** Files it must hold. */
  required: string[];
}

const COMMON = [/^package\.json$/, /^README\.md$/, /^LICENSE$/, /^NOTICE$/];
const COMMON_REQUIRED = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];

const RULES: Record<PackageName, Rules> = {
  protocol: {
    allowed: [...COMMON, /^dist\/[a-z-]+\.(?:js|d\.ts)$/],
    required: [...COMMON_REQUIRED, 'dist/index.js', 'dist/index.d.ts', 'dist/zod-config.js'],
  },
  adapter: {
    allowed: [...COMMON, /^dist\/[a-z-]+\.(?:js|d\.ts)$/, /^dist\/tabdock-adapter\.js\.map$/],
    required: [
      ...COMMON_REQUIRED,
      'dist/index.js',
      'dist/index.d.ts',
      'dist/tabdock-adapter.js',
      'dist/tabdock-adapter.js.map',
    ],
  },
  relay: {
    allowed: [
      ...COMMON,
      /^npm-shrinkwrap\.json$/,
      /^dist\/(?:cli|argument-worker)\.js$/,
      /^dist\/pair-page\/[a-z]+\.(?:html|js|css)$/,
    ],
    required: [
      ...COMMON_REQUIRED,
      'npm-shrinkwrap.json',
      'dist/cli.js',
      'dist/argument-worker.js',
      'dist/pair-page/pair.html',
      'dist/pair-page/invite.html',
    ],
  },
};

/**
 * Every package each published package may depend on when it runs: names
 * from CLAUDE.md's list of approved runtime dependencies, the official MCP
 * SDK's packages, `jose` and `openid-client` (ADR 0013), and the sibling a
 * package needs. Whatever reaches the relay's tree reaches every `npx` user,
 * so a name joins this list only with the owner's approval in an ADR, and
 * release-check.test.ts holds the workspace's package.json files to it as
 * well, so an addition fails on its pull request rather than on release day.
 */
export const RUNTIME_DEPENDENCIES: Record<PackageName, readonly string[]> = {
  protocol: ['zod'],
  adapter: ['@tabdock/protocol', 'qrcode-generator', 'zod'],
  relay: [
    '@modelcontextprotocol/node',
    '@modelcontextprotocol/server',
    '@tabdock/protocol',
    'jose',
    'openid-client',
    'ws',
    'zod',
  ],
};

/**
 * Manifest fields that pull packages in beside `dependencies`, which the
 * allowlist and the exact pins would not see: npm installs optional
 * dependencies when it can and, from npm 7, peer dependencies too, by range;
 * bundled ones ship inside the tarball unchecked. None of the three needs one.
 */
const OTHER_DEPENDENCY_FIELDS = [
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundleDependencies',
  'bundledDependencies',
] as const;

/** An exact version, never a range, a tag or a URL. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A sha512 integrity as npm writes it: 64 bytes, so 86 base64 characters and its padding. */
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** Never in a tarball whatever the allowlist says; named so a refusal says why. */
const FORBIDDEN: [RegExp, string][] = [
  [/(?:^|\/)tests?\//, 'a test directory'],
  [/\.(?:test|spec)\.[cm]?[jt]s$/, 'a test file'],
  [/(?:^|\/)\.env(?:\.|$)/, 'a .env file'],
  [/(?:^|\/)\.?owner-token/, 'an owner token'],
  [/(?:^|\/)claude-headers$/, 'a header helper'],
  [/\.tmp$/, 'a temporary file'],
  [/(?<!\.d)\.ts$/, 'TypeScript source'],
  [/(?:^|\/)node_modules\//, 'node_modules'],
  [/\.tsbuildinfo$/, 'a build cache'],
];

/** Scripts npm runs when the package is installed; a published package needs none. */
const INSTALL_SCRIPTS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'preprepare',
  'postprepare',
];

export interface Tarball {
  files: string[];
  read(path: string): Buffer;
}

/** A tarball read with the system's tar: its file list and any file's bytes. */
export function readTarball(path: string): Tarball {
  const listed = spawnSync('tar', ['-tzf', path], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`cannot list ${path}: ${listed.stderr}`);
  const files = listed.stdout
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('/'))
    .map((line) => line.replace(/^package\//, ''));
  return {
    files,
    read(file) {
      const ran = spawnSync('tar', ['-xzOf', path, `package/${file}`], {
        maxBuffer: 64 * 1024 * 1024,
      });
      if (ran.status !== 0) throw new Error(`cannot read ${file} from ${path}`);
      return ran.stdout;
    },
  };
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function object(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** The SRI digest of a file, as a page's integrity attribute takes it. */
export function integrityOf(bytes: Buffer): string {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

export function tarballName(name: PackageName, version: string): string {
  return `tabdock-${name}-${version}.tgz`;
}

export interface CheckOptions {
  /** The release tag, v and the version, which every package must carry. */
  tag?: string | undefined;
  /** Where LICENSE and NOTICE come from; the repository root. */
  root?: string;
}

/** Every problem with the tarballs in `dir`; an empty list means they may be published. */
export function checkRelease(dir: string, options: CheckOptions = {}): string[] {
  const root = options.root ?? ROOT;
  const problems: string[] = [];
  const tarballs = readdirSync(dir).filter((file) => file.endsWith('.tgz'));
  const versions = new Map<PackageName, string>();
  for (const name of PACKAGES) {
    const found = tarballs.filter((file) => file.startsWith(`tabdock-${name}-`));
    if (found.length !== 1) {
      problems.push(`${dir} holds ${String(found.length)} tarballs of @tabdock/${name}, not one`);
      continue;
    }
    const version = /^tabdock-[a-z]+-(.+)\.tgz$/.exec(found[0] ?? '')?.[1];
    if (version !== undefined) versions.set(name, version);
  }
  const strays = tarballs.filter(
    (file) => !PACKAGES.some((name) => file.startsWith(`tabdock-${name}-`)),
  );
  for (const stray of strays) problems.push(`${stray} is none of the three packages`);
  const shared = [...new Set(versions.values())];
  if (shared.length > 1)
    problems.push(`the packages carry different versions: ${shared.join(', ')}`);
  const version = shared[0];
  if (version === undefined) return problems;
  if (!EXACT_VERSION.test(version)) problems.push(`${version} is not a version`);
  if (options.tag !== undefined && options.tag !== `v${version}`) {
    problems.push(`the tag ${options.tag} is not v${version}, the packages' version`);
  }
  const license = readFileSync(join(root, 'LICENSE'));
  const notice = readFileSync(join(root, 'NOTICE'));
  const exportsOf = new Map<PackageName, Json | undefined>();
  const readmes = new Map<PackageName, string>();
  // Each tarball's integrity, as the relay's shrinkwrap must pin its siblings.
  const integrities = new Map(
    [...versions].map(([name, tarballVersion]) => [
      `@tabdock/${name}`,
      tarballIntegrity(readFileSync(join(dir, tarballName(name, tarballVersion)))),
    ]),
  );
  for (const [name, tarballVersion] of versions) {
    const where = `@tabdock/${name}`;
    const tarball = readTarball(join(dir, tarballName(name, tarballVersion)));
    const rules = RULES[name];
    for (const file of tarball.files) {
      const forbidden = FORBIDDEN.find(([pattern]) => pattern.test(file));
      if (forbidden !== undefined) problems.push(`${where} holds ${file}, ${forbidden[1]}`);
      else if (!rules.allowed.some((pattern) => pattern.test(file))) {
        problems.push(`${where} holds ${file}, which its allowlist does not name`);
      }
    }
    for (const file of rules.required) {
      if (!tarball.files.includes(file)) problems.push(`${where} lacks ${file}`);
    }
    if (tarball.files.includes('LICENSE') && !tarball.read('LICENSE').equals(license)) {
      problems.push(`${where}'s LICENSE is not the repository's`);
    }
    if (tarball.files.includes('NOTICE') && !tarball.read('NOTICE').equals(notice)) {
      problems.push(`${where}'s NOTICE is not the repository's`);
    }
    if (tarball.files.includes('README.md')) {
      readmes.set(name, tarball.read('README.md').toString('utf8'));
    }
    if (!tarball.files.includes('package.json')) continue;
    const manifest = object(JSON.parse(tarball.read('package.json').toString('utf8')) as Json);
    exportsOf.set(name, manifest.exports);
    problems.push(...checkManifest(name, manifest, version, tarball));
    if (name === 'relay') problems.push(...checkRelay(manifest, version, tarball, integrities));
    if (name === 'adapter' && tarball.files.includes('dist/tabdock-adapter.js')) {
      const script = tarball.read('dist/tabdock-adapter.js');
      if (script.byteLength >= SCRIPT_TAG_LIMIT_BYTES) {
        problems.push(
          `${where}'s dist/tabdock-adapter.js is ${String(script.byteLength)} bytes, not under ${String(SCRIPT_TAG_LIMIT_BYTES)}`,
        );
      }
      const integrityFile = join(dir, 'tabdock-adapter.integrity.txt');
      if (existsSync(integrityFile)) {
        const written = readFileSync(integrityFile, 'utf8').split('\n')[0];
        if (written !== integrityOf(script)) {
          problems.push(
            "tabdock-adapter.integrity.txt does not hold the packed script-tag file's digest",
          );
        }
      }
    }
  }
  for (const [name, readme] of readmes) {
    problems.push(...readmeProblems(name, readme, (other) => exportsOf.get(other)));
  }
  const sums = join(dir, 'SHA256SUMS');
  if (existsSync(sums)) {
    for (const line of readFileSync(sums, 'utf8')
      .split('\n')
      .filter((l) => l !== '')) {
      const [digest, file] = line.split(/ {2}/);
      if (digest === undefined || file === undefined || !existsSync(join(dir, file))) {
        problems.push(`SHA256SUMS names ${file ?? line}, which is not here`);
        continue;
      }
      const actual = createHash('sha256')
        .update(readFileSync(join(dir, file)))
        .digest('hex');
      if (actual !== digest) problems.push(`SHA256SUMS does not match ${file}`);
    }
  }
  return problems;
}

/** Whether a manifest's `exports` lets an importer reach `subpath` ('.' or './x'). */
function exported(exports: unknown, subpath: string): boolean {
  if (exports === undefined || exports === null) return false;
  // A string, or an object of conditions rather than paths, exports '.' alone.
  if (typeof exports === 'string' || Array.isArray(exports)) return subpath === '.';
  if (typeof exports !== 'object') return false;
  const keys = Object.keys(exports);
  if (!keys.every((key) => key.startsWith('.'))) return subpath === '.';
  return keys.some((key) => {
    if (key === subpath) return true;
    const star = key.indexOf('*');
    if (star === -1) return false;
    const before = key.slice(0, star);
    const after = key.slice(star + 1);
    return (
      subpath.length > before.length + after.length &&
      subpath.startsWith(before) &&
      subpath.endsWith(after)
    );
  });
}

const PUBLISHED = PACKAGES.join('|');
/** `@tabdock/<package>/<subpath>`, which is an import whatever the prose around it says. */
const SUBPATH_MENTION = new RegExp(`@tabdock/(${PUBLISHED})/([A-Za-z0-9_./-]*[A-Za-z0-9_-])`, 'g');
/** An import, dynamic import or require of a package's root. */
const ROOT_IMPORT = new RegExp(
  `(?:\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\brequire\\s*\\(\\s*|\\bimport\\s+)['"]@tabdock/(${PUBLISHED})['"]`,
  'g',
);

/** Fenced code blocks blanked: examples, whose paths are a page's own, not links. */
function withoutFences(text: string): string {
  return text.replace(/^(\s*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\2[`~]*\s*$/gm, '');
}

/** A Markdown link or image whose target is not absolute, an in-page anchor aside. */
const RELATIVE_LINK = /!?\[[^\]]*\]\((?![a-z][a-z0-9+.-]*:|#|\/\/)([^)\s]+)[^)]*\)/gi;
/** An HTML href or src in prose that is not absolute. */
const RELATIVE_HTML = /\b(?:href|src)\s*=\s*["'](?![a-z][a-z0-9+.-]*:|#|\/\/)([^"']+)["']/gi;
/** A link whose target is absolute: its text may name a path, since the link opens it. */
const ABSOLUTE_LINK = /!?\[[^\]]*\]\([a-z][a-z0-9+.-]*:[^)]*\)/gi;
/**
 * A path into the repository rather than the package: docs/..., the spec or
 * the owner's files at the root, or an ADR's file, none of which the tarball
 * holds or npm can open.
 */
const REPOSITORY_PATH =
  /(?<![\w./:@-])(?:docs\/[\w./-]*[\w-]|SPEC\.md|CLAUDE\.md|CHANGELOG\.md|\d{4}-[a-z0-9-]+\.md)(?![\w/-])/g;

/**
 * What a packed README tells its reader to import that the packed manifests
 * do not export: npm shows the README as the package's page, and a reader who
 * follows it would meet ERR_PACKAGE_PATH_NOT_EXPORTED. A CDN path such as
 * `@tabdock/adapter@0.1.0/dist/...` names a version, not an import, and passes.
 * The same page must not send its reader anywhere npm cannot follow: a
 * relative link resolves against npmjs.com, and a bare repository path, such
 * as docs/guide/... or an ADR's file, names nothing an npm reader has. Both
 * belong as absolute GitHub URLs (ADR 0035).
 */
export function readmeProblems(
  name: PackageName,
  readme: string,
  exportsOf: (name: PackageName) => unknown,
): string[] {
  const where = `@tabdock/${name}'s README`;
  const problems = new Set<string>();
  for (const match of readme.matchAll(SUBPATH_MENTION)) {
    const target = match[1] as PackageName;
    const subpath = match[2] ?? '';
    if (!exported(exportsOf(target), `./${subpath}`)) {
      problems.add(
        `${where} names @tabdock/${target}/${subpath}, which the packed @tabdock/${target} does not export`,
      );
    }
  }
  for (const match of readme.matchAll(ROOT_IMPORT)) {
    const target = match[1] as PackageName;
    if (!exported(exportsOf(target), '.')) {
      problems.add(
        `${where} imports @tabdock/${target}, which the packed @tabdock/${target} does not export`,
      );
    }
  }
  const prose = withoutFences(readme);
  const outsideSpans = prose.replace(/(`+)[^`]*?\1/g, '');
  for (const match of [
    ...outsideSpans.matchAll(RELATIVE_LINK),
    ...outsideSpans.matchAll(RELATIVE_HTML),
  ]) {
    problems.add(
      `${where} links to ${match[1] ?? ''}, a relative path npm cannot follow; use an absolute GitHub URL`,
    );
  }
  for (const match of prose.replace(ABSOLUTE_LINK, '').matchAll(REPOSITORY_PATH)) {
    problems.add(
      `${where} names ${match[0]}, a repository path an npm reader cannot open; link it with an absolute GitHub URL`,
    );
  }
  return [...problems];
}

function checkManifest(
  name: PackageName,
  manifest: Record<string, Json>,
  version: string,
  tarball: Tarball,
): string[] {
  const where = `@tabdock/${name}`;
  const problems: string[] = [];
  if (manifest.name !== where)
    problems.push(`${where}'s package.json names ${JSON.stringify(manifest.name)}`);
  if (manifest.version !== version)
    problems.push(`${where}'s package.json says ${JSON.stringify(manifest.version)}`);
  if (manifest.private !== undefined) problems.push(`${where} is marked private`);
  if (manifest.license !== 'Apache-2.0') problems.push(`${where}'s license is not Apache-2.0`);
  const repository = object(manifest.repository);
  if (repository.url !== REPOSITORY_URL) {
    problems.push(
      `${where}'s repository.url is ${JSON.stringify(repository.url)}, not ${REPOSITORY_URL}`,
    );
  }
  if (repository.directory !== `packages/${name}`) {
    problems.push(`${where}'s repository.directory is not packages/${name}`);
  }
  if (object(manifest.publishConfig).access !== 'public') {
    problems.push(`${where}'s publishConfig.access is not public`);
  }
  if (manifest.sideEffects === false) {
    problems.push(`${where} declares sideEffects false, which would drop zod-config.ts`);
  }
  if (JSON.stringify(manifest).includes('workspace:')) {
    problems.push(`${where}'s package.json still holds a workspace: specifier`);
  }
  for (const [dependency, spec] of Object.entries(object(manifest.dependencies))) {
    if (!RUNTIME_DEPENDENCIES[name].includes(dependency)) {
      problems.push(
        `${where} depends on ${dependency}, which its allowlist of runtime dependencies does not name`,
      );
    }
    if (dependency.startsWith('@tabdock/') && spec !== version) {
      problems.push(
        `${where} depends on ${dependency} ${JSON.stringify(spec)}, not exactly ${version}`,
      );
    }
    if (typeof spec !== 'string' || !EXACT_VERSION.test(spec)) {
      problems.push(
        `${where} depends on ${dependency} ${JSON.stringify(spec)}, not an exact version`,
      );
    }
  }
  problems.push(...otherDependencyProblems(where, manifest));
  // A library's bin lands in its consumer's node_modules/.bin, where a name
  // such as node or npm would shadow the real one for every script there.
  if (name !== 'relay' && manifest.bin !== undefined) {
    problems.push(`${where} has a bin; only @tabdock/relay may, and only tabdock-relay`);
  }
  // npm turns every file in directories.bin into a bin when bin is absent.
  if (object(manifest.directories).bin !== undefined) {
    problems.push(`${where} names a bin directory, whose every file npm would link as a bin`);
  }
  for (const script of INSTALL_SCRIPTS) {
    if (object(manifest.scripts)[script] !== undefined) {
      problems.push(`${where} has a ${script} script, which npm would run on install`);
    }
  }
  const targets: string[] = [];
  const collect = (value: Json | undefined): void => {
    if (typeof value === 'string') targets.push(value);
    else if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) collect(inner);
    }
  };
  collect(manifest.exports);
  collect(manifest.bin);
  collect(manifest.types);
  for (const target of targets) {
    const file = target.replace(/^\.\//, '');
    if (!tarball.files.includes(file))
      problems.push(`${where} points at ${target}, which it does not hold`);
  }
  if (name !== 'relay') {
    const main = object(object(manifest.exports)['.']);
    if (main.types !== './dist/index.d.ts' || main.default !== './dist/index.js') {
      problems.push(`${where} does not export . as dist/index.js with its declarations`);
    }
  }
  return problems;
}

/** Each field of a manifest, or the shrinkwrap's root, that pulls packages in beside `dependencies`. */
function otherDependencyProblems(where: string, manifest: Record<string, Json>): string[] {
  return OTHER_DEPENDENCY_FIELDS.filter((field) => manifest[field] !== undefined).map(
    (field) => `${where} has ${field}, which none of the three packages may have`,
  );
}

/**
 * Every dependency the shrinkwrap's tree leaves without a package, as npm
 * resolves one: from the dependent's own node_modules up through each
 * enclosing one to the root's. The root's dependencies count, so a relay
 * whose shrinkwrap lacks one of them, @tabdock/protocol as it once did, is
 * refused here rather than by a person's npx.
 */
export function missingFromShrinkwrap(packages: Record<string, Json>): string[] {
  const problems: string[] = [];
  for (const [path, value] of Object.entries(packages)) {
    const dependencies = object(object(value).dependencies);
    for (const dependency of Object.keys(dependencies)) {
      let base = path;
      let found = false;
      for (;;) {
        const candidate = `${base === '' ? '' : `${base}/`}node_modules/${dependency}`;
        if (packages[candidate] !== undefined) {
          found = true;
          break;
        }
        if (base === '') break;
        const cut = base.lastIndexOf('/node_modules/');
        base = cut === -1 ? '' : base.slice(0, cut);
      }
      if (!found) {
        problems.push(
          `npm-shrinkwrap.json leaves out ${dependency}, which ${path === '' ? '@tabdock/relay' : path} depends on, so npm would never install it`,
        );
      }
    }
  }
  return problems;
}

function checkRelay(
  manifest: Record<string, Json>,
  version: string,
  tarball: Tarball,
  siblings: ReadonlyMap<string, string>,
): string[] {
  const problems: string[] = [];
  const bin = object(manifest.bin);
  if (Object.keys(bin).length !== 1 || bin['tabdock-relay'] !== './dist/cli.js') {
    problems.push('@tabdock/relay must have exactly one bin, tabdock-relay, at ./dist/cli.js');
  }
  const exports = object(manifest.exports);
  if (Object.keys(exports).some((key) => key !== './package.json')) {
    problems.push('@tabdock/relay exports a library entry point; 0.1.0 publishes a command only');
  }
  if (object(manifest.engines).node !== '>=22.18')
    problems.push('@tabdock/relay engines.node is not >=22.18');
  if (tarball.files.includes('dist/cli.js')) {
    const cli = tarball.read('dist/cli.js').toString('utf8');
    if (!cli.startsWith('#!/usr/bin/env node\n'))
      problems.push('@tabdock/relay dist/cli.js lacks its #! line');
    if (cli.includes('TABDOCK_PACKAGED'))
      problems.push('@tabdock/relay dist/cli.js was built without the packaged mark');
  }
  if (!tarball.files.includes('npm-shrinkwrap.json')) return problems;
  const shrinkwrap = object(
    JSON.parse(tarball.read('npm-shrinkwrap.json').toString('utf8')) as Json,
  );
  if (shrinkwrap.lockfileVersion !== 3)
    problems.push('npm-shrinkwrap.json is not lockfile version 3');
  const packages = object(shrinkwrap.packages);
  const rootEntry = object(packages['']);
  if (rootEntry.name !== '@tabdock/relay' || rootEntry.version !== version) {
    problems.push('npm-shrinkwrap.json does not describe this @tabdock/relay');
  }
  const sorted = (value: Json | undefined): string =>
    JSON.stringify(Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b)));
  if (sorted(rootEntry.dependencies) !== sorted(manifest.dependencies)) {
    problems.push("npm-shrinkwrap.json's dependencies are not package.json's");
  }
  problems.push(...otherDependencyProblems("npm-shrinkwrap.json's root", rootEntry));
  // npm installs a shrinkwrapped package's dependencies from the file alone,
  // so whatever the tree needs and the file leaves out is never installed.
  problems.push(...missingFromShrinkwrap(packages));
  for (const [path, value] of Object.entries(packages)) {
    const entry = object(value);
    // The install-script refusal on the manifests stops at the relay itself;
    // npm records here which package in its tree would run one, and npx runs
    // it on every user's machine, though the workspace's pnpm never does.
    if (entry.hasInstallScript !== undefined && entry.hasInstallScript !== false) {
      problems.push(
        `npm-shrinkwrap.json pins ${path === '' ? 'the relay' : path}, which runs a script on install`,
      );
    }
    if (path === '') continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (name.startsWith('@tabdock/')) {
      // A sibling of this release: exactly the tarball beside the relay, at the URL npm will give it.
      const sibling = siblings.get(name);
      if (path !== `node_modules/${name}` || entry.version !== version) {
        problems.push(
          `npm-shrinkwrap.json pins ${path} at ${JSON.stringify(entry.version)}, not ${name}@${version} beside the relay`,
        );
      }
      if (entry.resolved !== registryTarballUrl(name, version)) {
        problems.push(
          `npm-shrinkwrap.json takes ${path} from ${JSON.stringify(entry.resolved)}, not ${registryTarballUrl(name, version)}`,
        );
      }
      if (sibling === undefined) {
        problems.push(`npm-shrinkwrap.json pins ${path}, which this release does not pack`);
      } else if (entry.integrity !== sibling) {
        problems.push(
          `npm-shrinkwrap.json pins ${path} with an integrity other than the packed ${name}'s`,
        );
      }
      continue;
    }
    // The URL must be this very package's tarball at this very version: a
    // registry prefix alone would let an entry named ws fetch any package,
    // or an alias fetch another under ws's name.
    const entryVersion = entry.version;
    if (typeof entryVersion !== 'string' || !EXACT_VERSION.test(entryVersion)) {
      problems.push(
        `npm-shrinkwrap.json pins ${path} at ${JSON.stringify(entryVersion)}, not an exact version`,
      );
    } else if (entry.resolved !== registryTarballUrl(name, entryVersion)) {
      problems.push(
        `npm-shrinkwrap.json takes ${path} from ${JSON.stringify(entry.resolved)}, not ${registryTarballUrl(name, entryVersion)}`,
      );
    }
    if (typeof entry.integrity !== 'string' || !SHA512_INTEGRITY.test(entry.integrity)) {
      problems.push(`npm-shrinkwrap.json pins ${path} without a whole sha512 integrity`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: { tag: { type: 'string' } },
    allowPositionals: true,
  });
  const dir = resolve(positionals[0] ?? DEFAULT_OUT);
  const problems = checkRelease(dir, { tag: values.tag });
  if (problems.length > 0) {
    console.error(`release-check: ${String(problems.length)} problems in ${dir}`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`release-check: the three packages in ${dir} may be published`);
  }
}
