import { defineConfig } from 'vitest/config';

// End-to-end suites that start real product processes (`pnpm test:e2e`).
// Kept out of the root `pnpm test` include: they need `pnpm build` output, take
// seconds per case, and are run by their own CI job (`daemon-e2e` in ci.yml).
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 40_000,
    // One daemon per file; files run one at a time so their ports never race.
    fileParallelism: false,
  },
});
