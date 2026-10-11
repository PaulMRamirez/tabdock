// The Wave 3 gate (A6.26, docs/plans/M6.md): M6's foundation stubbed every
// part a later wave built and marked each stub, so this fails while any part
// is still a stub, and while any sentence the documents wrote ahead of the
// code is still a promise. No seam marker is left in the sources, tests or
// scripts but the one constant that names it for packages/relay's
// foundation test; first-class tools carry SPEC section 7's prefix word for
// word; every setting guide page 14 lists is read by the relay outside
// config.ts, where it is only parsed; and no setting is refused as one the
// relay does not read, serve or write yet.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_FIRST_CLASS_ORIGIN_CHARS } from '@tabdock/protocol';
import { describe, expect, it } from 'vitest';
import { firstClassDescription } from '../../../packages/relay/src/first-class.ts';
import { readRepo, ROOT, tables } from '../src/doc-files.ts';

/** The marker each foundation stub carried, as packages/relay/test/m6-foundation.test.ts names it. */
const SEAM_MARKER = '// M6 seam: not built';
/** The one line allowed to hold the marker: a test's constant naming it, as above. */
const NAMING_LINE = `const SEAM_MARKER = '${SEAM_MARKER}';`;
/** What a stub said, with or without the comment's slashes (a stub that threw said it too). */
const MARKER_WORDS = SEAM_MARKER.slice(3);
/** The words the foundation's refusals of a setting not built yet used, written apart so this file holds none of them. */
const NOT_YET = ['read', 'served', 'written'].map((verb) =>
  ['not', verb, 'by this relay yet'].join(' '),
);
const TREES = ['packages', 'apps', 'tests', 'scripts'];

/** Every file git tracks under the four trees, and any it would track once added. */
function sourceFiles(): string[] {
  const listed = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...TREES],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return [...new Set(listed.split('\0').filter((path) => path !== ''))].filter((path) =>
    existsSync(join(ROOT, path)),
  );
}

/** Each text line, with its place, that holds one of `needles`; a file holding a NUL byte is not text. */
function linesHolding(files: readonly string[], needles: readonly string[]): string[] {
  const found: string[] = [];
  for (const path of files) {
    const bytes = readFileSync(join(ROOT, path));
    if (bytes.includes(0)) continue;
    bytes
      .toString('utf8')
      .split('\n')
      .forEach((line, index) => {
        if (needles.some((needle) => line.includes(needle))) {
          found.push(`${path}:${String(index + 1)}: ${line.trim()}`);
        }
      });
  }
  return found;
}

/** The relay's sources but config.ts, without comments, so a setting named only in prose is not read. */
function relayCodeOutsideConfig(dir = join(ROOT, 'packages/relay/src')): string {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return [relayCodeOutsideConfig(path)];
      if (!name.endsWith('.ts') || path === join(ROOT, 'packages/relay/src/config.ts')) return [];
      return [
        readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, ''),
      ];
    })
    .join('\n');
}

/** Whether code reads the field, as a property or by destructuring. */
function reads(code: string, field: string): boolean {
  return new RegExp(`\\.${field}\\b|\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`).test(code);
}

/**
 * The option field config.ts parses a setting into, read off the refusals
 * that name both as `field (TABDOCK_...)`, so the map is the code's own.
 */
function fieldOf(config: string, setting: string): string[] {
  const named = [...config.matchAll(new RegExp(`\\b(\\w+) \\(${setting}\\)`, 'g'))];
  return [...new Set(named.map((match) => match[1] ?? ''))];
}

describe('the Wave 3 gate (A6.26)', () => {
  const files = sourceFiles();

  it('finds no seam marker left in packages, apps, tests or scripts', () => {
    expect(files.length).toBeGreaterThan(100);
    const left = linesHolding(files, [MARKER_WORDS]).filter(
      (line) => line.slice(line.indexOf(': ') + 2) !== NAMING_LINE,
    );
    expect(left).toEqual([]);
  });

  it('finds the marker where one is, and passes only the line that names it', () => {
    // Shown on the foundation's own constant, so a scan that read nothing could not pass.
    const naming = linesHolding(files, [MARKER_WORDS]);
    expect(
      naming.some(
        (line) =>
          line.startsWith('packages/relay/test/m6-foundation.test.ts:') &&
          line.endsWith(NAMING_LINE),
      ),
    ).toBe(true);
    expect(naming.every((line) => line.endsWith(`: ${NAMING_LINE}`))).toBe(true);
  });

  it('finds no setting refused as one this relay does not read, serve or write yet', () => {
    expect(linesHolding(files, NOT_YET)).toEqual([]);
  });

  it("gives first-class tools SPEC section 7's prefix word for word", () => {
    const spec = readRepo('SPEC.md');
    const section = spec.slice(spec.indexOf('## 7. '), spec.indexOf('## 8. '));
    const promised =
      /description is the prefix `(\[tabdock: [^`]+\])`, with the origin cut to (\d+) characters, then `([^`]+)`/.exec(
        section,
      );
    expect(promised).not.toBeNull();
    const [, prefix = '', cut = '', then = ''] = promised ?? [];
    expect(Number(cut)).toBe(MAX_FIRST_CLASS_ORIGIN_CHARS);
    const origin = `https://${'o'.repeat(120)}.example`;
    const built = firstClassDescription('pg_seams', origin, {
      name: 'get_view',
      description: '',
      inputSchema: { type: 'object' },
    });
    const expected = `${prefix
      .replace('<name>', 'get_view')
      .replace('<page id>', 'pg_seams')
      .replace('<origin>', origin.slice(0, Number(cut)))} ${then}`;
    expect(built.slice(0, expected.length)).toBe(expected);
  });

  describe('every setting guide page 14 lists', () => {
    const page = 'docs/guide/14-settings-for-rooms.md';
    const settings = tables(readRepo(page)).flatMap((table) =>
      table.rows.flatMap((row) => {
        const name = /^`(TABDOCK_[A-Z0-9_]+)`$/.exec(row.values[0] ?? '')?.[1];
        return name === undefined ? [] : [name];
      }),
    );
    const config = readRepo('packages/relay/src/config.ts');
    const code = relayCodeOutsideConfig();

    it('is one the page states, M6 room, member, agent and restart settings among them', () => {
      expect(settings).toEqual(
        expect.arrayContaining([
          'TABDOCK_MAX_IMAGE_BYTES',
          'TABDOCK_MAX_OBSERVERS_PER_PAGE',
          'TABDOCK_MEMBERS_FILE',
          'TABDOCK_AGENT_TOKENS',
          'TABDOCK_RESTART_SNAPSHOT',
        ]),
      );
    });

    it('is parsed into one option field, which the relay reads outside config.ts', () => {
      const unread = settings.flatMap((setting) => {
        const fields = fieldOf(config, setting);
        if (fields.length !== 1) return [`${setting}: config.ts names ${JSON.stringify(fields)}`];
        const [field = ''] = fields;
        return reads(code, field) ? [] : [`${setting}: ${field} is read only in config.ts`];
      });
      expect(unread).toEqual([]);
    });

    it('would be caught parsed and never read', () => {
      expect(fieldOf(config, 'TABDOCK_RESTART_SNAPSHOT')).toEqual(['restartSnapshot']);
      expect(reads('if (options.restartSnapshot) take();', 'restartSnapshot')).toBe(true);
      expect(reads('const { restartSnapshot, port } = options;', 'restartSnapshot')).toBe(true);
      expect(reads('const restartSnapshot = parseFlag(name, value);', 'restartSnapshot')).toBe(
        false,
      );
      expect(code).not.toContain('// ');
    });
  });
});
