import { defineConfig } from 'vitest/config';
import path from 'path';

// Optional cap on the fork-pool worker count. Unset -> vitest's default (one
// worker per CPU), so normal single-gate runs are unchanged. Set it to bound
// the suite's process/fd footprint when several full gates run concurrently in
// one shared worktree (sprint sibling lanes) — that concurrency, not any single
// run, is what pushes the machine past kern.maxfiles (system-wide, ~122880) and
// makes fs.watch-based watcher tests the EMFILE victim. e.g. CYBOFLOW_TEST_MAX_FORKS=4.
const maxForksEnv = Number(process.env.CYBOFLOW_TEST_MAX_FORKS);
const maxForks = Number.isInteger(maxForksEnv) && maxForksEnv > 0 ? maxForksEnv : undefined;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    ...(maxForks !== undefined
      ? { pool: 'forks' as const, poolOptions: { forks: { maxForks, minForks: 1 } } }
      : {}),
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