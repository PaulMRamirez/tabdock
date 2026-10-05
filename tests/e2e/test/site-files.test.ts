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

  it('pins marked and mermaid exactly, and the tools at the workspace versions', () => {
    expect(dev.marked).toBe('18.0.14');
    expect(dev.mermaid).toBe('12.1.0');
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
    expect(read('pnpm-workspace.yaml')).toMatch(/^ {2}- '!apps\/site'$/m);
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
});
