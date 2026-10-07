/**
 * `AppConfig.agents` — the Agents & Environments gate, plus the dev-only `cloud.origin` override.
 *
 * What is pinned here:
 *   - the gate is isDevBuild() && agents.enabled === true (floor-on-read, live per call);
 *   - a release build rejects `config.update({agents})` outright and ignores a stale stored `enabled:true`;
 *   - in a dev build the boundary accepts booleans only, rejects unknown keys, merges over the stored
 *     block and stores an empty block as absent;
 *   - `cloud` can never be written through the renderer channel;
 *   - getCloudOrigin(): release → production always; dev → override (validated) ?? staging;
 *   - main's AppConfig / UpdateConfigRequest and the frontend AppConfig declare the same `agents` shape.
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via setCyboflowDirectory().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppServices } from '../../ipc/types';
import { createConfigOps } from '../../ipc/configOps';
import type { ConfigOpsLike } from '../../orchestrator/trpc/contracts/configOps';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import { _setDevBuildForTesting, isDevBuild, isDevBuildFor } from '../../utils/buildChannel';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../frontend/src/types/config';
import { AGENTS_CONFIG_KEYS, type AgentsConfig } from '../../../../shared/types/persistentAgents';
import { CLOUD_PRODUCTION_ORIGIN, CLOUD_STAGING_ORIGIN } from '../../../../shared/types/cloudOrigins';

// --- compile-time type parity across every layer that declares the shape -----
type MainField = MainAppConfig['agents'];
type FrontendField = FrontendAppConfig['agents'];
type UpdateField = UpdateConfigRequest['agents'];

const agentsParity: [MainField] extends [FrontendField]
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

async function readPersisted(dir: string): Promise<{ agents?: AgentsConfig; cloud?: unknown }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
    agents?: AgentsConfig;
    cloud?: unknown;
  };
}

async function managerWith(stored: Record<string, unknown>): Promise<ConfigManager> {
  await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(stored, null, 2));
  const mgr = new ConfigManager();
  await mgr.initialize();
  return mgr;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-agents-config-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  _setDevBuildForTesting(undefined);
  vi.restoreAllMocks();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('agents type parity', () => {
  it('declares the same shape in main, frontend and the update request', () => {
    expect(agentsParity).toBe(true);
  });

  it('AGENTS_CONFIG_KEYS is exactly the stored block members', () => {
    expect([...AGENTS_CONFIG_KEYS]).toEqual(['enabled']);
  });
});

describe('build channel', () => {
  it('isDevBuildFor truth table', () => {
    expect(isDevBuildFor(false, 'stable')).toBe(true);
    expect(isDevBuildFor(false, 'dev')).toBe(true);
    expect(isDevBuildFor(true, 'dev')).toBe(true);
    expect(isDevBuildFor(true, 'stable')).toBe(false);
  });

  it('isDevBuild() fails closed without electron app.isPackaged, and honours the test override', () => {
    expect(isDevBuild()).toBe(false);
    _setDevBuildForTesting(true);
    expect(isDevBuild()).toBe(true);
    _setDevBuildForTesting(false);
    expect(isDevBuild()).toBe(false);
  });
});

describe('release build', () => {
  beforeEach(() => _setDevBuildForTesting(false));

  it('ignores a stale stored agents.enabled:true', async () => {
    const mgr = await managerWith({ agents: { enabled: true } });
    expect(mgr.isAgentsAvailable()).toBe(false);
    expect(mgr.isAgentsEnabled()).toBe(false);
  });

  it('rejects config.update({agents}) and persists nothing', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({ agents: { enabled: true } });
    expect(result).toEqual({ success: false, error: 'Agents & Environments is not available in this build' });
    expect(mgr.getConfig().agents).toBeUndefined();
    expect(mgr.isAgentsEnabled()).toBe(false);
  });
});

describe('dev build', () => {
  beforeEach(() => _setDevBuildForTesting(true));

  it('is disabled by default and not seeded into defaults', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    expect(mgr.isAgentsAvailable()).toBe(true);
    expect(mgr.isAgentsEnabled()).toBe(false);
    expect(mgr.getConfig().agents).toBeUndefined();
  });

  it('enabling persists the block sparsely and the gate reads it live', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({ agents: { enabled: true } });
    expect(result).toEqual({ success: true });
    expect(mgr.isAgentsEnabled()).toBe(true);
    expect((await readPersisted(tempDir)).agents).toEqual({ enabled: true });
  });

  it('null clears the member and the empty block is stored as absent', async () => {
    const mgr = await managerWith({ agents: { enabled: true } });
    const result = await configOpsFor(mgr).updateConfig({
      agents: { enabled: null } as unknown as AgentsConfig,
    });
    expect(result).toEqual({ success: true });
    expect(mgr.getConfig().agents).toBeUndefined();
    expect(mgr.isAgentsEnabled()).toBe(false);
    expect('agents' in (await readPersisted(tempDir))).toBe(false);
  });

  it("rejects a non-boolean ('true' string)", async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      agents: { enabled: 'true' } as unknown as AgentsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Invalid agents.enabled: expected a boolean' });
    expect(mgr.getConfig().agents).toBeUndefined();
  });

  it('rejects an unknown key', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      agents: { x: true } as unknown as AgentsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Unknown agents key: x' });
  });

  it('rejects a non-object payload', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      agents: [true] as unknown as AgentsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Invalid agents payload' });
  });

  it('turning it off flips the gate live', async () => {
    const mgr = await managerWith({ agents: { enabled: true } });
    expect(mgr.isAgentsEnabled()).toBe(true);
    await configOpsFor(mgr).updateConfig({ agents: { enabled: false } });
    expect(mgr.isAgentsEnabled()).toBe(false);
    expect((await readPersisted(tempDir)).agents).toEqual({ enabled: false });
  });
});

describe('cloud is never writable from the renderer channel', () => {
  it('strips cloud from an update', async () => {
    _setDevBuildForTesting(true);
    const mgr = await managerWith({ cloud: { origin: 'production' } });
    const result = await configOpsFor(mgr).updateConfig(
      { cloud: { origin: 'https://evil.example' } } as unknown as UpdateConfigRequest,
    );
    expect(result).toEqual({ success: true });
    expect(mgr.getConfig().cloud).toEqual({ origin: 'production' });
  });
});

describe('getCloudOrigin', () => {
  it('release: production even with an override', async () => {
    _setDevBuildForTesting(false);
    const mgr = await managerWith({ cloud: { origin: 'http://127.0.0.1:8787' } });
    expect(mgr.getCloudOrigin()).toBe(CLOUD_PRODUCTION_ORIGIN);
  });

  it('dev: staging by default', async () => {
    _setDevBuildForTesting(true);
    const mgr = new ConfigManager();
    await mgr.initialize();
    expect(mgr.getCloudOrigin()).toBe(CLOUD_STAGING_ORIGIN);
  });

  it("dev: 'production' selects production", async () => {
    _setDevBuildForTesting(true);
    const mgr = await managerWith({ cloud: { origin: 'production' } });
    expect(mgr.getCloudOrigin()).toBe(CLOUD_PRODUCTION_ORIGIN);
  });

  it('dev: a local wrangler origin is honoured', async () => {
    _setDevBuildForTesting(true);
    const mgr = await managerWith({ cloud: { origin: 'http://127.0.0.1:8787' } });
    expect(mgr.getCloudOrigin()).toBe('http://127.0.0.1:8787');
  });

  it('dev: a rejected override falls back to staging and warns once', async () => {
    _setDevBuildForTesting(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mgr = await managerWith({ cloud: { origin: 'http://evil.com' } });
    expect(mgr.getCloudOrigin()).toBe(CLOUD_STAGING_ORIGIN);
    expect(mgr.getCloudOrigin()).toBe(CLOUD_STAGING_ORIGIN);
    const originWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('cloud.origin'));
    expect(originWarnings).toHaveLength(1);
  });
});
