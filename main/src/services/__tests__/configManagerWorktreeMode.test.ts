/**
 * ConfigManager.quickSessionWorktreeMode coverage (migration 046 — opt-out
 * worktree isolation for quick sessions).
 *
 * This suite proves the getter contract:
 *   - getQuickSessionWorktreeMode() floors to 'worktree' on a fresh instance
 *     (no config.json).
 *   - The field is NOT seeded into the constructor defaults (existing config.json
 *     files stay byte-identical).
 *   - A config.json with NO key reads 'worktree' (back-compat).
 *   - updateConfig({ quickSessionWorktreeMode: 'in-place' }) persists and
 *     round-trips through a fresh initialize() on the same config dir.
 *   - A BOGUS persisted value (config.json is user-editable) floors to 'worktree'
 *     rather than being trusted verbatim.
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-worktreemode-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.quickSessionWorktreeMode', () => {
  it("getQuickSessionWorktreeMode() returns 'worktree' on a fresh instance (floor, before initialize)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getQuickSessionWorktreeMode()).toBe('worktree');
  });

  it("quickSessionWorktreeMode is NOT seeded into the constructor defaults (config.json stays byte-identical)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().quickSessionWorktreeMode).toBeUndefined();
    expect(mgr.getQuickSessionWorktreeMode()).toBe('worktree');
  });

  it("reads 'worktree' from a config.json that has no quickSessionWorktreeMode key (back-compat)", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().quickSessionWorktreeMode).toBeUndefined();
    expect(mgr.getQuickSessionWorktreeMode()).toBe('worktree');
  });

  it("updateConfig({ quickSessionWorktreeMode: 'in-place' }) persists and round-trips through a fresh initialize()", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ quickSessionWorktreeMode: 'in-place' });

    expect(mgr.getQuickSessionWorktreeMode()).toBe('in-place');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().quickSessionWorktreeMode).toBe('in-place');
    expect(reloaded.getQuickSessionWorktreeMode()).toBe('in-place');
  });

  it("flipping back to 'worktree' persists and round-trips (rollback of the global default)", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ quickSessionWorktreeMode: 'in-place' });
    await mgr.updateConfig({ quickSessionWorktreeMode: 'worktree' });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getQuickSessionWorktreeMode()).toBe('worktree');
  });

  it("floors a BOGUS persisted value to 'worktree' (config.json is user-editable)", async () => {
    // Hand-edited config.json with an invalid mode — the getter must not trust it.
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', quickSessionWorktreeMode: 'sideways' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    // The raw (untrusted) value survives the deep-merge onto config (read via an
    // unknown cast since it is not a valid QuickSessionWorktreeMode)...
    expect((mgr.getConfig() as Record<string, unknown>).quickSessionWorktreeMode).toBe('sideways');
    // ...but the getter validates it and floors to the safe default.
    expect(mgr.getQuickSessionWorktreeMode()).toBe('worktree');
  });
});
