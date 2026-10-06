/**
 * TASK-155: pins the Claude-panel model fallback site (claude-panels:get-model)
 * to configManager.getDefaultLaunchModel('quick') instead of getDefaultModel().
 *
 * getDefaultModel()'s floor ('sonnet') is not the Quick Session floor — these
 * are exactly the quick-session-launch surface a per-type model default
 * targets, so leaving them on getDefaultModel() produced a split-brain
 * default between this IPC path and the renderer's quick-session launcher.
 *
 * Uses a real ConfigManager (temp cyboflow dir) rather than a hand-typed mock
 * so the assertions track ConfigManager's actual getDefaultLaunchModel
 * behavior instead of a hardcoded guess about its floor value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'node:events';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/path'),
    getName: vi.fn(() => 'Cyboflow'),
    getVersion: vi.fn(() => '0.1.0'),
  },
}));

const panel = {
  id: 'panel-1',
  sessionId: 'session-1',
  type: 'claude' as const,
  title: 'Chat',
  substrate: 'interactive' as const,
  state: { isActive: true, customState: {} },
  metadata: { createdAt: '', lastActiveAt: '', position: 1 },
};

vi.mock('../../services/panelManager', () => ({
  panelManager: {
    getPanel: vi.fn(() => panel),
    getAllPanels: vi.fn(() => []),
    getPanelsForSession: vi.fn(() => [panel]),
    updatePanel: vi.fn(async () => {}),
  },
}));

import { registerClaudePanelHandlers } from '../claudePanel';
import type { AppServices } from '../types';
import { panelManager } from '../../services/panelManager';
import { ConfigManager } from '../../services/configManager';
import { setCyboflowDirectory } from '../../utils/cyboflowDirectory';

type Handler = (...args: unknown[]) => Promise<unknown>;

function makeHandlerCapture() {
  const handlers = new Map<string, Handler>();
  const ipcMain = { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) };
  return { ipcMain, handlers };
}

function invoke(handlers: Map<string, Handler>, channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({} as unknown, ...args);
}

function makeCliManager() {
  return Object.assign(new EventEmitter(), {
    startPanel: vi.fn(async () => {}),
    continuePanel: vi.fn(async () => {}),
    stopPanel: vi.fn(async () => {}),
  });
}

function makeServices(
  configManager: ConfigManager,
  sdkManager: ReturnType<typeof makeCliManager>,
  interactiveManager: ReturnType<typeof makeCliManager>,
  panelSettings: Record<string, unknown>,
  dbSession: Record<string, unknown> = { substrate: 'sdk' },
): AppServices {
  return {
    sessionManager: {
      getSession: vi.fn(() => ({ id: 'session-1', worktreePath: '/tmp/session-1' })),
      getDbSession: vi.fn(() => dbSession),
      getPanelConversationMessages: vi.fn(() => []),
      addPanelConversationMessage: vi.fn(),
      getPanelOutputs: vi.fn(() => []),
    },
    databaseService: {
      getActivePanels: vi.fn(() => []),
      getPanelSettings: vi.fn(() => panelSettings),
      updatePanelSettings: vi.fn(),
    },
    configManager,
    claudeCodeManager: sdkManager,
    interactiveCliManager: interactiveManager,
  } as unknown as AppServices;
}

let tempDir: string;
let configManager: ConfigManager;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(panelManager.getPanel).mockReturnValue(panel);
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cyboflow-claude-panel-model-default-'));
  setCyboflowDirectory(tempDir);
  configManager = new ConfigManager();
  await configManager.initialize();
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('claude-panels model fallback site resolves via getDefaultLaunchModel(\'quick\')', () => {
  it('get-model floors to getDefaultLaunchModel(\'quick\') with nothing configured', async () => {
    // Confirm this floor differs from getDefaultModel()'s 'sonnet' floor, so the
    // assertion below is meaningfully pinned to the launch-kind resolver.
    expect(configManager.getDefaultLaunchModel('quick')).not.toBe(configManager.getDefaultModel());

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe(configManager.getDefaultLaunchModel('quick'));
  });

  it('get-model honors a stored quick run-type default over the floor', async () => {
    await configManager.updateConfig({ runTypeDefaults: { quick: { model: 'sonnet' } } });
    expect(configManager.getDefaultLaunchModel('quick')).toBe('sonnet');

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe('sonnet');
  });

  it('get-model prefers a stored panelSettings.model over the config floor', async () => {
    expect(configManager.getDefaultLaunchModel('quick')).not.toBe('sonnet');

    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, { model: 'sonnet' });
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe('sonnet');
  });

  // TASK-155 follow-up (onboarding restructure §0 "verified prerequisite"):
  // onboarding's Model step (step 3) can persist a Codex catalog id into the
  // GLOBAL `defaultLaunchModel` when Codex is the chosen default runtime. On a
  // Claude session that candidate must normalize to the Claude family (falling
  // back to DEFAULT_QUICK_MODEL, 'opus').
  it("get-model normalizes a Codex catalog id in the global launch model to opus on a Claude session", async () => {
    await configManager.updateConfig({ defaultLaunchModel: 'gpt-5.2-codex' });
    expect(configManager.getDefaultLaunchModel('quick')).toBe('gpt-5.2-codex');

    const services = makeServices(configManager, makeCliManager(), makeCliManager(), {});
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe('opus');
  });

  it('get-model normalizes a Codex catalog id in stored panel settings to opus', async () => {
    const sdkManager = makeCliManager();
    const interactiveManager = makeCliManager();
    const services = makeServices(configManager, sdkManager, interactiveManager, { model: 'gpt-5.2-codex' });
    const { ipcMain, handlers } = makeHandlerCapture();

    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );

    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as {
      success: boolean;
      data: string;
    };

    expect(result.success).toBe(true);
    expect(result.data).toBe('opus');
  });
});

// Every provider's chat rides a 'claude'-typed panel and reads its model through
// claude-panels:get-model, so the normalization family must follow the panel's
// SESSION provider — not Claude's. Regression (2026-09-11): an OMP quick session
// launched on `openrouter/auto` showed an "opus" pill because the OMP id was
// normalized against Claude's family, dropped, and floored to DEFAULT_QUICK_MODEL.
describe('claude-panels:get-model normalizes against the panel session\'s provider', () => {
  function register(panelSettings: Record<string, unknown>, dbSession: Record<string, unknown>) {
    const services = makeServices(configManager, makeCliManager(), makeCliManager(), panelSettings, dbSession);
    const { ipcMain, handlers } = makeHandlerCapture();
    registerClaudePanelHandlers(
      ipcMain as unknown as Parameters<typeof registerClaudePanelHandlers>[0],
      services,
    );
    return handlers;
  }

  it('keeps an OMP <provider>/<model> selection on an omp-sdk session', async () => {
    const handlers = register({ model: 'openrouter/auto' }, { substrate: 'sdk', agent_runtime: 'omp-sdk' });
    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as { success: boolean; data: unknown };
    expect(result).toEqual({ success: true, data: 'openrouter/auto' });
  });

  it('keeps a Codex catalog id on a codex-sdk session', async () => {
    const handlers = register({ model: 'gpt-5.2-codex' }, { substrate: 'sdk', agent_runtime: 'codex-sdk' });
    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as { success: boolean; data: unknown };
    expect(result).toEqual({ success: true, data: 'gpt-5.2-codex' });
  });

  it('floors a stale Claude alias to Codex\'s auto on a codex-sdk session', async () => {
    const handlers = register({ model: 'opus' }, { substrate: 'sdk', agent_runtime: 'codex-sdk' });
    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as { success: boolean; data: unknown };
    expect(result).toEqual({ success: true, data: 'auto' });
  });

  it('resolves to no model (vendor default) on an omp-sdk session with nothing OMP-shaped stored', async () => {
    // The global quick default is a Claude alias; OMP has no model to floor to,
    // and an omitted model is what its spawn seam treats as "OMP's own default".
    const handlers = register({}, { substrate: 'sdk', agent_runtime: 'omp-sdk' });
    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as { success: boolean; data: unknown };
    expect(result).toEqual({ success: true, data: undefined });
  });

  it('still floors an OMP-shaped id to opus on a Claude session', async () => {
    const handlers = register({ model: 'openrouter/auto' }, { substrate: 'sdk', agent_runtime: 'claude-sdk' });
    const result = (await invoke(handlers, 'claude-panels:get-model', 'panel-1')) as { success: boolean; data: unknown };
    expect(result).toEqual({ success: true, data: 'opus' });
  });
});

describe('claudePanel.ts source guard: getDefaultModel() must not reappear at the fallback site', () => {
  it('has zero references to getDefaultModel() and exactly one to getDefaultLaunchModel(\'quick\')', async () => {
    const sourcePath = path.join(__dirname, '..', 'claudePanel.ts');
    const source = await fs.readFile(sourcePath, 'utf-8');

    const getDefaultModelHits = source.match(/getDefaultModel\(\)/g) ?? [];
    const getDefaultLaunchModelQuickHits = source.match(/getDefaultLaunchModel\('quick'\)/g) ?? [];

    expect(getDefaultModelHits).toHaveLength(0);
    expect(getDefaultLaunchModelQuickHits).toHaveLength(1);
  });
});
