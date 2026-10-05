// The script-tag build's ceiling (ADR 0028, A5.5): the adapter a page loads
// with one <script> tag, built here in memory with exactly the options
// packages/adapter/scripts/build.ts writes it with, minified, must stay under
// 150,000 bytes. It measured 286,140 on classic zod and about 127,000 on
// zod/mini; a dependency or a locale that creeps back in fails here before a
// release ships it.

import { describe, expect, it } from 'vitest';
import { scriptTagBytes } from '../../../packages/adapter/scripts/script-tag-build.ts';
import { SCRIPT_TAG_LIMIT_BYTES } from '../../../scripts/release-check.ts';

describe('the adapter script-tag build', () => {
  it('stays under 150,000 bytes minified', async () => {
    expect(SCRIPT_TAG_LIMIT_BYTES).toBe(150_000);
    const bytes = await scriptTagBytes();
    expect(bytes).toBeLessThan(SCRIPT_TAG_LIMIT_BYTES);
    // A build that lost the adapter would pass the ceiling for the wrong reason.
    expect(bytes).toBeGreaterThan(50_000);
  }, 60_000);
});
