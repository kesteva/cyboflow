/**
 * ConfigManager.defaultSubstrate coverage (IDEA-013 / TASK-806 accessor, locked
 * by TASK-812).
 *
 * The accessor + AppConfig field are owned by TASK-806/S1 (configManager.ts is
 * read-only here); this suite only proves the contract:
 *   - getDefaultSubstrate() floors to 'sdk' on a fresh instance (no config.json).
 *   - A config.json with NO `defaultSubstrate` key still reads 'sdk' (back-compat:
 *     the field is intentionally absent from the constructor defaults so existing
 *     files stay byte-identical).
 *   - updateConfig({ defaultSubstrate: 'interactive' }) persists and round-trips
 *     through a fresh initialize() on the same config directory.
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-substrate-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.defaultSubstrate', () => {
  it("getDefaultSubstrate() returns 'sdk' on a fresh instance (floor, before initialize)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getDefaultSubstrate()).toBe('sdk');
  });

  it("defaultSubstrate is NOT seeded into the constructor defaults (config.json stays byte-identical)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    // The field is intentionally absent — the accessor floors instead.
    expect(mgr.getConfig().defaultSubstrate).toBeUndefined();
    expect(mgr.getDefaultSubstrate()).toBe('sdk');
  });

  it("reads 'sdk' from a config.json that has no defaultSubstrate key (back-compat)", async () => {
    // Pre-seed a config file with NO defaultSubstrate key.
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().defaultSubstrate).toBeUndefined();
    expect(mgr.getDefaultSubstrate()).toBe('sdk');
  });

  it("updateConfig({ defaultSubstrate: 'interactive' }) persists and round-trips through a fresh initialize()", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ defaultSubstrate: 'interactive' });

    expect(mgr.getDefaultSubstrate()).toBe('interactive');

    // A brand-new instance on the SAME config dir must read the persisted value.
    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().defaultSubstrate).toBe('interactive');
    expect(reloaded.getDefaultSubstrate()).toBe('interactive');
  });

  it("flipping back to 'sdk' persists and round-trips (rollback of the global default)", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ defaultSubstrate: 'interactive' });
    await mgr.updateConfig({ defaultSubstrate: 'sdk' });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getDefaultSubstrate()).toBe('sdk');
  });
});
