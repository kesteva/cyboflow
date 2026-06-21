import { describe, it, expect, vi } from 'vitest';
import {
  SdkSupervisorSession,
  SdkSupervisorAdvisor,
  buildSupervisorTriagePrompt,
  parseSupervisorAdvice,
  SUPERVISOR_TRIAGE_SCHEMA,
  type SupervisorAdvisor,
  type StructuredQueryFn,
} from '../sdkSupervisor';
import type { WorkflowStep } from '../../../../../shared/types/workflows';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}
const ctx = { runId: 'r', projectId: 1, workflowName: 'planner', worktreePath: '/wt' };

describe('parseSupervisorAdvice', () => {
  it('parses a valid structured verdict', () => {
    expect(parseSupervisorAdvice({ decision: 'retry', rationale: 'flaky' })).toEqual({ decision: 'retry', rationale: 'flaky' });
  });
  it("falls back to 'escalate' for unparseable / unknown verdicts", () => {
    expect(parseSupervisorAdvice(null).decision).toBe('escalate');
    expect(parseSupervisorAdvice({ decision: 'nope' }).decision).toBe('escalate');
    expect(parseSupervisorAdvice('garbage').decision).toBe('escalate');
  });
  it('tolerates a missing rationale', () => {
    expect(parseSupervisorAdvice({ decision: 'fail' })).toEqual({ decision: 'fail', rationale: '' });
  });
});

describe('buildSupervisorTriagePrompt', () => {
  it('includes the failed step, error, and recent events', () => {
    const p = buildSupervisorTriagePrompt({
      workflowName: 'planner',
      failedStep: { id: 'epics', name: 'Epics', agent: 'epics' },
      error: 'boom',
      recentEvents: [{ kind: 'step-failed', runId: 'r', stepId: 'epics', error: 'boom' }],
      cwd: '/wt',
    });
    expect(p).toContain('`epics`');
    expect(p).toContain('boom');
    expect(p).toContain('retry');
    expect(p).toContain('escalate');
  });
});

describe('SdkSupervisorSession', () => {
  it('returns the advisor decision and passes the run cwd + recent events', async () => {
    const advise = vi.fn().mockResolvedValue({ decision: 'retry', rationale: 'transient' });
    const advisor: SupervisorAdvisor = { advise };
    const s = new SdkSupervisorSession(advisor);
    await s.start(ctx);
    s.notify({ kind: 'step-running', runId: 'r', stepId: 'epics' });
    s.notify({ kind: 'step-failed', runId: 'r', stepId: 'epics', error: 'boom' });

    const decision = await s.triage({ step: step({ id: 'epics' }), error: 'boom' });

    expect(decision).toBe('retry');
    const req = advise.mock.calls[0][0];
    expect(req.cwd).toBe('/wt');
    expect(req.failedStep.id).toBe('epics');
    expect(req.recentEvents[0].kind).toBe('step-failed'); // most recent first
  });

  it("escalates to human when the advisor throws (fail-soft, never hard-fails)", async () => {
    const advisor: SupervisorAdvisor = { advise: vi.fn().mockRejectedValue(new Error('sdk down')) };
    const s = new SdkSupervisorSession(advisor);
    await s.start(ctx);
    expect(await s.triage({ step: step({ id: 'a' }), error: undefined })).toBe('escalate');
  });

  it('bounds the monitor ring buffer to maxEvents', async () => {
    const advise = vi.fn().mockResolvedValue({ decision: 'fail', rationale: '' });
    const s = new SdkSupervisorSession({ advise }, { maxEvents: 3 });
    await s.start(ctx);
    for (let i = 0; i < 10; i++) s.notify({ kind: 'step-running', runId: 'r', stepId: `s${i}` });
    await s.triage({ step: step({ id: 'x' }), error: undefined });
    expect(advise.mock.calls[0][0].recentEvents).toHaveLength(3);
  });
});

describe('SdkSupervisorAdvisor', () => {
  it('runs a structured query with the triage schema + run cwd and parses the verdict', async () => {
    const queryFn: StructuredQueryFn = vi.fn().mockResolvedValue({ decision: 'escalate', rationale: 'needs a human' });
    const advisor = new SdkSupervisorAdvisor(queryFn);

    const advice = await advisor.advise({
      workflowName: 'planner',
      failedStep: { id: 'a', name: 'A', agent: 'executor' },
      error: 'boom',
      recentEvents: [],
      cwd: '/wt',
    });

    expect(advice.decision).toBe('escalate');
    const args = (queryFn as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.schema).toBe(SUPERVISOR_TRIAGE_SCHEMA);
    expect(args.cwd).toBe('/wt');
    expect(args.prompt).toContain('`a`');
  });

  it("parses an unusable query result to an 'escalate' fallback", async () => {
    const advisor = new SdkSupervisorAdvisor(vi.fn().mockResolvedValue(null) as StructuredQueryFn);
    const advice = await advisor.advise({
      workflowName: 'planner', failedStep: { id: 'a', name: 'A', agent: 'executor' }, error: undefined, recentEvents: [], cwd: '/wt',
    });
    expect(advice.decision).toBe('escalate');
  });
});
