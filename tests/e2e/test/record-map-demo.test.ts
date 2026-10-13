// pnpm record:map-demo writes a video and a poster that may show a pairing
// code, dead by then but still a code, so git must ignore every file it
// writes, and the root script must reach it. The recording itself runs by
// hand only, never here or in CI.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/doc-files.ts';
import { RECORDING_DIR, RECORDING_FILES } from '../src/record-map-demo.ts';

describe('pnpm record:map-demo', () => {
  it('writes only into a directory git ignores', () => {
    expect(relative(ROOT, RECORDING_DIR)).toBe(join('apps', 'map-demo', 'recording'));
    for (const name of RECORDING_FILES) {
      const path = relative(ROOT, join(RECORDING_DIR, name));
      // check-ignore exits 0 only when the path is ignored, and throws otherwise.
      expect(() =>
        execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: ROOT }),
      ).not.toThrow();
    }
  });

  it('runs from the root and from the end-to-end package, and from no CI workflow', () => {
    const scripts = (dir: string): Record<string, string> =>
      (
        JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8')) as {
          scripts: Record<string, string>;
        }
      ).scripts;
    expect(scripts('.')['record:map-demo']).toBe('pnpm --filter @tabdock/e2e record:map-demo');
    expect(scripts('tests/e2e')['record:map-demo']).toBe('node src/record-map-demo.ts');
    const workflows = join(ROOT, '.github', 'workflows');
    for (const workflow of readdirSync(workflows)) {
      const text = readFileSync(join(workflows, workflow), 'utf8');
      expect(text, workflow).not.toContain('record:map-demo');
    }
  });
});
