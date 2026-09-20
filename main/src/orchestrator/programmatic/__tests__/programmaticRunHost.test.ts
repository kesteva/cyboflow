import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProgrammaticRunHost,
  LANE_TRIAGE_KILL_SWITCH_ENV,
  REVIEW_LOOP_KILL_SWITCH_ENV,
  type StepReporter,
} from '../programmaticRunHost';
import type { HumanGateResolver } from '../humanGate';
import type { LaneTriageDecision, MonitorSession } from '../monitor';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type {
  ControllerStepContext,
  FanOutDriver,
  LaneTriageFailure,
  ReviewLoopDecision,
  ReviewLoopRequest,
  SystemicPauseVerdict,
} from '../types';
import type {
  AdversarialFinding,
  AdversarialSeverity,
} from '../../../../../shared/types/adversarialReview';
import type { SystemicPauseResolver } from '../systemicPauseGate';

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
  guidance?: string,
): MonitorSession & { triage: ReturnType<typeof vi.fn> } {
  return {
    triage: vi.fn().mockResolvedValue({ decision, rationale, ...(guidance ? { guidance } : {}) }),
    answer: vi.fn().mockResolvedValue(''),
  };
}

/** Collect the text of every assistant turn the host injected into the run stream. */
function injectedText(events: ClaudeStreamEvent[]): string {
  return events
    .map((ev) =>
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '',
    )
    .join('\n');
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

  it("downgrades a monitor 'fail' verdict to 'escalate' — ending a run is the human's call", async () => {
    const monitor = makeMonitor('fail', 'the branch is unbuildable');
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      injectEvent: (e) => injected.push(e),
    });

    const decision = await host.triageFailure(step({ id: 'a', name: 'Build epics' }), ctx, 'boom');

    expect(decision).toBe('escalate');
    // The chat turn carries the recommendation + the rationale so the escalation
    // surfaces in BOTH the chat and the review queue.
    expect(injected).toHaveLength(1);
    const ev = injected[0];
    const text =
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '';
    expect(text).toContain('recommends ending the run');
    expect(text).toContain('the branch is unbuildable');
  });

  it("defaults triageFailure to 'escalate' with a plain chat note when no monitor is wired", async () => {
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      injectEvent: (e) => injected.push(e),
    });

    expect(await host.triageFailure(step({ id: 'a', name: 'Build epics' }), ctx, undefined)).toBe('escalate');
    // Dual-surface invariant holds even without a brain: the escalation renders in chat too.
    expect(injected).toHaveLength(1);
    const ev = injected[0];
    const text =
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '';
    expect(text).toContain('escalated to the review queue');
  });

  // ── one-shot retry guidance (RunDirectives.retryGuidance write half) ───────
  it("stages a 'retry' verdict's guidance for the next spawn and quotes it in the chat note", async () => {
    const monitor = makeMonitor('retry', 'the fixture clock is stale', 'pin the fixture clock');
    const injected: ClaudeStreamEvent[] = [];
    const setRetryGuidance = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      setRetryGuidance,
      injectEvent: (e) => injected.push(e),
    });

    expect(await host.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom')).toBe('retry');

    expect(setRetryGuidance).toHaveBeenCalledWith('impl', 'pin the fixture clock');
    const text = injectedText(injected);
    expect(text).toContain('Triage — Implement: retry. the fixture clock is stale');
    expect(text).toContain('Guidance for the retry: pin the fixture clock');
  });

  it('retries WITHOUT guidance (and warns) when no setRetryGuidance is wired', async () => {
    const monitor = makeMonitor('retry', 'stale fixture', 'pin the fixture clock');
    const injected: ClaudeStreamEvent[] = [];
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      injectEvent: (e) => injected.push(e),
      logger,
    });

    // The retry still happens — a dropped hint is never worse than the old path.
    expect(await host.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom')).toBe('retry');
    expect(logger.warn).toHaveBeenCalledWith(
      '[ProgrammaticRunHost] retry guidance dropped (no setter wired)',
      expect.objectContaining({ stepId: 'impl' }),
    );
    // …and the chat note does not promise guidance the re-run will never see.
    expect(injectedText(injected)).not.toContain('Guidance for the retry');
  });

  it('is fail-soft when setRetryGuidance throws — the retry proceeds unguided', async () => {
    const monitor = makeMonitor('retry', 'stale fixture', 'pin the fixture clock');
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      setRetryGuidance: () => {
        throw new Error('directives boom');
      },
      injectEvent: (e) => injected.push(e),
    });

    expect(await host.triageFailure(step({ id: 'impl' }), ctx, 'boom')).toBe('retry');
    expect(injectedText(injected)).not.toContain('Guidance for the retry');
  });

  // ── OPTIONAL step: nothing is escalated, so nothing may say it was ─────────
  it('phrases an OPTIONAL step\'s escalate / fail verdicts as skipping, not escalating', async () => {
    for (const [decision, expected] of [
      ['escalate', 'skipping the optional step'],
      ['fail', 'skipping the optional step'],
    ] as const) {
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r',
        projectId: 1,
        reporter: makeReporter(),
        gate: makeGate('approve'),
        monitor: makeMonitor(decision, 'not worth another attempt'),
        injectEvent: (e) => injected.push(e),
      });

      expect(
        await host.triageFailure(step({ id: 'proto', name: 'Prototype', optional: true }), ctx, 'boom'),
      ).toBe('escalate');
      const text = injectedText(injected);
      expect(text).toContain(expected);
      expect(text).not.toContain('escalated to the review queue');
    }
  });

  it('keeps the review-queue wording for a REQUIRED step (unchanged behaviour)', async () => {
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor: makeMonitor('escalate', 'a product call'),
      injectEvent: (e) => injected.push(e),
    });

    await host.triageFailure(step({ id: 'a', name: 'Build epics' }), ctx, 'boom');

    expect(injectedText(injected)).toContain('Triage — Build epics: escalate. a product call');
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

  it('forwards recordStepResult to the recorder with the bound runId (migration 033)', () => {
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

  // ── Adversarial-review artifact read-back (the loopback's durable channel) ──
  it('readAdversarialReview passes the injected reader through and is fail-soft when it throws or is unset', () => {
    const wired = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      readAdversarialReview: () => '## Blocking\n\n#### AR-1 — x\n',
    });
    expect(wired.readAdversarialReview()).toBe('## Blocking\n\n#### AR-1 — x\n');

    // A thrown read degrades to "no artifact" rather than aborting a walk that is
    // mid-review.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const throwing = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      readAdversarialReview: () => { throw new Error('db down'); },
      logger,
    });
    expect(throwing.readAdversarialReview()).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();

    const none = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(none.readAdversarialReview()).toBeUndefined();
  });

  // ── Fan-out lane driver (generalize-parallel-fan-out; LIVE resolution) ──────
  it('exposes the provider-resolved fan-out driver on host.fanOut, consulting the provider on EVERY read', () => {
    const fanOutDriver: FanOutDriver = {
      resolveItems: vi.fn(() => ['t1', 't2']),
      driveLane: vi.fn(),
    };
    const fanOutDriverProvider = vi.fn(() => fanOutDriver);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), fanOutDriverProvider,
    });

    expect(host.fanOut).toBe(fanOutDriver);
    // And it is callable through the host (the controller resolves items via it).
    expect(host.fanOut?.resolveItems('r', 'tasks')).toEqual(['t1', 't2']);
    // The getter is a live pass-through — NOT cached by the host itself (any
    // memoization is the provider's own responsibility, per its docblock).
    expect(fanOutDriverProvider).toHaveBeenCalledTimes(2);
  });

  it('host.fanOut is undefined when no provider is injected (the controller never fans out)', () => {
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(host.fanOut).toBeUndefined();
  });

  it('host.fanOut is undefined when the provider itself has not yet resolved a driver (e.g. batch_id not stamped)', () => {
    const fanOutDriverProvider = vi.fn(() => undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), fanOutDriverProvider,
    });
    expect(host.fanOut).toBeUndefined();
    expect(fanOutDriverProvider).toHaveBeenCalledTimes(1);
  });

  // ── Systemic-pause seam (the 2026-07-06 planner-incident fix) ────────────────
  it("awaitSystemicPause returns 'giveup' and injects nothing when no gate is wired", async () => {
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      injectEvent: (e) => injected.push(e),
    });

    expect(await host.awaitSystemicPause(step({ id: 'a', name: 'Build epics' }), ctx, 'usage limit reached')).toBe(
      'giveup',
    );
    // Byte-identical to a world without the seam — no chat turn.
    expect(injected).toHaveLength(0);
  });

  it("delegates awaitSystemicPause with run/project/step/error/signal and injects the pause + resume turns on 'retry'", async () => {
    const awaitClear = vi.fn<(req: unknown) => Promise<SystemicPauseVerdict>>().mockResolvedValue('retry');
    const systemicGate: SystemicPauseResolver = { awaitClear };
    const injected: ClaudeStreamEvent[] = [];
    const signal = new AbortController().signal;
    const host = new ProgrammaticRunHost({
      runId: 'run-9',
      projectId: 7,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      systemicGate,
      injectEvent: (e) => injected.push(e),
    });

    const verdict = await host.awaitSystemicPause({ ...step({ id: 'a', name: 'Build epics' }) }, { ...ctx, signal }, 'usage limit reached');

    expect(verdict).toBe('retry');
    expect(awaitClear).toHaveBeenCalledWith({
      runId: 'run-9',
      projectId: 7,
      step: expect.objectContaining({ id: 'a' }),
      error: 'usage limit reached',
      signal,
    });
    // Two chat turns: the pause note, then the resume note.
    const texts = injected.map((ev) =>
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '',
    );
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Run paused');
    expect(texts[0]).toContain('Build epics');
    expect(texts[1]).toContain('Resuming');
  });

  it("injects the pause + dismissed turns on 'giveup'", async () => {
    const systemicGate: SystemicPauseResolver = { awaitClear: vi.fn().mockResolvedValue('giveup') };
    const injected: ClaudeStreamEvent[] = [];
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      systemicGate,
      injectEvent: (e) => injected.push(e),
    });

    expect(await host.awaitSystemicPause(step({ id: 'a', name: 'Build epics' }), ctx, 'rate limit')).toBe('giveup');
    const texts = injected.map((ev) =>
      'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
        ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        : '',
    );
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('dismissed');
  });

  it("is fail-soft — a throwing systemic gate defaults to 'giveup' and does not abort the walk", async () => {
    const systemicGate: SystemicPauseResolver = {
      awaitClear: vi.fn().mockRejectedValue(new Error('gate boom')),
    };
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      systemicGate,
    });

    expect(await host.awaitSystemicPause(step({ id: 'a' }), ctx, 'boom')).toBe('giveup');
  });
  // ── Autonomous LANE TRIAGE (monitor lane rescue) ────────────────────────────
  describe('triageLaneFailure', () => {
    const failure: LaneTriageFailure = {
      itemId: 'tsk_a',
      stepId: 'implement',
      attempt: 3,
      failureKind: 'inner-step',
      errorExcerpt: 'tsc: 4 errors',
      innerStepIds: ['implement', 'code-review', 'task-verify'],
    };

    /** A monitor whose triageLane returns a canned verdict. */
    function makeLaneMonitor(
      decision: LaneTriageDecision,
    ): MonitorSession & { triageLane: ReturnType<typeof vi.fn> } {
      return {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        triageLane: vi.fn().mockResolvedValue(decision),
      };
    }

    const RETRY: LaneTriageDecision = {
      verdict: 'retry',
      targetStepId: 'implement',
      guidance: 'stub the network layer instead of hitting it',
      reason: 'the failure is an unmocked fetch',
    };
    const ADJUST: LaneTriageDecision = {
      verdict: 'adjust_and_retry',
      targetStepId: 'implement',
      guidance: 'narrow the criterion to the sync path',
      reason: 'the async API the AC assumes does not exist (src/x.ts:12)',
      taskBody: '## New body\n\nnarrowed',
    };

    /** Extract the plain text of every injected assistant turn. */
    function texts(events: ClaudeStreamEvent[]): string[] {
      return events.map((ev) =>
        'type' in ev && ev.type === 'assistant' && Array.isArray(ev.message.content)
          ? ev.message.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
          : '',
      );
    }

    afterEach(() => {
      delete process.env[LANE_TRIAGE_KILL_SWITCH_ENV];
    });

    it('gives up WITHOUT consulting the monitor when the kill switch is set', async () => {
      process.env[LANE_TRIAGE_KILL_SWITCH_ENV] = '1';
      const monitor = makeLaneMonitor(RETRY);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor, injectEvent: (e) => injected.push(e),
      });

      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
      expect(monitor.triageLane).not.toHaveBeenCalled();
      // A rollback lever is silent — no chat turn beyond the log.
      expect(injected).toHaveLength(0);
    });

    it('gives up when no monitor is wired', async () => {
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      });
      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
    });

    it('gives up when the monitor has no triageLane (the suite’s faked sessions)', async () => {
      const monitor: MonitorSession = { triage: vi.fn(), answer: vi.fn().mockResolvedValue('') };
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });
      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
    });

    it('enriches the request with the task facts and injects NO chat turn of its own (triageLane owns its rendering)', async () => {
      const monitor = makeLaneMonitor(RETRY);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        injectEvent: (e) => injected.push(e),
        readLaneTask: () => ({ taskRef: 'TASK-014', taskTitle: 'Wire the thing', taskBody: '## Old body' }),
      });

      const outcome = await host.triageLaneFailure(failure);

      expect(outcome).toEqual({
        kind: 'rescue',
        targetStepId: 'implement',
        guidance: RETRY.guidance,
        adjusted: false,
      });
      expect(monitor.triageLane).toHaveBeenCalledWith(
        expect.objectContaining({
          taskRef: 'TASK-014',
          taskTitle: 'Wire the thing',
          taskBody: '## Old body',
          itemId: 'tsk_a',
          stepId: 'implement',
          attempt: 3,
          failureKind: 'inner-step',
          innerStepIds: ['implement', 'code-review', 'task-verify'],
        }),
        undefined,
      );
      // The host must not double-render what the brain already announced.
      expect(injected).toHaveLength(0);
    });

    it('falls back to the item id as the ref when no task reader is wired', async () => {
      const monitor = makeLaneMonitor(RETRY);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });

      await host.triageLaneFailure(failure);

      expect(monitor.triageLane).toHaveBeenCalledWith(
        expect.objectContaining({ taskRef: 'tsk_a', taskTitle: '', taskBody: '' }),
        undefined,
      );
    });

    it('files NO finding for a give_up verdict (the failure already reaches the human gate)', async () => {
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor({ verdict: 'give_up', reason: 'genuinely broken' }),
        fileLaneTriageFinding,
      });

      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
      expect(fileLaneTriageFinding).not.toHaveBeenCalled();
    });

    // ── append_correction (advisory, no rescue spent) ───────────────────────

    const CORRECTION: LaneTriageDecision = {
      verdict: 'append_correction',
      reason: 'the shared fixture writes local timestamps, so every lane touching it fails the same way',
      guidance: 'pin TZ=UTC in the shared fixture rather than in each test',
    };

    it('files an ADVISORY finding for append_correction and still settles the lane (give_up)', async () => {
      // The hole this closes: a plain give_up files NOTHING, so a monitor that
      // diagnosed a real cross-lane cause and declined to re-drive left no record.
      const adjustRunTask = vi.fn().mockResolvedValue({ ok: true });
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(CORRECTION),
        injectEvent: (e) => injected.push(e),
        readLaneTask: () => ({ taskRef: 'TASK-014', taskTitle: 'T', taskBody: '## Old body' }),
        adjustRunTask,
        fileLaneTriageFinding,
      });

      const outcome = await host.triageLaneFailure(failure);

      // The lane settles exactly as it did before this verdict existed...
      expect(outcome).toEqual({ kind: 'give_up' });
      // ...nothing is re-driven and NO task body is touched...
      expect(adjustRunTask).not.toHaveBeenCalled();
      // ...the brain's own turn already announced the decision, so no host turn...
      expect(injected).toHaveLength(0);
      // ...and the diagnosis survives.
      const finding = fileLaneTriageFinding.mock.calls[0][0] as { title: string; body: string };
      expect(finding.title).toBe('Monitor diagnosis for TASK-014 (inner-step) — advisory');
      expect(finding.body).toContain('advisory (no rescue spent)');
      expect(finding.body).toContain('WITHOUT re-driving');
      expect(finding.body).toContain('## Diagnosis');
      expect(finding.body).toContain('shared fixture writes local timestamps');
      expect(finding.body).toContain('## Suggested correction');
      expect(finding.body).toContain('pin TZ=UTC');
    });

    it('omits the correction section when append_correction carried no guidance', async () => {
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor({ verdict: 'append_correction', reason: 'a real cause' }),
        readLaneTask: () => ({ taskRef: 'TASK-014', taskTitle: 'T', taskBody: '' }),
        fileLaneTriageFinding,
      });

      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
      const finding = fileLaneTriageFinding.mock.calls[0][0] as { body: string };
      expect(finding.body).not.toContain('## Suggested correction');
    });

    it('still settles the lane when the append_correction finding sink is absent or throws', async () => {
      const bare = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(CORRECTION),
      });
      expect(await bare.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });

      const broken = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(CORRECTION),
        fileLaneTriageFinding: vi.fn().mockRejectedValue(new Error('review queue down')),
      });
      expect(await broken.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
    });

    it('applies the adjust_and_retry body edit and reports adjusted:true', async () => {
      const adjustRunTask = vi.fn().mockResolvedValue({ ok: true });
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(ADJUST),
        injectEvent: (e) => injected.push(e),
        readLaneTask: () => ({ taskRef: 'TASK-014', taskTitle: 'T', taskBody: '## Old body' }),
        adjustRunTask,
        fileLaneTriageFinding,
      });

      const outcome = await host.triageLaneFailure(failure);

      expect(outcome).toMatchObject({ kind: 'rescue', adjusted: true, guidance: ADJUST.guidance });
      expect(adjustRunTask).toHaveBeenCalledWith({ taskRef: 'TASK-014', body: ADJUST.taskBody });
      // A successful adjust needs no host turn — the brain already said it would.
      expect(injected).toHaveLength(0);
      const finding = fileLaneTriageFinding.mock.calls[0][0] as { title: string; body: string };
      expect(finding.title).toBe('Monitor rescued TASK-014 (inner-step)');
      expect(finding.body).toContain('APPLIED');
      expect(finding.body).toContain('## Old body');
      expect(finding.body).toContain('## New body');
    });

    it('DOWNGRADES a refused adjust to a plain rescue: adjusted:false + a chat turn + the finding says so', async () => {
      const adjustRunTask = vi.fn().mockResolvedValue({ ok: false, reason: 'That task has already started.' });
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(ADJUST),
        injectEvent: (e) => injected.push(e),
        readLaneTask: () => ({ taskRef: 'TASK-014', taskBody: '## Old body' }),
        adjustRunTask,
        fileLaneTriageFinding,
      });

      const outcome = await host.triageLaneFailure(failure);

      // The rescue still happens — the guidance carries the substance.
      expect(outcome).toEqual({
        kind: 'rescue',
        targetStepId: 'implement',
        guidance: ADJUST.guidance,
        adjusted: false,
      });
      // The ONE thing the brain could not know is rendered by the host.
      const injectedTexts = texts(injected);
      expect(injectedTexts).toHaveLength(1);
      expect(injectedTexts[0]).toContain('TASK-014');
      expect(injectedTexts[0]).toContain('That task has already started.');
      const finding = fileLaneTriageFinding.mock.calls[0][0] as { body: string };
      expect(finding.body).toContain('NOT applied');
      expect(finding.body).toContain('That task has already started.');
      // The proposed body is recorded, but nothing claims it was written.
      expect(finding.body).toContain('Proposed (not applied) body');
    });

    it('downgrades an adjust when the edit THROWS, and when no adjust capability is wired at all', async () => {
      const thrower = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(ADJUST),
        adjustRunTask: vi.fn().mockRejectedValue(new Error('router down')),
      });
      expect(await thrower.triageLaneFailure(failure)).toMatchObject({ kind: 'rescue', adjusted: false });

      const unwired = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(ADJUST),
      });
      expect(await unwired.triageLaneFailure(failure)).toMatchObject({ kind: 'rescue', adjusted: false });
    });

    it('maps a systemic-tagged give_up to a SYSTEMIC outcome and files no finding', async () => {
      // The supervisor's own turn hit the limit: it judged nothing, so the lane
      // must be parked, not failed.
      const limit = "You've hit your session limit · resets 6pm (America/Los_Angeles)";
      const fileLaneTriageFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor({ verdict: 'give_up', reason: 'triage failed', systemicError: limit }),
        fileLaneTriageFinding,
      });

      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'systemic', error: limit });
      expect(fileLaneTriageFinding).not.toHaveBeenCalled();
    });

    it('maps an escaped systemic throw to a SYSTEMIC outcome, and an ordinary throw to give_up', async () => {
      const limit = 'Claude AI usage limit reached|1751234567';
      const systemicThrower = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: { triage: vi.fn(), answer: vi.fn().mockResolvedValue(''), triageLane: vi.fn().mockRejectedValue(new Error(limit)) },
      });
      expect(await systemicThrower.triageLaneFailure(failure)).toEqual({ kind: 'systemic', error: limit });

      const ordinaryThrower = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: { triage: vi.fn(), answer: vi.fn().mockResolvedValue(''), triageLane: vi.fn().mockRejectedValue(new Error('parse blew up')) },
      });
      expect(await ordinaryThrower.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
    });

    it('is fail-soft on the finding: a throwing sink never costs the lane its rescue', async () => {
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor: makeLaneMonitor(RETRY),
        fileLaneTriageFinding: vi.fn().mockRejectedValue(new Error('review queue down')),
      });

      expect(await host.triageLaneFailure(failure)).toMatchObject({ kind: 'rescue', adjusted: false });
    });

    it('is fail-soft on a throwing task reader (the consult still runs, with no body)', async () => {
      const monitor = makeLaneMonitor(RETRY);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        readLaneTask: () => { throw new Error('db down'); },
      });

      expect(await host.triageLaneFailure(failure)).toMatchObject({ kind: 'rescue' });
      expect(monitor.triageLane).toHaveBeenCalledWith(
        expect.objectContaining({ taskBody: '' }),
        undefined,
      );
    });

    it('gives up (belt-and-braces) when triageLane itself rejects', async () => {
      const monitor: MonitorSession = {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        triageLane: vi.fn().mockRejectedValue(new Error('brain boom')),
      };
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });

      expect(await host.triageLaneFailure(failure)).toEqual({ kind: 'give_up' });
    });

    it('forwards the run signal so a slow triage query dies with the run', async () => {
      const monitor = makeLaneMonitor(RETRY);
      const signal = new AbortController().signal;
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });

      await host.triageLaneFailure({ ...failure, signal });

      expect(monitor.triageLane).toHaveBeenCalledWith(expect.anything(), signal);
    });
  });

  // -------------------------------------------------------------------------
  // F8 — the pre-row visual-verification skip finding
  // (docs/proposals/visual-verification-brittleness-fixes.md §F8)
  // -------------------------------------------------------------------------

  describe('reportVerificationSkipped', () => {
    it('files a finding naming the lane, the run and the reason verbatim', () => {
      const fileVerificationSkipFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        fileVerificationSkipFinding,
      });

      host.reportVerificationSkipped({
        runId: 'run-9',
        laneTaskRef: 'TASK-014',
        reason: 'scheduler-unavailable',
        detail: 'extra context',
      });

      const finding = fileVerificationSkipFinding.mock.calls[0][0] as { title: string; body: string };
      expect(finding.title).toContain('TASK-014');
      expect(finding.body).toContain('run-9');
      expect(finding.body).toContain('scheduler-unavailable');
      expect(finding.body).toContain('extra context');
    });

    it('FENCES the untrusted reason and neutralizes a fence-closing backtick run', () => {
      // The enqueue-decline reason is `prepared.error`, which for a §7.2
      // forbidden-command rejection quotes the AGENT'S OWN composed commands
      // verbatim — free to contain markdown, headings, or its own ``` fence.
      const fileVerificationSkipFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        fileVerificationSkipFinding,
      });

      host.reportVerificationSkipped({
        runId: 'run-9',
        laneTaskRef: 'TASK-014',
        reason: 'forbidden command:\n```\n# Injected heading\n',
      });

      const { body } = fileVerificationSkipFinding.mock.calls[0][0] as { title: string; body: string };
      // The reason lives inside a fence...
      expect(body).toContain('Reason:\n\n```\n');
      // ...and no RAW ``` run survives inside it to close that fence early.
      expect(body).toContain('forbidden command:');
      expect(body).not.toContain('\n```\n# Injected heading');
    });

    it('CAPS a runaway reason instead of letting it dominate the review queue', () => {
      const fileVerificationSkipFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        fileVerificationSkipFinding,
      });

      host.reportVerificationSkipped({ runId: 'run-9', laneTaskRef: 'T', reason: 'x'.repeat(9000) });

      const { body } = fileVerificationSkipFinding.mock.calls[0][0] as { title: string; body: string };
      expect(body.length).toBeLessThan(4000);
      expect(body).toContain('truncated, 9000 chars total');
    });

    it('is a no-op when no sink is wired', () => {
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      });

      expect(() =>
        host.reportVerificationSkipped({ runId: 'r', laneTaskRef: 't1', reason: 'why' }),
      ).not.toThrow();
    });

    it('is fail-soft: neither a synchronous throw nor a rejected write escapes', async () => {
      const thrower = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        fileVerificationSkipFinding: () => {
          throw new Error('router down');
        },
      });
      expect(() =>
        thrower.reportVerificationSkipped({ runId: 'r', laneTaskRef: 't1', reason: 'why' }),
      ).not.toThrow();

      const rejecter = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        fileVerificationSkipFinding: vi.fn().mockRejectedValue(new Error('review queue down')),
      });
      rejecter.reportVerificationSkipped({ runId: 'r', laneTaskRef: 't1', reason: 'why' });
      // Let the rejection settle — an unhandled rejection would fail the suite.
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // -------------------------------------------------------------------------
  // The SUPERVISED adversarial-review loop (ControllerHost.adviseReviewLoop)
  // -------------------------------------------------------------------------

  describe('adviseReviewLoop', () => {
    function arEntry(id: string, title: string, severity: AdversarialSeverity = 'blocker'): AdversarialFinding {
      return { id, title, severity, fix: `fix ${id}` };
    }

    const req: ReviewLoopRequest = {
      stepId: 'adversarial-review',
      loopbackStepId: 'expand-spec',
      round: 2,
      lapsUsed: 1,
      maxLaps: 3,
      reviewMarkdown: '## Blocking\n\n#### AR-1 — Spend screen',
      parsed: {
        blocking: [arEntry('AR-1', 'Spend screen has no way back')],
        findings: [arEntry('AR-3', 'Copy nit', 'advisory')],
        prior: [],
      },
      priorRounds: [],
    };

    const LOOP: ReviewLoopDecision = {
      verdict: 'loop',
      rationale: 'AR-1 is a one-line fix',
      steering: { address: ['AR-1'], setAside: [{ id: 'AR-3', reason: 'copy nit' }], guidance: 'add a Home affordance' },
    };

    /** A monitor whose adviseReviewLoop returns a canned verdict. */
    function makeLoopMonitor(
      decision: ReviewLoopDecision | undefined,
    ): MonitorSession & { adviseReviewLoop: ReturnType<typeof vi.fn> } {
      return {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        adviseReviewLoop: vi.fn().mockResolvedValue(decision),
      };
    }

    afterEach(() => {
      delete process.env[REVIEW_LOOP_KILL_SWITCH_ENV];
    });

    it('returns undefined WITHOUT consulting the monitor when the kill switch is set', async () => {
      process.env[REVIEW_LOOP_KILL_SWITCH_ENV] = '1';
      const monitor = makeLoopMonitor(LOOP);
      const injected: ClaudeStreamEvent[] = [];
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
        monitor, injectEvent: (e) => injected.push(e),
      });

      expect(await host.adviseReviewLoop(req, ctx)).toBeUndefined();
      expect(monitor.adviseReviewLoop).not.toHaveBeenCalled();
      // A rollback lever is silent — no chat turn beyond the log.
      expect(injected).toHaveLength(0);
    });

    it('returns undefined when no monitor is wired, and when it has no adviseReviewLoop', async () => {
      const bare = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
      expect(await bare.adviseReviewLoop(req, ctx)).toBeUndefined();

      const monitor: MonitorSession = { triage: vi.fn(), answer: vi.fn().mockResolvedValue('') };
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });
      expect(await host.adviseReviewLoop(req, ctx)).toBeUndefined();
    });

    it('files the audit finding + one set-aside finding, and injects NO chat turn of its own', async () => {
      const monitor = makeLoopMonitor(LOOP);
      const injected: ClaudeStreamEvent[] = [];
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const fileSetAsideFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        injectEvent: (e) => injected.push(e),
        fileMonitorFinding,
        fileSetAsideFinding,
      });

      expect(await host.adviseReviewLoop(req, ctx)).toEqual(LOOP);
      expect(monitor.adviseReviewLoop).toHaveBeenCalledWith(req, ctx.signal);

      const audit = fileMonitorFinding.mock.calls[0][0] as { title: string; body: string; category?: string };
      expect(audit.title).toBe('Review loop — adversarial-review round 2: loop');
      expect(audit.category).toBe('review-loop');
      expect(audit.body).toContain('AR-1 is a one-line fix');
      expect(audit.body).toContain('`expand-spec`');
      expect(audit.body).toContain('add a Home affordance');
      expect(audit.body).toContain('- AR-3: copy nit');

      // The set-aside travels as the ENTRY, so the sink can compose the finding
      // exactly like the approve-design gate's accepted-risk twin.
      expect(fileSetAsideFinding).toHaveBeenCalledTimes(1);
      expect(fileSetAsideFinding.mock.calls[0][0]).toEqual({
        entry: req.parsed.findings[0],
        reason: 'copy nit',
        round: 2,
      });
      // The brain owns its rendering — a host turn here would double-render.
      expect(injected).toHaveLength(0);
    });

    it('files set-asides on a STOP too (an entry set aside must still reach the human)', async () => {
      const monitor = makeLoopMonitor({
        verdict: 'stop',
        rationale: 'a product call',
        setAside: [{ id: 'AR-1', reason: 'out of scope' }],
      });
      const fileSetAsideFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileSetAsideFinding,
      });

      await host.adviseReviewLoop(req, ctx);

      expect(fileSetAsideFinding.mock.calls[0][0]).toEqual({
        entry: req.parsed.blocking[0],
        reason: 'out of scope',
        round: 2,
      });
    });

    it('a THROWING sink does not cost the decision', async () => {
      const monitor = makeLoopMonitor(LOOP);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding: vi.fn().mockRejectedValue(new Error('queue down')),
        fileSetAsideFinding: vi.fn().mockRejectedValue(new Error('queue down')),
      });

      expect(await host.adviseReviewLoop(req, ctx)).toEqual(LOOP);
    });

    it('a THROWING consult resolves undefined (the mechanical budget)', async () => {
      const monitor: MonitorSession = {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        adviseReviewLoop: vi.fn().mockRejectedValue(new Error('sdk down')),
      };
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      });

      expect(await host.adviseReviewLoop(req, ctx)).toBeUndefined();
    });

    it('records nothing when the run is canceled mid-consult', async () => {
      // The controller discards a verdict that arrives after the abort, so the
      // audit finding would assert a lap that never happened and the set-aside
      // findings would defer entries nothing ever set aside.
      const controller = new AbortController();
      const monitor: MonitorSession = {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        adviseReviewLoop: vi.fn().mockImplementation(async () => {
          controller.abort();
          return LOOP;
        }),
      };
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const fileSetAsideFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding,
        fileSetAsideFinding,
      });

      expect(await host.adviseReviewLoop(req, { ...ctx, signal: controller.signal })).toBeUndefined();
      expect(fileMonitorFinding).not.toHaveBeenCalled();
      expect(fileSetAsideFinding).not.toHaveBeenCalled();
    });

    it('files nothing when the monitor returns no verdict', async () => {
      const monitor = makeLoopMonitor(undefined);
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding,
      });

      expect(await host.adviseReviewLoop(req, ctx)).toBeUndefined();
      expect(fileMonitorFinding).not.toHaveBeenCalled();
    });
  });
});
