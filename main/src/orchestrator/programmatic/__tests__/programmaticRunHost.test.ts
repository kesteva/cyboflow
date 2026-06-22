import { describe, it, expect, vi } from 'vitest';
import { ProgrammaticRunHost, type StepReporter } from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import type { MonitorSession } from '../monitor';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { ControllerStepContext, FanOutDriver } from '../types';

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

/** A fake ON-DEMAND monitor: triage returns a canned verdict; answer is unused here. */
function makeMonitor(
  decision: 'retry' | 'escalate' | 'fail',
  rationale = 'because',
): MonitorSession & { triage: ReturnType<typeof vi.fn> } {
  return {
    triage: vi.fn().mockResolvedValue({ decision, rationale }),
    answer: vi.fn().mockResolvedValue(''),
  };
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

  // ── Triage seam: ON-DEMAND monitor (monitor-unify) ──────────────────────────
  it('routes triageFailure to monitor.triage and returns its decision', async () => {
    const monitor = makeMonitor('retry');
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor });

    const decision = await host.triageFailure(step({ id: 'a' }), ctx, 'boom');

    expect(decision).toBe('retry');
    expect(monitor.triage).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'boom', ctx.signal);
  });

  it('injects the monitor rationale into the run stream as an assistant turn on triage', async () => {
    const monitor = makeMonitor('escalate', 'looks ambiguous; a human should decide');
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      injectEvent: (e) => injected.push(e),
    });

    await host.triageFailure(step({ id: 'a', name: 'Build epics' }), ctx, 'boom');

    expect(injected).toHaveLength(1);
    const ev = injected[0];
    expect('type' in ev && ev.type === 'assistant').toBe(true);
    // The injected assistant turn carries the triage decision + rationale text.
    const text =
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content
            .map((b) => (b.type === 'text' ? b.text : ''))
            .join('')
        : '';
    expect(text).toContain('Build epics');
    expect(text).toContain('escalate');
    expect(text).toContain('looks ambiguous');
  });

  it("defaults triageFailure to 'escalate' when no monitor is wired (review-queue default)", async () => {
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(await host.triageFailure(step({ id: 'a' }), ctx, undefined)).toBe('escalate');
  });

  it("is fail-soft — a throwing monitor.triage defaults to 'escalate' and does not abort the walk", async () => {
    const monitor: MonitorSession = {
      triage: vi.fn().mockRejectedValue(new Error('triage boom')),
      answer: vi.fn().mockResolvedValue(''),
    };
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor });

    expect(await host.triageFailure(step({ id: 'a' }), ctx, undefined)).toBe('escalate');
  });

  it('is fail-soft when injectEvent throws on a triage turn (a broken stream must not abort the walk)', async () => {
    const monitor = makeMonitor('retry');
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      injectEvent: () => {
        throw new Error('inject boom');
      },
    });

    // The inject throw is swallowed; the monitor's decision still returns.
    await expect(host.triageFailure(step({ id: 'a' }), ctx, 'boom')).resolves.toBe('retry');
  });

  it('forwards recordStepResult to the recorder with the bound runId (migration 032)', () => {
    const recordStepResult = vi.fn();
    const host = new ProgrammaticRunHost({ runId: 'run-9', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), recordStepResult });

    host.recordStepResult({ stepId: 'epics', phaseId: 'refine', outcome: 'done', attempts: 2 });

    expect(recordStepResult).toHaveBeenCalledWith('run-9', expect.objectContaining({ stepId: 'epics', outcome: 'done', attempts: 2 }));
  });

  it('recordStepResult is fail-soft (a throwing recorder does not abort the walk) and a no-op when unset', () => {
    const throwing = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      recordStepResult: () => { throw new Error('db down'); },
    });
    expect(() => throwing.recordStepResult({ stepId: 'a', phaseId: 'p', outcome: 'failed', attempts: 1 })).not.toThrow();

    const none = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(() => none.recordStepResult({ stepId: 'a', phaseId: 'p', outcome: 'done', attempts: 1 })).not.toThrow();
  });

  // ── Fan-out lane driver (generalize-parallel-fan-out) ───────────────────────
  it('exposes the injected fan-out driver on host.fanOut', () => {
    const fanOutDriver: FanOutDriver = {
      resolveItems: vi.fn(() => ['t1', 't2']),
      driveLane: vi.fn(),
    };
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), fanOutDriver });

    expect(host.fanOut).toBe(fanOutDriver);
    // And it is callable through the host (the controller resolves items via it).
    expect(host.fanOut?.resolveItems('r', 'tasks')).toEqual(['t1', 't2']);
  });

  it('host.fanOut is undefined when no driver is injected (the controller never fans out)', () => {
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(host.fanOut).toBeUndefined();
  });
});
