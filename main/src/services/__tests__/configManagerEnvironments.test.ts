/**
 * `AppConfig.environments` — the Environments gate. Same rules as `agents`:
 *   - the gate is isDevBuild() && environments.enabled === true (live per call);
 *   - a release build rejects `config.update({environments})` outright and ignores a stale stored `enabled:true`;
 *   - in a dev build the boundary accepts booleans only, rejects unknown keys, merges over the stored block
 *     and stores an empty block as absent;
 *   - main's AppConfig and UpdateConfigRequest declare the same `environments` shape.
 *
 * Hermetic: each test points ConfigManager at a unique temp dir via setCyboflowDirectory().
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
import { _setDevBuildForTesting } from '../../utils/buildChannel';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../types/config';
import { HOSTS_CONFIG_KEYS, type HostsConfig } from '../../../../shared/types/hosts';

type MainField = MainAppConfig['environments'];
type UpdateField = UpdateConfigRequest['environments'];

const environmentsParity: [MainField] extends [UpdateField]
  ? [UpdateField] extends [MainField]
    ? true
    : never
  : never = true;

function configOpsFor(manager: ConfigManager): ConfigOpsLike {
  return createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
}

async function readPersisted(dir: string): Promise<{ environments?: HostsConfig }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as { environments?: HostsConfig };
}

async function managerWith(stored: Record<string, unknown>): Promise<ConfigManager> {
  await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify(stored, null, 2));
  const mgr = new ConfigManager();
  await mgr.initialize();
  return mgr;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-environments-config-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  _setDevBuildForTesting(undefined);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('environments type parity', () => {
  it('declares the same shape in AppConfig and the update request', () => {
    expect(environmentsParity).toBe(true);
  });

  it('HOSTS_CONFIG_KEYS is exactly the stored block members', () => {
    expect([...HOSTS_CONFIG_KEYS]).toEqual(['enabled']);
  });
});

describe('release build', () => {
  beforeEach(() => _setDevBuildForTesting(false));

  it('ignores a stale stored environments.enabled:true', async () => {
    const mgr = await managerWith({ environments: { enabled: true } });
    expect(mgr.isEnvironmentsAvailable()).toBe(false);
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
  });

  it('rejects config.update({environments}) and persists nothing', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({ environments: { enabled: true } });
    expect(result).toEqual({ success: false, error: 'Environments is not available in this build' });
    expect(mgr.getConfig().environments).toBeUndefined();
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
  });
});

describe('dev build', () => {
  beforeEach(() => _setDevBuildForTesting(true));

  it('is disabled by default and not seeded into defaults', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    expect(mgr.isEnvironmentsAvailable()).toBe(true);
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
    expect(mgr.getConfig().environments).toBeUndefined();
  });

  it('is independent of the agents gate', async () => {
    const mgr = await managerWith({ agents: { enabled: true } });
    expect(mgr.isAgentsEnabled()).toBe(true);
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
  });

  it('enabling persists the block sparsely and the gate reads it live', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({ environments: { enabled: true } });
    expect(result).toEqual({ success: true });
    expect(mgr.isEnvironmentsEnabled()).toBe(true);
    expect((await readPersisted(tempDir)).environments).toEqual({ enabled: true });
  });

  it('null clears the member and the empty block is stored as absent', async () => {
    const mgr = await managerWith({ environments: { enabled: true } });
    const result = await configOpsFor(mgr).updateConfig({
      environments: { enabled: null } as unknown as HostsConfig,
    });
    expect(result).toEqual({ success: true });
    expect(mgr.getConfig().environments).toBeUndefined();
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
    expect('environments' in (await readPersisted(tempDir))).toBe(false);
  });

  it("rejects a non-boolean ('true' string)", async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      environments: { enabled: 'true' } as unknown as HostsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Invalid environments.enabled: expected a boolean' });
    expect(mgr.getConfig().environments).toBeUndefined();
  });

  it('rejects an unknown key', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      environments: { x: true } as unknown as HostsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Unknown environments key: x' });
  });

  it('rejects a non-object payload', async () => {
    const mgr = new ConfigManager();
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({
      environments: [true] as unknown as HostsConfig,
    });
    expect(result).toEqual({ success: false, error: 'Invalid environments payload' });
  });

  it('turning it off flips the gate live', async () => {
    const mgr = await managerWith({ environments: { enabled: true } });
    expect(mgr.isEnvironmentsEnabled()).toBe(true);
    await configOpsFor(mgr).updateConfig({ environments: { enabled: false } });
    expect(mgr.isEnvironmentsEnabled()).toBe(false);
    expect((await readPersisted(tempDir)).environments).toEqual({ enabled: false });
  });
});
