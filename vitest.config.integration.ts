/**
 * Vitest configuration for the Tier-3 mocked-SDK integration suite.
 *
 * Separate from `main/vitest.config.ts` (unit tests) because:
 *
 *  1. Tier-3 files use the `*.itest.ts` extension so main's unit config
 *     (`include: ['src/**\/*.{test,spec}.…']`) NEVER collects them — `.itest.ts`
 *     matches neither `.test.` nor `.spec.`. This config includes ONLY
 *     `main/src/**\/*.itest.ts`.
 *  2. They boot the real orchestrator stack over a migration-replay temp DB and
 *     import from `main/src` + `tests/helpers` via relative paths — the `@` alias
 *     resolves to `main/src/` (same as the gate config).
 *  3. Process-wide singletons (ApprovalRouter, TaskChangeRouter, …) force
 *     `pool: 'forks'` + `maxWorkers: 1` so scenario files run serialized in one
 *     worker; `integration.setup.ts` resets each between tests.
 *
 * Usage: pnpm test:integration
 */
import { defineConfig, configDefaults } from 'vitest/config';
import path from 'path';

import { titleVitestRoot } from './vitestForkCap';

// vitest 4 no longer titles its root; the orphan reaper/gate counter key on it.
titleVitestRoot();

// __dirname = repo root (this config lives at the root).
const repoRoot = __dirname;

export default defineConfig({
  root: repoRoot,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 30_000,
    include: ['main/src/**/*.itest.ts'],
    // Flake quarantine — *.quarantine.itest.ts is pulled out of the blocking
    // suite and run report-only by e2e.yml's flake-watch job, which sets
    // CYBOFLOW_RUN_QUARANTINE=1 to lift this exclude. See
    // docs/archive/ci-gate-mocked-sdk-integration.md "Flake quarantine".
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.CYBOFLOW_RUN_QUARANTINE ? [] : ['**/*.quarantine.itest.ts']),
    ],
    pool: 'forks',
    // vitest 4 removed poolOptions.forks.singleFork; maxWorkers: 1 keeps files
    // serialized (one fork at a time, still isolated per file).
    maxWorkers: 1,
    // main/src/test/setup.ts mocks electron/sentry/aptabase; integration.setup.ts
    // installs the defensive SDK mock + resets singletons.
    setupFiles: [
      path.resolve(repoRoot, 'main/src/test/setup.ts'),
      path.resolve(repoRoot, 'main/src/test/integration/integration.setup.ts'),
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'main/src'),
    },
  },
});
