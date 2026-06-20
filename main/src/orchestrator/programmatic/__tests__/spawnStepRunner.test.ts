import { describe, it, expect, vi } from 'vitest';
import { SpawnStepRunner } from '../spawnStepRunner';
import type { ClaudeSpawnerLike, ClaudeSpawnerOptions } from '../../runExecutor';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext } from '../types';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}
const ctx: ControllerStepContext = { runId: 'r', phaseId: 'p', stepIndex: 0, attempt: 1 };

function makeSpawner(impl?: () => Promise<void>): ClaudeSpawnerLike {
  return {
    spawnCliProcess: vi.fn<(o: ClaudeSpawnerOptions) => Promise<void>>(impl ?? (() => Promise.resolve())),
    abort: vi.fn<(p: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

const opts = {
  panelId: 'r',
  sessionId: 'r',
  runId: 'r',
  worktreePath: '/wt',
  workflowName: 'planner',
  agentPermissionMode: 'auto' as const,
};

describe('SpawnStepRunner', () => {
  it('returns ok and spawns a scoped per-step turn when the turn drains cleanly', async () => {
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'epics', agent: 'epics' }), ctx);

    expect(result.status).toBe('ok');
    expect(spawner.spawnCliProcess).toHaveBeenCalledOnce();
    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.panelId).toBe('r');
    expect(passed.worktreePath).toBe('/wt');
    expect(passed.agentPermissionMode).toBe('auto');
    expect(passed.prompt).toContain('`epics`'); // the step-scoped prompt
  });

  it('returns failed (not throws) when the spawned turn rejects, carrying the error', async () => {
    const spawner = makeSpawner(() => Promise.reject(new Error('turn aborted')));
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), ctx);

    expect(result.status).toBe('failed');
    expect(result.error).toBe('turn aborted');
  });

  it('omits agentPermissionMode from the spawn when none is bound', async () => {
    const spawner = makeSpawner();
    const noMode = { panelId: 'r', sessionId: 'r', runId: 'r', worktreePath: '/wt', workflowName: 'planner' };
    const runner = new SpawnStepRunner(spawner, noMode);

    await runner.runStep(step({ id: 'a' }), ctx);

    const passed = (spawner.spawnCliProcess as ReturnType<typeof vi.fn>).mock.calls[0][0] as ClaudeSpawnerOptions;
    expect(passed.agentPermissionMode).toBeUndefined();
  });

  // ── cancellation: SDK abort resolves the spawn cleanly, so a resolved spawn
  //    under an aborted signal must map to 'aborted', NOT 'ok' (fix #5/#3/#14) ──
  it('returns aborted (not ok) when the signal fired during a cleanly-resolving spawn', async () => {
    const ac = new AbortController();
    // The spawn "resolves cleanly" (SDK treats a canceled turn as a clean drain),
    // but the signal aborted meanwhile.
    const spawner = makeSpawner(() => {
      ac.abort();
      return Promise.resolve();
    });
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
  });

  it('short-circuits to aborted without spawning when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const spawner = makeSpawner();
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
    expect(spawner.spawnCliProcess).not.toHaveBeenCalled();
  });

  it('maps a rejection under an aborted signal to aborted (not failed)', async () => {
    const ac = new AbortController();
    const spawner = makeSpawner(() => {
      ac.abort();
      return Promise.reject(new Error('killed'));
    });
    const runner = new SpawnStepRunner(spawner, opts);

    const result = await runner.runStep(step({ id: 'a' }), { ...ctx, signal: ac.signal });

    expect(result.status).toBe('aborted');
  });
});
