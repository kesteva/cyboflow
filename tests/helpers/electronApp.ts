/**
 * electronApp.ts — Playwright launch fixture for the built Cyboflow bundle.
 *
 * Root cause this replaces: the legacy configs drove a bare Chromium tab at
 * http://localhost:4521 (the Vite dev renderer). That tab has no Electron
 * `preload`, so `window.electronAPI` never exists, every IPC-backed testid
 * never mounts, and the specs timed out. Here we launch the real packaged
 * main process via `_electron.launch()` and attach Playwright to its window.
 *
 * Launch contract (verified against main/src/index.ts + cyboflowDirectory.ts):
 *  - target: `main/dist/main/src/index.js` (package.json `main`)
 *  - NODE_ENV=production flips `isDevelopment` false → the window `loadFile`s
 *    the built `frontend/dist/index.html` (no Vite dev server in the loop).
 *  - CYBOFLOW_DIR env + `--cyboflow-dir` flag both point at a throwaway tmp
 *    dir so tests never touch `~/.cyboflow_dev`. The CLI flag wins (programmatic
 *    override), the env var is belt-and-suspenders.
 *  - ELECTRON_DISABLE_SANDBOX=1 for headless-ish CI runners.
 *
 * Prereqs (wired via root `pretest:e2e`): `pnpm build:main` + `pnpm
 * build:frontend` + `pnpm electron:rebuild` (better-sqlite3 must match the
 * Electron ABI for the LAUNCHED app — do NOT run host-node vitest after that
 * rebuild until `pnpm rebuild better-sqlite3` restores the host ABI).
 *
 * This helper MUST NOT be used in production code.
 */
import {
  test as base,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Absolute repo root (this file lives at <root>/tests/helpers/). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** Built main entrypoint — matches package.json `main`. */
const MAIN_ENTRY = path.join(REPO_ROOT, 'main', 'dist', 'main', 'src', 'index.js');

/** sessions.db lives directly under the CYBOFLOW_DIR (getBootDatabasePath). */
export function sessionsDbPath(dataDir: string): string {
  return path.join(dataDir, 'sessions.db');
}

/** Create a fresh, isolated CYBOFLOW_DIR for a test or worker. */
export function makeTmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-e2e-'));
}

/** Best-effort recursive delete; never throws (teardown must not fail a test). */
export function rmTmpDataDir(dataDir: string): void {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Launch the built Electron bundle against an isolated data dir and return the
 * app + its first window. Asserts `window.electronAPI` is present so a preload
 * regression fails fast with a clear message instead of a selector timeout.
 */
export async function launchElectronApp(dataDir: string): Promise<{
  app: ElectronApplication;
  page: Page;
}> {
  const app = await electron.launch({
    args: [MAIN_ENTRY, `--cyboflow-dir=${dataDir}`],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CYBOFLOW_DIR: dataDir,
      ELECTRON_DISABLE_SANDBOX: '1',
    },
  });

  const page = await app.firstWindow();

  // Fixture-level sanity gate — the whole point of the rework. `waitForFunction`
  // (not a one-shot `evaluate`) tolerates the initial about:blank → loadFile
  // navigation that would otherwise destroy the execution context.
  await page
    .waitForFunction(() => Boolean((window as { electronAPI?: unknown }).electronAPI), null, {
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error('window.electronAPI was never exposed by the Electron preload');
    });

  return { app, page };
}

/**
 * Consolidated startup-dialog dismisser (replaces 4 copy-pasted variants).
 * Fresh data dirs show the Welcome modal ("Get Started"); seeded dirs may show
 * an analytics/consent prompt. Both are optional and best-effort.
 */
export async function dismissDialogs(page: Page): Promise<void> {
  const getStarted = page.locator('button:has-text("Get Started")');
  if (await getStarted.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await getStarted.click().catch(() => {});
    await settle(page, 300);
  }

  const consent = page
    .locator('button:has-text("I Agree"), button:has-text("Accept"), button:has-text("OK")')
    .first();
  if (await consent.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await consent.click().catch(() => {});
    await settle(page, 300);
  }
}

