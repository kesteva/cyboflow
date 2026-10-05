/**
 * System view watched ports — ConfigManager.getSystemWatchedPorts floors and the
 * config:update boundary (ipc/configOps.ts) that validates and normalizes the list.
 *
 * The contracts that matter: an absent key reads the defaults (3000, 5000, 8080)
 * and stays absent on disk; an explicit [] means "watch nothing"; a malformed
 * payload is rejected rather than coerced; and saving the defaults back drops the
 * key, so a Settings save that never touched the field leaves config.json alone.
 *
 * Hermetic: each test points ConfigManager at a unique temp dir.
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

// Compile-time parity: the field must read the same on both AppConfig sides and the update request.
type MainField = MainAppConfig['systemWatchedPorts'];
type FrontendField = FrontendAppConfig['systemWatchedPorts'];
type UpdateField = UpdateConfigRequest['systemWatchedPorts'];
const parity: [MainField] extends [FrontendField]
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

async function readPersisted(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as Record<string, unknown>;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-watched-ports-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager.getSystemWatchedPorts', () => {
  it('keeps the type parity across main, frontend and the update request', () => {
    expect(parity).toBe(true);
  });

  it('defaults to 3000, 5000, 8080 and is not seeded into the constructor defaults', () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    expect(mgr.getConfig().systemWatchedPorts).toBeUndefined();
    expect(mgr.getSystemWatchedPorts()).toEqual([3000, 5000, 8080]);
  });

  it('floors a hand-edited malformed value to the defaults', async () => {
    await fs.writeFile(path.join(tempDir, 'config.json'), JSON.stringify({ systemWatchedPorts: ['3000', 99999] }));
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    expect(mgr.getSystemWatchedPorts()).toEqual([3000, 5000, 8080]);
  });
});

describe('config:update systemWatchedPorts boundary', () => {
  it('stores a custom list deduplicated and reads it back', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    const result = await configOpsFor(mgr).updateConfig({ systemWatchedPorts: [3000, 4000, 3000] });
    expect(result.success).toBe(true);
    expect(mgr.getSystemWatchedPorts()).toEqual([3000, 4000]);
    expect((await readPersisted(tempDir)).systemWatchedPorts).toEqual([3000, 4000]);
  });

  it('stores an explicit empty list as "watch nothing"', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    await configOpsFor(mgr).updateConfig({ systemWatchedPorts: [] });
    expect(mgr.getSystemWatchedPorts()).toEqual([]);
  });

  it('drops the key when the saved list equals the defaults', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    const ops = configOpsFor(mgr);
    await ops.updateConfig({ systemWatchedPorts: [8080] });
    await ops.updateConfig({ systemWatchedPorts: [3000, 5000, 8080] });
    expect('systemWatchedPorts' in (await readPersisted(tempDir))).toBe(false);
    expect(mgr.getSystemWatchedPorts()).toEqual([3000, 5000, 8080]);
  });

  it('rejects a malformed payload without touching the stored list', async () => {
    const mgr = new ConfigManager('/tmp/test-git-path');
    await mgr.initialize();
    const ops = configOpsFor(mgr);
    await ops.updateConfig({ systemWatchedPorts: [4000] });
    for (const bad of [[0], [65536], [3000.5], ['3000'], 'nope', Array.from({ length: 33 }, (_, i) => i + 1)]) {
      const result = await ops.updateConfig({ systemWatchedPorts: bad as unknown as number[] });
      expect(result.success).toBe(false);
    }
    expect(mgr.getSystemWatchedPorts()).toEqual([4000]);
  });
});
