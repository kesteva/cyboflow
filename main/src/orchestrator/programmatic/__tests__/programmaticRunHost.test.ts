import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ProgrammaticRunHost,
  ESCALATION_REVIEW_KILL_SWITCH_ENV,
  LANE_TRIAGE_KILL_SWITCH_ENV,
  MONITOR_RUN_RESOLVE_CAP,
  MONITOR_WALK_RESOLVE_CAP,
  REVIEW_LOOP_KILL_SWITCH_ENV,
  firstSentence,
  type StepReporter,
} from '../programmaticRunHost';
import type { HumanGateOpenedSnapshot, HumanGateResolver } from '../humanGate';
import type { LaneTriageDecision, MonitorSession } from '../monitor';
import type { ClaudeStreamEvent } from '../../../../../shared/types/claudeStream';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type {
  BlockingItemDecision,
  BlockingItemsEscalationRequest,
  ControllerStepContext,
  FanOutDriver,
  GateEscalationDecision,
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
import type { BlockingItemsResolver, PendingBlockingItem } from '../blockingItemsGate';

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

  it("files a non-blocking 'triage-retry' audit finding for a supervised retry, fail-soft when the sink throws", async () => {
    const monitor = makeMonitor('retry', 'the fixture clock is stale', 'pin the fixture clock');
    const fileMonitorFinding = vi.fn<(input: { title: string; body: string; category?: string }) => Promise<void>>(
      async () => undefined,
    );
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      setRetryGuidance: vi.fn(),
      fileMonitorFinding,
      injectEvent: () => undefined,
    });
    expect(await host.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom')).toBe('retry');
    expect(fileMonitorFinding).toHaveBeenCalledTimes(1);
    const filed = fileMonitorFinding.mock.calls[0][0];
    expect(filed.title).toBe('Triage retry — Implement');
    expect(filed.category).toBe('triage-retry');
    expect(filed.body).toContain('pin the fixture clock');
    expect(filed.body).toContain('the fixture clock is stale');

    const throwing = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      setRetryGuidance: vi.fn(),
      fileMonitorFinding: async () => {
        throw new Error('queue down');
      },
      injectEvent: () => undefined,
    });
    expect(await throwing.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom')).toBe('retry');
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

  // ── FB-3: no consult the controller could not honour ───────────────────────
  it("escalates WITHOUT consulting the monitor when the controller has no retry left", async () => {
    const monitor = makeMonitor('retry', 'worth one more go', 'pin the fixture clock');
    const injected: ClaudeStreamEvent[] = [];
    const setRetryGuidance = vi.fn();
    const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r',
      projectId: 1,
      reporter: makeReporter(),
      gate: makeGate('approve'),
      monitor,
      setRetryGuidance,
      fileMonitorFinding,
      injectEvent: (e) => injected.push(e),
    });

    expect(
      await host.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom', { retryAvailable: false }),
    ).toBe('escalate');

    expect(monitor.triage).not.toHaveBeenCalled();
    expect(setRetryGuidance).not.toHaveBeenCalled();
    expect(fileMonitorFinding).not.toHaveBeenCalled();
    expect(injectedText(injected)).toContain(
      'Step **Implement** exhausted its retries and its retry budget — escalated to the review queue for your decision.',
    );
  });

  it('consults as usual when a retry is still available (and when the option is absent)', async () => {
    for (const opts of [{ retryAvailable: true }, undefined]) {
      const monitor = makeMonitor('retry', 'worth one more go');
      const host = new ProgrammaticRunHost({
        runId: 'r',
        projectId: 1,
        reporter: makeReporter(),
        gate: makeGate('approve'),
        monitor,
        injectEvent: () => undefined,
      });

      expect(await host.triageFailure(step({ id: 'impl', name: 'Implement' }), ctx, 'boom', opts)).toBe('retry');
      expect(monitor.triage).toHaveBeenCalledTimes(1);
    }
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

  it('readAdversarialReview forwards the freshness bound verbatim to the injected reader', () => {
    // The host neither reads nor invents the instant — the controller owns it.
    const reader = vi.fn(() => '## Blocking\n\n#### AR-1 — x\n');
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      readAdversarialReview: reader,
    });

    expect(host.readAdversarialReview({ reportedSinceMs: 5 })).toBe('## Blocking\n\n#### AR-1 — x\n');
    expect(reader).toHaveBeenCalledWith({ reportedSinceMs: 5 });

    // No bound ⇒ nothing invented on the way through.
    host.readAdversarialReview();
    expect(reader).toHaveBeenLastCalledWith(undefined);
  });

  it('shouldSkipHumanGate forwards the freshness ctx to humanGateSkip and stays fail-soft', () => {
    const humanGateSkip = vi.fn(() => 'no design surface to review');
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      humanGateSkip,
    });
    const gateStep = step({ id: 'approve-design', optional: true });

    expect(host.shouldSkipHumanGate(gateStep, 'r', { reviewReportedSinceMs: 5 })).toBe(
      'no design surface to review',
    );
    expect(humanGateSkip).toHaveBeenCalledWith(gateStep, { reviewReportedSinceMs: 5 });

    // No ctx ⇒ the predicate sees undefined, and an unwired host still opens the gate.
    host.shouldSkipHumanGate(gateStep, 'r');
    expect(humanGateSkip).toHaveBeenLastCalledWith(gateStep, undefined);

    const none = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve') });
    expect(none.shouldSkipHumanGate(gateStep, 'r', { reviewReportedSinceMs: 5 })).toBeNull();
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

    it('a THROWING sink does not cost the decision, but prunes what it could not file', async () => {
      // The verdict survives a dead queue; the set-aside does NOT — "set aside"
      // is only safe because the finding exists.
      const monitor = makeLoopMonitor(LOOP);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding: vi.fn().mockRejectedValue(new Error('queue down')),
        fileSetAsideFinding: vi.fn().mockRejectedValue(new Error('queue down')),
      });

      expect(await host.adviseReviewLoop(req, ctx)).toEqual({
        verdict: 'loop',
        rationale: LOOP.rationale,
        steering: { address: ['AR-1'], setAside: [], guidance: 'add a Home affordance' },
      });
    });

    it('a BLOCKING entry whose set-aside finding fails is put back into the lap', async () => {
      // Nothing else would carry it: the re-run is told set-asides are already
      // filed, and the human gate files only the CURRENT round's entries.
      const twoBlocking: ReviewLoopRequest = {
        ...req,
        parsed: {
          blocking: [arEntry('AR-1', 'Spend screen has no way back'), arEntry('AR-2', 'No empty state')],
          findings: [arEntry('AR-3', 'Copy nit', 'advisory')],
          prior: [],
        },
      };
      const monitor = makeLoopMonitor({
        verdict: 'loop',
        rationale: 'AR-1 is a one-line fix',
        steering: { address: ['AR-1'], setAside: [{ id: 'AR-2', reason: 'bigger than a lap' }] },
      });
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding,
        fileSetAsideFinding: vi.fn().mockRejectedValue(new Error('queue down')),
      });

      expect(await host.adviseReviewLoop(twoBlocking, ctx)).toEqual({
        verdict: 'loop',
        rationale: 'AR-1 is a one-line fix',
        steering: { address: ['AR-1', 'AR-2'], setAside: [] },
      });
      // The audit names only entries that really do have a finding — and says
      // what happened to the one that does not (the queue is the durable record).
      const audit = fileMonitorFinding.mock.calls[0][0] as { body: string };
      expect(audit.body).toContain('addressing: AR-1, AR-2');
      expect(audit.body).not.toContain('Set aside for this round');
      expect(audit.body).toContain('Set-aside findings that could not be filed: AR-2 (kept in the lap)');
    });

    it('an ADVISORY entry whose set-aside finding fails is pruned but NOT added to the lap', async () => {
      // It is still in the review the re-run reads, still advisory — no rescue
      // into the must-fix set is warranted.
      const monitor = makeLoopMonitor(LOOP);
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding,
        fileSetAsideFinding: vi.fn().mockRejectedValue(new Error('queue down')),
      });

      const decision = await host.adviseReviewLoop(req, ctx);
      expect(decision).toEqual({
        verdict: 'loop',
        rationale: LOOP.rationale,
        steering: { address: ['AR-1'], setAside: [], guidance: 'add a Home affordance' },
      });
      const audit = fileMonitorFinding.mock.calls[0][0] as { body: string };
      expect(audit.body).toContain('addressing: AR-1');
      expect(audit.body).toContain('Set-aside findings that could not be filed: AR-3 (dropped from the set-aside list)');
    });

    it('a STOP whose set-aside finding fails returns an EMPTY set-aside list', async () => {
      const monitor = makeLoopMonitor({
        verdict: 'stop',
        rationale: 'a product call',
        setAside: [{ id: 'AR-1', reason: 'out of scope' }],
      });
      const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
      const host = new ProgrammaticRunHost({
        runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
        fileMonitorFinding,
        fileSetAsideFinding: vi.fn().mockRejectedValue(new Error('queue down')),
      });

      expect(await host.adviseReviewLoop(req, ctx)).toEqual({
        verdict: 'stop',
        rationale: 'a product call',
        setAside: [],
      });
      const audit = fileMonitorFinding.mock.calls[0][0] as { body: string };
      expect(audit.body).not.toContain('Set aside for this round');
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

// ---------------------------------------------------------------------------
// Gate escalation (item 8b) — the supervisor's recommendation at an open gate.
// ---------------------------------------------------------------------------

/** A monitor whose `reviewGateEscalation` returns a canned decision. */
function makeGateMonitor(
  decision: GateEscalationDecision,
): MonitorSession & { reviewGateEscalation: ReturnType<typeof vi.fn> } {
  return {
    triage: vi.fn(),
    answer: vi.fn().mockResolvedValue(''),
    reviewGateEscalation: vi.fn().mockResolvedValue(decision),
  };
}

function snapshot(p: Partial<HumanGateOpenedSnapshot> = {}): HumanGateOpenedSnapshot {
  return { reviewItemId: 'ri-1', title: 'Approve the design', body: 'the gate body', resumed: false, ...p };
}

describe('ProgrammaticRunHost.reviewGateEscalation', () => {
  afterEach(() => {
    delete process.env[ESCALATION_REVIEW_KILL_SWITCH_ENV];
  });

  it('consults the monitor and annotates the item with the composed recommendation', async () => {
    const monitor = makeGateMonitor({ action: 'recommend', choice: 'continue', rationale: 'AR-1 is cosmetic. It costs nothing.' });
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const listRunReviewItems = vi.fn().mockResolvedValue([
      { id: 'ri-9', kind: 'finding' as const, source: 'monitor', severity: 'info', status: 'pending', title: 'AR-3 — nit' },
    ]);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'),
      monitor, annotateReviewItem, listRunReviewItems,
    });

    await host.reviewGateEscalation(step({ id: 'approve-design', name: 'Approve design' }), ctx, snapshot());

    expect(monitor.reviewGateEscalation).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'gate',
        stepId: 'approve-design',
        stepName: 'Approve design',
        reviewItemId: 'ri-1',
        body: 'the gate body',
        reviewItems: [expect.objectContaining({ id: 'ri-9' })],
      }),
      ctx.signal,
    );
    const written = annotateReviewItem.mock.calls[0][0] as { reviewItemId: string; markdown: string };
    expect(written.reviewItemId).toBe('ri-1');
    // The machine-readable first line carries the FIRST sentence; the whole
    // rationale follows.
    expect(written.markdown.split('\n')[0]).toBe('Recommended: continue — AR-1 is cosmetic.');
    expect(written.markdown).toContain('It costs nothing.');
  });

  it('does not repeat a ONE-SENTENCE rationale under the Recommended line', async () => {
    // The headline IS the whole rationale here, so writing it as the tail too
    // would print the same sentence twice in the section.
    const monitor = makeGateMonitor({ action: 'recommend', choice: 'rerun', rationale: 'AR-2 is a real defect.' });
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor, annotateReviewItem,
    });

    await host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot());

    const written = annotateReviewItem.mock.calls[0][0] as { markdown: string };
    expect(written.markdown).toBe('Recommended: rerun — AR-2 is a real defect.');
    expect(written.markdown.split('AR-2 is a real defect.')).toHaveLength(2);
  });

  it('forwards the controller escalation when the gate followed a loop stop', async () => {
    const monitor = makeGateMonitor({ action: 'pass', rationale: 'x' });
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor });
    const escalated: ControllerStepContext = {
      ...ctx,
      escalation: { loopStopRationale: 'product call', setAsideIds: ['AR-3'] },
    };

    await host.reviewGateEscalation(step({ id: 'approve-design' }), escalated, snapshot());

    expect(monitor.reviewGateEscalation).toHaveBeenCalledWith(
      expect.objectContaining({ escalation: { loopStopRationale: 'product call', setAsideIds: ['AR-3'] } }),
      undefined,
    );
  });

  it('writes NOTHING on a pass', async () => {
    const monitor = makeGateMonitor({ action: 'pass', rationale: 'a genuine judgement call' });
    const annotateReviewItem = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor, annotateReviewItem,
    });

    await host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot());

    expect(annotateReviewItem).not.toHaveBeenCalled();
  });

  it('does not consult when the kill switch is set', async () => {
    process.env[ESCALATION_REVIEW_KILL_SWITCH_ENV] = '1';
    const monitor = makeGateMonitor({ action: 'recommend', choice: 'continue', rationale: 'x' });
    const annotateReviewItem = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor, annotateReviewItem,
    });

    await host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot());

    expect(monitor.reviewGateEscalation).not.toHaveBeenCalled();
    expect(annotateReviewItem).not.toHaveBeenCalled();
  });

  it('does not consult when the body ALREADY carries a recommendation (a resumed, annotated gate)', async () => {
    const monitor = makeGateMonitor({ action: 'recommend', choice: 'continue', rationale: 'x' });
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor });
    const annotated = snapshot({
      resumed: true,
      body: 'the gate body\n\n## Supervisor recommendation\n\nRecommended: continue — already advised.',
    });

    await host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, annotated);

    expect(monitor.reviewGateEscalation).not.toHaveBeenCalled();
  });

  it('DOES consult a resumed gate that was never annotated', async () => {
    const monitor = makeGateMonitor({ action: 'pass', rationale: 'x' });
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor });

    await host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot({ resumed: true }));

    expect(monitor.reviewGateEscalation).toHaveBeenCalledTimes(1);
  });

  it('swallows the expected invalid_status refusal (the human answered first)', async () => {
    const monitor = makeGateMonitor({ action: 'recommend', choice: 'continue', rationale: 'x' });
    const refusal = Object.assign(new Error('review item ri-1 is not pending'), { code: 'invalid_status' });
    const annotateReviewItem = vi.fn().mockRejectedValue(refusal);
    const warn = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor, annotateReviewItem,
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
    });

    await expect(
      host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot()),
    ).resolves.toBeUndefined();
    // Logged at DEBUG, not warn: this is the designed outcome of the race.
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws — a throwing reader, monitor or sink all degrade to no recommendation', async () => {
    const monitor: MonitorSession = {
      triage: vi.fn(),
      answer: vi.fn().mockResolvedValue(''),
      reviewGateEscalation: vi.fn().mockRejectedValue(new Error('consult boom')),
    };
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor,
      listRunReviewItems: vi.fn().mockRejectedValue(new Error('read boom')),
      annotateReviewItem: vi.fn().mockRejectedValue(new Error('write boom')),
    });

    await expect(
      host.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot()),
    ).resolves.toBeUndefined();

    // A monitor with no escalation method is also inert.
    const bare = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), monitor: makeMonitor('retry') });
    await expect(bare.reviewGateEscalation(step({ id: 'approve-design' }), ctx, snapshot())).resolves.toBeUndefined();
  });
});

