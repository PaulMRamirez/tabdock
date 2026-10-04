import { configDefaults, defineConfig } from 'vitest/config';

// One root run covers every workspace package. Browser tests use Playwright
// (*.spec.ts under tests/e2e) and stay out of this run so `pnpm test` needs no browser.

const INCLUDE = '{packages,apps,tests}/*/{src,test}/**/*.test.ts';

/**
 * Files that time the relay's main loop against a yardstick taken earlier in
 * the same file, so they run alone once everything else has finished. Beside
 * the rest of the suite, which from M4 starts child relays of its own (whole
 * hosted relays filling their tool budget among them), a load spike can land
 * on one measure and not the other and fail a build that is fine, or pass
 * one that is not.
 */
const ALONE = ['packages/relay/test/tools-flood.test.ts'];

const shared = {
  environment: 'node' as const,
  // Throwaway homes for every test file, so local mode never touches the real one.
  setupFiles: ['./vitest.setup.ts'],
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          ...shared,
          name: 'unit',
          include: [INCLUDE],
          exclude: [...configDefaults.exclude, ...ALONE],
        },
      },
      {
        test: {
          ...shared,
          name: 'alone',
          include: ALONE,
          // A later group starts only when the earlier one has finished.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
