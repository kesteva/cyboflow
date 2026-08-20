/**
 * ConfigManager.agentProviderAccess coverage — the per-provider on/off toggles
 * written by BOTH Settings → Integrations and the onboarding Connect step.
 *
 * The contract this locks:
 *   - Absent field ⇒ both providers ENABLED, and the field is NOT seeded into
 *     the constructor defaults (existing config.json files stay byte-identical).
 *   - A partial map floors its absent member to enabled.
 *   - An all-off map degrades to both-on rather than leaving the app unable to
 *     launch anything (resolveAgentProviderAccess's floor).
 *   - The setting persists and round-trips through a fresh initialize().
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
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-provider-access-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.agentProviderAccess', () => {
  it('floors each provider to its OWN default on a fresh instance, without seeding the field', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().agentProviderAccess).toBeUndefined();
    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: true, omp: false });
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderEnabled('codex')).toBe(true);
    // A fresh install must not silently switch on a vendor introduced after the
    // toggles existed — that is what the per-provider default is for.
    expect(mgr.isAgentProviderEnabled('omp')).toBe(false);
  });

  it('reads both-enabled from a config.json with no agentProviderAccess key (back-compat)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );

    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().agentProviderAccess).toBeUndefined();
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderEnabled('codex')).toBe(true);
  });

  it('disables just the named provider and leaves its sibling enabled', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { claude: true, codex: false } });

    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderEnabled('codex')).toBe(false);
  });

  it("floors a PARTIAL map's absent member to enabled", async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { codex: false } });

    // `omp` materializes too, at ITS default (false) — the absent-key floor is
    // per-provider, not one blanket "enabled".
    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: false, omp: false });
  });

  it('degrades an all-off map to all-enabled (never brick every launch seam)', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    // Bypasses the IPC normalization (a hand-edited config.json can do this).
    await mgr.updateConfig({ agentProviderAccess: { claude: false, codex: false, omp: false } });

    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: true, omp: false });
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    // The degradation restores the DEFAULTS, so it must not switch on a
    // provider the user has never opted into.
    expect(mgr.isAgentProviderEnabled('omp')).toBe(false);
  });

  it('persists and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { claude: false, codex: true } });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().agentProviderAccess).toEqual({ claude: false, codex: true });
    expect(reloaded.isAgentProviderEnabled('claude')).toBe(false);
    expect(reloaded.isAgentProviderEnabled('codex')).toBe(true);
  });
});
