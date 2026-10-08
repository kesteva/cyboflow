/**
 * Agents & Environments smoke (blocking minimal tier): the pane opens behind the dev-build flag and
 * switches tabs.
 *
 * No network: a fresh data dir has no cloud account row and no connections, so neither the cloud
 * client nor the inbound pump issues a request, and the spec never opens the Connect dialog. The e2e
 * app runs unpackaged, so it is a dev build and only the config flag is needed; ConfigManager merges
 * this partial config.json over its defaults.
 */
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, dismissDialogs, makeTmpDataDir, rmTmpDataDir } from './helpers/electronApp';

const test = base.extend<{ dataDir: string }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature
  dataDir: async ({}, use) => {
    const dir = makeTmpDataDir();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agents: { enabled: true } }));
    await use(dir);
    rmTmpDataDir(dir);
  },
});

test('Agents & Environments pane opens behind the flag and switches tabs', async ({ page }) => {
  await dismissDialogs(page);
  const item = page.locator('[data-testid="agents-env-rail-item"]');
  await expect(item).toBeVisible({ timeout: 15_000 });
  await expect(item).toHaveAttribute('aria-pressed', 'false');
  await item.click();
  await expect(page.locator('[data-testid="agents-env-view"]')).toBeVisible();
  await expect(item).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-testid="agents-env-tab-agents"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-testid="agents-empty"]')).toBeVisible();
  await expect(page.locator('[data-testid="rail-persistent-agents"]')).toHaveCount(0);
  await page.locator('[data-testid="agents-env-tab-environments"]').click();
  await expect(page.locator('[data-testid="environments-placeholder"]')).toBeVisible();
  await item.click();
  await expect(page.locator('[data-testid="agents-env-view"]')).toHaveCount(0);
});
