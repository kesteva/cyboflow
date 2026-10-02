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
import { isAgentProviderEnabled } from '../../../../shared/types/agentRuntime';

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
    const mgr = new ConfigManager();
    expect(mgr.getConfig().agentProviderAccess).toBeUndefined();
    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: true, omp: false, pi: false });
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

    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getConfig().agentProviderAccess).toBeUndefined();
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderEnabled('codex')).toBe(true);
  });

  it('disables just the named provider and leaves its sibling enabled', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { claude: true, codex: false } });

    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderEnabled('codex')).toBe(false);
  });

  it("floors a PARTIAL map's absent member to enabled", async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { codex: false } });

    // `omp` materializes too, at ITS default (false) — the absent-key floor is
    // per-provider, not one blanket "enabled".
    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: false, omp: false, pi: false });
  });

  it('degrades an all-off map to all-enabled (never brick every launch seam)', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    // Bypasses the IPC normalization (a hand-edited config.json can do this).
    await mgr.updateConfig({ agentProviderAccess: { claude: false, codex: false, omp: false } });

    expect(mgr.getAgentProviderAccess()).toEqual({ claude: true, codex: true, omp: false, pi: false });
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    // The degradation restores the DEFAULTS, so it must not switch on a
    // provider the user has never opted into.
    expect(mgr.isAgentProviderEnabled('omp')).toBe(false);
  });

  it('persists and round-trips through a fresh initialize()', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    await mgr.updateConfig({ agentProviderAccess: { claude: false, codex: true } });

    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.getConfig().agentProviderAccess).toEqual({ claude: false, codex: true });
    expect(reloaded.isAgentProviderEnabled('claude')).toBe(false);
    expect(reloaded.isAgentProviderEnabled('codex')).toBe(true);
  });
});

/**
 * The Aria gate at the AUTHORITY. `isAgentProviderEnabled` is what the launch
 * seams read (WorkflowRegistry.createRun, the quick-session IPC handler, the
 * per-step agent resolver), so the gate has to live here and not only in the
 * pickers — an MCP-pinned agent config names a runtime without ever passing
 * through the UI.
 */
describe('ConfigManager Aria-mode provider gate', () => {
  it('refuses pi on a non-Aria install even with its access key switched on', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', agentProviderAccess: { pi: true } }, null, 2),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getAriaMode()).toBe(false);
    expect(mgr.isAgentProviderEnabled('pi')).toBe(false);
    expect(mgr.isAgentProviderSurfaced('pi')).toBe(false);
    // The gate is pi-specific: its siblings are untouched by it.
    expect(mgr.isAgentProviderEnabled('claude')).toBe(true);
    expect(mgr.isAgentProviderSurfaced('omp')).toBe(true);
  });

  it('allows pi once Aria mode is on AND its access key is on', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify(
        { gitRepoPath: '/some/repo', ariaMode: true, agentProviderAccess: { pi: true } },
        null,
        2,
      ),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.isAgentProviderSurfaced('pi')).toBe(true);
    expect(mgr.isAgentProviderEnabled('pi')).toBe(true);
  });

  it('gates the ACCESS MAP itself, not just the predicate', async () => {
    // This is the fix for the bypass the predicate alone left open. The launch
    // seams (WorkflowRegistry.createRun, the quick-session IPC handler) take
    // getAgentProviderAccess() and test it with the PURE isAgentProviderEnabled
    // from shared/types/agentRuntime — a same-named function that knows nothing
    // about Aria mode. If the map still said `pi: true`, an explicit pi launch
    // would be admitted on a non-Aria install, which is exactly the stale/
    // MCP-written access key this gate exists to refuse.
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', agentProviderAccess: { pi: true } }, null, 2),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getAgentProviderAccess().pi).toBe(false);
    expect(isAgentProviderEnabled(mgr.getAgentProviderAccess(), 'pi')).toBe(false);
    // The user's RAW toggle is untouched — Settings renders its switches from
    // the config field, so nothing here rewrites what the user chose.
    expect(mgr.getConfig().agentProviderAccess).toEqual({ pi: true });
  });

  it('passes pi through the access map once Aria mode is on', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify(
        { gitRepoPath: '/some/repo', ariaMode: true, agentProviderAccess: { pi: true } },
        null,
        2,
      ),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(isAgentProviderEnabled(mgr.getAgentProviderAccess(), 'pi')).toBe(true);
  });

  it('keeps pi off under Aria mode when its access key is not set (gate is not an opt-in)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', ariaMode: true }, null, 2),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    // Surfaced (the card renders) but still switched off until the user says so.
    expect(mgr.isAgentProviderSurfaced('pi')).toBe(true);
    expect(mgr.isAgentProviderEnabled('pi')).toBe(false);
  });
});
