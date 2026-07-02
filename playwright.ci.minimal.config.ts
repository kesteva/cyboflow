import { defineConfig } from '@playwright/test';

/**
 * Smoke e2e tier — the fast, no-seed subset (health-check + smoke +
 * permissions). Each test gets its own fresh tmp CYBOFLOW_DIR from the fixture,
 * so there is no shared state; it could be parallelized, but Electron windows
 * grab screen focus, so `workers: 1` keeps CI runs stable.
 *
 * Drives the built Electron bundle via `_electron.launch()` — no
 * `webServer`/`baseURL`. Prereqs: built main + frontend + Electron-ABI
 * better-sqlite3 (see playwright.config.ts header).
 */
export default defineConfig({
  testDir: './tests',
  testMatch: ['health-check.spec.ts', 'smoke.spec.ts', 'permissions-ui-fixed.spec.ts'],
  timeout: 60 * 1000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