describe('ProgrammaticRunHost.requestHumanGate — the onOpened hook', () => {
  it('forwards (step, ctx, snapshot) to an injected onGateOpened override', async () => {
    const onGateOpened = vi.fn().mockResolvedValue(undefined);
    const gate = makeGate('approve');
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate, onGateOpened });
    const gateStep = step({ id: 'approve-design', name: 'Approve design' });

    await host.requestHumanGate(gateStep, ctx);

    const req = gate.resolve.mock.calls[0][0] as { onOpened?: (s: HumanGateOpenedSnapshot) => void };
    expect(req.onOpened).toBeDefined();
    const snap = snapshot();
    req.onOpened?.(snap);
    expect(onGateOpened).toHaveBeenCalledWith(gateStep, ctx, snap);
  });

  it('defaults the hook to its OWN escalation review when an escalation-capable monitor is wired', async () => {
    const monitor = makeGateMonitor({ action: 'pass', rationale: 'x' });
    const gate = makeGate('approve');
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate, monitor });

    await host.requestHumanGate(step({ id: 'approve-design' }), ctx);

    const req = gate.resolve.mock.calls[0][0] as { onOpened?: (s: HumanGateOpenedSnapshot) => void };
    expect(req.onOpened).toBeDefined();
    await req.onOpened?.(snapshot());
    expect(monitor.reviewGateEscalation).toHaveBeenCalledTimes(1);
  });

  it('passes NO hook when neither an override nor an escalation-capable monitor exists', async () => {
    const gate = makeGate('approve');
    const host = new ProgrammaticRunHost({ runId: 'r', projectId: 1, reporter: makeReporter(), gate, monitor: makeMonitor('retry') });

    await host.requestHumanGate(step({ id: 'approve-design' }), ctx);

    expect(gate.resolve.mock.calls[0][0]).not.toHaveProperty('onOpened');
  });
});

