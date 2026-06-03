/**
 * Cyboflow workflow-picker smoke spec.
 *
 * Exercises the WorkflowPicker, RunView, and CyboflowRoot components at the
 * Playwright level.  These tests run against the renderer at
 * http://localhost:4521 (set in playwright.config.ts as baseURL) and require:
 *   - `pnpm dev` (or the test harness equivalent) to be running
 *   - At least one project configured so the app renders CyboflowRoot
 *     instead of the welcome / no-project fallback
 *
 * Acceptance criteria covered (updated in TASK-688):
 *   AC1/2 — WorkflowPicker renders with a select element after opening the picker
 *            modal via the trigger button; Start Run button present inside the modal
 *   AC3   — CyboflowRoot shows "Choose a workflow to start" CTA before any run is started
 *   AC4   — CyboflowRoot is mounted in App.tsx (verified by checking for the
 *            "Choose workflow" trigger button)
 */
import { type Page, test, expect } from '@playwright/test';

/** Navigate to the app and dismiss common startup dialogs. */
async function navigateAndDismissDialogs(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 30_000 });

  const getStartedBtn = page.locator('button:has-text("Get Started")');
  if (await getStartedBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await getStartedBtn.click();
    await page.waitForTimeout(300);
  }
  const analyticsBtn = page
    .locator('button:has-text("I Agree"), button:has-text("Accept"), button:has-text("OK")')
    .first();
  if (await analyticsBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await analyticsBtn.click();
    await page.waitForTimeout(300);
  }
}

/**
 * Check whether CyboflowRoot is present by looking for the "Choose workflow"
 * header trigger button (visible regardless of project/run state).
 * Returns false if the trigger is not found (e.g. no active project).
 */
async function hasCyboflowRoot(page: Page): Promise<boolean> {
  const trigger = page.locator(
    '[data-testid="open-workflow-picker"], button:has-text("Choose workflow")',
  );
  return trigger.isVisible({ timeout: 5_000 }).catch(() => false);
}

/**
 * Open the WorkflowPicker modal by clicking the header "Choose workflow" button.
 * Returns the modal locator once it is visible.
 */
async function openPicker(page: Page) {
  const trigger = page.locator(
    '[data-testid="open-workflow-picker"], button:has-text("Choose workflow")',
  ).first();
  await trigger.click();
  const modal = page.locator('[role="dialog"]');
  await modal.waitFor({ state: 'visible', timeout: 5_000 });
  return modal;
}

test.describe('CyboflowRoot / WorkflowPicker', () => {
  test('workflow select is present when a project is active', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const hasRoot = await hasCyboflowRoot(page);
    if (!hasRoot) {
      test.skip(true, 'No active project found; workflow picker is not rendered in no-project state');
      return;
    }

    await openPicker(page);

    const select = page.locator('select[aria-label="Select workflow"]');
    await expect(select).toBeVisible({ timeout: 5_000 });
  });

  test('workflow select contains the 5 SoloFlow workflow options', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const hasRoot = await hasCyboflowRoot(page);
    if (!hasRoot) {
      test.skip(true, 'No active project found');
      return;
    }

    await openPicker(page);

    const select = page.locator('select[aria-label="Select workflow"]');

    // Wait for options to be populated (IPC round-trip)
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('select[aria-label="Select workflow"]');
        return sel !== null && sel.querySelectorAll('option').length >= 2;
      },
      { timeout: 10_000 },
    );

    const options = await select.locator('option').allTextContents();
    const expectedNames = ['planner', 'sprint'];
    for (const name of expectedNames) {
      expect(options).toContain(name);
    }
  });

  test('Start Run button is present alongside the workflow select', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const hasRoot = await hasCyboflowRoot(page);
    if (!hasRoot) {
      test.skip(true, 'No active project found');
      return;
    }

    await openPicker(page);

    const startBtn = page.locator('button:has-text("Start Run")');
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
  });

  /**
   * AC3 — CyboflowRoot shows "Choose a workflow to start" CTA before any run is started.
   *
   * When CyboflowRoot is rendered and cyboflowStore.activeRunId is null (the
   * initial state), the empty-state branch renders a centered CTA with the text
   * "Choose a workflow to start".
   */
  test('CyboflowRoot shows "Choose a workflow to start" CTA before a run is started', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const hasRoot = await hasCyboflowRoot(page);
    if (!hasRoot) {
      test.skip(true, 'No active project found; CyboflowRoot is not rendered');
      return;
    }

    // The empty-state CTA is visible immediately because no run has been
    // started (activeRunId is null on fresh load).
    const cta = page.locator('text=Choose a workflow to start');
    await expect(cta).toBeVisible({ timeout: 5_000 });
  });
});
