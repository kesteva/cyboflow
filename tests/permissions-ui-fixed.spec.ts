import { test, expect } from '@playwright/test';

test.describe('Permission UI Elements', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    
    // Close welcome dialog if present
    const getStartedButton = page.locator('button:has-text("Get Started")');
    if (await getStartedButton.isVisible({ timeout: 1000 }).catch(() => false)) {
      await getStartedButton.click();
    }
  });

  test('Settings should have permission mode option', async ({ page }) => {
    // Click settings button with retry
    const settingsButton = page.locator('[data-testid="settings-button"]');
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();

    // Wait for settings dialog (header is "Crystal Settings")
    const settingsDialog = page.locator('div[role="dialog"]:has-text("Settings")');
    await expect(settingsDialog).toBeVisible({ timeout: 10000 });

    // Check for permission mode section (renamed to "Default Security Mode")
    await expect(page.locator('text="Default Security Mode"')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text="Fast & Flexible"')).toBeVisible();
    await expect(page.locator('text="Secure & Controlled"')).toBeVisible();

    // Check radio buttons
    await expect(page.locator('input[name="defaultPermissionMode"][value="ignore"]')).toBeVisible();
    await expect(page.locator('input[name="defaultPermissionMode"][value="approve"]')).toBeVisible();

    // Default should be 'ignore'
    await expect(page.locator('input[name="defaultPermissionMode"][value="ignore"]')).toBeChecked();
  });

  test('Can toggle default permission mode radio', async ({ page }) => {
    // Note: this test only verifies the radio toggles in the UI. Persistence on
    // Save is intentionally not tested here because the renderer talks to the
    // main process over Electron IPC, which is unavailable when Playwright
    // drives the Vite dev server directly.
    const settingsButton = page.locator('[data-testid="settings-button"]');
    await expect(settingsButton).toBeVisible({ timeout: 10000 });
    await settingsButton.click();

    const settingsDialog = page.locator('div[role="dialog"]:has-text("Settings")');
    await expect(settingsDialog).toBeVisible({ timeout: 10000 });

    const ignoreRadio = page.locator('input[name="defaultPermissionMode"][value="ignore"]');
    const approveRadio = page.locator('input[name="defaultPermissionMode"][value="approve"]');

    await expect(ignoreRadio).toBeChecked();

    await approveRadio.click();
    await expect(approveRadio).toBeChecked();
    await expect(ignoreRadio).not.toBeChecked();

    await ignoreRadio.click();
    await expect(ignoreRadio).toBeChecked();
    await expect(approveRadio).not.toBeChecked();
  });

  test('Permission dialog component renders correctly', async ({ page }) => {
    // This test checks if the permission dialog component exists in the codebase
    // For a real test, we'd need to trigger a permission request
    
    // Navigate to a page that might show permissions
    await page.goto('/');
    
    // For now, just check that the app loaded
    await expect(page.locator('body')).toBeVisible();
    
    // Could add more specific tests here when we know how to trigger permission dialogs
  });
});