describe('firstSentence', () => {
  it('takes the first terminated sentence, or the whole text when there is none', () => {
    expect(firstSentence('AR-1 is cosmetic. It costs nothing.')).toBe('AR-1 is cosmetic.');
    expect(firstSentence('  Is this right? Probably.  ')).toBe('Is this right?');
    expect(firstSentence('no terminator here')).toBe('no terminator here');
    // A decimal must not split the sentence — there is no whitespace after it.
    expect(firstSentence('The budget is 3.5 laps. Stop now.')).toBe('The budget is 3.5 laps.');
  });
});

// ---------------------------------------------------------------------------
// Item 9 — the step-boundary escalation review (blocking items)
// ---------------------------------------------------------------------------

function blockingItem(p: Partial<PendingBlockingItem> = {}): PendingBlockingItem {
  return {
    id: 'rvw_f1',
    kind: 'finding',
    source: 'agent:code-review',
    severity: 'error',
    title: 'null deref in parser',
    body: 'parse() dereferences `node`.',
    ...p,
  };
}

/**
 * A fake blocking gate whose pending list is mutable, recording the ORDER of the
 * calls the host makes against it — which is how the write-barrier ordering is
 * asserted without a real router.
 */
function makeBlockingGate(
  items: PendingBlockingItem[],
  trace: string[] = [],
): BlockingItemsResolver & { items: PendingBlockingItem[]; trace: string[]; awaitClear: ReturnType<typeof vi.fn> } {
  const gate = {
    items: [...items],
    trace,
    listPendingBlockingItems: (): PendingBlockingItem[] => {
      trace.push('list');
      return gate.items;
    },
    awaitClear: vi.fn(async (): Promise<'proceed' | 'canceled'> => {
      trace.push(gate.items.length > 0 ? 'park' : 'proceed');
      return 'proceed';
    }),
  };
  return gate;
}