/** Small deterministic settle — replaces ad-hoc `waitForTimeout` sprinkles. */
export async function settle(page: Page, ms = 250): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Boot the app once purely to create + migrate `sessions.db` under `dataDir`,
 * then close it. Used before `seedProject`, which needs the schema to exist.
 */
export async function bootToCreateDb(dataDir: string): Promise<void> {
  const { app } = await launchElectronApp(dataDir);
  // firstWindow having electronAPI means the main process booted; poll until
  // the migrated `projects` table exists before we hand off to sqlite3.
  await waitForProjectsTable(dataDir, 20_000);
  await app.close();
}

/** Poll until the migrated `projects` table exists in the freshly-created DB. */
async function waitForProjectsTable(dataDir: string, timeoutMs: number): Promise<void> {
  const dbPath = sessionsDbPath(dataDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(dbPath)) {
      try {
        const out = execFileSync(
          '/usr/bin/sqlite3',
          [dbPath, "SELECT name FROM sqlite_master WHERE type='table' AND name='projects';"],
          { encoding: 'utf-8' },
        ).trim();
        if (out === 'projects') return;
      } catch {
        /* db mid-migration / locked — retry */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`bootToCreateDb: projects table never materialized in ${dbPath} within ${timeoutMs}ms`);
}

/**
 * Seed a single active project row directly into an already-migrated
 * `sessions.db` via the macOS `sqlite3` CLI.
 *
 * Why the CLI and not better-sqlite3: after `pnpm electron:rebuild` the native
 * better-sqlite3 binary is compiled for the Electron ABI, so importing it from
 * the host-node Playwright runner throws NODE_MODULE_VERSION. The `sqlite3` CLI
 * (`/usr/bin/sqlite3`, present on every macOS runner) sidesteps that entirely.
 *
 * `active = 1` makes it the project `ProjectSelector` auto-selects
 * (`data.find(p => p.active)`), which is what renders CyboflowRoot / the
 * workflow picker instead of the no-project fallback.
 *
 * Requires `bootToCreateDb(dataDir)` first (the schema must exist).
 */
export function seedProject(dataDir: string, repoPath: string, name = 'e2e-project'): void {
  const dbPath = sessionsDbPath(dataDir);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`seedProject: ${dbPath} does not exist — call bootToCreateDb() first`);
  }
  const esc = (v: string): string => v.replace(/'/g, "''");
  const sql = `INSERT INTO projects (name, path, active) VALUES ('${esc(name)}', '${esc(repoPath)}', 1);`;
  execFileSync('/usr/bin/sqlite3', [dbPath, sql], { encoding: 'utf-8' });
}

/**
 * Create a throwaway git repo with one commit — the cheapest fixture that lets
 * a seeded project resolve a real worktree base.
 */
export function makeTmpGitRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cyboflow-e2e-repo-'));
  const run = (cmd: string, args: string[]): void => {
    execFileSync(cmd, args, { cwd: repo, stdio: 'ignore' });
  };
  run('git', ['init', '-b', 'main']);
  run('git', ['config', 'user.email', 'e2e@cyboflow.test']);
  run('git', ['config', 'user.name', 'Cyboflow E2E']);
  fs.writeFileSync(path.join(repo, 'README.md'), '# e2e fixture repo\n');
  run('git', ['add', '.']);
  run('git', ['commit', '-m', 'initial']);
  return repo;
}

/**
 * Extended `test` for no-seed specs: auto-launches the built bundle against a
 * fresh per-test tmp CYBOFLOW_DIR and tears it down (close app + rm tmp dir).
 *
 * Seeded specs (picker, terminal) do NOT use this — they need pre-launch DB
 * seeding, so they drive `bootToCreateDb` / `seedProject` / `launchElectronApp`
 * directly.
 */
export const test = base.extend<{
  dataDir: string;
  app: ElectronApplication;
  page: Page;
}>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  dataDir: async ({}, use) => {
    const dir = makeTmpDataDir();
    await use(dir);
    rmTmpDataDir(dir);
  },
  app: async ({ dataDir }, use) => {
    const { app } = await launchElectronApp(dataDir);
    await use(app);
    await app.close().catch(() => {});
  },
  page: async ({ app }, use) => {
    const page = await app.firstWindow();
    await use(page);
  },
});

export { expect };
export type { ElectronApplication, Page };
