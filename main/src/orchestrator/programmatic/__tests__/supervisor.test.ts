import { describe, it, expect } from 'vitest';
import { NoopSupervisor, ReviewQueueSupervisor, type SupervisorSession } from '../supervisor';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}

describe('NoopSupervisor', () => {
  it("triages every failure to 'fail' (byte-identical Stages 1-2 default)", async () => {
    const s: SupervisorSession = new NoopSupervisor();
    await s.start({ runId: 'r', projectId: 1, workflowName: 'planner', worktreePath: '/wt' });
    s.notify({ kind: 'step-failed', runId: 'r', stepId: 'a' });
    expect(await s.triage({ step: step({ id: 'a' }), error: 'boom' })).toBe('fail');
    await s.stop();
  });
});

describe('ReviewQueueSupervisor', () => {
  it("triages a failure to 'escalate' (routes it to the human review queue)", async () => {
    const s = new ReviewQueueSupervisor();
    await s.start({ runId: 'r', projectId: 1, workflowName: 'planner', worktreePath: '/wt' });
    expect(await s.triage({ step: step({ id: 'a' }), error: 'boom' })).toBe('escalate');
    await s.stop();
  });

  it('start/notify/stop never throw without a logger', async () => {
    const s = new ReviewQueueSupervisor();
    await expect(s.start({ runId: 'r', projectId: 1, workflowName: 'planner', worktreePath: '/wt' })).resolves.toBeUndefined();
    expect(() => s.notify({ kind: 'run-finished', runId: 'r', outcome: 'completed' })).not.toThrow();
    await expect(s.stop()).resolves.toBeUndefined();
  });
});
