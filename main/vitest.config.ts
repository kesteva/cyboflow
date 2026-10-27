import { defineConfig } from 'vitest/config';
import path from 'path';

import { forkPoolOptions } from '../vitestForkCap';

// Cap on the fork-pool worker count. An explicit CYBOFLOW_TEST_MAX_FORKS wins;
// otherwise, when cyboflow marks the process tree as agent-spawned, the cap is
// an even share of the cores across the gates running right now. A gate run by
// hand in a terminal (and CI) keeps vitest's default one-worker-per-CPU.
//
// That concurrency, not any single run, is what pushes the machine past
// kern.maxfiles (system-wide, ~122880) and makes fs.watch-based watcher tests
// the EMFILE victim — and what pins every core when sprint sibling lanes each
// run the full gate in the shared worktree. See shared/types/testConcurrency.ts.

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Windows runners: suites that build a fresh migrated DB per test spend ~2 s in
    // each hook and spike past vitest's 10 s default under full-suite load.
    ...(process.platform === 'win32' ? { hookTimeout: 30_000 } : {}),
    ...forkPoolOptions(),
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
    include: [
      'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
      '../shared/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'src/orchestrator/__tests__/cyboflowDayGate.test.ts',
      // Flake quarantine — *.quarantine.test.ts is pulled out of the blocking
      // suite and run report-only by e2e.yml's flake-watch job, which sets
      // CYBOFLOW_RUN_QUARANTINE=1 to lift this exclude (the quarantined files
      // still match `include`, so this exclude is the only gate). See
      // docs/archive/ci-gate-mocked-sdk-integration.md "Flake quarantine".
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