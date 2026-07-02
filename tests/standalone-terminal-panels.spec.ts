/**
 * Add-Terminal / PanelTabBar spec.
 *
 * DEVIATION FROM THE PLAN: the triage table budgets this as a convertible
 * seeded spec. On the ground the "Add terminal panel" button and its "Panel
 * Tabs" bar live ONLY inside CyboflowRoot's `session` view
 * (`PanelTabBar onAddTerminal`), which mounts only once a live session/run
 * exists. The sole way to reach that from a fresh seeded project is to launch a
 * Quick session, which spawns a real CLI (`claude`) process — the exact
 * "prohibitive fixture cost" the original spec already `test.skip`-ped for its
 * session-context case, and not viable in a headless CI runner without the CLI
 * binary + API credentials.
 *
 * So this spec covers the cheap, robust slice — that the Quick session launcher
 * (the entry point to the terminal-hosting surface) is reachable from a seeded
 * project via the wizard — and SKIPS the add-terminal interaction with a TODO.
 */
import {
  test,
  expect,
  bootToCreateDb,
  seedProject,
  makeTmpDataDir,
  rmTmpDataDir,
  makeTmpGitRepo,
  launchElectronApp,
  dismissDialogs,
  settle,
  type ElectronApplication,
  type Page,
} from './helpers/electronApp';

test.describe.configure({ mode: 'serial' });

test.describe('Add Terminal Button — PanelTabBar', () => {
  let dataDir: string;
  let repoPath: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    dataDir = makeTmpDataDir();
    repoPath = makeTmpGitRepo();
    await bootToCreateDb(dataDir);
    seedProject(dataDir, repoPath);
    ({ app, page } = await launchElectronApp(dataDir));
    await dismissDialogs(page);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    rmTmpDataDir(dataDir);
    rmTmpDataDir(repoPath);
  });

  test('the Quick session launcher (terminal-hosting surface entry) is reachable from a seeded project', async () => {
    const startBtn = page.getByRole('button', { name: 'Start new session' }).first();
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await startBtn.click();
    await settle(page);

    // The Quick session card opens the CyboflowRoot session view that hosts the
    // PanelTabBar + Add-terminal button. Its presence is the reachable proxy.
    await expect(page.locator('[data-testid="quick-session-card"]')).toBeVisible({ timeout: 15_000 });
  });

  // TODO: Automate the actual Add-terminal interaction (click "Add terminal
  // panel" → assert a new active `[role="tab"]`). BLOCKED ON: a cheap way to
  // reach CyboflowRoot's `session` view without spawning a real `claude` CLI
  // process. Launching a Quick session from here calls useQuickSession →
  // runs.start, which spawns the CLI; that needs the `claude` binary + API
  // credentials and produces flaky, resource-heavy runs unsuitable for the
  // e2e tier. Revisit once a DemoCliManager-backed or stubbed-substrate launch
  // path is exposed to tests (the demo boot profile is the likely hook).
  test.skip('Clicking Add Terminal creates a new active terminal tab (needs a live session)', async () => {
    // Intentionally skipped — see the TODO above.
  });

  test.skip('Add Terminal button is keyboard-focusable and activates on Enter (needs a live session)', async () => {
    // Intentionally skipped — see the TODO above.
  });
});
