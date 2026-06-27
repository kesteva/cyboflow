/**
 * ConfigManager visual-verification getter coverage — the global master switch
 * and resolved-block getter for layered visual verification (P2; see
 * docs/visual-verification-design.md #7 and shared/types/visualVerification.ts).
 *
 * Contract:
 *   - getVisualVerifyEnabled() floors to false on a fresh instance (no config.json)
 *     and from a config.json that omits the `visualVerify` block (back-compat: the
 *     block is intentionally absent from constructor defaults so existing files
 *     stay byte-identical).
 *   - getVisualVerifyConfig() returns the fully-resolved block with
 *     VISUAL_VERIFY_DEFAULTS applied for any omitted member.
 *   - a real override (enabled + advanced fields) persists, round-trips through a
 *     fresh initialize(), and is reflected by both getters; partial overrides only
 *     replace the members they set, the rest keep their defaults.
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
import {
  VISUAL_VERIFY_DEFAULTS,
  DEFAULT_VERIFY_DEV_PORTS,
} from '../../../../shared/types/visualVerification';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-visualverify-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getVisualVerifyEnabled', () => {
  it('floors to false on a fresh instance (block not seeded)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().visualVerify).toBeUndefined();
    expect(mgr.getVisualVerifyEnabled()).toBe(false);
  });

  it('floors to false from a config.json that omits the block (back-compat)', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', defaultModel: 'sonnet' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    expect(mgr.getConfig().visualVerify).toBeUndefined();
    expect(mgr.getVisualVerifyEnabled()).toBe(false);
  });

  it('reflects an explicit enabled override and persists it across a fresh initialize()', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ visualVerify: { enabled: true } });
    expect(mgr.getVisualVerifyEnabled()).toBe(true);

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getVisualVerifyEnabled()).toBe(true);
  });
});

describe('ConfigManager.getVisualVerifyConfig', () => {
  it('returns the full default block on a fresh instance (every member floored)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getVisualVerifyConfig()).toEqual(VISUAL_VERIFY_DEFAULTS);
  });

  it('floors all members from a config.json that omits the block', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo' }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    const cfg = mgr.getVisualVerifyConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.defaultType).toBe('static-render-snapshot');
    expect(cfg.vlmConfidenceThreshold).toBe(0.7);
    expect(cfg.maxPerRunJudgeCalls).toBe(4);
    expect(cfg.devServerPorts).toEqual([...DEFAULT_VERIFY_DEV_PORTS]);
    expect(cfg.simulatorDevices).toEqual([]);
  });

  it('applies defaults per-member for a partial override (only set members replaced)', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({
      visualVerify: { enabled: true, maxPerRunJudgeCalls: 2 },
    });

    const cfg = mgr.getVisualVerifyConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.maxPerRunJudgeCalls).toBe(2);
    // Unset members keep their defaults.
    expect(cfg.defaultType).toBe('static-render-snapshot');
    expect(cfg.vlmConfidenceThreshold).toBe(0.7);
    expect(cfg.devServerPorts).toEqual([...DEFAULT_VERIFY_DEV_PORTS]);
    expect(cfg.simulatorDevices).toEqual([]);
  });

  it('floors an empty devServerPorts array to the default pool', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ visualVerify: { devServerPorts: [] } });
    expect(mgr.getVisualVerifyConfig().devServerPorts).toEqual([...DEFAULT_VERIFY_DEV_PORTS]);
  });

  it('honors and round-trips a full override (all advanced fields)', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({
      visualVerify: {
        enabled: true,
        defaultType: 'interactive-web-behavior',
        vlmConfidenceThreshold: 0.9,
        maxPerRunJudgeCalls: 8,
        devServerPorts: [1234, 5678],
        simulatorDevices: ['udid-A'],
      },
    });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getVisualVerifyConfig()).toEqual({
      enabled: true,
      defaultType: 'interactive-web-behavior',
      vlmConfidenceThreshold: 0.9,
      maxPerRunJudgeCalls: 8,
      devServerPorts: [1234, 5678],
      simulatorDevices: ['udid-A'],
    });
  });

  it('returns fresh array copies (mutating the result does not leak into config or defaults)', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    const cfg = mgr.getVisualVerifyConfig();
    cfg.devServerPorts.push(9999);
    cfg.simulatorDevices.push('leak');
    // Defaults are untouched; a second read is pristine.
    expect(mgr.getVisualVerifyConfig().devServerPorts).toEqual([...DEFAULT_VERIFY_DEV_PORTS]);
    expect(mgr.getVisualVerifyConfig().simulatorDevices).toEqual([]);
    expect(VISUAL_VERIFY_DEFAULTS.devServerPorts).toEqual([...DEFAULT_VERIFY_DEV_PORTS]);
  });
});
