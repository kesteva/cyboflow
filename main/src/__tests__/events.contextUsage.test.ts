import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPanel } from '../../../shared/types/panels';
import type { AppServices } from '../ipc/types';
import type { SessionOutput } from '../types/session';

const { getPanelMock, updatePanelMock, getPanelsForSessionMock } = vi.hoisted(() => ({
  getPanelMock: vi.fn(),
  updatePanelMock: vi.fn(),
  getPanelsForSessionMock: vi.fn(),
}));

vi.mock('../services/panelManager', () => ({
  panelManager: {
    getPanel: getPanelMock,
    updatePanel: updatePanelMock,
    getPanelsForSession: getPanelsForSessionMock,
  },
}));

vi.mock('../utils/sessionValidation', () => ({
  validateSessionExists: vi.fn(() => ({ valid: true })),
  validateEventContext: vi.fn(() => ({ valid: true })),
  validatePanelEventContext: vi.fn(() => ({ valid: true })),
  logValidationFailure: vi.fn(),
}));

vi.mock('../ipc/logs', () => ({
  addSessionLog: vi.fn(),
}));

import { setupEventListeners } from '../events';

interface ExitPayload {
  panelId?: string;
  sessionId: string;
  exitCode: number;
  signal: string;
}

type ManagerListener = (payload: unknown) => unknown;
type ExitListener = (payload: ExitPayload) => Promise<void>;

function jsonOutput(sessionId: string, panelId: string, data: Record<string, unknown>): SessionOutput {
  return {
    sessionId,
    panelId,
    type: 'json',
    data,
    timestamp: new Date(),
  };
}

function turnOutputs(
  sessionId: string,
  panelId: string,
  cacheReadInputTokens: number,
): SessionOutput[] {
  return [
    jsonOutput(sessionId, panelId, {
      type: 'assistant',
      message: {
        usage: {
          input_tokens: 1_000,
          cache_read_input_tokens: cacheReadInputTokens,
          cache_creation_input_tokens: 1_000,
        },
      },
    }),
    jsonOutput(sessionId, panelId, {
      type: 'result',
      modelUsage: {
        'claude-opus-4-8': { contextWindow: 200_000 },
      },
    }),
  ];
}

function makeHarness(initialOutputs: SessionOutput[]) {
  const listeners = new Map<string, ManagerListener[]>();
  let outputs = initialOutputs;

  const continuePanel = vi.fn().mockResolvedValue(undefined);
  const managerOn = vi.fn((event: string, listener: ManagerListener) => {
    const registered = listeners.get(event) ?? [];
    registered.push(listener);
    listeners.set(event, registered);
  });
  const getPanelOutputs = vi.fn(() => outputs);
  const refreshSessionGitStatus = vi.fn().mockResolvedValue(undefined);

  const services = {
    claudeCodeManager: {
      on: managerOn,
      continuePanel,
    },
    sessionManager: {
      on: vi.fn(),
      getPanelOutputs,
      // Skip the unrelated post-exit git summary branch.
      getSession: vi.fn(() => null),
    },
    executionTracker: {},
    runCommandManager: { on: vi.fn() },
    gitDiffManager: {},
    gitStatusManager: {
      on: vi.fn(),
      refreshSessionGitStatus,
    },
    worktreeManager: {},
    databaseService: {},
  } as unknown as AppServices;

  setupEventListeners(services, () => null);

  // setupEventListeners registers the generic lifecycle listener first and the
  // quick-session context refresh listener second. Drive the latter directly so
  // this test stays focused on the hidden-probe regression.
  const exitListener = listeners.get('exit')?.at(-1) as ExitListener | undefined;
  if (!exitListener) {
    throw new Error('Expected the Claude exit listener to be registered');
  }

  return {
    continuePanel,
    exitListener,
    getPanelOutputs,
    refreshSessionGitStatus,
    setOutputs(next: SessionOutput[]): void {
      outputs = next;
    },
  };
}

describe('Claude exit context refresh', () => {
  const sessionId = 'session-context-meter';
  const panelId = 'panel-context-meter';
  let panel: ToolPanel;

  beforeEach(() => {
    vi.clearAllMocks();
    panel = {
      id: panelId,
      sessionId,
      type: 'claude',
      title: 'Chat',
      state: {
        isActive: true,
        customState: {
          permissionMode: 'approve',
          panelStatus: 'stopped',
          contextUsage: null,
        },
      },
      metadata: {
        createdAt: '2026-07-21T00:00:00.000Z',
        lastActiveAt: '2026-07-21T00:00:00.000Z',
        position: 0,
      },
    };
    getPanelMock.mockImplementation(() => panel);
    getPanelsForSessionMock.mockReturnValue([panel]);
    updatePanelMock.mockImplementation(async (_id: string, updates: Partial<ToolPanel>) => {
      if (updates.state) panel.state = updates.state;
    });
  });

  it('persists inline SDK usage without launching a hidden /context continuation', async () => {
    const harness = makeHarness(turnOutputs(sessionId, panelId, 52_000));

    await harness.exitListener({ panelId, sessionId, exitCode: 0, signal: '' });

    expect(harness.getPanelOutputs).toHaveBeenCalledWith(panelId, 200);
    expect(updatePanelMock).toHaveBeenCalledTimes(1);
    expect(panel.state.customState).toMatchObject({
      permissionMode: 'approve',
      panelStatus: 'stopped',
      contextUsage: '54k/200k tokens (27%)',
    });
    expect(harness.continuePanel).not.toHaveBeenCalled();
    expect(harness.refreshSessionGitStatus).toHaveBeenCalledWith(sessionId);
  });

  it('handles back-to-back turn exits without an auto-context probe or mutex contention', async () => {
    const harness = makeHarness(turnOutputs(sessionId, panelId, 18_000));
    const firstExit = harness.exitListener({ panelId, sessionId, exitCode: 0, signal: '' });

    harness.setOutputs(turnOutputs(sessionId, panelId, 78_000));
    const queuedExit = harness.exitListener({ panelId, sessionId, exitCode: 0, signal: '' });

    await Promise.all([firstExit, queuedExit]);

    expect(harness.continuePanel).not.toHaveBeenCalled();
    expect(updatePanelMock).toHaveBeenCalledTimes(2);
    expect(panel.state.customState).toMatchObject({
      permissionMode: 'approve',
      panelStatus: 'stopped',
      contextUsage: '80k/200k tokens (40%)',
    });
    expect(vi.mocked(console.error).mock.calls).not.toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.stringContaining('automatic context usage')]),
      ]),
    );
  });
});
