/**
 * DefaultProgrammaticRunner for a run whose `workflow_runs.host_id` names a REMOTE environment (spec M2 §5 D3):
 * lane build slots and environment actions run through the injected RunHostAccess, the lane env is the remote slot
 * dir, the monitor is told its worktree is remote — and This Mac's git, exclude writer, mkdir and tool exec are
 * never called (spied). Without host access a remote run gets no slots / actions rather than local ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => ({
  runGitExit: vi.fn(),
  runToolCapture: vi.fn(),
  ensureGitExcludeEntries: vi.fn(),
  mkdir: vi.fn(),
}));
vi.mock('../../../utils/runGit', async (orig) => {
  const real = await orig<typeof import('../../../utils/runGit')>();
  return {
    ...real,
    runGitExit: local.runGitExit.mockImplementation(real.runGitExit),
    runToolCapture: local.runToolCapture.mockImplementation(real.runToolCapture),
  };
});
vi.mock('../../../utils/gitExcludeWriter', async (orig) => {
  const real = await orig<typeof import('../../../utils/gitExcludeWriter')>();
  return { ...real, ensureGitExcludeEntries: local.ensureGitExcludeEntries.mockImplementation(real.ensureGitExcludeEntries) };
});
vi.mock('fs/promises', async (orig) => {
  const real = await orig<typeof import('fs/promises')>();
  return { ...real, mkdir: local.mkdir.mockImplementation(real.mkdir) };
});

import { DefaultProgrammaticRunner } from '../defaultProgrammaticRunner';
import { LANE_BUILD_SLOTS_KILL_SWITCH_ENV } from '../laneBuildSlots';
import { ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV } from '../environmentActions';
import type { MonitorContext, MonitorSession } from '../monitor';
import type { StepReporter } from '../programmaticRunHost';
import type { FanOutDriver } from '../types';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions, ProgrammaticRunContext } from '../../runExecutor';
import type { RunHostAccess } from '../../trpc/contracts/runHostAccess';
import type { WorkflowDefinition, WorkflowRow, WorkflowRunRow } from '../../../../../shared/types/workflows';
import { fakeRunWorktreeHost, type FakeRunWorktreeHost } from './fakeRunWorktreeHost';

const WT = '/home/k/cf-remote/h1/wt/s1';

const fanOutDef: WorkflowDefinition = {
  id: 'd',
  phases: [
    {
      id: 'p',
      label: 'P',
      color: '#3b6dd6',
      steps: [
        {
          id: 'a',
          name: 'A',
          agent: 'executor',
          mcps: [],
          retries: 0,
          fanOut: { over: 'tasks', inner: [{ id: 'impl', agent: 'executor', name: 'Impl' }] },
        },
      ],
    },
  ],
};

function ctx(hostId: string | null): ProgrammaticRunContext {
  const workflow: WorkflowRow = {
    id: 'wf',
    project_id: 1,
    name: 'custom',
    workflow_path: null,
    permission_mode: 'default',
    spec_json: JSON.stringify(fanOutDef),
    tuning_level: 'standard',
    runtime_mix: 'claude',
    created_at: 'now',
    archived_at: null,
  };
  const run: WorkflowRunRow = {
    id: 'run-1',
    workflow_id: 'wf',
    project_id: 1,
    status: 'running',
    permission_mode_snapshot: 'auto',
    worktree_path: WT,
    branch_name: null,
    created_at: 'now',
    updated_at: 'now',
    batch_id: 'batch-9',
    host_id: hostId,
  };
  return {
    runId: 'run-1',
    panelId: 'run-1',
    sessionId: 'run-1',
    worktreePath: WT,
    run,
    workflow,
    agentPermissionMode: 'auto',
    signal: new AbortController().signal,
    injectEvent: () => {},
  };
}

function remoteHost(): FakeRunWorktreeHost {
  return fakeRunWorktreeHost({
    files: {
      [`${WT}/pnpm-lock.yaml`]: '',
      [`${WT}/package.json`]: JSON.stringify({ dependencies: { a: '1' } }),
    },
  });
}

async function runLane(
  hostId: string | null,
  access: RunHostAccess | undefined,
): Promise<{ lane: ClaudeSpawnerOptions; monitorCtx: MonitorContext | undefined }> {
  const spawner: ClaudeSpawnerLike = {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<void>>(() => Promise.resolve()),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
  const reporter: StepReporter = { report: vi.fn() };
  const driver: FanOutDriver = { resolveItems: vi.fn(() => ['task-1']), driveLane: vi.fn() };
  let monitorCtx: MonitorContext | undefined;
  const runner = new DefaultProgrammaticRunner({
    spawner,
    reporter,
    gate: { resolve: vi.fn().mockResolvedValue('approve') },
    fanOutDriverFactory: () => driver,
    monitorFactory: (c): MonitorSession => {
      monitorCtx = c;
      return { triage: vi.fn().mockResolvedValue({ decision: 'escalate', rationale: '' }), answer: vi.fn().mockResolvedValue('') };
    },
    ...(access ? { runHostAccess: access } : {}),
  });
  await runner.run(ctx(hostId));
  const lane = vi.mocked(spawner.spawnCliProcess).mock.calls.map(([o]) => o).find((o) => o.agentInvocationStepId === 'impl');
  if (!lane) throw new Error('the fan-out lane step never spawned');
  return { lane, monitorCtx };
}

const saved = {
  slots: process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV],
  env: process.env[ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV],
};
beforeEach(() => {
  delete process.env[LANE_BUILD_SLOTS_KILL_SWITCH_ENV];
  delete process.env[ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV];
  for (const fn of Object.values(local)) fn.mockClear();
});
afterEach(() => {
  for (const [key, value] of [
    [LANE_BUILD_SLOTS_KILL_SWITCH_ENV, saved.slots],
    [ENVIRONMENT_ACTIONS_KILL_SWITCH_ENV, saved.env],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function expectNoLocalCalls(): void {
  expect(local.runGitExit).not.toHaveBeenCalled();
  expect(local.runToolCapture).not.toHaveBeenCalled();
  expect(local.ensureGitExcludeEntries).not.toHaveBeenCalled();
  expect(local.mkdir).not.toHaveBeenCalled();
}

describe('DefaultProgrammaticRunner — remote run', () => {
  it('binds lane build slots and environment actions to the run host, never This Mac', async () => {
    const host = remoteHost();
    const forHost = vi.fn(() => host);

    const { lane, monitorCtx } = await runLane('h1', { forHost });

    expect(forHost).toHaveBeenCalledWith('h1');
    const slot = `${WT}/.cyboflow/build-slots/slot-0`;
    expect(lane.laneEnv).toEqual({
      CYBOFLOW_LANE_SCRATCH_DIR: slot,
      CLANG_MODULE_CACHE_PATH: `${slot}/clang-module-cache`,
      SWIFTPM_MODULECACHE_OVERRIDE: `${slot}/clang-module-cache`,
    });
    expect(host.gitExit).toHaveBeenCalledWith(WT, ['check-ignore', '-q', '--', '.cyboflow/build-slots/'], { timeoutMs: 15_000 });
    expect(host.mkdirp).toHaveBeenCalledWith(slot);
    // The fan-out preflight found the remote worktree missing node_modules and installed there.
    expect(host.execIn).toHaveBeenCalledWith(WT, 'pnpm', ['install', '--frozen-lockfile'], { timeoutMs: 15 * 60 * 1000 });
    expect(monitorCtx).toEqual({ runId: 'run-1', projectId: 1, workflowName: 'custom', worktreePath: WT, remoteWorktree: true });
    expectNoLocalCalls();
  });

  it('gives a remote run no slots and no actions without host access — never a local fallback', async () => {
    const { lane } = await runLane('h1', undefined);
    expect('laneEnv' in lane).toBe(false);
    expectNoLocalCalls();
  });

  it("a local run (host 'local') never consults host access", async () => {
    const forHost = vi.fn(() => remoteHost());
    const { monitorCtx } = await runLane('local', { forHost });
    expect(forHost).not.toHaveBeenCalled();
    expect(monitorCtx).toEqual({ runId: 'run-1', projectId: 1, workflowName: 'custom', worktreePath: WT });
    // The local path really ran (and failed softly: WT does not exist on this Mac).
    expect(local.ensureGitExcludeEntries).toHaveBeenCalled();
  });
});
