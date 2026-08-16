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
        // Regression guard — set slightly below current levels.
        // Raise these as coverage improves.
        lines: 17,
        functions: 15,
        branches: 14,
        statements: 16,
      },
    },
  },
});
