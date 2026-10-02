/**
 * `AppConfig.webViewer` — the native web viewer's config block and kill switch
 * (docs/proposals/native-web-viewer.md §7).
 *
 * What is pinned here:
 *   - the block is NOT seeded into constructor defaults, so config.json stays
 *     byte-identical for an install that never touches the feature;
 *   - getWebViewerConfig() floors human browsing ON and every agent capability
 *     OFF, and `enabled: false` is a MASTER switch that forces the agent
 *     capabilities off in the resolved block regardless of their stored values;
 *   - a PARTIAL update DEEP-MERGES over the stored block rather than replacing
 *     it — the regression this exists to prevent is `{ agentDrive: true }`
 *     dropping an explicit `enabled: false` back to its `true` floor and
 *     silently re-enabling a feature the user turned off;
 *   - the boundary rejects non-booleans (a string "false" would read as truthy
 *     downstream) and unknown keys, instead of persisting them;
 *   - main's AppConfig / UpdateConfigRequest and the frontend AppConfig mirror
 *     declare the same shape (the silent-drop class the repo's IPC type-parity
 *     rules guard against).
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via
 * setCyboflowDirectory(), so the real ~/.cyboflow config is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppServices } from '../../ipc/types';
import { createConfigOps } from '../../ipc/configOps';
import type { ConfigOpsLike } from '../../orchestrator/trpc/contracts/configOps';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../frontend/src/types/config';
import {
  WEB_VIEWER_CONFIG_KEYS,
  WEB_VIEWER_DEFAULTS,
  type WebViewerConfig,
} from '../../../../shared/types/webViewer';

// --- compile-time type parity across every layer that declares the shape -----
type MainField = MainAppConfig['webViewer'];
type FrontendField = FrontendAppConfig['webViewer'];
type UpdateField = UpdateConfigRequest['webViewer'];

const webViewerParity: [MainField] extends [FrontendField]
  ? [FrontendField] extends [MainField]
    ? [MainField] extends [UpdateField]
      ? [UpdateField] extends [MainField]
        ? true
        : never
      : never
    : never
  : never = true;

function configOpsFor(manager: ConfigManager): ConfigOpsLike {
  return createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
}

async function readPersisted(dir: string): Promise<{ webViewer?: WebViewerConfig }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
    webViewer?: WebViewerConfig;
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-webviewer-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('webViewer type parity', () => {
  it('declares the same shape in main, frontend and the update request', () => {
    expect(webViewerParity).toBe(true);
  });

  it('WEB_VIEWER_CONFIG_KEYS covers every member of the stored block', () => {
    // A key missing here is a key the boundary would reject as unknown.
    expect([...WEB_VIEWER_CONFIG_KEYS].sort()).toEqual(
      Object.keys(WEB_VIEWER_DEFAULTS).sort(),
    );
  });
});

describe('ConfigManager.getWebViewerConfig floors', () => {
  it('is not seeded into constructor defaults', () => {
    const mgr = new ConfigManager();
    expect(mgr.getConfig().webViewer).toBeUndefined();
  });

  it('floors human browsing ON and every agent capability OFF', () => {
    const mgr = new ConfigManager();
    expect(mgr.getWebViewerConfig()).toEqual({
      enabled: true,
      agentObserve: false,
      agentDrive: false,
      persistLogin: true,
    });
  });

  it('floors the same way from a config.json that omits the block', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ gitRepoPath: '/some/repo' }, null, 2),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    expect(mgr.getConfig().webViewer).toBeUndefined();
    expect(mgr.getWebViewerConfig()).toEqual(WEB_VIEWER_DEFAULTS);
  });

  it('treats enabled:false as a master switch over the agent capabilities', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify(
        { webViewer: { enabled: false, agentObserve: true, agentDrive: true } },
        null,
        2,
      ),
    );
    const mgr = new ConfigManager();
    await mgr.initialize();

    // The stored values say true; the resolved block must not.
    expect(mgr.getConfig().webViewer?.agentDrive).toBe(true);
    expect(mgr.getWebViewerConfig()).toEqual({
      enabled: false,
      agentObserve: false,
      agentDrive: false,
      persistLogin: false,
    });
  });
});

describe('webViewer partial updates (deep merge at the config boundary)', () => {
  it('a partial write PRESERVES an explicit enabled:false', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    await ops.updateConfig({ webViewer: { enabled: false } });
    expect(mgr.getWebViewerConfig().enabled).toBe(false);

    // The regression: a shallow spread would replace the whole block here, so
    // the omitted `enabled` would fall back to its `true` floor.
    const result = await ops.updateConfig({ webViewer: { agentDrive: true } });
    expect(result.success).toBe(true);
    expect(mgr.getConfig().webViewer).toEqual({ enabled: false, agentDrive: true });
    expect(mgr.getWebViewerConfig().enabled).toBe(false);
    expect(mgr.getWebViewerConfig().agentDrive).toBe(false); // master switch still wins

    expect((await readPersisted(tempDir)).webViewer).toEqual({
      enabled: false,
      agentDrive: true,
    });
  });

  it('accumulates members across successive partial writes and round-trips off disk', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    await ops.updateConfig({ webViewer: { agentObserve: true } });
    await ops.updateConfig({ webViewer: { persistLogin: false } });

    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.getConfig().webViewer).toEqual({
      agentObserve: true,
      persistLogin: false,
    });
    expect(reloaded.getWebViewerConfig()).toEqual({
      enabled: true,
      agentObserve: true,
      agentDrive: false,
      persistLogin: false,
    });
  });

  it('null clears one member back to its floor without touching the others', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    await ops.updateConfig({ webViewer: { agentObserve: true, agentDrive: true } });
    await ops.updateConfig({
      webViewer: { agentDrive: null } as unknown as WebViewerConfig,
    });

    expect(mgr.getConfig().webViewer).toEqual({ agentObserve: true });
  });

  it('stores an emptied block as absent rather than {}', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    await ops.updateConfig({ webViewer: { agentObserve: true } });
    await ops.updateConfig({
      webViewer: { agentObserve: null } as unknown as WebViewerConfig,
    });

    expect(mgr.getConfig().webViewer).toBeUndefined();
    expect('webViewer' in (await readPersisted(tempDir))).toBe(false);
  });
});

describe('webViewer boundary rejection', () => {
  it('rejects a non-boolean member instead of persisting it', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    // A string "false" passes the tRPC input guard and would be TRUTHY
    // everywhere downstream.
    const result = await ops.updateConfig({
      webViewer: { enabled: 'false' } as unknown as WebViewerConfig,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain('webViewer.enabled');
    expect(mgr.getConfig().webViewer).toBeUndefined();
  });

  it('rejects an unknown key instead of persisting it', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    const result = await ops.updateConfig({
      webViewer: { agentEverything: true } as unknown as WebViewerConfig,
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error).toContain('agentEverything');
    expect(mgr.getConfig().webViewer).toBeUndefined();
  });

  it('rejects a non-object payload', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const ops = configOpsFor(mgr);

    for (const bad of [null, [], 'yes', 7]) {
      const result = await ops.updateConfig({
        webViewer: bad as unknown as WebViewerConfig,
      });
      expect(result.success).toBe(false);
    }
    expect(mgr.getConfig().webViewer).toBeUndefined();
  });
});
