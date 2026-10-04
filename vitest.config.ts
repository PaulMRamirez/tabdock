import { defineConfig } from 'vitest/config';

// One root run covers every workspace package. Browser tests use Playwright
// (*.spec.ts under tests/e2e) and stay out of this run so `pnpm test` needs no browser.
export default defineConfig({
  test: {
    include: ['{packages,apps,tests}/*/{src,test}/**/*.test.ts'],
    environment: 'node',
    // Throwaway homes for every test file, so local mode never touches the real one.
    setupFiles: ['./vitest.setup.ts'],
  },
});