/** A monitor whose blocking-items consult returns canned per-item verdicts. */
function makeBlockingMonitor(
  decisions: BlockingItemDecision[],
): MonitorSession & { reviewBlockingItems: ReturnType<typeof vi.fn> } {
  return {
    triage: vi.fn(),
    answer: vi.fn().mockResolvedValue(''),
    reviewBlockingItems: vi.fn().mockResolvedValue(decisions),
  };
}

describe('ProgrammaticRunHost.awaitBlockingReviewItems — escalation review', () => {
  afterEach(() => {
    delete process.env[ESCALATION_REVIEW_KILL_SWITCH_ENV];
  });

  it('awaits the write barrier BEFORE the first queue read (CR-3)', async () => {
    const trace: string[] = [];
    const blockingGate = makeBlockingGate([blockingItem()], trace);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 7, reporter: makeReporter(), gate: makeGate('approve'),
      blockingGate,
      monitor: makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'pass', rationale: 'a human should look.' }]),
      awaitReviewWritesSettled: vi.fn(async (projectId: number) => {
        trace.push(`barrier:${projectId}`);
      }),
    });

    await host.awaitBlockingReviewItems('r');

    expect(trace[0]).toBe('barrier:7');
    expect(trace).toContain('list');
    expect(trace.indexOf('barrier:7')).toBeLessThan(trace.indexOf('list'));
  });

  it('still barriers on the PLAIN path (no monitor) before awaitClear reads', async () => {
    const trace: string[] = [];
    const blockingGate = makeBlockingGate([blockingItem()], trace);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      awaitReviewWritesSettled: vi.fn(async () => {
        trace.push('barrier');
      }),
    });

    await host.awaitBlockingReviewItems('r');

    expect(trace).toEqual(['barrier', 'park']);
  });

  it('a `resolve` clears the item so awaitClear fast-paths, and files the audit finding', async () => {
    const trace: string[] = [];
    const blockingGate = makeBlockingGate([blockingItem()], trace);
    const resolveReviewItemAsMonitor = vi.fn(async (input: { reviewItemId: string }) => {
      // The production sink's effect: the item stops being pending.
      blockingGate.items = blockingGate.items.filter((i) => i.id !== input.reviewItemId);
    });
    const fileMonitorFinding = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([
        { reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'already fixed in 9a1b2c3. The guard landed.' },
      ]),
      resolveReviewItemAsMonitor,
      fileMonitorFinding,
    });

    expect(await host.awaitBlockingReviewItems('r')).toBe('proceed');

    expect(resolveReviewItemAsMonitor).toHaveBeenCalledWith({
      reviewItemId: 'rvw_f1',
      resolution: 'resolved by supervisor: already fixed in 9a1b2c3. The guard landed.',
    });
    const audit = fileMonitorFinding.mock.calls[0][0] as { title: string; body: string; category: string };
    expect(audit.title).toBe('Supervisor resolve — null deref in parser');
    expect(audit.category).toBe('escalation-resolve');
    expect(audit.body).toContain('rvw_f1');
    // FB-8: the record is filed BEFORE the resolve, so it claims an intent, not
    // an accomplished close, and says what happens when the resolve is refused.
    expect(audit.body).toContain('is resolving this blocking finding on its own authority');
    expect(audit.body).toContain('whether or not the resolve lands');
    expect(audit.body).toContain('Item: `rvw_f1`');
    expect(audit.body).not.toContain('Resolved item:');
    // The resolve landed BEFORE awaitClear read the queue — no park flicker.
    expect(trace).toEqual(['list', 'proceed']);
  });

  it('a `pass` writes nothing and the run parks exactly as it does today', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const resolveReviewItemAsMonitor = vi.fn();
    const annotateReviewItem = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'pass', rationale: 'a human should look.' }]),
      resolveReviewItemAsMonitor,
      annotateReviewItem,
    });

    await host.awaitBlockingReviewItems('r');

    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
    expect(annotateReviewItem).not.toHaveBeenCalled();
    expect(blockingGate.trace).toEqual(['list', 'park']);
  });

  it('a `recommend` annotates the item with the finding menu and keeps it blocking', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([
        { reviewItemId: 'rvw_f1', action: 'recommend', choice: 'dismiss', rationale: 'AR-1 is cosmetic. It costs nothing.' },
      ]),
      annotateReviewItem,
    });

    await host.awaitBlockingReviewItems('r');

    const written = annotateReviewItem.mock.calls[0][0] as { reviewItemId: string; markdown: string };
    expect(written.reviewItemId).toBe('rvw_f1');
    expect(written.markdown.split('\n')[0]).toBe('Recommended: dismiss — AR-1 is cosmetic.');
    expect(blockingGate.trace).toEqual(['list', 'park']);
  });

  it('writes NO recommendation for an off-menu or absent choice, and logs it', async () => {
    // CX-3: there is no fallback choice. Every entry on a decision menu points
    // the human at a consequential button (Reject ENDS the run), so a default
    // would emphasize one on advice the supervisor never gave.
    const blockingGate = makeBlockingGate([blockingItem(), blockingItem({ id: 'rvw_d1', kind: 'decision', title: 'Approve the plan' })]);
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const info = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([
        // `approve` is not a finding's choice; the decision entry names none at all.
        { reviewItemId: 'rvw_f1', action: 'recommend', choice: 'approve', rationale: 'keep it.' },
        { reviewItemId: 'rvw_d1', action: 'recommend', rationale: 'send it back.' },
      ]),
      annotateReviewItem,
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });

    await host.awaitBlockingReviewItems('r');

    expect(annotateReviewItem).not.toHaveBeenCalled();
    expect(info.mock.calls.filter((c) => String(c[0]).includes('off-menu recommendation choice'))).toHaveLength(2);
    expect(blockingGate.trace).toEqual(['list', 'park']);
  });

  it('annotates a decision item whose choice IS on the menu', async () => {
    const blockingGate = makeBlockingGate([blockingItem({ id: 'rvw_d1', kind: 'decision', title: 'Approve the plan' })]);
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([
        { reviewItemId: 'rvw_d1', action: 'recommend', choice: 'approve', rationale: 'every blocker is closed.' },
      ]),
      annotateReviewItem,
    });

    await host.awaitBlockingReviewItems('r');

    const written = annotateReviewItem.mock.calls[0][0] as { markdown: string };
    expect(written.markdown.split('\n')[0]).toBe('Recommended: approve — every blocker is closed.');
  });

  it('NEVER resolves a `decision` item — it is annotated instead', async () => {
    const blockingGate = makeBlockingGate([blockingItem({ id: 'rvw_d1', kind: 'decision', title: 'Approve the plan' })]);
    const resolveReviewItemAsMonitor = vi.fn();
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      // The choice rides along because the resolve falls THROUGH to the
      // recommendation, and a recommendation without an on-menu choice now
      // writes nothing at all (CX-3) — which would hide what this test asserts.
      monitor: makeBlockingMonitor([
        { reviewItemId: 'rvw_d1', action: 'resolve', choice: 'approve', rationale: 'the gate is moot.' },
      ]),
      resolveReviewItemAsMonitor,
      annotateReviewItem,
    });

    await host.awaitBlockingReviewItems('r');

    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
    expect(annotateReviewItem).toHaveBeenCalledTimes(1);
  });

  it('downgrades to a recommendation once the WALK cap is spent', async () => {
    // One item per boundary, MONITOR_WALK_RESOLVE_CAP + 1 boundaries on ONE host.
    const total = MONITOR_WALK_RESOLVE_CAP + 1;
    const ids = Array.from({ length: total }, (_, i) => `rvw_f${i}`);
    const blockingGate = makeBlockingGate([]);
    const monitor: MonitorSession = {
      triage: vi.fn(),
      answer: vi.fn().mockResolvedValue(''),
      reviewBlockingItems: vi.fn(async (req: BlockingItemsEscalationRequest) =>
        req.items.map((i) => ({ reviewItemId: i.id, action: 'resolve' as const, rationale: 'already fixed.' })),
      ),
    };
    const resolveReviewItemAsMonitor = vi.fn(async (input: { reviewItemId: string }) => {
      blockingGate.items = blockingGate.items.filter((i) => i.id !== input.reviewItemId);
    });
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor, resolveReviewItemAsMonitor, annotateReviewItem,
      fileMonitorFinding: vi.fn().mockResolvedValue(undefined),
    });

    for (const id of ids) {
      blockingGate.items = [blockingItem({ id })];
      await host.awaitBlockingReviewItems('r');
    }

    expect(resolveReviewItemAsMonitor).toHaveBeenCalledTimes(MONITOR_WALK_RESOLVE_CAP);
    // The one past the cap became advice rather than being dropped.
    expect(annotateReviewItem).toHaveBeenCalledTimes(1);
  });

  it('abandons the resolve when the audit record cannot be filed (the durable cap is counted from it)', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const resolveReviewItemAsMonitor = vi.fn();
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'already fixed.' }]),
      resolveReviewItemAsMonitor,
      annotateReviewItem,
      fileMonitorFinding: vi.fn().mockRejectedValue(new Error('queue down')),
    });

    await host.awaitBlockingReviewItems('r');

    // Never resolved — the item keeps blocking and the advice reaches the human.
    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
    expect(annotateReviewItem).toHaveBeenCalledTimes(1);
    expect(blockingGate.trace).toEqual(['list', 'park']);

  });

  it('an abandoned resolve does NOT consume walk budget', async () => {
    // CAP + 1 boundaries on ONE host, the FIRST audit write failing. If the
    // abandoned item had spent a walk unit, only CAP - 1 of the rest could
    // resolve; it spends none, so all CAP of them do.
    const total = MONITOR_WALK_RESOLVE_CAP + 1;
    const blockingGate = makeBlockingGate([]);
    const monitor: MonitorSession = {
      triage: vi.fn(),
      answer: vi.fn().mockResolvedValue(''),
      reviewBlockingItems: vi.fn(async (req: BlockingItemsEscalationRequest) =>
        req.items.map((i) => ({ reviewItemId: i.id, action: 'resolve' as const, rationale: 'already fixed.' })),
      ),
    };
    const resolveReviewItemAsMonitor = vi.fn(async (input: { reviewItemId: string }) => {
      blockingGate.items = blockingGate.items.filter((i) => i.id !== input.reviewItemId);
    });
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const fileMonitorFinding = vi
      .fn()
      .mockRejectedValueOnce(new Error('queue down'))
      .mockResolvedValue(undefined);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor, resolveReviewItemAsMonitor, annotateReviewItem, fileMonitorFinding,
    });

    for (let i = 0; i < total; i += 1) {
      blockingGate.items = [blockingItem({ id: `rvw_f${i}` })];
      await host.awaitBlockingReviewItems('r');
    }

    expect(resolveReviewItemAsMonitor).toHaveBeenCalledTimes(MONITOR_WALK_RESOLVE_CAP);
    expect(annotateReviewItem).toHaveBeenCalledTimes(1);
  });

  it('downgrades to a recommendation when the DURABLE cap is already spent', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const resolveReviewItemAsMonitor = vi.fn();
    const annotateReviewItem = vi.fn().mockResolvedValue(undefined);
    const countMonitorResolves = vi.fn().mockResolvedValue(MONITOR_RUN_RESOLVE_CAP);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'already fixed.' }]),
      resolveReviewItemAsMonitor, annotateReviewItem, countMonitorResolves,
    });

    await host.awaitBlockingReviewItems('r');

    expect(countMonitorResolves).toHaveBeenCalledWith('r');
    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
    expect(annotateReviewItem).toHaveBeenCalledTimes(1);
  });

  it('treats an UNREADABLE durable budget as spent, never as free', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const resolveReviewItemAsMonitor = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'already fixed.' }]),
      resolveReviewItemAsMonitor,
      countMonitorResolves: vi.fn().mockRejectedValue(new Error('db boom')),
      annotateReviewItem: vi.fn().mockResolvedValue(undefined),
    });

    await host.awaitBlockingReviewItems('r');

    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
  });

  it('reviews each item ONCE per walk (a re-parked run is not re-litigated)', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const monitor = makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'pass', rationale: 'a human should look.' }]);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate, monitor,
    });

    await host.awaitBlockingReviewItems('r');
    await host.awaitBlockingReviewItems('r');

    expect(monitor.reviewBlockingItems).toHaveBeenCalledTimes(1);
  });

  it('consults about a NEWLY filed item even after an earlier boundary passed on another', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const monitor: MonitorSession = {
      triage: vi.fn(),
      answer: vi.fn().mockResolvedValue(''),
      reviewBlockingItems: vi.fn(async (req: BlockingItemsEscalationRequest) =>
        req.items.map((i) => ({ reviewItemId: i.id, action: 'pass' as const, rationale: 'x' })),
      ),
    };
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate, monitor,
    });

    await host.awaitBlockingReviewItems('r');
    blockingGate.items = [blockingItem(), blockingItem({ id: 'rvw_f2', title: 'second' })];
    await host.awaitBlockingReviewItems('r');

    const second = (monitor.reviewBlockingItems as ReturnType<typeof vi.fn>).mock
      .calls[1][0] as BlockingItemsEscalationRequest;
    expect(second.items.map((i) => i.id)).toEqual(['rvw_f2']);
  });

  it('goes straight to awaitClear when the kill switch is set (no read, no consult)', async () => {
    process.env[ESCALATION_REVIEW_KILL_SWITCH_ENV] = '1';
    const blockingGate = makeBlockingGate([blockingItem()]);
    const monitor = makeBlockingMonitor([{ reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'x' }]);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate, monitor,
      awaitReviewWritesSettled: vi.fn().mockResolvedValue(undefined),
    });

    await host.awaitBlockingReviewItems('r');

    expect(monitor.reviewBlockingItems).not.toHaveBeenCalled();
    expect(blockingGate.trace).toEqual(['park']);
  });

  it('never throws: a broken barrier, consult, resolve or annotate all still reach awaitClear', async () => {
    const blockingGate = makeBlockingGate([blockingItem()]);
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        reviewBlockingItems: vi.fn().mockRejectedValue(new Error('consult boom')),
      },
      awaitReviewWritesSettled: vi.fn().mockRejectedValue(new Error('barrier boom')),
      resolveReviewItemAsMonitor: vi.fn().mockRejectedValue(new Error('resolve boom')),
      annotateReviewItem: vi.fn().mockRejectedValue(new Error('annotate boom')),
    });

    await expect(host.awaitBlockingReviewItems('r')).resolves.toBe('proceed');
    expect(blockingGate.awaitClear).toHaveBeenCalledTimes(1);
  });

  // ── FB-4: a cancel between the consult and the applies discards the batch ──
  it('discards the verdicts (and marks nothing reviewed) when the run is canceled mid-consult', async () => {
    const controller = new AbortController();
    const blockingGate = makeBlockingGate([blockingItem()]);
    const resolveReviewItemAsMonitor = vi.fn();
    const annotateReviewItem = vi.fn();
    const fileMonitorFinding = vi.fn();
    const monitor: MonitorSession = {
      triage: vi.fn(),
      answer: vi.fn().mockResolvedValue(''),
      // The cancel lands WHILE the consult is in flight: the verdict resolves,
      // but the walk it belongs to no longer exists.
      reviewBlockingItems: vi.fn(async (): Promise<BlockingItemDecision[]> => {
        controller.abort();
        return [{ reviewItemId: 'rvw_f1', action: 'resolve', rationale: 'already fixed.' }];
      }),
    };
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate, monitor,
      resolveReviewItemAsMonitor, annotateReviewItem, fileMonitorFinding,
    });

    await host.awaitBlockingReviewItems('r', controller.signal);

    expect(resolveReviewItemAsMonitor).not.toHaveBeenCalled();
    expect(annotateReviewItem).not.toHaveBeenCalled();
    expect(fileMonitorFinding).not.toHaveBeenCalled();
    // …and the ids are NOT burned: a resumed run's next boundary looks again.
    await host.awaitBlockingReviewItems('r');
    expect(monitor.reviewBlockingItems).toHaveBeenCalledTimes(2);
  });

  // ── FB-8: the designed invalid_status race is not a failure and costs nothing ─
  it('spends no walk budget on a resolve the human answered first', async () => {
    const refusal = Object.assign(new Error('review item is not pending'), { code: 'invalid_status' });
    const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const blockingGate = makeBlockingGate([blockingItem()]);
    // The FIRST resolve is refused (a human triaged it mid-consult); the rest land.
    const resolveReviewItemAsMonitor = vi.fn(async ({ reviewItemId }: { reviewItemId: string }) => {
      if (reviewItemId === 'rvw_f0') throw refusal;
    });
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), blockingGate,
      monitor: {
        triage: vi.fn(),
        answer: vi.fn().mockResolvedValue(''),
        reviewBlockingItems: vi.fn(async (req: BlockingItemsEscalationRequest) =>
          req.items.map((i) => ({ reviewItemId: i.id, action: 'resolve' as const, rationale: 'already fixed.' })),
        ),
      },
      resolveReviewItemAsMonitor,
      annotateReviewItem: vi.fn().mockResolvedValue(undefined),
      fileMonitorFinding: vi.fn().mockResolvedValue(undefined),
      logger,
    });

    // CAP + 1 boundaries, one item each: the refused one must not have cost a unit.
    for (let i = 0; i <= MONITOR_WALK_RESOLVE_CAP; i += 1) {
      blockingGate.items = [blockingItem({ id: `rvw_f${i}` })];
      await host.awaitBlockingReviewItems('r');
    }

    expect(resolveReviewItemAsMonitor).toHaveBeenCalledTimes(MONITOR_WALK_RESOLVE_CAP + 1);
    expect(logger.info).toHaveBeenCalledWith(
      '[ProgrammaticRunHost] blocking finding triaged before the supervisor resolve landed',
      expect.objectContaining({ reviewItemId: 'rvw_f0' }),
    );
    // The designed race gets its OWN info log, not the generic apply warning.
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[ProgrammaticRunHost] blocking-item verdict not applied (fail-soft)',
      expect.anything(),
    );
  });

  it('is a no-op (no barrier, no consult) for a host built without a blocking gate', async () => {
    const awaitReviewWritesSettled = vi.fn();
    const host = new ProgrammaticRunHost({
      runId: 'r', projectId: 1, reporter: makeReporter(), gate: makeGate('approve'), awaitReviewWritesSettled,
    });

    expect(await host.awaitBlockingReviewItems('r')).toBe('proceed');
    expect(awaitReviewWritesSettled).not.toHaveBeenCalled();
  });
});
