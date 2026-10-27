import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

import { forkPoolOptions } from '../vitestForkCap';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Same fork-pool governor as main/vitest.config.ts — `pnpm test:unit` runs
    // BOTH suites, so capping only main leaves half the oversubscription in
    // place. See shared/types/testConcurrency.ts.
    ...forkPoolOptions(),
    // Windows runners: leave room for the raised asyncUtilTimeout in src/test/setup.ts.
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    // Flake quarantine — *.quarantine.test.ts is pulled out of the blocking
    // suite and run report-only by e2e.yml's flake-watch job, which sets
    // CYBOFLOW_RUN_QUARANTINE=1 to lift this exclude. See
    // docs/archive/ci-gate-mocked-sdk-integration.md "Flake quarantine".
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.CYBOFLOW_RUN_QUARANTINE ? [] : ['**/*.quarantine.test.ts']),
    ],
    setupFiles: ['./src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/__tests__/**',
        '**/*.test.*',
        '**/*.spec.*',
        'src/test/**',
        'src/main.tsx',
      ],
    },
  },
});
