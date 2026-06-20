import { describe, it, expect, vi } from 'vitest';
import { ProgrammaticRunHost, type StepReporter } from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import type { SupervisorSession } from '../supervisor';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext, SupervisorEvent } from '../types';

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
      signal: undefined,
    });
  });

  // ── Stage 3: supervisor forwarding ──────────────────────────────────────────
  function makeSupervisor(decision: 'retry' | 'escalate' | 'fail'): SupervisorSession & {
    events: SupervisorEvent[];
    triage: ReturnType<typeof vi.fn>;
  } {
    const events: SupervisorEvent[] = [];
    return {
      events,
      start: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn((e: SupervisorEvent) => events.push(e)),
      triage: vi.fn().mockResolvedValue(decision),
      stop: vi.fn().mockResolvedValue(undefined),
    };
  }

  it('forwards notify to the supervisor and routes triageFailure to supervisor.triage', async () => {
    const supervisor = makeSupervisor('escalate');
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), supervisor });

    host.notify({ kind: 'step-failed', runId: 'r', stepId: 'a', error: 'boom' });
    expect(supervisor.events).toHaveLength(1);

    const decision = await host.triageFailure(step({ id: 'a' }), ctx, 'boom');
    expect(decision).toBe('escalate');
    expect(supervisor.triage).toHaveBeenCalledWith({ step: expect.objectContaining({ id: 'a' }), error: 'boom' });
  });

  it("defaults triageFailure to 'fail' when no supervisor is wired (Stages 1-2 behavior)", async () => {
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(await host.triageFailure(step({ id: 'a' }), ctx, undefined)).toBe('fail');
    expect(() => host.notify({ kind: 'run-started', runId: 'r' })).not.toThrow();
  });

  it("is fail-soft — a throwing supervisor.triage defaults to 'fail', a throwing notify is swallowed", async () => {
    const supervisor: SupervisorSession = {
      start: vi.fn().mockResolvedValue(undefined),
      notify: vi.fn(() => {
        throw new Error('notify boom');
      }),
      triage: vi.fn().mockRejectedValue(new Error('triage boom')),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), supervisor });

    expect(() => host.notify({ kind: 'run-started', runId: 'r' })).not.toThrow();
    expect(await host.triageFailure(step({ id: 'a' }), ctx, undefined)).toBe('fail');
  });
});
