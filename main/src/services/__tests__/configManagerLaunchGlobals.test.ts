/**
 * The two GLOBAL launch defaults — `defaultLaunchModel` and `defaultAgentRuntime`
 * — that fill the previously-empty middle rung of the launch ladder documented in
 * shared/types/sessionDefaults.ts:
 *
 *   per-run-type stored value → global config default → hardcoded floor
 *
 * What is pinned here:
 *   - both fields round-trip through the REAL IPC path (config:update →
 *     config:get → a fresh initialize() off disk), not just through the type;
 *   - getDefaultLaunchModel consults defaultLaunchModel as its middle rung and
 *     still NEVER inherits the legacy `defaultModel` (which feeds the assistant
 *     fallback and the legacy panel backfill — conflating the two would silently
 *     move assistant behavior);
 *   - with both fields absent, config.json stays byte-identical and every getter
 *     returns exactly what it returned before the fields existed;
 *   - main's AppConfig / UpdateConfigRequest and the frontend AppConfig mirror
 *     declare the same shape for both fields (the silent-drop class the repo's
 *     IPC type-parity rules guard against).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { AppServices } from '../../ipc/types';
import { createConfigOps } from '../../ipc/configOps';
import { appRouter } from '../../orchestrator/trpc/router';
import { createContext } from '../../orchestrator/trpc/context';
import { ConfigManager } from '../configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';
import type { AppConfig as MainAppConfig, UpdateConfigRequest } from '../../types/config';
import type { AppConfig as FrontendAppConfig } from '../../../../frontend/src/types/config';
import { DEFAULT_RUN_TYPE_MODEL_FLOORS } from '../../../../shared/types/sessionDefaults';

// --- compile-time type parity across every layer that declares the shape -----
type MainLaunchModel = MainAppConfig['defaultLaunchModel'];
type FrontendLaunchModel = FrontendAppConfig['defaultLaunchModel'];
type UpdateLaunchModel = UpdateConfigRequest['defaultLaunchModel'];
type MainAgentRuntime = MainAppConfig['defaultAgentRuntime'];
type FrontendAgentRuntime = FrontendAppConfig['defaultAgentRuntime'];
type UpdateAgentRuntime = UpdateConfigRequest['defaultAgentRuntime'];

const launchModelParity: [MainLaunchModel] extends [FrontendLaunchModel]
  ? [FrontendLaunchModel] extends [MainLaunchModel]
    ? [MainLaunchModel] extends [UpdateLaunchModel]
      ? [UpdateLaunchModel] extends [MainLaunchModel]
        ? true
        : never
      : never
    : never
  : never = true;

const agentRuntimeParity: [MainAgentRuntime] extends [FrontendAgentRuntime]
  ? [FrontendAgentRuntime] extends [MainAgentRuntime]
    ? [MainAgentRuntime] extends [UpdateAgentRuntime]
      ? [UpdateAgentRuntime] extends [MainAgentRuntime]
        ? true
        : never
      : never
    : never
  : never = true;

/** Build a real cyboflow.config tRPC caller backed by the given ConfigManager. */
function callerFor(manager: ConfigManager): ReturnType<typeof appRouter.createCaller> {
  const configOps = createConfigOps({
    configManager: manager,
    claudeCodeManager: {} as unknown as AppServices['claudeCodeManager'],
  });
  return appRouter.createCaller(createContext({ configOps }));
}

