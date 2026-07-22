/**
 * ConfigManager.getAssistantContextRetention coverage — the assistant's
 * day-boundary context strategy ('clear-daily' | 'compact-daily' |
 * 'auto-compact').
 *
 * Contract:
 *   - floors to 'clear-daily' (DEFAULT_ASSISTANT_CONTEXT_RETENTION) on a fresh
 *     instance, from a config.json that omits the key, and from an INVALID
 *     stored value (hand-edited config.json) — never throws, never leaks the
 *     bad string to callers.
 *   - a valid override persists and round-trips through a fresh initialize().
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-assistantretention-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getAssistantContextRetention', () => {
  it("floors to 'clear-daily' on a fresh instance (field not seeded)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().assistantContextRetention).toBeUndefined();
    expect(mgr.getAssistantContextRetention()).toBe('clear-daily');
  });

  it("floors to 'clear-daily' from a config.json that omits the key (back-compat)", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    expect(mgr.getAssistantContextRetention()).toBe('clear-daily');
  });

  it("floors an invalid stored value to 'clear-daily' instead of leaking it", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', assistantContextRetention: 'weekly' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    expect(mgr.getAssistantContextRetention()).toBe('clear-daily');
  });

  it('persists each valid mode and round-trips through a fresh initialize()', async () => {
    for (const mode of ['compact-daily', 'auto-compact', 'clear-daily'] as const) {
      const mgr = new ConfigManager('/tmp/test-git-path');
      await mgr.initialize();
      await mgr.updateConfig({ assistantContextRetention: mode });
      expect(mgr.getAssistantContextRetention()).toBe(mode);

      const reloaded = new ConfigManager('/tmp/test-git-path');
      await reloaded.initialize();
      expect(reloaded.getAssistantContextRetention()).toBe(mode);
    }
  });
});
