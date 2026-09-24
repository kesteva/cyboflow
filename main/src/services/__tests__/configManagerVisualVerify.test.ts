/**
 * ConfigManager visual-verification getter coverage — the global master switch
 * and resolved-block getter for layered visual verification (P2; see
 * docs/proposals/visual-verification-design.md #7 and shared/types/visualVerification.ts).
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
  DEFAULT_EXPLORE_DEADLINE_FLOOR_MS,
  EXPLORE_DEADLINE_FLOOR_MAX_MS,
  EXPLORE_DEADLINE_FLOOR_MIN_MS,
  MOBILE_DRIVE_ENGINES,
  resolveExploreDeadlineFloorMs,
} from '../../../../shared/types/visualVerification';
import {
  AGENT_REQUEST_TIMEOUT_CEILING_MS,
  DEFAULT_AGENT_REQUEST_TIMEOUT_MS,
} from '../../orchestrator/verify/verificationSchedulerContracts';

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
    expect(cfg.agentSlots).toBe(2);
    // F9: autoBootstrapRunbook floors to ON — without it, every project except
    // one that already hand-authored a runbook stays permanently unverifiable.
    expect(cfg.autoBootstrapRunbook).toBe(true);
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
    expect(cfg.agentSlots).toBe(2);
    // Enabling verification does not change the bootstrap: they are separate
    // decisions, and F9 floors the second one ON independently of the first.
    expect(cfg.autoBootstrapRunbook).toBe(true);
  });

  it('the runbook bootstrap is its own switch, opted OUT of independently (F9: default ON)', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({ visualVerify: { enabled: true, autoBootstrapRunbook: false } });
    expect(mgr.getVisualVerifyConfig().autoBootstrapRunbook).toBe(false);
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
      // Not overridden above → floored to the mobile-tier defaults
      // (mobile-verification-tier.md §8). Asserted INSIDE this exact-shape
      // expectation on purpose: a knob added to the resolved type but never
      // materialized here would otherwise typecheck and silently never reach
      // the scheduler.
      mobileSimSlots: 1,
      mobileSimDeviceType: '',
      mobileSimRuntime: '',
      mobileDeadlineFloorMs: 900_000,
      // Not overridden above → floored to the default (§5.6 queued-age ceiling).
      queuedAgeCeilingMs: 15 * 60 * 1000,
      // Not overridden above → floored to the default (§4 roster footnote 1).
      agentSlots: 2,
      // Not overridden above → floored ON (F9 / lane-runbook-bootstrap.md §12).
      autoBootstrapRunbook: true,
      // Not overridden above → the runbook-optional defaults (explore ON, a
      // 15-minute explore floor, the probe-driven mobile drive engine).
      requireProvenRunbook: false,
      exploreDeadlineFloorMs: 15 * 60 * 1000,
      mobileDriveEngine: 'auto',
    });
  });

  it('floors all four mobile knobs when the block omits them', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', visualVerify: { enabled: true } }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();

    const cfg = mgr.getVisualVerifyConfig();
    expect(cfg.mobileSimSlots).toBe(VISUAL_VERIFY_DEFAULTS.mobileSimSlots);
    // '' is the ACTIVE default, not a missing value: it means "resolve the
    // newest compatible device type / runtime live", which is the only answer
    // that survives an Xcode release.
    expect(cfg.mobileSimDeviceType).toBe('');
    expect(cfg.mobileSimRuntime).toBe('');
    expect(cfg.mobileDeadlineFloorMs).toBe(VISUAL_VERIFY_DEFAULTS.mobileDeadlineFloorMs);
  });

  it('honors an explicit override of each mobile knob', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({
      visualVerify: {
        mobileSimSlots: 3,
        mobileSimDeviceType: 'iPhone 16 Pro',
        mobileSimRuntime: 'iOS 26.0',
        mobileDeadlineFloorMs: 1_200_000,
      },
    });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    const cfg = reloaded.getVisualVerifyConfig();
    expect(cfg.mobileSimSlots).toBe(3);
    expect(cfg.mobileSimDeviceType).toBe('iPhone 16 Pro');
    expect(cfg.mobileSimRuntime).toBe('iOS 26.0');
    expect(cfg.mobileDeadlineFloorMs).toBe(1_200_000);
    // The clamp to [1,4] belongs to the scheduler, not to this getter: the
    // getter's contract is materialize-what-was-configured, and moving the
    // clamp here would hide a bad value from the one place that logs it.
    expect(cfg.agentSlots).toBe(VISUAL_VERIFY_DEFAULTS.agentSlots);
  });

  it('honors an explicit agentSlots override and floors it when absent', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    expect(mgr.getVisualVerifyConfig().agentSlots).toBe(2);

    await mgr.updateConfig({ visualVerify: { agentSlots: 4 } });
    expect(mgr.getVisualVerifyConfig().agentSlots).toBe(4);
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

// The runbook-optional knobs (docs/proposals/runbook-optional-verification.md
// §A1 kill switch, §A1.1 explore deadline floor, §B3 mobile drive engine). Each
// is VALIDATED on read, not merely `??`-floored: config.json is hand-editable,
// and every consumer branches on the resolved value.
describe('ConfigManager.getVisualVerifyConfig — the runbook-optional knobs', () => {
  /** Write a raw config.json (so a hand-edited, mistyped value can be expressed) and load it. */
  async function loadRaw(visualVerify: Record<string, unknown>): Promise<ConfigManager> {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo', visualVerify }, null, 2),
    );
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    return mgr;
  }

  it('floors all three when the block omits them', async () => {
    const cfg = (await loadRaw({ enabled: true })).getVisualVerifyConfig();
    expect(cfg.requireProvenRunbook).toBe(false);
    expect(cfg.exploreDeadlineFloorMs).toBe(DEFAULT_EXPLORE_DEADLINE_FLOOR_MS);
    expect(cfg.exploreDeadlineFloorMs).toBe(15 * 60 * 1000);
    expect(cfg.mobileDriveEngine).toBe('auto');
  });

  it('honors and round-trips an explicit override of each', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await mgr.updateConfig({
      visualVerify: { requireProvenRunbook: true, exploreDeadlineFloorMs: 18 * 60 * 1000, mobileDriveEngine: 'xcode' },
    });

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    const cfg = reloaded.getVisualVerifyConfig();
    expect(cfg.requireProvenRunbook).toBe(true);
    expect(cfg.exploreDeadlineFloorMs).toBe(18 * 60 * 1000);
    expect(cfg.mobileDriveEngine).toBe('xcode');
  });

  it('accepts every MobileDriveEngine member', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    for (const engine of MOBILE_DRIVE_ENGINES) {
      await mgr.updateConfig({ visualVerify: { mobileDriveEngine: engine } });
      expect(mgr.getVisualVerifyConfig().mobileDriveEngine).toBe(engine);
    }
  });

  it('floors a hand-edited, mistyped kill switch to OFF rather than treating a truthy string as ON', async () => {
    for (const requireProvenRunbook of ['yes', 1, null]) {
      expect((await loadRaw({ requireProvenRunbook })).getVisualVerifyConfig().requireProvenRunbook).toBe(false);
    }
  });

  it('floors an unknown drive engine to auto', async () => {
    for (const mobileDriveEngine of ['Xcode', 'appium', 3, null]) {
      expect((await loadRaw({ mobileDriveEngine })).getVisualVerifyConfig().mobileDriveEngine).toBe('auto');
    }
  });

  it('floors a non-numeric or non-finite explore floor to the default', async () => {
    for (const exploreDeadlineFloorMs of ['900000', null, true]) {
      expect((await loadRaw({ exploreDeadlineFloorMs })).getVisualVerifyConfig().exploreDeadlineFloorMs).toBe(
        DEFAULT_EXPLORE_DEADLINE_FLOOR_MS,
      );
    }
    // Infinity cannot survive JSON, so exercise the pure resolver for it directly.
    expect(resolveExploreDeadlineFloorMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_EXPLORE_DEADLINE_FLOOR_MS);
    expect(resolveExploreDeadlineFloorMs(Number.NaN)).toBe(DEFAULT_EXPLORE_DEADLINE_FLOOR_MS);
  });

  it('clamps the explore floor into [default agent deadline, 20-minute agent ceiling]', async () => {
    expect((await loadRaw({ exploreDeadlineFloorMs: 60_000 })).getVisualVerifyConfig().exploreDeadlineFloorMs).toBe(
      EXPLORE_DEADLINE_FLOOR_MIN_MS,
    );
    expect((await loadRaw({ exploreDeadlineFloorMs: -5 })).getVisualVerifyConfig().exploreDeadlineFloorMs).toBe(
      EXPLORE_DEADLINE_FLOOR_MIN_MS,
    );
    expect(
      (await loadRaw({ exploreDeadlineFloorMs: 60 * 60 * 1000 })).getVisualVerifyConfig().exploreDeadlineFloorMs,
    ).toBe(EXPLORE_DEADLINE_FLOOR_MAX_MS);
  });

  // The clamp bounds are duplicated into shared/ (which cannot import the
  // orchestrator); these pins are what keeps the copies honest.
  it('pins the clamp bounds to the scheduler deadline constants', () => {
    expect(EXPLORE_DEADLINE_FLOOR_MIN_MS).toBe(DEFAULT_AGENT_REQUEST_TIMEOUT_MS);
    expect(EXPLORE_DEADLINE_FLOOR_MAX_MS).toBe(AGENT_REQUEST_TIMEOUT_CEILING_MS);
    expect(DEFAULT_EXPLORE_DEADLINE_FLOOR_MS).toBeGreaterThanOrEqual(EXPLORE_DEADLINE_FLOOR_MIN_MS);
    expect(DEFAULT_EXPLORE_DEADLINE_FLOOR_MS).toBeLessThanOrEqual(EXPLORE_DEADLINE_FLOOR_MAX_MS);
  });
});
