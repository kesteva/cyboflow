/**
 * Workflow-launch spec — seeds a project, opens the new-flow wizard, and asserts
 * the built-in flows are offered.
 *
 * DEVIATION FROM THE PLAN: the triage table describes a `WorkflowPicker`
 * `<select aria-label="Select workflow">` reached by a "Choose workflow" header
 * button on project select. That UI has since been superseded — CyboflowRoot's
 * legacy `WorkflowPicker` modal only mounts in the `session` view (needs an
 * existing run/session), while the primary launch surface is now the
 * `SessionStartWizard` opened by each project's "Start new session" button
 * (`goToWizard`). This spec drives that current surface instead.
 *
 * Also fixes the stale expectation: the built-ins are `planner` / `sprint` /
 * `compound` (the SoloFlow-era "5 workflows" no longer exist). They surface via
 * `workflows.list` → `ensureGlobalBuiltIns`, which is project-independent, so a
 * directly-seeded project row is sufficient.
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

test.describe('New-flow wizard — built-in workflows', () => {
  let dataDir: string;
  let repoPath: string;
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    dataDir = makeTmpDataDir();
    repoPath = makeTmpGitRepo();
    // Boot once to create + migrate the DB, then seed a project row directly.
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

  async function openWizard(): Promise<void> {
    const startBtn = page.getByRole('button', { name: 'Start new session' }).first();
    await expect(startBtn).toBeVisible({ timeout: 15_000 });
    await startBtn.click();
    await settle(page);
  }

  test('the seeded project renders in the sidebar', async () => {
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('e2e-project').first()).toBeVisible({ timeout: 10_000 });
  });

  test('the wizard offers Planner, Sprint, and Compound', async () => {
    await openWizard();

    const rows = page.locator('[data-testid="workflow-list-row"]');
    // Built-ins load over an IPC round-trip; wait for at least the three.
    await expect
      .poll(async () => rows.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    const titles = await rows.allInnerTexts();
    const joined = titles.join('\n');
    expect(joined).toContain('Planner');
    expect(joined).toContain('Sprint');
    expect(joined).toContain('Compound');
  });

  test('selecting Sprint advances to the configure step with a launch CTA', async () => {
    await openWizard();

    const rows = page.locator('[data-testid="workflow-list-row"]');
    await expect
      .poll(async () => rows.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(3);

    // Click the Sprint row.
    await rows.filter({ hasText: 'Sprint' }).first().click();
    await settle(page);

    await expect(page.locator('[data-testid="wizard-step3"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="wizard-cta"]')).toBeVisible();
  });
});
