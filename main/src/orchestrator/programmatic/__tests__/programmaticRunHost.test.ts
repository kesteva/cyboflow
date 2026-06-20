import { describe, it, expect, vi } from 'vitest';
import { ProgrammaticRunHost, type StepReporter } from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext } from '../types';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'human', mcps: [], retries: 0, ...p };
}
const ctx: ControllerStepContext = { runId: 'r', phaseId: 'p', stepIndex: 0, attempt: 1 };

function makeReporter(): StepReporter & { report: ReturnType<typeof vi.fn> } {
  return { report: vi.fn() };
}
function makeGate(decision: 'approve' | 'reject' | 'revise'): HumanGateResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn().mockResolvedValue(decision) };
}

describe('ProgrammaticRunHost', () => {
  it('forwards reportStep to the reporter with the bound runId', () => {
    const reporter = makeReporter();
    const host = new ProgrammaticRunHost({ runId: 'run-9', projectId: 1, reporter, gate: makeGate('approve') });

    host.reportStep('epics', 'running');

    expect(reporter.report).toHaveBeenCalledWith('run-9', 'epics', 'running');
  });

  it('is fail-soft when the reporter throws (a broken timeline must not abort the walk)', () => {
    const reporter: StepReporter = {
      report: vi.fn(() => {
        throw new Error('emit boom');
      }),
    };
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter, gate: makeGate('approve') });

    expect(() => host.reportStep('a', 'done')).not.toThrow();
  });

  it('delegates requestHumanGate to the gate resolver with run + project + step', async () => {
    const gate = makeGate('reject');
    const host = new ProgrammaticRunHost({ runId: 'run-9', projectId: 7, reporter: makeReporter(), gate });

    const decision = await host.requestHumanGate(step({ id: 'approve-plan' }), ctx);

    expect(decision).toBe('reject');
    expect(gate.resolve).toHaveBeenCalledWith({
      runId: 'run-9',
      projectId: 7,
      step: expect.objectContaining({ id: 'approve-plan' }),
    });
  });
});
