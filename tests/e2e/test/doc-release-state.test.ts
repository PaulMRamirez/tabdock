// Install claims must wait for the publish (ADR 0035). While the newest
// heading in CHANGELOG.md says the release is not yet published, nothing is on
// npm, so a reader who runs `npx @tabdock/relay` or `npm install
// @tabdock/adapter`, or loads the jsDelivr tag, meets a 404. Every sentence in
// the README, the guide, the deploy guide and the package READMEs that names
// one must also say it waits ('once' or 'after'), and lead readers to the
// clone. The release commit that dates the heading lifts the rule and turns
// it round: from then on no such doc may still say the release is not on npm.
// While an Unreleased section gathers work past that release (M6, after
// 0.1.0: ADR 0049 decision 3), the guide's index says it arrives in "the
// release after" the newest one, and no section that names a package
// subpath the newest release lacks (0.1.0's published subpaths are pinned
// here, as doc-changelog.test.ts pins its surface) pins an install to that
// release, which would install a package without it.

import { describe, expect, it } from 'vitest';
import {
  codeBlocks,
  guidePages,
  markdownIn,
  packageReadmes,
  readRepo,
  withoutCodeBlocks,
} from '../src/doc-files.ts';

/** What each published package exported in 0.1.0 (its publishConfig.exports), as it shipped. */
const PUBLISHED_0_1_0: Readonly<Record<string, readonly string[]>> = {
  '@tabdock/protocol': ['.'],
  '@tabdock/adapter': ['.'],
  '@tabdock/relay': ['./package.json'],
};

/** The packages a release publishes, by directory. */
const PUBLISHED_DIRS = ['packages/protocol', 'packages/adapter', 'packages/relay'];

interface Manifest {
  name: string;
  private?: boolean;
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
}

/** Each published package's subpaths as its package.json publishes them now, as import names. */
function publishedSubpaths(): string[] {
  return PUBLISHED_DIRS.flatMap((dir) => {
    const manifest = JSON.parse(readRepo(`${dir}/package.json`)) as Manifest;
    if (manifest.private === true) return [];
    const exports = manifest.publishConfig?.exports ?? manifest.exports ?? {};
    return Object.keys(exports).map((key) => `${manifest.name}${key.slice(1)}`);
  });
}

/** The subpaths published now that `released` lacked. */
function newSubpaths(
  now: readonly string[],
  released: Readonly<Record<string, readonly string[]>>,
): string[] {
  const before = new Set(
    Object.entries(released).flatMap(([name, keys]) => keys.map((key) => `${name}${key.slice(1)}`)),
  );
  return now.filter((subpath) => !before.has(subpath) && !subpath.endsWith('/package.json'));
}

