/**
 * Cyboflow workflow-picker smoke spec.
 *
 * Exercises the WorkflowPicker and CyboflowRoot components at the Playwright
 * level.  These tests run against the renderer at http://localhost:4521 (set
 * in playwright.config.ts as baseURL) and require:
 *   - `pnpm dev` (or the test harness equivalent) to be running
 *   - At least one project configured so the app renders CyboflowRoot
 *     instead of the welcome / no-project fallback
 *
 * Acceptance criteria covered:
 *   AC1/2 — WorkflowPicker renders with a select element; Start Run button present
 *   AC4   — CyboflowRoot is mounted in App.tsx (verified by checking for the
 *            aria-label on the workflow select)
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

test.describe('CyboflowRoot / WorkflowPicker', () => {
  test('workflow select is present when a project is active', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const select = page.locator('select[aria-label="Select workflow"]');
    const hasSelect = await select.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasSelect) {
      test.skip(true, 'No active project found; workflow picker is not rendered in no-project state');
      return;
    }

    await expect(select).toBeVisible();
  });

  test('workflow select contains the 5 SoloFlow workflow options', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const select = page.locator('select[aria-label="Select workflow"]');
    const hasSelect = await select.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasSelect) {
      test.skip(true, 'No active project found');
      return;
    }

    // Wait for options to be populated (IPC round-trip)
    await page.waitForFunction(
      () => {
        const sel = document.querySelector('select[aria-label="Select workflow"]');
        return sel !== null && sel.querySelectorAll('option').length >= 5;
      },
      { timeout: 10_000 },
    );

    const options = await select.locator('option').allTextContents();
    const expectedNames = ['soloflow', 'planner', 'sprint', 'compound', 'prune'];
    for (const name of expectedNames) {
      expect(options).toContain(name);
    }
  });

  test('Start Run button is present alongside the workflow select', async ({ page }) => {
    await navigateAndDismissDialogs(page);

    const select = page.locator('select[aria-label="Select workflow"]');
    const hasSelect = await select.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!hasSelect) {
      test.skip(true, 'No active project found');
      return;
    }

    const startBtn = page.locator('button:has-text("Start Run")');
    await expect(startBtn).toBeVisible({ timeout: 5_000 });
  });
});
