/**
 * ConfigManager.getAssistantModel coverage — the model alias override for the
 * global cyboflow assistant (the agent-rail chat).
 *
 * Contract:
 *   - getAssistantModel() floors to null (unset) on a fresh instance (no
 *     config.json) and from a config.json that omits the key (back-compat:
 *     the field is intentionally absent from constructor defaults so existing
 *     files stay byte-identical).
 *   - a blank / whitespace-only override still floors to null.
 *   - a real override persists and round-trips through a fresh initialize();
 *     the value is trimmed on read.
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-assistantmodel-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getAssistantModel', () => {
  it('floors to null on a fresh instance (field not seeded)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().assistantModel).toBeUndefined();
    expect(mgr.getAssistantModel()).toBeNull();
  });

  it('floors to null from a config.json that omits the key (back-compat)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().assistantModel).toBeUndefined();
    expect(mgr.getAssistantModel()).toBeNull();
  });

  it('floors a blank / whitespace-only override to null', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ assistantModel: '   ' });
    expect(mgr.getAssistantModel()).toBeNull();
  });

  it('persists a real override, trims it on read, and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ assistantModel: '  opus  ' });

    // Stored verbatim; floored/trimmed on read.
    expect(mgr.getConfig().assistantModel).toBe('  opus  ');
    expect(mgr.getAssistantModel()).toBe('opus');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getAssistantModel()).toBe('opus');
  });
});
