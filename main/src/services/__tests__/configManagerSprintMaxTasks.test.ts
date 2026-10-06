/**
 * `AppConfig.sprintMaxTasks` — the user-configurable sprint task-selection cap
 * that replaced the hardcoded `SPRINT_BATCH_MAX_TASKS` map.
 *
 * What is pinned here:
 *   - the pure resolver: an absent/invalid override falls back to the built-in
 *     per-substrate default, a present one wins, and every value is clamped to
 *     [SPRINT_MAX_TASKS_MIN, SPRINT_MAX_TASKS_MAX];
 *   - the field round-trips through the REAL IPC path (config:update →
 *     config:get → a fresh initialize() off disk), and the IPC boundary STORES
 *     the clamped value rather than trusting the renderer;
 *   - a malformed payload is rejected at the boundary instead of persisting;
 *   - with the field absent, `getSprintMaxTasks()` returns `{}`, config.json
 *     stays free of the key, and every consumer sees the pre-setting defaults;
 *   - main's AppConfig / UpdateConfigRequest and the frontend AppConfig mirror
 *     declare the same shape (the silent-drop class the repo's IPC type-parity
 *     rules guard against).
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
  clampSprintMaxTasks,
  resolveSprintMaxTasks,
  SPRINT_BATCH_MAX_TASKS_DEFAULTS,
  SPRINT_MAX_TASKS_MAX,
  SPRINT_MAX_TASKS_MIN,
} from '../../../../shared/types/sprintBatch';

// --- compile-time type parity across every layer that declares the shape -----
type MainField = MainAppConfig['sprintMaxTasks'];
type FrontendField = FrontendAppConfig['sprintMaxTasks'];
type UpdateField = UpdateConfigRequest['sprintMaxTasks'];

const sprintMaxTasksParity: [MainField] extends [FrontendField]
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

async function readPersisted(dir: string): Promise<{ sprintMaxTasks?: Record<string, number> }> {
  return JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as {
    sprintMaxTasks?: Record<string, number>;
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-sprint-cap-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('resolveSprintMaxTasks / clampSprintMaxTasks', () => {
  it('declares the same shape on every layer that carries it', () => {
    expect(sprintMaxTasksParity).toBe(true);
  });

  it('falls back to the built-in default when there is no override', () => {
    expect(resolveSprintMaxTasks(undefined, 'sdk')).toBe(SPRINT_BATCH_MAX_TASKS_DEFAULTS.sdk);
    expect(resolveSprintMaxTasks({}, 'interactive')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    );
  });

  it('is keyed per substrate — overriding one leaves the other on its default', () => {
    expect(resolveSprintMaxTasks({ sdk: 40 }, 'sdk')).toBe(40);
    expect(resolveSprintMaxTasks({ sdk: 40 }, 'interactive')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    );
  });

  it('clamps to the documented bounds and truncates a fractional value', () => {
    expect(resolveSprintMaxTasks({ sdk: 0 }, 'sdk')).toBe(SPRINT_MAX_TASKS_MIN);
    expect(resolveSprintMaxTasks({ sdk: -7 }, 'sdk')).toBe(SPRINT_MAX_TASKS_MIN);
    expect(resolveSprintMaxTasks({ sdk: 10_000 }, 'sdk')).toBe(SPRINT_MAX_TASKS_MAX);
    expect(resolveSprintMaxTasks({ sdk: 12.9 }, 'sdk')).toBe(12);
  });

  it('treats a non-numeric hand-edited value as NO override, not as 0', () => {
    // config.json is user-editable: `"twenty"` must degrade to the default rather
    // than clamping to the 1-task floor, which would block every sprint launch.
    expect(clampSprintMaxTasks('twenty')).toBeNull();
    expect(clampSprintMaxTasks(NaN)).toBeNull();
    expect(clampSprintMaxTasks(null)).toBeNull();
    expect(
      resolveSprintMaxTasks({ sdk: 'twenty' } as unknown as { sdk?: number }, 'sdk'),
    ).toBe(SPRINT_BATCH_MAX_TASKS_DEFAULTS.sdk);
  });
});

describe('ConfigManager.getSprintMaxTasks', () => {
  it('round-trips through configOps.updateConfig → .getConfig → a fresh load off disk', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const updated = await configOps.updateConfig({
      sprintMaxTasks: { sdk: 40, interactive: 25 },
    } satisfies UpdateConfigRequest);
    expect(updated).toEqual({ success: true });

    const fetched = (await configOps.getConfig()) as {
      success: boolean;
      data: MainAppConfig;
    };
    expect(fetched.data.sprintMaxTasks).toEqual({ sdk: 40, interactive: 25 });
    expect((await readPersisted(tempDir)).sprintMaxTasks).toEqual({ sdk: 40, interactive: 25 });

    // A relaunch reads the same values (config is a plain JSON file).
    const reloaded = new ConfigManager();
    await reloaded.initialize();
    expect(reloaded.getSprintMaxTasks()).toEqual({ sdk: 40, interactive: 25 });
    expect(resolveSprintMaxTasks(reloaded.getSprintMaxTasks(), 'sdk')).toBe(40);
  });

  it('STORES the clamped value — the boundary does not trust the renderer', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    await configOps.updateConfig({
      sprintMaxTasks: { sdk: 10_000, interactive: 0 },
    } satisfies UpdateConfigRequest);

    expect((await readPersisted(tempDir)).sprintMaxTasks).toEqual({
      sdk: SPRINT_MAX_TASKS_MAX,
      interactive: SPRINT_MAX_TASKS_MIN,
    });
  });

  it('rejects a malformed payload instead of persisting it', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    const wrongType = await configOps.updateConfig({
      sprintMaxTasks: 20,
    } as unknown as UpdateConfigRequest);
    expect(wrongType).toEqual({ success: false, error: 'Invalid sprintMaxTasks payload' });

    const wrongMember = (await configOps.updateConfig({
      sprintMaxTasks: { sdk: 'twenty' },
    } as unknown as UpdateConfigRequest)) as { success: boolean; error?: string };
    expect(wrongMember.success).toBe(false);
    expect(wrongMember.error).toContain('sprintMaxTasks.sdk');

    expect((await readPersisted(tempDir)).sprintMaxTasks).toBeUndefined();
    expect(manager.getSprintMaxTasks()).toEqual({});
  });

  it('drops a cleared member so the substrate falls back to its built-in default', async () => {
    const manager = new ConfigManager();
    await manager.initialize();
    const configOps = configOpsFor(manager);

    await configOps.updateConfig({
      sprintMaxTasks: { sdk: 40, interactive: undefined },
    } satisfies UpdateConfigRequest);

    expect(manager.getSprintMaxTasks()).toEqual({ sdk: 40 });
    expect(resolveSprintMaxTasks(manager.getSprintMaxTasks(), 'interactive')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    );
  });

  it('with the field absent, config.json stays free of the key and the defaults hold', async () => {
    const manager = new ConfigManager();
    await manager.initialize();

    expect(manager.getConfig().sprintMaxTasks).toBeUndefined();
    expect(manager.getSprintMaxTasks()).toEqual({});
    expect((await readPersisted(tempDir)).sprintMaxTasks).toBeUndefined();
    expect(resolveSprintMaxTasks(manager.getSprintMaxTasks(), 'sdk')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.sdk,
    );
    expect(resolveSprintMaxTasks(manager.getSprintMaxTasks(), 'interactive')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    );
  });

  it('sanitizes a HAND-EDITED config.json on read', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify({ sprintMaxTasks: { sdk: 999, interactive: 'ten' } }),
    );
    const manager = new ConfigManager();
    await manager.initialize();

    // sdk clamps to the ceiling; the non-numeric interactive entry is DROPPED so
    // the resolver falls back to the built-in default rather than to a floor.
    expect(manager.getSprintMaxTasks()).toEqual({ sdk: SPRINT_MAX_TASKS_MAX });
    expect(resolveSprintMaxTasks(manager.getSprintMaxTasks(), 'interactive')).toBe(
      SPRINT_BATCH_MAX_TASKS_DEFAULTS.interactive,
    );
  });
});
