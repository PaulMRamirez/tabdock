// The Pages site's package as a clean clone sees it (ADR 0029), checked
// without installing it: apps/site stays out of the pnpm workspace with its
// own lockfile, so `pnpm install`, lint, typecheck and test never need
// mermaid's packages; its pins are exact; its playwright-core is the
// workspace's Playwright, so it drives the Chromium CI already installs; and
// `pnpm site:build` installs it from that lockfile alone.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const json = (path: string): Record<string, unknown> =>
  JSON.parse(read(path)) as Record<string, unknown>;
const table = (value: unknown): Record<string, string> => (value ?? {}) as Record<string, string>;
/** A pnpm-workspace.yaml's `packages:` entries, as written. */
const workspaceGlobs = (text: string): string[] => {
  const block = /^packages:\n((?:(?: {2}.*)?\n)*)/m.exec(text)?.[1] ?? '';
  return [...block.matchAll(/^ {2}- (.+)$/gm)].map((match) => match[1] ?? '');
};

describe('apps/site (ADR 0029)', () => {
  const site = json('apps/site/package.json');
  const dev = table(site.devDependencies);

  it('is private, with no runtime dependencies and no install scripts', () => {
    expect(site.private).toBe(true);
    expect(site.dependencies).toBeUndefined();
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
      expect(table(site.scripts)[hook], hook).toBeUndefined();
    }
  });

  it('pins every package exactly, and the tools at the workspace versions', () => {
    for (const [name, version] of Object.entries(dev))
      expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dev['playwright-core']).toBe(
      table(json('tests/e2e/package.json').devDependencies)['@playwright/test'],
    );
    const root = table(json('package.json').devDependencies);
    expect(dev.typescript).toBe(root.typescript);
    expect(dev['@types/node']).toBe(root['@types/node']);
    expect(Object.keys(dev).sort()).toEqual([
      '@types/node',
      'marked',
      'mermaid',
      'playwright-core',
      'typescript',
    ]);
  });

  it('keeps its own lockfile, holding those pins, outside the workspace', () => {
    const lock = read('apps/site/pnpm-lock.yaml');
    for (const [name, version] of Object.entries(dev)) {
      expect(lock, name).toContain(`${name}@${version}`);
    }
    // The workspace names the demo alone under apps/: Dependabot expands these
    // globs without pnpm's '!' negation, so `apps/*` would hand it the site too.
    expect(workspaceGlobs(read('pnpm-workspace.yaml'))).toEqual([
      'packages/*',
      'apps/demo',
      'tests/*',
    ]);
    // The workspace's own lockfile knows nothing of it, so a clean clone's install never fetches mermaid.
    const workspaceLock = read('pnpm-lock.yaml');
    expect(workspaceLock).not.toMatch(/^ {2}apps\/site:/m);
    expect(workspaceLock).not.toMatch(/mermaid@/);
  });

  it('is built only by pnpm site:build, from its own frozen lockfile', () => {
    const script = table(json('package.json').scripts)['site:build'] ?? '';
    expect(script).toMatch(
      /^pnpm --dir apps\/site install --frozen-lockfile --ignore-workspace && /,
    );
    expect(script).toContain('pnpm --dir apps/site run check');
    expect(script).toMatch(/pnpm --dir apps\/site run build$/);
  });

  it("stays out of a clean clone's lint and unit tests, which could not resolve its packages", () => {
    expect(read('eslint.config.js')).toMatch(/^\s*'apps\/site\/\*\*',$/m);
    // The root vitest run takes {src,test} under each app; the site's tests live in lib/ and run with node --test.
    expect(read('vitest.config.ts')).toContain("'{packages,apps,tests}/*/{src,test}/**/*.test.ts'");
    expect(existsSync(join(ROOT, 'apps/site/src'))).toBe(false);
    expect(existsSync(join(ROOT, 'apps/site/test'))).toBe(false);
    expect(table(site.scripts).test).toMatch(/^node --test /);
  });

  it('is a pnpm project of its own, so a tool that cannot pass --ignore-workspace updates its lockfile', () => {
    // Dependabot changed apps/site/package.json without its lockfile while
    // pnpm took the site for part of the parent workspace; its own
    // pnpm-workspace.yaml makes pnpm stop the search there.
    const lines = read('apps/site/pnpm-workspace.yaml')
      .split('\n')
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual(['packages:', '  - .']);
  });
});

