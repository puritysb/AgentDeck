import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'bridge/src/__tests__/**/*.test.ts',
      'hooks/src/__tests__/**/*.test.ts',
      'shared/src/__tests__/**/*.test.ts',
      'plugin/src/__tests__/**/*.test.ts',
      'plugin-ulanzi/src/__tests__/**/*.test.ts',
      'scripts/__tests__/**/*.test.ts',
      'setup/src/__tests__/**/*.test.ts',
    ],
    testTimeout: 10_000,
    // Setup hooks carry the first-use cost of native modules (27 files open an
    // ApmeStore, i.e. load better-sqlite3, inside beforeEach). On a cold
    // 4-core container that first load pushed three hooks past 10 s
    // (2026-09-28, import phase 45 s); the warm re-run took under 1 s. A
    // bounded 30 s keeps a genuine hang failing without flaking a cold runner.
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: [
        'bridge/src/**/*.ts',
        'shared/src/**/*.ts',
        'plugin/src/**/*.ts',
        'hooks/src/**/*.ts',
        // Only the unit-tested Ulanzi module — pulling the whole package in would
        // count its many untested renderer files against the global thresholds.
        'plugin-ulanzi/src/reconnect-supervisor.ts',
      ],
      exclude: [
        '**/__tests__/**',
        '**/node_modules/**',
        '**/dist/**',
      ],
      thresholds: {
        // Regression guard, ~3 points below measured coverage (2026-09-28:
        // lines 59.6, functions 60.0, branches 55.3, statements 58.6). The old
        // 17/15/14/16 sat ~40 points under reality and could not catch a real
        // regression. Raise these as coverage improves; never lower them to
        // land a change.
        lines: 56,
        functions: 57,
        branches: 52,
        statements: 55,
      },
    },
  },
});
