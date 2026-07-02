import { defineConfig } from '@playwright/test';

/**
 * Full e2e tier — every spec, driving the built Electron bundle via
 * `_electron.launch()` (see tests/helpers/electronApp.ts). There is NO
 * `webServer`/`baseURL`: the app is launched per-test by the fixture, not by a
 * Vite dev server, and Playwright attaches to the real Electron window.
 *
 * `workers: 1` because the seeded specs (picker, terminal) share a boot-once
 * data dir and launch multiple Electron processes; serial keeps launches and
 * screen focus deterministic. Smoke-only runs should use
 * playwright.ci.minimal.config.ts.
 *
 * Prereqs (enforced by root `pretest:e2e`): built main + frontend, and
 * better-sqlite3 rebuilt for the Electron ABI (`pnpm electron:rebuild`).
 */
export default defineConfig({
  testDir: './tests',
  // Vitest-only specs live under __tests__/ — never let Playwright grab them.
  testIgnore: ['**/__tests__/**', '**/helpers/**'],
  timeout: 90 * 1000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
});
