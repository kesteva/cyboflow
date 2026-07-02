/**
 * Smoke tests — real IPC round-trips against the built Electron bundle.
 *
 * Legacy version false-passed test 1 (static `<title>`) and hung tests 2-3
 * (IPC-backed testids never mounted in a bare Chromium tab). Ported straight
 * onto the `_electron.launch()` fixture with genuine assertions.
 */
import { test, expect, dismissDialogs } from './helpers/electronApp';

test.describe('Smoke Tests — built Electron bundle', () => {
  test('renderer boots with the correct document title', async ({ page }) => {
    await expect(page).toHaveTitle('Cyboflow');
  });

  test('sidebar and settings button mount (IPC-backed)', async ({ page }) => {
    await dismissDialogs(page);

    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });

    const settingsButton = page.locator('[data-testid="settings-button"]');
    await expect(settingsButton).toHaveCount(1);
    await expect(settingsButton).toBeVisible();
  });

  test('settings button is enabled and clickable', async ({ page }) => {
    await dismissDialogs(page);

    const settingsButton = page.locator('[data-testid="settings-button"]');
    await expect(settingsButton).toBeVisible({ timeout: 15_000 });
    await expect(settingsButton).toBeEnabled();

    await settingsButton.click();

    // With live IPC the click opens the real Settings dialog — assert it (the
    // legacy spec could not, since it never reached a main process).
    const settingsDialog = page.locator('div[role="dialog"]:has-text("Settings")');
    await expect(settingsDialog).toBeVisible({ timeout: 10_000 });
  });
});
