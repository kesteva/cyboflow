/**
 * Proof-of-life spec — validates the whole `_electron.launch()` rework in one
 * shot: build prereqs are present, the Electron preload exposes
 * `window.electronAPI`, the built renderer boots against an isolated tmp
 * CYBOFLOW_DIR, and the sidebar (an IPC-backed component) actually mounts.
 *
 * The legacy version of this file false-passed by asserting only the static
 * `<title>` the bare Vite page served — it tested nothing.
 */
import { test, expect, dismissDialogs } from './helpers/electronApp';

test.describe('Health Check — built Electron bundle', () => {
  test('preload exposes electronAPI and the sidebar mounts', async ({ page }) => {
    // The fixture already asserted window.electronAPI at launch; re-assert here
    // so this spec is self-documenting about what "alive" means.
    const hasApi = await page.evaluate(() =>
      Boolean((window as { electronAPI?: unknown }).electronAPI),
    );
    expect(hasApi).toBe(true);

    await dismissDialogs(page);

    // The sidebar is rendered by IPC-backed state — it only appears when the
    // preload bridge is live. A bare Chromium tab never got here.
    const sidebar = page.locator('[data-testid="sidebar"]');
    await expect(sidebar).toBeVisible({ timeout: 15_000 });
  });
});