/** `text` cut at each heading outside code blocks, each part keeping its code blocks. */
function sectionsOf(text: string): { heading: string; text: string }[] {
  const lines = text.split('\n');
  const outside = withoutCodeBlocks(text).split('\n');
  const starts = outside.flatMap((line, index) => (/^#{1,6} /.test(line) ? [index] : []));
  const bounds = [0, ...starts.filter((start) => start > 0), lines.length];
  return bounds.slice(0, -1).map((start, index) => ({
    heading: (lines[start] ?? '').trim(),
    text: lines.slice(start, bounds[index + 1]).join('\n'),
  }));
}

/** Sections that name a subpath the newest release lacks and pin an install to that release. */
function pinnedWithout(
  doc: string,
  text: string,
  version: string,
  missing: readonly string[],
): string[] {
  const pin = new RegExp(`@tabdock/[a-z-]+@${version.replaceAll('.', '\\.')}(?![\\d.])`);
  return sectionsOf(text)
    .filter((section) => missing.some((subpath) => section.text.includes(subpath)))
    .filter((section) => pin.test(section.text))
    .map((section) => `${doc}: ${section.heading || '(before the first heading)'}`);
}

const DOCS = ['README.md', ...markdownIn('docs/guide'), 'docs/deploy.md', ...packageReadmes()];
const INSTALL =
  /npx(?: --yes)? @tabdock\/|npm install @tabdock\/|cdn\.jsdelivr\.net\/npm\/@tabdock/;
const WAITS = /\b(?:once|after)\b/i;
const NOT_YET = /\bnot yet (?:on npm|published)\b/i;

/**
 * The newest release heading in CHANGELOG.md. An Unreleased section above
 * it gathers work no release carries yet (docs/release.md), so it is read
 * past: what is on npm is what the newest release heading says.
 */
function newestHeading(changelog: string): string {
  return /^## (?!Unreleased\b)(.+)$/m.exec(changelog)?.[1] ?? '';
}

/** Whether a heading says its release has not reached npm. */
function unpublished(heading: string): boolean {
  return /not yet published/i.test(heading);
}

/** Each sentence of the prose, each table row and each code block, with its line. */
function statements(text: string): { text: string; line: number }[] {
  const found: { text: string; line: number }[] = [];
  const lines = withoutCodeBlocks(text).split('\n');
  let paragraph: { text: string; line: number }[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const start = paragraph[0]?.line ?? 0;
    // Periods inside code spans, as in 0.1.0 or a file name, end no sentence.
    const joined = paragraph
      .map((part) => part.text)
      .join(' ')
      .replace(/(`+)([^`]*?)\1/g, (span) => span.replace(/\.(?=\S)/g, '\u0000'));
    for (const sentence of joined.split(/(?<=[.!?])\s+/)) {
      found.push({ text: sentence.replaceAll('\u0000', '.'), line: start });
    }
    paragraph = [];
  };
  lines.forEach((line, index) => {
    if (line.trim() === '') flush();
    else if (line.trim().startsWith('|')) {
      flush();
      found.push({ text: line, line: index + 1 });
    } else paragraph.push({ text: line, line: index + 1 });
  });
  flush();
  for (const block of codeBlocks(text)) found.push({ text: block.body, line: block.line });
  return found;
}

/** Install claims that do not say they wait for the publish. */
function earlyClaims(doc: string, text: string): string[] {
  return statements(text)
    .filter(({ text: statement }) => INSTALL.test(statement) && !WAITS.test(statement))
    .map(({ text: statement, line }) => `${doc}:${String(line)}: ${statement.slice(0, 160)}`);
}

/** Sentences that still say the release is not on npm. */
function staleWaits(doc: string, text: string): string[] {
  return statements(text)
    .filter(({ text: statement }) => NOT_YET.test(statement))
    .map(({ text: statement, line }) => `${doc}:${String(line)}: ${statement.slice(0, 160)}`);
}

describe('install claims and the release state', () => {
  const heading = newestHeading(readRepo('CHANGELOG.md'));

  it('read the newest CHANGELOG heading', () => {
    expect(heading).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('wait for the publish while the heading says it has not happened', () => {
    if (!unpublished(heading)) return;
    const named = DOCS.filter((doc) => INSTALL.test(readRepo(doc)));
    expect(named.length).toBeGreaterThan(3);
    expect(DOCS.flatMap((doc) => earlyClaims(doc, readRepo(doc)))).toEqual([]);
  });

  it('say nothing is on npm no longer once the heading is dated', () => {
    if (unpublished(heading)) return;
    expect(DOCS.flatMap((doc) => staleWaits(doc, readRepo(doc)))).toEqual([]);
  });

  it('would refuse a claim made too early, and a wait left too long', () => {
    expect(unpublished('0.1.0 (prepared 5 October 2026, not yet published)')).toBe(true);
    expect(unpublished('0.1.0, 9 October 2026')).toBe(false);
    expect(earlyClaims('x.md', 'Run `npx @tabdock/relay` to start.')).not.toEqual([]);
    expect(earlyClaims('x.md', 'Once 0.1.0 is on npm, run `npx @tabdock/relay`.')).toEqual([]);
    expect(
      earlyClaims(
        'x.md',
        '```html\n<script src="https://cdn.jsdelivr.net/npm/@tabdock/adapter@0.1.0/x.js"></script>\n```',
      ),
    ).not.toEqual([]);
    expect(staleWaits('x.md', 'Tabdock 0.1.0 is not yet on npm.')).not.toEqual([]);
  });

  it('reads the newest release past an Unreleased section, never the section itself', () => {
    const unreleasedAbove = [
      '# Changelog',
      '## Unreleased (M6)',
      'Work in progress.',
      '## 0.1.0 (prepared 5 October 2026, not yet published)',
      '## 0.0.9, 1 October 2026',
    ].join('\n\n');
    expect(newestHeading(unreleasedAbove)).toBe(
      '0.1.0 (prepared 5 October 2026, not yet published)',
    );
    expect(unpublished(newestHeading(unreleasedAbove))).toBe(true);
    expect(newestHeading('# Changelog\n\n## 0.2.0, 1 November 2026\n\n## 0.1.0, 9 October')).toBe(
      '0.2.0, 1 November 2026',
    );
  });
});

describe('work past the newest release', () => {
  const changelog = readRepo('CHANGELOG.md');
  const version = /^(\d+\.\d+\.\d+)/.exec(newestHeading(changelog))?.[1] ?? '';
  const unreleased = /^## Unreleased\b/m.test(changelog);
  const missing = newSubpaths(publishedSubpaths(), PUBLISHED_0_1_0);

  it('reads the newest version and the subpaths it lacks', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    if (version === '0.1.0') {
      expect(missing).toEqual(['@tabdock/protocol/devtools', '@tabdock/adapter/testing']);
    }
  });

  it('is said in the guide index to arrive in the release after the newest one', () => {
    if (!unreleased) return;
    expect(readRepo('docs/guide/README.md')).toContain(`the release after ${version}`);
  });

  it('is never installed pinned to the newest release where a section names what it lacks', () => {
    if (!unreleased || version !== '0.1.0') return;
    const docs = ['README.md', ...guidePages(), 'docs/guide/README.md', ...packageReadmes()];
    expect(docs.flatMap((doc) => pinnedWithout(doc, readRepo(doc), version, missing))).toEqual([]);
  });

  it('would fail a pin beside a new subpath, and pass a placeholder or a pin elsewhere', () => {
    const lacks = ['@tabdock/adapter/testing'];
    const pinned = [
      '## Copy the check',
      'It imports `@tabdock/adapter/testing`.',
      '```sh',
      '# pin the release',
      'npm install @tabdock/relay@0.1.0 @tabdock/adapter@0.1.0',
      '```',
    ].join('\n');
    expect(pinnedWithout('x.md', pinned, '0.1.0', lacks)).toEqual(['x.md: ## Copy the check']);
    expect(
      pinnedWithout('x.md', pinned.replaceAll('@0.1.0', '@<version>'), '0.1.0', lacks),
    ).toEqual([]);
    const apart = `${pinned.split('\n').slice(0, 2).join('\n')}\n\n## Install\n\nnpm install @tabdock/adapter@0.1.0`;
    expect(pinnedWithout('x.md', apart, '0.1.0', lacks)).toEqual([]);
    expect(pinnedWithout('x.md', pinned.replaceAll('0.1.0', '0.1.01'), '0.1.0', lacks)).toEqual([]);
    expect(newSubpaths(['@tabdock/adapter', '@tabdock/adapter/testing'], PUBLISHED_0_1_0)).toEqual(
      lacks,
    );
  });
});