/** Every .ts file under a directory, excluding test files/directories. */
async function productionSources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...(await productionSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.') && !entry.name.includes('.itest.')) {
      out.push(full);
    }
  }
  return out;
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-launch-globals-test-'));
  setCyboflowDirectory(tempDir);
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('global launch defaults: defaultLaunchModel / defaultAgentRuntime', () => {
  it('declares the same shape on every layer that carries it', () => {
    expect(launchModelParity).toBe(true);
    expect(agentRuntimeParity).toBe(true);
  });

  it('round-trips both fields through cyboflow.config.update → .get → a fresh load off disk', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    const caller = callerFor(manager);

    const updated = await caller.cyboflow.config.update({
      defaultLaunchModel: 'sonnet',
      defaultAgentRuntime: 'codex-sdk',
    } satisfies UpdateConfigRequest);
    expect(updated).toEqual({ success: true });

    const fetched = (await caller.cyboflow.config.get()) as {
      success: boolean;
      data: MainAppConfig;
    };
    expect(fetched.success).toBe(true);
    expect(fetched.data.defaultLaunchModel).toBe('sonnet');
    expect(fetched.data.defaultAgentRuntime).toBe('codex-sdk');

    // ...and the same values are what actually hit config.json, so a relaunch
    // sees them (config is a JSON file — there is no schema/migration involved).
    const persisted = JSON.parse(await fs.readFile(path.join(tempDir, 'config.json'), 'utf8')) as {
      defaultLaunchModel?: string;
      defaultAgentRuntime?: string;
    };
    expect(persisted.defaultLaunchModel).toBe('sonnet');
    expect(persisted.defaultAgentRuntime).toBe('codex-sdk');

    const reloaded = new ConfigManager('/tmp/test-git-path');
    await reloaded.initialize();
    expect(reloaded.getConfig().defaultLaunchModel).toBe('sonnet');
    expect(reloaded.getConfig().defaultAgentRuntime).toBe('codex-sdk');
    expect(reloaded.getDefaultAgentRuntime()).toBe('codex-sdk');
  });

  it('getDefaultLaunchModel: per-type override → defaultLaunchModel → the per-kind floor', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    // Rung 3 (nothing set anywhere): the per-kind floor.
    expect(manager.getDefaultLaunchModel('quick')).toBe(DEFAULT_RUN_TYPE_MODEL_FLOORS.quick);
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe(
      DEFAULT_RUN_TYPE_MODEL_FLOORS.workflow,
    );

    // Rung 2: the global default, for BOTH launch kinds.
    await manager.updateConfig({ defaultLaunchModel: 'haiku' });
    expect(manager.getDefaultLaunchModel('quick')).toBe('haiku');
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe('haiku');

    // Rung 1: a per-run-type override outranks the global; unrelated keys do not.
    await manager.updateConfig({ runTypeDefaults: { 'workflow:flow-a': { model: 'opus' } } });
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe('opus');
    expect(manager.getDefaultLaunchModel('workflow:flow-b')).toBe('haiku');
    expect(manager.getDefaultLaunchModel('quick')).toBe('haiku');
  });

  it('getDefaultLaunchModel NEVER returns the legacy defaultModel, at any rung', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    await manager.updateConfig({ defaultModel: 'legacy-assistant-model' });
    expect(manager.getDefaultModel()).toBe('legacy-assistant-model');
    expect(manager.getDefaultLaunchModel('quick')).toBe(DEFAULT_RUN_TYPE_MODEL_FLOORS.quick);
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe(
      DEFAULT_RUN_TYPE_MODEL_FLOORS.workflow,
    );

    // Still ignored once the launch global exists — and setting the launch global
    // must not disturb the legacy field the assistant reads.
    await manager.updateConfig({ defaultLaunchModel: 'sonnet' });
    expect(manager.getDefaultLaunchModel('quick')).toBe('sonnet');
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe('sonnet');
    expect(manager.getDefaultModel()).toBe('legacy-assistant-model');
  });

  it('a blank defaultLaunchModel falls through to the floor rather than launching an empty model', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    await manager.updateConfig({ defaultLaunchModel: '   ' });
    expect(manager.getDefaultLaunchModel('quick')).toBe(DEFAULT_RUN_TYPE_MODEL_FLOORS.quick);
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe(
      DEFAULT_RUN_TYPE_MODEL_FLOORS.workflow,
    );
  });

  it('getDefaultLaunchAgentRuntime: per-type override → defaultAgentRuntime → undefined (no floor)', async () => {
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    expect(manager.getDefaultAgentRuntime()).toBeUndefined();
    expect(manager.getDefaultLaunchAgentRuntime('quick')).toBeUndefined();
    expect(manager.getDefaultLaunchAgentRuntime('workflow:flow-a')).toBeUndefined();

    await manager.updateConfig({ defaultAgentRuntime: 'claude-interactive' });
    expect(manager.getDefaultLaunchAgentRuntime('quick')).toBe('claude-interactive');
    expect(manager.getDefaultLaunchAgentRuntime('workflow:flow-a')).toBe('claude-interactive');

    await manager.updateConfig({ runTypeDefaults: { quick: { agentRuntime: 'codex-pty' } } });
    expect(manager.getDefaultLaunchAgentRuntime('quick')).toBe('codex-pty');
    expect(manager.getDefaultLaunchAgentRuntime('workflow:flow-a')).toBe('claude-interactive');
  });

  it('floors a hand-edited invalid defaultAgentRuntime to undefined', async () => {
    await fs.writeFile(
      path.join(tempDir, 'config.json'),
      JSON.stringify(
        { gitRepoPath: '/some/repo', defaultAgentRuntime: 'telepathy' },
        null,
        2,
      ),
    );
    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();

    // Stored raw (config.json is the user's file) but never handed to a launch.
    expect((manager.getConfig() as Record<string, unknown>).defaultAgentRuntime).toBe('telepathy');
    expect(manager.getDefaultAgentRuntime()).toBeUndefined();
    expect(manager.getDefaultLaunchAgentRuntime('quick')).toBeUndefined();
  });

  it('with both fields absent, nothing changes: no seeding, no config.json rewrite, same resolutions', async () => {
    // Neither field is seeded into the constructor defaults...
    const fresh = new ConfigManager('/tmp/test-git-path');
    expect(fresh.getConfig().defaultLaunchModel).toBeUndefined();
    expect(fresh.getConfig().defaultAgentRuntime).toBeUndefined();

    // ...and an existing config.json without them is left BYTE-IDENTICAL on load.
    const existing = JSON.stringify(
      {
        gitRepoPath: '/some/repo',
        defaultModel: 'sonnet',
        telemetry: {
          errorReportingEnabled: false,
          usageMetricsEnabled: false,
          installId: 'fixed-install-id',
        },
      },
      null,
      2,
    );
    const configPath = path.join(tempDir, 'config.json');
    await fs.writeFile(configPath, existing);

    const manager = new ConfigManager('/tmp/test-git-path');
    await manager.initialize();
    expect(await fs.readFile(configPath, 'utf8')).toBe(existing);

    expect(manager.getConfig().defaultLaunchModel).toBeUndefined();
    expect(manager.getConfig().defaultAgentRuntime).toBeUndefined();
    expect(manager.getDefaultLaunchModel('quick')).toBe(DEFAULT_RUN_TYPE_MODEL_FLOORS.quick);
    expect(manager.getDefaultLaunchModel('workflow:flow-a')).toBe(
      DEFAULT_RUN_TYPE_MODEL_FLOORS.workflow,
    );
    expect(manager.getDefaultLaunchAgentRuntime('quick')).toBeUndefined();
    expect(manager.getDefaultModel()).toBe('sonnet');
  });

  it('leaves the legacy defaultModel consumers alone (exactly one production getDefaultModel() call site)', async () => {
    const mainSrc = path.resolve(__dirname, '../..');
    const files = await productionSources(mainSrc);
    const callSites: string[] = [];
    for (const file of files) {
      if (file.endsWith(path.join('services', 'configManager.ts'))) continue; // the declaration
      const source = await fs.readFile(file, 'utf8');
      const hits = source.match(/getDefaultModel\(\)/g)?.length ?? 0;
      for (let i = 0; i < hits; i += 1) callSites.push(path.relative(mainSrc, file));
    }
    expect(callSites.sort()).toEqual([
      // The legacy panel-model backfill. The global assistant's Claude fallback
      // is the other consumer, but it now lives INSIDE ConfigManager
      // (getAssistantModelFor — per-provider, see ASSISTANT-CODEX-RUNTIME.md),
      // which this scan excludes as the declaration file.
      path.join('database', 'database.ts'),
    ]);
  });
});
