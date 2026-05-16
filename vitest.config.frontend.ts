/**
 * Vitest configuration for frontend unit tests.
 *
 * Covers tests in frontend/src/ that can run in a jsdom/happy-dom browser-like
 * environment without the full Vite/Electron dev server.  Tests in this suite
 * use pure functions only (no IPC, no Electron context).
 *
 * Usage:
 *   pnpm test:unit:frontend
 *
 * Why separate from main/vitest.config.ts:
 *   - The main config uses `environment: 'node'` (required for better-sqlite3
 *     and other Node-native modules).  Frontend tests need a DOM environment.
 *   - The main config's `include` pattern is scoped to main/src/.
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
