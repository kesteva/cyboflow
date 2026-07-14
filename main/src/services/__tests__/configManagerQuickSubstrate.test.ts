/**
 * ConfigManager.quickSessionDefaultSubstrate coverage — the global default CLI
 * substrate for NEW quick sessions (quick sessions default to the interactive
 * PTY).
 *
 * This suite proves the getter contract:
 *   - getQuickSessionDefaultSubstrate() floors to 'interactive' on a fresh
 *     instance (no config.json).
 *   - The field is NOT seeded into the constructor defaults (existing config.json
 *     files stay byte-identical).
 *   - A config.json with NO key reads 'interactive' (the new default).
 *   - updateConfig({ quickSessionDefaultSubstrate: 'sdk' }) persists and
 *     round-trips through a fresh initialize() on the same config dir.
 *   - A BOGUS persisted value (config.json is user-editable) floors to
 *     'interactive' rather than being trusted verbatim.
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-quicksubstrate-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.quickSessionDefaultSubstrate', () => {
  it("getQuickSessionDefaultSubstrate() returns 'interactive' on a fresh instance (floor, before initialize)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getQuickSessionDefaultSubstrate()).toBe('interactive');
  });

  it("quickSessionDefaultSubstrate is NOT seeded into the constructor defaults (config.json stays byte-identical)", () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().quickSessionDefaultSubstrate).toBeUndefined();
    expect(mgr.getQuickSessionDefaultSubstrate()).toBe('interactive');
  });

  it("reads 'interactive' from a config.json that has no quickSessionDefaultSubstrate key (new default)", async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().quickSessionDefaultSubstrate).toBeUndefined();
    expect(mgr.getQuickSessionDefaultSubstrate()).toBe('interactive');
  });

  it("updateConfig({ quickSessionDefaultSubstrate: 'sdk' }) persists and round-trips through a fresh initialize()", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ quickSessionDefaultSubstrate: 'sdk' });

    expect(mgr.getQuickSessionDefaultSubstrate()).toBe('sdk');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().quickSessionDefaultSubstrate).toBe('sdk');
    expect(reloaded.getQuickSessionDefaultSubstrate()).toBe('sdk');
  });

  it("flipping back to 'interactive' persists and round-trips (rollback of the global default)", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ quickSessionDefaultSubstrate: 'sdk' });
    await mgr.updateConfig({ quickSessionDefaultSubstrate: 'interactive' });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getQuickSessionDefaultSubstrate()).toBe('interactive');
  });

  it("floors a BOGUS persisted value to 'interactive' (config.json is user-editable)", async () => {
    // Hand-edited config.json with an invalid substrate — the getter must not trust it.
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', quickSessionDefaultSubstrate: 'telepathy' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    // The raw (untrusted) value survives the deep-merge onto config (read via an
    // unknown cast since it is not a valid CliSubstrate)...
    expect((mgr.getConfig() as Record<string, unknown>).quickSessionDefaultSubstrate).toBe('telepathy');
    // ...but the getter validates it and floors to the safe default.
    expect(mgr.getQuickSessionDefaultSubstrate()).toBe('interactive');
  });
});
