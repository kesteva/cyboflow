/**
 * Vitest configuration for the day-3 gate integration test.
 *
 * This config is intentionally separate from `main/vitest.config.ts` (which
 * covers unit tests inside main/src/) because:
 *
 *  1. The gate test lives at `main/src/orchestrator/__tests__/` so it is
 *     collected by vitest (not Playwright) — the `@` alias resolves to `main/src/`.
 *  2. The gate test imports directly from `main/src/` and `tests/helpers/` via
 *     relative paths.
 *  3. The gate test needs `node` environment and a longer default timeout (120s).
 *
 * Usage: pnpm test:gate
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

// __dirname = directory of this config file = repo root
// (e.g., /Users/raimundoesteva/Developer/cyboflow)
const repoRoot = __dirname;

export default defineConfig({
  root: repoRoot,
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 30_000,
    include: ['main/src/orchestrator/__tests__/cyboflowDayGate.test.ts'],
    // No setupFiles — the gate test bootstraps its own DB and does not mock Electron
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'main/src'),
    },
  },
});
