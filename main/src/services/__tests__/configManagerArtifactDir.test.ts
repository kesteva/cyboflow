/**
 * ConfigManager.getArtifactCommitDir coverage — the global on-disk location for
 * COMMITTED-artifact manifests (FEATURE #3 durability snapshot).
 *
 * Contract:
 *   - getArtifactCommitDir() floors to DEFAULT_ARTIFACT_COMMIT_DIR on a fresh
 *     instance (no config.json) and from a config.json that omits the key
 *     (back-compat: the field is intentionally absent from constructor defaults
 *     so existing files stay byte-identical).
 *   - a blank / whitespace-only override still floors to the default.
 *   - a real override persists and round-trips through a fresh initialize(); the
 *     value is trimmed on read.
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
import { DEFAULT_ARTIFACT_COMMIT_DIR } from '../../../../shared/types/artifacts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-artifactdir-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getArtifactCommitDir', () => {
  it('floors to DEFAULT_ARTIFACT_COMMIT_DIR on a fresh instance (field not seeded)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().artifactCommitDir).toBeUndefined();
    expect(mgr.getArtifactCommitDir()).toBe(DEFAULT_ARTIFACT_COMMIT_DIR);
  });

  it('floors to the default from a config.json that omits the key (back-compat)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().artifactCommitDir).toBeUndefined();
    expect(mgr.getArtifactCommitDir()).toBe(DEFAULT_ARTIFACT_COMMIT_DIR);
  });

  it('floors a blank / whitespace-only override to the default', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ artifactCommitDir: '   ' });
    expect(mgr.getArtifactCommitDir()).toBe(DEFAULT_ARTIFACT_COMMIT_DIR);
  });

  it('persists a real override, trims it on read, and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ artifactCommitDir: '  docs/deliverables  ' });

    // Stored verbatim; floored/trimmed on read.
    expect(mgr.getConfig().artifactCommitDir).toBe('  docs/deliverables  ');
    expect(mgr.getArtifactCommitDir()).toBe('docs/deliverables');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getArtifactCommitDir()).toBe('docs/deliverables');
  });

  it('accepts an absolute override (returned as-is by the getter)', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ artifactCommitDir: '/var/cyboflow/artifacts' });
    expect(mgr.getArtifactCommitDir()).toBe('/var/cyboflow/artifacts');
  });
});