describe('Dependabot keeps together what must move together, and leaves to a person what one pull request cannot move (docs/develop.md)', () => {
  /** Each `updates:` entry of .github/dependabot.yml, as text. */
  const entries = read('.github/dependabot.yml')
    .split(/^ {2}- package-ecosystem: /m)
    .slice(1);
  const entry = (ecosystem: string, directory: string): string => {
    const found = entries.find(
      (text) =>
        text.startsWith(`${ecosystem}\n`) && text.includes(`\n    directory: ${directory}\n`),
    );
    if (found === undefined) throw new Error(`no ${ecosystem} entry for ${directory}`);
    return found;
  };
  /** An entry's `ignore:` rules: each dependency name, with the condition lines under it. */
  const ignoreRules = (text: string): Map<string, string[]> => {
    const block = /^ {4}ignore:\n((?: {6}.*\n)*)/m.exec(text)?.[1] ?? '';
    const rules = new Map<string, string[]>();
    let conditions: string[] | undefined;
    for (const line of block.split('\n')) {
      const rule = /^ {6}- dependency-name: '?([^']+)'?$/.exec(line);
      if (rule !== null) {
        conditions = [];
        rules.set(rule[1] ?? '', conditions);
      } else if (/^ {8}\S/.test(line)) {
        conditions?.push(line.trim());
      }
    }
    return rules;
  };

  it('keeps the tools the workspace and the site share out of both npm entries, every version', () => {
    const workspace = ignoreRules(entry('npm', '/'));
    const site = ignoreRules(entry('npm', '/apps/site'));
    // A rule with no versions or update-types under it ignores every version.
    for (const name of ['typescript', '@types/node', 'playwright-core']) {
      expect(workspace.get(name), `workspace ${name}`).toEqual([]);
      expect(site.get(name), `site ${name}`).toEqual([]);
    }
    expect(workspace.get('@playwright/test'), 'workspace @playwright/test').toEqual([]);
    // The site's own packages still move on their own.
    expect(site.has('marked')).toBe(false);
    expect(site.has('mermaid')).toBe(false);
  });

  /**
   * An entry's `groups:` in the order written, the order Dependabot matches
   * them in. Reads block-style lists of single-quoted names with no blank
   * lines; any other spelling fails here, never passes.
   */
  const groups = (text: string): { name: string; keys: string[]; patterns: string[] }[] => {
    const block = /^ {4}groups:\n((?: {6}.*\n)*)/m.exec(text)?.[1] ?? '';
    const found: { name: string; keys: string[]; patterns: string[] }[] = [];
    for (const line of block.split('\n')) {
      const group = /^ {6}([\w-]+):$/.exec(line);
      const key = /^ {8}([\w-]+):/.exec(line);
      const pattern = /^ {10}- '([^']+)'$/.exec(line);
      if (group !== null) found.push({ name: group[1] ?? '', keys: [], patterns: [] });
      else if (key !== null) found.at(-1)?.keys.push(key[1] ?? '');
      else if (pattern !== null) found.at(-1)?.patterns.push(pattern[1] ?? '');
    }
    return found;
  };

  it('moves the MCP SDK the relay pins in one pull request, matched before runtime and tooling (ADR 0037)', () => {
    // Dependabot puts a dependency in the first group it matches. After
    // runtime, server would go there and client, a development dependency,
    // to tooling, as pull requests #13 and #14 split them, each leaving two
    // cores in the tree.
    const relay = json('packages/relay/package.json');
    const pinned = Object.keys({
      ...table(relay.dependencies),
      ...table(relay.devDependencies),
    }).filter((name) => name.startsWith('@modelcontextprotocol/'));
    const [sdk, ...rest] = groups(entry('npm', '/'));
    expect(sdk?.name).toBe('mcp-sdk');
    // Patterns alone: a dependency-type would leave server or client out.
    expect(sdk?.keys).toEqual(['patterns']);
    // Each package by name, core too though it comes only through server's
    // and client's exact pins; a wildcard would also pull in the conformance alpha.
    expect(sdk?.patterns.toSorted()).toEqual(
      [...new Set([...pinned, '@modelcontextprotocol/core'])].toSorted(),
    );
    expect(rest.map((group) => group.name)).toEqual(['runtime', 'tooling']);
  });

  it('proposes no new major of Node for the image, whose runtime moves by a recorded decision', () => {
    expect(ignoreRules(entry('docker', '/')).get('node')).toEqual([
      "update-types: ['version-update:semver-major']",
    ]);
  });
});
