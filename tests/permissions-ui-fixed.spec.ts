/**
 * Settings-dialog spec — a real IPC-backed round-trip against the built bundle.
 *
 * DEVIATION FROM THE PLAN (triage said "Salvage — selectors valid"): the global
 * default-permission-mode radio the legacy spec asserted
 * (`input[name="defaultPermissionMode"][value="approve"]`, "Default Security
 * Mode", "Secure & Controlled") NO LONGER EXISTS in Settings. The permission-mode
 * redesign moved permission mode out of global Settings into the per-panel CLI
 * composer (`BaseCliPanel.tsx`), which isn't reachable without a live session.
 * So this spec now asserts what global Settings actually renders today — the
 * modal opens over live IPC and its General/Notifications/Updates tabs mount.
 */
import { test, expect, dismissDialogs, settle } from './helpers/electronApp';
import type { Page } from './helpers/electronApp';

async function openSettings(page: Page) {
  await dismissDialogs(page);
  const settingsButton = page.locator('[data-testid="settings-button"]');
  await expect(settingsButton).toBeVisible({ timeout: 15_000 });
  await settingsButton.click();
  const settingsDialog = page.locator('div[role="dialog"]:has-text("Settings")');
  await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  return settingsDialog;
}

test.describe('Settings dialog', () => {
  test('opens over live IPC and shows all three tabs', async ({ page }) => {
    const dialog = await openSettings(page);

    await expect(dialog.getByRole('button', { name: 'General', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Notifications', exact: true })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Updates', exact: true })).toBeVisible();
  });

  test('General tab renders the Appearance & Theme section by default', async ({ page }) => {
    const dialog = await openSettings(page);
    await expect(dialog.locator('text="Appearance & Theme"')).toBeVisible({ timeout: 5_000 });
  });

  test('switching to the Updates tab swaps the tab body', async ({ page }) => {
    const dialog = await openSettings(page);
    await dialog.getByRole('button', { name: 'Updates', exact: true }).click();
    await settle(page);
    // The General-only Appearance section must be gone once Updates is active.
    await expect(dialog.locator('text="Appearance & Theme"')).toHaveCount(0);
  });
});
