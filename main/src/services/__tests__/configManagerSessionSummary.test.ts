/**
 * ConfigManager.isSessionSummaryEnabled coverage — the global kill switch for
 * the idle-debounced session-summary scheduler and lazy catch-up kick.
 *
 * Contract:
 *   - isSessionSummaryEnabled() floors to true (enabled) on a fresh instance
 *     (no config.json) and from a config.json that omits the key (back-compat:
 *     the field is intentionally absent from constructor defaults so existing
 *     files stay byte-identical).
 *   - updateConfig({ sessionSummaryEnabled: false }) persists and round-trips
 *     through a fresh initialize().
 *   - updateConfig({ sessionSummaryEnabled: true }) explicitly re-enables it.
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via
 * setCyboflowDirectory(), so the real ~/.cyboflow config is never touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-sessionsummary-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.isSessionSummaryEnabled', () => {
  it('floors to true on a fresh instance (field not seeded)', () => {
    const mgr = new ConfigManager();
    expect(mgr.getConfig().sessionSummaryEnabled).toBeUndefined();
    expect(mgr.isSessionSummaryEnabled()).toBe(true);
  });

  it('floors to true from a config.json that omits the key (back-compat)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getConfig().sessionSummaryEnabled).toBeUndefined();
    expect(mgr.isSessionSummaryEnabled()).toBe(true);
  });

  it('persists false and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ sessionSummaryEnabled: false });

    expect(mgr.getConfig().sessionSummaryEnabled).toBe(false);
    expect(mgr.isSessionSummaryEnabled()).toBe(false);

    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.isSessionSummaryEnabled()).toBe(false);
  });

  it('persists an explicit true and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ sessionSummaryEnabled: false });
    await mgr.updateConfig({ sessionSummaryEnabled: true });

    expect(mgr.isSessionSummaryEnabled()).toBe(true);

    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.isSessionSummaryEnabled()).toBe(true);
  });
});
