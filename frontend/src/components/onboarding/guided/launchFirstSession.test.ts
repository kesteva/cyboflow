/**
 * launchFirstSession — the guided step-13 launcher for the Planner/Ship flow
 * kinds. Mocks the same three seams useTaskRunLauncher's tests mock (trpc,
 * ensureSessionForLaunch, telemetry) plus resolveLaunchDefaults itself (kept
 * as a fixed stub — its own ladder is covered by useTaskRunLauncher's tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const workflowsListQuery = vi.fn();
const runsStartMutate = vi.fn();
const ensureSessionForLaunch = vi.fn();
const trackEvent = vi.fn();
const resolveLaunchDefaults = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      workflows: { list: { query: (...a: unknown[]) => workflowsListQuery(...a) } },
      runs: { start: { mutate: (...a: unknown[]) => runsStartMutate(...a) } },
    },
  },
}));

vi.mock('../../../utils/ensureSessionForLaunch', () => ({
  ensureSessionForLaunch: (...a: unknown[]) => ensureSessionForLaunch(...a),
}));

vi.mock('../../../utils/telemetry', () => ({
  trackEvent: (...a: unknown[]) => trackEvent(...a),
}));

vi.mock('../../Backlog/useTaskRunLauncher', () => ({
  resolveLaunchDefaults: (...a: unknown[]) => resolveLaunchDefaults(...a),
  MAX_PLANNER_SEED_IDEAS: 4,
}));

import { launchFirstFlow, MAX_PLANNER_SEED_IDEAS } from './launchFirstSession';

const DEFAULTS = { model: 'opus', permissionMode: 'auto' as const, substrate: 'sdk' as const };

describe('launchFirstSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workflowsListQuery.mockResolvedValue([
      { id: 'wf-planner', name: 'planner' },
      { id: 'wf-ship', name: 'ship' },
      { id: 'wf-sprint', name: 'sprint' },
    ]);
    ensureSessionForLaunch.mockResolvedValue('session-1');
    resolveLaunchDefaults.mockReturnValue(DEFAULTS);
    runsStartMutate.mockResolvedValue({ runId: 'run-1' });
  });

  it('re-exports MAX_PLANNER_SEED_IDEAS from useTaskRunLauncher', () => {
    expect(MAX_PLANNER_SEED_IDEAS).toBe(4);
  });

  it('planner resolves the planner workflow by name and passes truncated ideaIds + defaults', async () => {
    const result = await launchFirstFlow({
      kind: 'planner',
      projectId: 7,
      ideaIds: ['i1', 'i2', 'i3', 'i4', 'i5'],
      permissionMode: 'auto',
    });

    expect(workflowsListQuery).toHaveBeenCalledWith({ projectId: 7 });
    expect(resolveLaunchDefaults).toHaveBeenCalledWith('wf-planner', 'auto');
    expect(runsStartMutate).toHaveBeenCalledWith({
      workflowId: 'wf-planner',
      projectId: 7,
      sessionId: 'session-1',
      ideaIds: ['i1', 'i2', 'i3', 'i4'],
      ...DEFAULTS,
    });
    expect(result).toEqual({ kind: 'planner', sessionId: 'session-1', runId: 'run-1' });
  });

  it('planner with no ideas omits ideaIds entirely', async () => {
    await launchFirstFlow({ kind: 'planner', projectId: 7, ideaIds: [], permissionMode: 'auto' });

    const payload = runsStartMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('ideaIds');
    expect(payload).toMatchObject({ workflowId: 'wf-planner', projectId: 7, sessionId: 'session-1' });
  });

  it('ship passes the singular ideaId and no ideaIds', async () => {
    const result = await launchFirstFlow({
      kind: 'ship',
      projectId: 7,
      ideaIds: ['i1'],
      permissionMode: 'default',
    });

    expect(resolveLaunchDefaults).toHaveBeenCalledWith('wf-ship', 'default');
    const payload = runsStartMutate.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      workflowId: 'wf-ship',
      projectId: 7,
      sessionId: 'session-1',
      ideaId: 'i1',
    });
    expect(payload).not.toHaveProperty('ideaIds');
    expect(result).toEqual({ kind: 'ship', sessionId: 'session-1', runId: 'run-1' });
  });

  it('ship with no ideas rejects and never calls runs.start', async () => {
    await expect(
      launchFirstFlow({ kind: 'ship', projectId: 7, ideaIds: [], permissionMode: 'default' }),
    ).rejects.toThrow('Pick one idea to ship');
    expect(runsStartMutate).not.toHaveBeenCalled();
  });

  it('rejects with the flow name in the message when the workflow is missing', async () => {
    workflowsListQuery.mockResolvedValue([{ id: 'wf-sprint', name: 'sprint' }]);
    await expect(
      launchFirstFlow({ kind: 'planner', projectId: 7, ideaIds: [], permissionMode: 'auto' }),
    ).rejects.toThrow('planner');
    expect(ensureSessionForLaunch).not.toHaveBeenCalled();
  });

  it('fires workflow_run_started with launch_surface onboarding', async () => {
    await launchFirstFlow({ kind: 'ship', projectId: 7, ideaIds: ['i1'], permissionMode: 'auto' });
    expect(trackEvent).toHaveBeenCalledWith('workflow_run_started', {
      launch_surface: 'onboarding',
      flow: 'ship',
    });
  });
});
