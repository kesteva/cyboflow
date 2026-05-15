/**
 * Vitest configuration for frontend unit tests.
 *
 * Covers tests in frontend/src/ that can run in a node environment without
 * the full Vite/Electron dev server.  Pure-function tests (formatAge,
 * truncatePayload, store reducers) live here.  Component tests that need
 * jsdom + @testing-library/react use the extended config added by TASK-402
 * (frontend/vite.config.ts test block) — those tests are deferred until the
 * RTL installation is merged.
 *
 * Usage:
 *   pnpm test:unit:frontend
 *
 * Why separate from main/vitest.config.ts:
 *   - The main config's `include` pattern is scoped to main/src/.
 *   - This config deliberately avoids `environment: jsdom` so it can run
 *     even before RTL/jsdom is installed; component tests are guarded inside
 *     the test files themselves.
 */
import { defineConfig } from 'vitest/config';
import path from 'path';

const repoRoot = __dirname;

export default defineConfig({
  root: repoRoot,
  test: {
    globals: true,
    environment: 'node',
    include: ['frontend/src/**/*.{test,spec}.{ts,tsx}'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(repoRoot, 'frontend/src'),
    },
  },
});
