/**
 * ConfigManager.computeCostFromRates coverage.
 *
 * The opt-in display setting floors to false without being constructor-seeded,
 * then persists and round-trips through the same config.json path as the sibling
 * codeReviewEvalEnabled toggle.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-computed-cost-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.computeCostFromRates', () => {
  it('floors to false without seeding the constructor defaults', () => {
    const manager = new ConfigManager('/tmp/test-git-path');

    expect(manager.getConfig().computeCostFromRates).toBeUndefined();
    expect(manager.getComputeCostFromRates()).toBe(false);
  });

  it('persists an enabled value and round-trips through a fresh initialize', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({ computeCostFromRates: true });

    expect(manager.getComputeCostFromRates()).toBe(true);

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().computeCostFromRates).toBe(true);
    expect(reloaded.getComputeCostFromRates()).toBe(true);
  });
});
