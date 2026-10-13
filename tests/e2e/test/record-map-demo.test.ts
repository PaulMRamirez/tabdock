// pnpm record:map-demo films the map demo with the pairing code kept off
// camera, writes its take, poster and stills into a directory git ignores
// for a person to look at, and copies a take within budget into
// apps/map-demo/media/, which the page links and the site publishes. This
// holds the review files ignored, the kept files tracked, the right kind and
// within budget, and the script reachable from the root and from no CI
// workflow. The recording itself runs by hand only, never here or in CI.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../src/doc-files.ts';
import { pngDimensions } from '../src/image-helpers.ts';
import { MEDIA_BUDGET, MEDIA_DIR, RECORDING_DIR, RECORDING_FILES } from '../src/record-map-demo.ts';

/** Whether git ignores a path, whether or not it exists. */
function ignored(path: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', path], { cwd: ROOT });
    return true;
  } catch {
    return false;
  }
}

/** Whether git tracks a path. */
function tracked(path: string): boolean {
  return (
    execFileSync('git', ['ls-files', '--', path], { cwd: ROOT, encoding: 'utf8' }).trim() === path
  );
}

describe('pnpm record:map-demo', () => {
  it('writes its take, poster and stills for review only where git ignores them', () => {
    expect(relative(ROOT, RECORDING_DIR)).toBe(join('apps', 'map-demo', 'recording'));
    for (const name of [...Object.values(RECORDING_FILES), 'stills/01-page.png']) {
      expect(ignored(relative(ROOT, join(RECORDING_DIR, name))), name).toBe(true);
    }
  });

  it('keeps exactly a WebM and a 1280 by 720 PNG poster in media/, tracked and within budget', () => {
    expect(relative(ROOT, MEDIA_DIR)).toBe(join('apps', 'map-demo', 'media'));
    expect(MEDIA_BUDGET).toEqual({ video: 4_000_000, poster: 300_000 });
    expect(readdirSync(MEDIA_DIR).sort()).toEqual(Object.values(RECORDING_FILES).sort());
    for (const name of Object.values(RECORDING_FILES)) {
      const path = relative(ROOT, join(MEDIA_DIR, name));
      expect(ignored(path), path).toBe(false);
      expect(tracked(path), path).toBe(true);
    }

    const video = readFileSync(join(MEDIA_DIR, RECORDING_FILES.video));
    expect(video.length).toBeLessThanOrEqual(MEDIA_BUDGET.video);
    // An EBML header naming the webm document type.
    expect([...video.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(video.subarray(0, 64).includes(Buffer.from('webm'))).toBe(true);

    const poster = readFileSync(join(MEDIA_DIR, RECORDING_FILES.poster));
    expect(poster.length).toBeLessThanOrEqual(MEDIA_BUDGET.poster);
    expect(pngDimensions(new Uint8Array(poster))).toEqual({ width: 1280, height: 720 });
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
