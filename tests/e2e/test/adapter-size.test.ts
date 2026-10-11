// The script-tag build's ceiling (ADRs 0028 and 0048, section 8, A6.26): the
// adapter a page loads with one <script> tag, built here in memory with
// exactly the options packages/adapter/scripts/build.ts writes it with,
// minified, must stay under 200,000 bytes, raised for M6 from M5's 150,000.
// It measured 286,140 on classic zod, about 127,000 on zod/mini, 146,091
// after M6's foundation and 136,645 once the protocol named its one side
// effect; a dependency or a locale that creeps back in fails
// here before a release ships it. ADR 0048's per-wave checkpoints are
// recorded in docs/plans/M6.md at each wave's merge.

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scriptTagBytes } from '../../../packages/adapter/scripts/script-tag-build.ts';
import { SCRIPT_TAG_LIMIT_BYTES } from '../../../scripts/release-check.ts';

describe('the adapter script-tag build', () => {
  it('stays under 200,000 bytes minified', async () => {
    expect(SCRIPT_TAG_LIMIT_BYTES).toBe(200_000);
    const bytes = await scriptTagBytes();
    expect(bytes).toBeLessThan(SCRIPT_TAG_LIMIT_BYTES);
    // A build that lost the adapter would pass the ceiling for the wrong reason.
    expect(bytes).toBeGreaterThan(50_000);
  }, 60_000);

  // The session record's modules keep a budget of their own, which W3-A's
  // metafile check holds; ADR 0045's decision is the one in force, so SPEC
  // and ADR 0048 name the same number until a decision changes it.
  it("names one budget for the session record's modules", async () => {
    const read = (path: string): Promise<string> =>
      readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    const bound = (text: string, pattern: RegExp): string | undefined => pattern.exec(text)?.[1];
    const decided = bound(
      await read('docs/adr/0045-session-record-for-the-operator.md'),
      /^23\. \*\*Budget:\*\* at most ([\d,]+) bytes/m,
    );
    expect(decided).toMatch(/^[\d,]+$/);
    expect(bound(await read('SPEC.md'), /the record's modules under ([\d,]+)/)).toBe(decided);
    expect(
      bound(
        await read('docs/adr/0048-script-tag-ceiling-for-m6.md'),
        /The session record's modules \(ADR 0045\) keep their own budget of ([\d,]+) bytes/,
      ),
    ).toBe(decided);
  });

  // Importing any schema must still run zod-config.ts, in the workspace's
  // sources and in the published dist alike; every other protocol module is
  // pure, so the build may drop those a page never imports (ADR 0048's notes).
  it('drops unused protocol modules but never zod-config', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../../../packages/protocol/package.json', import.meta.url), 'utf8'),
    ) as { sideEffects?: unknown };
    expect(manifest.sideEffects).toEqual(['./src/zod-config.ts', './dist/zod-config.js']);
  });
});
