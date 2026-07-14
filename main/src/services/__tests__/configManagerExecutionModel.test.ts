/**
 * ConfigManager.getDefaultExecutionModel coverage — the global default execution
 * model for new SDK workflow runs. New SDK flow runs default to 'programmatic'
 * (the in-process host loop).
 *
 * This suite proves the getter contract:
 *   - getDefaultExecutionModel() floors to 'programmatic' on a fresh instance
 *     (no config.json).
 *   - The field is NOT seeded into the constructor defaults (existing config.json
 *     files stay byte-identical).
 *   - A config.json with NO key reads 'programmatic' (the new default).
 *   - updateConfig({ defaultExecutionModel: 'orchestrated' }) persists and
 *     round-trips through a fresh initialize() on the same config dir.
 *   - A BOGUS persisted value (config.json is user-editable) floors to
 *     'programmatic' rather than being trusted verbatim.
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-execmodel-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getDefaultExecutionModel', () => {
  it("floors to 'programmatic' on a fresh instance (before initialize)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getDefaultExecutionModel()).toBe('programmatic');
  });

  it("defaultExecutionModel is NOT seeded into the constructor defaults (config.json stays byte-identical)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().defaultExecutionModel).toBeUndefined();
    expect(mgr.getDefaultExecutionModel()).toBe('programmatic');
  });

  it("reads 'programmatic' from a config.json that has no defaultExecutionModel key (new default)", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().defaultExecutionModel).toBeUndefined();
    expect(mgr.getDefaultExecutionModel()).toBe('programmatic');
  });

  it("updateConfig({ defaultExecutionModel: 'orchestrated' }) persists and round-trips through a fresh initialize()", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ defaultExecutionModel: 'orchestrated' });

    expect(mgr.getDefaultExecutionModel()).toBe('orchestrated');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().defaultExecutionModel).toBe('orchestrated');
    expect(reloaded.getDefaultExecutionModel()).toBe('orchestrated');
  });

  it("floors a BOGUS persisted value to 'programmatic' (config.json is user-editable)", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultExecutionModel: 'telekinetic' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    // The raw (untrusted) value survives the deep-merge onto config...
    expect((mgr.getConfig() as Record<string, unknown>).defaultExecutionModel).toBe('telekinetic');
    // ...but the getter validates it and floors to the safe default.
    expect(mgr.getDefaultExecutionModel()).toBe('programmatic');
  });
});
