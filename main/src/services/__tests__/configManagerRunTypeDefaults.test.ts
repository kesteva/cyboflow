import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { TRPCError } from '@trpc/server';
import type { AppServices } from '../../ipc/types';
import { createConfigOps } from '../../ipc/configOps';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { AppConfig as MainAppConfig } from '../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../frontend/src/types/config';
import {
  DEFAULT_QUICK_MODEL,
  DEFAULT_RUN_TYPE_MODEL_FLOORS,
  DEFAULT_WORKFLOW_MODEL,
  type RunTypeDefaults,
} from '../../../../shared/types/sessionDefaults';

type MainRunTypeDefaults = MainAppConfig['runTypeDefaults'];
type FrontendRunTypeDefaults = FrontendAppConfig['runTypeDefaults'];
const mainRunTypeDefaultsParity: MainRunTypeDefaults extends FrontendRunTypeDefaults ? true : never = true;
const frontendRunTypeDefaultsParity: FrontendRunTypeDefaults extends MainRunTypeDefaults ? true : never = true;

/** Build a real cyboflow.config tRPC caller backed by the given ConfigManager. */
function callerFor(manager: ConfigManager): ReturnType<typeof appRouter.createCaller> {
  const configOps = createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
  return appRouter.createCaller(createContext({ configOps }));
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-runtype-defaults-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('ConfigManager run-type defaults', () => {
  it('keeps the shared model floors and AppConfig runTypeDefaults mirrors aligned', () => {
    expect(DEFAULT_WORKFLOW_MODEL).toBe('opus');
    expect(DEFAULT_QUICK_MODEL).toBe('opus');
    expect(DEFAULT_RUN_TYPE_MODEL_FLOORS).toEqual({ workflow: 'opus', quick: 'opus' });
    expect(mainRunTypeDefaultsParity).toBe(true);
    expect(frontendRunTypeDefaultsParity).toBe(true);

    const defaults: RunTypeDefaults = { model: DEFAULT_WORKFLOW_MODEL };
    expect(defaults).toEqual({ model: 'opus' });
  });

  it('reads sparse entries raw and keeps launch floors separate from defaultModel', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    expect(manager.getConfig().runTypeDefaults).toBeUndefined();
    expect(manager.getDefaultModel()).toBe('sonnet');
    expect(manager.getRunTypeDefaults('workflow:nonexistent')).toBeUndefined();
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).toBe('opus');
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).not.toBe(manager.getDefaultModel());
    expect(manager.getDefaultLaunchModel('quick')).toBe('opus');

    // The assertions above are tautological on their own: with defaultModel
    // unset, both `defaultModel ?? floor` (the exact regression TASK-130
    // forbids) and the real floor-only implementation evaluate to the floor,
    // so they can't distinguish the two. Set defaultModel to a distinct
    // value and prove getDefaultLaunchModel never reads it.
    await manager.updateConfig({ defaultModel: 'haiku' });
    expect(manager.getDefaultModel()).toBe('haiku');
    expect(manager.getDefaultLaunchModel('workflow:nonexistent')).toBe('opus');
    expect(manager.getDefaultLaunchModel('quick')).toBe('opus');

    await manager.updateConfig({ runTypeDefaults: { 'workflow:flow-a': { model: 'sonnet' } } });
    expect(manager.getRunTypeDefaults('workflow:flow-a')).toEqual({ model: 'sonnet' });
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe('sonnet');
  });

  it('returns the previous value and applies sparse merge deletion', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    const prior = { model: 'opus' as const };
    await manager.updateConfig({ runTypeDefaults: { quick: prior } });

    const updated = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { model: null },
    });

    expect(updated.previous).toBe(prior);
    expect(updated.previous).toEqual(prior);
    expect(updated.config.runTypeDefaults).toBeUndefined();
    expect(manager.getRunTypeDefaults('quick')).toBeUndefined();
  });

  it('creates a sparse key when merging an override that did not previously exist', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    const created = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { substrate: 'sdk' },
    });

    expect(created.previous).toBeUndefined();
    expect(created.config.runTypeDefaults?.quick).toEqual({ substrate: 'sdk' });
  });

  it('a key of "__proto__" is stored as a genuine own entry, not the object prototype (prototype-pollution guard)', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({ runTypeDefaults: { quick: { model: 'opus' } } });

    const result = await manager.applyRunTypeDefault('__proto__', {
      kind: 'merge',
      value: { model: 'sonnet' },
    });

    // The pre-existing 'quick' entry must survive: a plain-object working
    // structure (`{ ...runTypeDefaults }`) has Object.prototype as its
    // [[Prototype]], so `runTypeDefaults['__proto__'] = value` invokes the
    // inherited accessor instead of creating an own property — silently
    // wiping every OTHER key once re-serialized, while reporting success.
    expect(manager.getRunTypeDefaults('quick')).toEqual({ model: 'opus' });
    // And the '__proto__' write itself must land as a real, independently
    // readable entry — not vanish, and not corrupt the object's prototype.
    expect(manager.getRunTypeDefaults('__proto__')).toEqual({ model: 'sonnet' });
    // Computed key ['__proto__'], deliberately NOT the literal `__proto__:`
    // shorthand: the shorthand form is special-cased by object-literal syntax
    // itself to set the *expected* object's prototype rather than a property,
    // which would make this assertion's own fixture wrong in exactly the way
    // this test exists to catch.
    expect(result.config.runTypeDefaults).toEqual({
      quick: { model: 'opus' },
      ['__proto__']: { model: 'sonnet' },
    });
    expect(Object.getPrototypeOf(result.config.runTypeDefaults)).toBe(Object.prototype);

    const persisted = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'),
    ) as { runTypeDefaults?: Record<string, unknown> };
    expect(persisted.runTypeDefaults?.quick).toEqual({ model: 'opus' });
  });

  it('returns undefined when the key did not exist and supports replace', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    const created = await manager.applyRunTypeDefault('workflow:flow-a', {
      kind: 'replace',
      value: { model: 'sonnet', substrate: 'sdk' },
    });
    expect(created.previous).toBeUndefined();
    expect(created.config.runTypeDefaults?.['workflow:flow-a']).toEqual({ model: 'sonnet', substrate: 'sdk' });

    const persistedAfterCreate = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'),
    ) as { runTypeDefaults?: Record<string, Record<string, string>> };
    expect(persistedAfterCreate.runTypeDefaults?.['workflow:flow-a']).toEqual({
      model: 'sonnet',
      substrate: 'sdk',
    });

    const replaced = await manager.applyRunTypeDefault('workflow:flow-a', {
      kind: 'replace',
      value: null,
    });
    expect(replaced.previous).toEqual({ model: 'sonnet', substrate: 'sdk' });
    expect(replaced.config.runTypeDefaults).toBeUndefined();

    const persistedAfterDelete = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config.json'), 'utf8'),
    ) as { runTypeDefaults?: Record<string, Record<string, string>> };
    expect(persistedAfterDelete.runTypeDefaults).toBeUndefined();
  });

  it('preserves unrelated sparse fields across merge patches before deleting the empty key', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({
      runTypeDefaults: {
        quick: {
          model: 'opus',
          substrate: 'sdk',
          reasoningEffort: 'high',
        },
      },
    });

    const merged = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { model: null, substrate: 'interactive' },
    });

    expect(merged.previous).toEqual({
      model: 'opus',
      substrate: 'sdk',
      reasoningEffort: 'high',
    });
    expect(merged.config.runTypeDefaults?.quick).toEqual({
      substrate: 'interactive',
      reasoningEffort: 'high',
    });

    const deleted = await manager.applyRunTypeDefault('quick', {
      kind: 'merge',
      value: { substrate: null, reasoningEffort: null },
    });

    expect(deleted.previous).toEqual({
      substrate: 'interactive',
      reasoningEffort: 'high',
    });
    expect(deleted.config.runTypeDefaults).toBeUndefined();
  });

  it('deletes a key when replace receives an empty object and returns the whole updated config', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    await manager.updateConfig({ runTypeDefaults: { quick: { model: 'opus' } } });

    const result = await manager.applyRunTypeDefault('quick', {
      kind: 'replace',
      value: {},
    });

    expect(result.previous).toEqual({ model: 'opus' });
    expect(result.config).toBe(manager.getConfig());
    expect(result.config.runTypeDefaults).toBeUndefined();
  });

  it('the cyboflow.config.applyRunTypeDefault procedure delegates valid input and rejects invalid input', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    const caller = callerFor(manager);

    const valid = (await caller.cyboflow.config.applyRunTypeDefault({
      key: 'quick',
      op: { kind: 'replace', value: { model: 'opus' } },
    })) as { success: boolean; data?: { previous: RunTypeDefaults | undefined; config: MainAppConfig } };
    expect(valid).toEqual({
      success: true,
      data: {
        previous: undefined,
        config: manager.getConfig(),
      },
    });

    // An unrecognized field on a merge value fails zod's .strict() at the
    // router boundary — a TRPCError, not the legacy { success: false } envelope.
    await expect(
      caller.cyboflow.config.applyRunTypeDefault({
        key: 'quick',
        op: { kind: 'merge', value: { unknownField: 'nope' } } as never,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof TRPCError && err.code === 'BAD_REQUEST');
  });

  it('the generic cyboflow.config.update channel cannot clobber runTypeDefaults (the "two write channels cannot race" invariant)', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    const caller = callerFor(manager);

    await caller.cyboflow.config.applyRunTypeDefault({
      key: 'quick',
      op: { kind: 'replace', value: { model: 'opus' } },
    });
    expect(manager.getRunTypeDefaults('quick')).toEqual({ model: 'opus' });

    // `UpdateConfigRequest` (main/src/types/config.ts) deliberately has no
    // `runTypeDefaults` field, but the router's `update` input schema only
    // asserts "is a plain object" — it does not itself reject or strip an
    // extra key. The `as unknown as` cast here stands in for a caller whose
    // OWN static type still carries the field (the exact bug this test
    // guards against: frontend/src/stores/configStore.ts's `updateConfig`
    // used to be typed as `Partial<AppConfig>`, which does include it).
    await caller.cyboflow.config.update({
      verbose: true,
      runTypeDefaults: { quick: { model: 'sonnet' } },
    } as unknown as Parameters<typeof caller.cyboflow.config.update>[0]);

    // The generic write must be defensively stripped (main/src/ipc/configOps.ts)
    // rather than silently clobbering the whole map through this channel —
    // the stored default must be untouched, and the unrelated field must
    // still have landed.
    expect(manager.getRunTypeDefaults('quick')).toEqual({ model: 'opus' });
    expect(manager.getConfig().verbose).toBe(true);
  });
});
