import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.config.*',
        '**/test/**',
        'src/index.ts',
        'src/preload.ts',
      ]
    },
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/orchestrator/__tests__/cyboflowDayGate.test.ts',
      // Flake quarantine — *.quarantine.test.ts is pulled out of the blocking
      // suite and run report-only by e2e.yml's flake-watch job, which sets
      // CYBOFLOW_RUN_QUARANTINE=1 to lift this exclude (the quarantined files
      // still match `include`, so this exclude is the only gate). See
      // docs/plans/ci-gate-mocked-sdk-integration.md "Flake quarantine".
      ...(process.env.CYBOFLOW_RUN_QUARANTINE ? [] : ['**/*.quarantine.test.ts']),
    ],
    setupFiles: ['./src/test/setup.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});