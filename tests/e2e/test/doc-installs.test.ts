// What a reader installs must be what the project tests (ADR 0035). Every
// `npm install` in the guide, the README and the package READMEs that names a
// version saves it exactly, since npm otherwise writes a caret range and a
// later release can change what the guide describes; that version, and any
// version an `npx` command runs, is the one the workspace pins for that
// package. And a whole program the guide or the README gives, one a reader
// saves and runs, comes with an exact install of each package it imports on
// the same page (the guide once gave a client program with no install step,
// which failed with ERR_MODULE_NOT_FOUND in an empty folder).

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  codeBlocks,
  codeSpans,
  existsInRepo,
  markdownIn,
  packageReadmes,
  readRepo,
  ROOT,
} from '../src/doc-files.ts';

const DOCS = ['README.md', ...markdownIn('docs/guide'), ...packageReadmes()];
const SHELL_LANGS = new Set(['', 'sh', 'bash', 'shell', 'console', 'zsh']);
const SCRIPT_LANGS = new Set(['ts', 'typescript', 'js', 'javascript', 'mjs']);
/** A registry package with a version: name@1.2.3, the name scoped or not. */
const VERSIONED = /^((?:@[a-z0-9._-]+\/)?[a-z0-9._-]+)@(\d[^\s]*)$/;

interface Command {
  readonly where: string;
  readonly words: readonly string[];
}

/** Every shell command a doc gives, in code spans and shell blocks, continuations joined. */
function commands(doc: string): Command[] {
  const text = readRepo(doc);
  const found: Command[] = codeSpans(text).map(({ span, line }) => ({
    where: `${doc}:${String(line)}`,
    words: span.split(/\s+/),
  }));
  for (const block of codeBlocks(text).filter((candidate) => SHELL_LANGS.has(candidate.lang))) {
    const joined = block.body.replace(/\\\n\s*/g, ' ');
    joined.split('\n').forEach((line, index) => {
      for (const part of line.split(/&&|;|\|\|/)) {
        found.push({
          where: `${doc}:${String(block.line + index + 1)}`,
          words: part.trim().split(/\s+/),
        });
      }
    });
  }
  return found;
}

/** The words after `npm install` or `npm i`, or null for any other command. */
function npmInstallArgs(words: readonly string[]): string[] | null {
  const at = words.indexOf('npm');
  if (at < 0) return null;
  const verb = words[at + 1];
  return verb === 'install' || verb === 'i' ? words.slice(at + 2) : null;
}

/** The words after `npx` and its own flags, or null for any other command. */
function npxArgs(words: readonly string[]): string[] | null {
  const at = words.indexOf('npx');
  return at < 0 ? null : words.slice(at + 1).filter((word) => !word.startsWith('-'));
}

/** Every version a package.json in the workspace pins for each package. */
function pinnedVersions(): Map<string, Set<string>> {
  const manifests = ['package.json'];
  for (const dir of ['packages', 'apps', 'tests']) {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}/package.json`;
      if (entry.isDirectory() && existsInRepo(path)) manifests.push(path);
    }
  }
  const pinned = new Map<string, Set<string>>();
  for (const path of manifests) {
    const manifest = JSON.parse(readRepo(path)) as Record<
      string,
      Record<string, string> | undefined
    >;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[field] ?? {})) {
        if (!/^\d/.test(version)) continue;
        const versions = pinned.get(name) ?? new Set<string>();
        versions.add(version);
        pinned.set(name, versions);
      }
    }
  }
  return pinned;
}

/** A versioned word's problems against the workspace's pins: none when it matches or nothing pins it. */
function pinProblems(where: string, word: string, pinned: Map<string, Set<string>>): string[] {
  const match = VERSIONED.exec(word);
  if (match === null) return [];
  const [, name = '', version = ''] = match;
  const versions = pinned.get(name);
  return versions === undefined || versions.has(version)
    ? []
    : [`${where}: ${word}, where the workspace pins ${[...versions].join(' or ')}`];
}

/** The packages a whole program imports from the registry: not node:, relative or the project's own. */
function registryImports(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)) {
    const specifier = match[1] ?? match[2] ?? '';
    if (/^(?:node:|\.|\/|@tabdock\/)/.test(specifier)) continue;
    const parts = specifier.split('/');
    names.add(specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? ''));
  }
  return [...names];
}

describe('npm installs in the docs', () => {
  const pinned = pinnedVersions();
  const all = DOCS.flatMap(commands);
  const installs = all.flatMap(({ where, words }) => {
    const args = npmInstallArgs(words);
    return args === null ? [] : [{ where, args }];
  });

  it('are found, and the workspace pins versions', () => {
    expect(installs.length).toBeGreaterThan(3);
    expect(pinned.get('@modelcontextprotocol/client')?.size).toBeGreaterThan(0);
  });

  it('save every version they name exactly, the one the workspace pins', () => {
    const problems = installs.flatMap(({ where, args }) => {
      const versioned = args.filter((word) => VERSIONED.test(word));
      const exact = args.includes('--save-exact') || args.includes('-E');
      return [
        ...(versioned.length > 0 && !exact
          ? [`${where}: npm install ${versioned.join(' ')} without --save-exact`]
          : []),
        ...versioned.flatMap((word) => pinProblems(where, word, pinned)),
      ];
    });
    expect(problems).toEqual([]);
  });

  it('and npx commands run the versions the workspace pins', () => {
    const problems = all.flatMap(({ where, words }) =>
      (npxArgs(words) ?? []).slice(0, 1).flatMap((word) => pinProblems(where, word, pinned)),
    );
    expect(problems).toEqual([]);
  });

  it('would flag a caret install and a version the workspace does not pin', () => {
    const where = 'sample';
    const args = ['@modelcontextprotocol/client@9.9.9'];
    expect(args.includes('--save-exact')).toBe(false);
    expect(pinProblems(where, args[0] ?? '', pinned)).not.toEqual([]);
  });
});

describe('whole programs in the guide and the README', () => {
  it('come with an exact install of each package they import, on the same page', () => {
    const pinned = pinnedVersions();
    const problems = ['README.md', ...markdownIn('docs/guide')].flatMap((doc) => {
      const installed = new Set(
        commands(doc).flatMap(({ words }) => {
          const args = npmInstallArgs(words);
          if (args === null || !(args.includes('--save-exact') || args.includes('-E'))) return [];
          return args.flatMap((word) => VERSIONED.exec(word)?.[1] ?? []);
        }),
      );
      return codeBlocks(readRepo(doc))
        .filter((block) => SCRIPT_LANGS.has(block.lang) && !block.fragment)
        .flatMap((block) =>
          registryImports(block.body)
            .filter((name) => !installed.has(name))
            .map((name) => {
              const version = [...(pinned.get(name) ?? [])][0] ?? '<version>';
              return `${doc}:${String(block.line)} imports ${name} with no npm install --save-exact ${name}@${version} on the page`;
            }),
        );
    });
    expect(problems).toEqual([]);
  });

  it('would flag an import the page never installs', () => {
    expect(registryImports("import { Client } from '@modelcontextprotocol/client';")).toEqual([
      '@modelcontextprotocol/client',
    ]);
    expect(
      registryImports("import { attach } from '@tabdock/adapter';\nimport fs from 'node:fs';"),
    ).toEqual([]);
  });
});
