// Install claims must wait for the publish (ADR 0035). While the newest
// heading in CHANGELOG.md says the release is not yet published, nothing is on
// npm, so a reader who runs `npx @tabdock/relay` or `npm install
// @tabdock/adapter`, or loads the jsDelivr tag, meets a 404. Every sentence in
// the README, the guide, the deploy guide and the package READMEs that names
// one must also say it waits ('once' or 'after'), and lead readers to the
// clone. The release commit that dates the heading lifts the rule and turns
// it round: from then on no such doc may still say the release is not on npm.

import { describe, expect, it } from 'vitest';
import {
  codeBlocks,
  markdownIn,
  packageReadmes,
  readRepo,
  withoutCodeBlocks,
} from '../src/doc-files.ts';

const DOCS = ['README.md', ...markdownIn('docs/guide'), 'docs/deploy.md', ...packageReadmes()];
const INSTALL =
  /npx(?: --yes)? @tabdock\/|npm install @tabdock\/|cdn\.jsdelivr\.net\/npm\/@tabdock/;
const WAITS = /\b(?:once|after)\b/i;
const NOT_YET = /\bnot yet (?:on npm|published)\b/i;

/** The newest release heading in CHANGELOG.md. */
function newestHeading(changelog: string): string {
  return /^## (.+)$/m.exec(changelog)?.[1] ?? '';
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
});
