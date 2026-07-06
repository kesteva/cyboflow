import { describe, it, expect, vi } from 'vitest';
import {
  DefaultMonitorSession,
  MonitorRegistry,
  buildTriagePrompt,
  buildAnswerPrompt,
  buildActionAnswerPrompt,
  parseTriageAdvice,
  parseConverseOutput,
  MONITOR_TRIAGE_SCHEMA,
  MONITOR_CONVERSE_SCHEMA,
  type HistoryReader,
  type MonitorContext,
  type MonitorHistory,
  type MonitorSession,
  type MonitorActions,
} from '../monitor';
import type { StructuredQueryFn, TextQueryFn } from '../monitorQuery';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import type { StepResultRow } from '../../stepResultStore';

function step(p: Partial<WorkflowStep> & { id: string }): WorkflowStep {
  return { name: p.id, agent: 'executor', mcps: [], retries: 0, ...p };
}

const ctx: MonitorContext = { runId: 'run-1', projectId: 1, workflowName: 'planner', worktreePath: '/wt' };

function userMsg(content: string): UnifiedMessage {
  return { id: `u-${content}`, role: 'user', timestamp: '2026-01-01T00:00:00.000Z', segments: [{ type: 'text', content }] };
}
function assistantMsg(content: string): UnifiedMessage {
  return {
    id: `a-${content}`,
    role: 'assistant',
    timestamp: '2026-01-01T00:00:01.000Z',
    segments: [{ type: 'text', content }],
  };
}
function stepRow(p: Partial<StepResultRow> & { stepId: string; outcome: StepResultRow['outcome'] }): StepResultRow {
  return { runId: 'run-1', phaseId: null, attempts: 1, summary: null, error: null, ...p };
}

/** A fake HistoryReader that records every read and returns a canned snapshot. */
function fakeHistory(snapshot: MonitorHistory): { reader: HistoryReader; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    reader: {
      async read(runId: string): Promise<MonitorHistory> {
        reads.push(runId);
        return snapshot;
      },
    },
  };
}

describe('parseTriageAdvice', () => {
  it('parses a valid structured verdict', () => {
    expect(parseTriageAdvice({ decision: 'retry', rationale: 'flaky' })).toEqual({ decision: 'retry', rationale: 'flaky' });
  });
  it("falls back to 'escalate' for unparseable / unknown verdicts", () => {
    expect(parseTriageAdvice(null).decision).toBe('escalate');
    expect(parseTriageAdvice({ decision: 'nope' }).decision).toBe('escalate');
    expect(parseTriageAdvice('garbage').decision).toBe('escalate');
  });
  it('tolerates a missing rationale', () => {
    expect(parseTriageAdvice({ decision: 'fail' })).toEqual({ decision: 'fail', rationale: '' });
  });
});

describe('MONITOR_TRIAGE_SCHEMA', () => {
  it('enforces a decision enum + rationale', () => {
    const props = MONITOR_TRIAGE_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.decision.enum).toEqual(['retry', 'escalate', 'fail']);
    expect(MONITOR_TRIAGE_SCHEMA.required).toEqual(['decision', 'rationale']);
  });
});

describe('buildTriagePrompt', () => {
  it('frames the supervisor and includes step, error, timeline, and conversation', () => {
    const history: MonitorHistory = {
      conversation: [userMsg('what is happening'), assistantMsg('running steps')],
      steps: [stepRow({ stepId: 'epics', outcome: 'failed', error: 'boom' })],
    };
    const p = buildTriagePrompt(ctx, step({ id: 'epics', name: 'Epics', agent: 'epics' }), 'boom', history);
    expect(p).toContain('SUPERVISOR');
    expect(p).toContain('`epics`');
    expect(p).toContain('boom');
    expect(p).toContain('retry');
    expect(p).toContain('escalate');
    expect(p).toContain('fail');
    expect(p).toContain('running steps'); // conversation digest
    expect(p).toContain('epics'); // step timeline
  });
});

describe('buildAnswerPrompt', () => {
  it('frames the supervisor and includes the question + history digest', () => {
    const history: MonitorHistory = {
      conversation: [assistantMsg('finished analyze')],
      steps: [stepRow({ stepId: 'analyze', outcome: 'done' })],
    };
    const p = buildAnswerPrompt(ctx, 'why did it stop?', history);
    expect(p).toContain('SUPERVISOR');
    expect(p).toContain('why did it stop?');
    expect(p).toContain('finished analyze');
    expect(p).toContain('analyze');
  });
});

describe('DefaultMonitorSession.triage', () => {
  it('reads the whole history, runs a structured query, and returns the parsed decision', async () => {
    const { reader, reads } = fakeHistory({
      conversation: [userMsg('hi')],
      steps: [stepRow({ stepId: 'a', outcome: 'failed', error: 'boom' })],
    });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({ decision: 'retry', rationale: 'transient' });
    const textQuery: TextQueryFn = vi.fn();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery });

    const advice = await session.triage(step({ id: 'a' }), 'boom');

    expect(advice).toEqual({ decision: 'retry', rationale: 'transient' });
    expect(reads).toEqual(['run-1']);
    const args = (structuredQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.schema).toBe(MONITOR_TRIAGE_SCHEMA);
    expect(args.cwd).toBe('/wt');
    expect(args.prompt).toContain('`a`');
    expect(args.prompt).toContain('boom');
  });

  it('passes through the abort signal and the model when provided', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({ decision: 'fail', rationale: 'definitive' });
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), model: 'opus' });
    const controller = new AbortController();

    await session.triage(step({ id: 'a' }), undefined, controller.signal);

    const args = (structuredQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.signal).toBe(controller.signal);
    expect(args.model).toBe('opus');
  });

  it("fails-soft to 'escalate' when the query throws", async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn() });

    const advice = await session.triage(step({ id: 'a' }), 'boom');

    expect(advice.decision).toBe('escalate');
    expect(advice.rationale).toContain('monitor failed');
  });

  it("fails-soft to 'escalate' when the history read throws", async () => {
    const reader: HistoryReader = { read: vi.fn().mockRejectedValue(new Error('db gone')) };
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery: vi.fn() });

    expect((await session.triage(step({ id: 'a' }), 'boom')).decision).toBe('escalate');
  });

  it("parses an unusable structured result to an 'escalate' fallback", async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue(null);
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn() });

    expect((await session.triage(step({ id: 'a' }), undefined)).decision).toBe('escalate');
  });
});

describe('DefaultMonitorSession.answer', () => {
  it('reads the whole history, runs a text query, and returns the reply', async () => {
    const { reader, reads } = fakeHistory({ conversation: [userMsg('status?')], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('We finished step 1 and are on step 2.');
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery });

    const reply = await session.answer('status?');

    expect(reply).toBe('We finished step 1 and are on step 2.');
    expect(reads).toEqual(['run-1']);
    const args = (textQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.cwd).toBe('/wt');
    expect(args.prompt).toContain('status?');
  });

  it('reads the history FRESH on each call (no accumulated feed)', async () => {
    const { reader, reads } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('ok');
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery });

    await session.answer('q1');
    await session.answer('q2');

    expect(reads).toEqual(['run-1', 'run-1']);
  });

  it('fails-soft to an apologetic string when the text query throws', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery });

    const reply = await session.answer('q');

    expect(reply.toLowerCase()).toContain('sorry');
  });
});

describe('parseConverseOutput', () => {
  it('parses a reply with no action', () => {
    expect(parseConverseOutput({ reply: 'hello' })).toEqual({ reply: 'hello' });
  });

  it('parses a reply with a valid retry_step action (with and without stepId)', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'retry_step', stepId: 'tasks' } })).toEqual({
      reply: 'ok',
      action: { kind: 'retry_step', stepId: 'tasks' },
    });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'retry_step' } })).toEqual({
      reply: 'ok',
      action: { kind: 'retry_step' },
    });
  });

  it('drops an unknown action kind', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'delete_everything' } })).toEqual({ reply: 'ok' });
  });

  it('drops a malformed action (non-string stepId, non-object action)', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'retry_step', stepId: 42 } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: 'retry_step' })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: null })).toEqual({ reply: 'ok' });
  });

  it('never throws: missing/non-string reply falls back to empty string', () => {
    expect(parseConverseOutput(null)).toEqual({ reply: '' });
    expect(parseConverseOutput('garbage')).toEqual({ reply: '' });
    expect(parseConverseOutput({})).toEqual({ reply: '' });
    expect(parseConverseOutput({ reply: 42 })).toEqual({ reply: '' });
  });
});

describe('MONITOR_CONVERSE_SCHEMA', () => {
  it('requires reply, makes action optional, and enforces the retry_step kind enum', () => {
    expect(MONITOR_CONVERSE_SCHEMA.required).toEqual(['reply']);
    expect(MONITOR_CONVERSE_SCHEMA.additionalProperties).toBe(false);
    const props = MONITOR_CONVERSE_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props.action.additionalProperties).toBe(false);
    const actionProps = props.action.properties as Record<string, { enum?: string[] }>;
    expect(actionProps.kind.enum).toEqual(['retry_step']);
  });
});

describe('buildActionAnswerPrompt', () => {
  it('includes the capabilities contract, the retry_step action, and the question', () => {
    const history: MonitorHistory = {
      conversation: [assistantMsg('finished analyze')],
      steps: [stepRow({ stepId: 'tasks', outcome: 'failed', error: 'boom' })],
    };
    const p = buildActionAnswerPrompt(ctx, 'retry the failed step please', history);
    expect(p).toContain('retry_step');
    expect(p).toContain('retry the failed step please');
    expect(p).toContain('tasks'); // step timeline
    expect(p).toContain('finished analyze'); // conversation digest
    expect(p).not.toContain('do NOT try to run, edit, or re-order steps');
  });
});

describe('DefaultMonitorSession.converse', () => {
  it('injects the user turn, answers, then injects the reply (in that order)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('the monitor reply');
    const injected: Array<{ role: string; text: string }> = [];
    const injectEvent = (event: unknown): void => {
      // Narrow the synthetic event to its role + first text block (no `any`).
      const e = event as {
        type: string;
        message: { role: string; content: Array<{ type: string; text?: string }> };
      };
      const text = e.message.content.find((b) => b.type === 'text')?.text ?? '';
      injected.push({ role: e.message.role, text });
    };
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery: vi.fn(),
      textQuery,
      injectEvent,
    });

    const reply = await session.converse('why did step 2 fail?');

    expect(reply).toBe('the monitor reply');
    // user turn injected BEFORE the assistant reply.
    expect(injected).toEqual([
      { role: 'user', text: 'why did step 2 fail?' },
      { role: 'assistant', text: 'the monitor reply' },
    ]);
  });

  it('still answers (no render) when no injectEvent is wired', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('bare reply');
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery });

    const reply = await session.converse('q');

    expect(reply).toBe('bare reply');
  });

  it('fails-soft: a throwing injectEvent does not throw out of converse', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('reply');
    const injectEvent = (): void => {
      throw new Error('bridge gone');
    };
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery: vi.fn(),
      textQuery,
      injectEvent,
    });

    await expect(session.converse('q')).resolves.toBe('reply');
  });

  it('injects an apologetic assistant turn when the answer query fails (fail-soft)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const injected: string[] = [];
    const injectEvent = (event: unknown): void => {
      const e = event as { message: { role: string; content: Array<{ type: string; text?: string }> } };
      if (e.message.role === 'assistant') {
        injected.push(e.message.content.find((b) => b.type === 'text')?.text ?? '');
      }
    };
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery: vi.fn(),
      textQuery,
      injectEvent,
    });

    const reply = await session.converse('q');

    expect(reply.toLowerCase()).toContain('sorry');
    expect(injected[0]?.toLowerCase()).toContain('sorry');
  });

  it('renders a placeholder assistant turn when the answer is empty (no silent drop)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    // A successful-but-EMPTY answer ('' / whitespace) must NOT render as nothing.
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('   ');
    const injected: Array<{ role: string; text: string }> = [];
    const injectEvent = (event: unknown): void => {
      const e = event as { message: { role: string; content: Array<{ type: string; text?: string }> } };
      injected.push({ role: e.message.role, text: e.message.content.find((b) => b.type === 'text')?.text ?? '' });
    };
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery, injectEvent });

    const reply = await session.converse('q');

    expect(reply.trim().length).toBeGreaterThan(0);
    const assistant = injected.find((m) => m.role === 'assistant');
    expect(assistant?.text.trim().length).toBeGreaterThan(0);
    expect(assistant?.text).toBe(reply);
  });

  it('serializes concurrent converse calls so their turns never interleave', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    let call = 0;
    const textQuery: TextQueryFn = vi.fn().mockImplementation(() => {
      call += 1;
      const n = call;
      // The FIRST answer is slow: were converse not serialized, the second call's
      // user turn + (fast) reply would inject before the first call's reply.
      const delay = n === 1 ? 20 : 0;
      return new Promise<string>((resolve) => setTimeout(() => resolve(`r${n}`), delay));
    });
    const injected: Array<{ role: string; text: string }> = [];
    const injectEvent = (event: unknown): void => {
      const e = event as { message: { role: string; content: Array<{ type: string; text?: string }> } };
      injected.push({ role: e.message.role, text: e.message.content.find((b) => b.type === 'text')?.text ?? '' });
    };
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery, injectEvent });

    // Fire both WITHOUT awaiting the first — they must still run strictly in order.
    const p1 = session.converse('first');
    const p2 = session.converse('second');
    await Promise.all([p1, p2]);

    expect(injected).toEqual([
      { role: 'user', text: 'first' },
      { role: 'assistant', text: 'r1' },
      { role: 'user', text: 'second' },
      { role: 'assistant', text: 'r2' },
    ]);
  });
});

/** Collect injected turns as { role, text } pairs, in order. */
function collectInjected(): { injectEvent: (event: unknown) => void; injected: Array<{ role: string; text: string }> } {
  const injected: Array<{ role: string; text: string }> = [];
  const injectEvent = (event: unknown): void => {
    const e = event as { message: { role: string; content: Array<{ type: string; text?: string }> } };
    injected.push({ role: e.message.role, text: e.message.content.find((b) => b.type === 'text')?.text ?? '' });
  };
  return { injectEvent, injected };
}

describe('DefaultMonitorSession.converse — actuation (MonitorActions seam)', () => {
  it('with no actions wired, converse uses textQuery exactly as before (structuredQuery untouched)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('plain answer');
    const structuredQuery: StructuredQueryFn = vi.fn();
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery, injectEvent });

    const reply = await session.converse('what happened?');

    expect(reply).toBe('plain answer');
    expect(structuredQuery).not.toHaveBeenCalled();
    expect(textQuery).toHaveBeenCalledTimes(1);
    expect(injected).toEqual([
      { role: 'user', text: 'what happened?' },
      { role: 'assistant', text: 'plain answer' },
    ]);
  });

  it('with actions wired and a plain reply (no action), runs the action-capable structured query and does NOT call retryStep', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({ reply: 'the run is on step 3' });
    const textQuery: TextQueryFn = vi.fn();
    const retryStep = vi.fn<MonitorActions['retryStep']>();
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery,
      injectEvent,
      actions,
    });

    const reply = await session.converse('what step are we on?');

    expect(reply).toBe('the run is on step 3');
    expect(textQuery).not.toHaveBeenCalled();
    const args = (structuredQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.schema).toBe(MONITOR_CONVERSE_SCHEMA);
    expect(args.prompt).toContain('retry_step');
    expect(retryStep).not.toHaveBeenCalled();
    expect(injected).toEqual([
      { role: 'user', text: 'what step are we on?' },
      { role: 'assistant', text: 'the run is on step 3' },
    ]);
  });

  it('a retry_step action calls retryStep(stepId) and injects a ▶-prefixed success turn; the returned reply is unchanged', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ reply: 'retrying tasks now.', action: { kind: 'retry_step', stepId: 'tasks' } });
    const retryStep = vi.fn<MonitorActions['retryStep']>().mockResolvedValue({ ok: true, message: 'run resumed from tasks' });
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions,
    });

    const reply = await session.converse('please retry the tasks step');

    expect(reply).toBe('retrying tasks now.');
    expect(retryStep).toHaveBeenCalledTimes(1);
    expect(retryStep).toHaveBeenCalledWith('tasks');
    expect(injected).toEqual([
      { role: 'user', text: 'please retry the tasks step' },
      { role: 'assistant', text: 'retrying tasks now.' },
      { role: 'assistant', text: '▶ run resumed from tasks' },
    ]);
  });

  it('a retry_step action resolving ok:false injects a ⚠-prefixed turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ reply: 'attempting retry.', action: { kind: 'retry_step' } });
    const retryStep = vi.fn<MonitorActions['retryStep']>().mockResolvedValue({ ok: false, message: 'run is not failed or resting' });
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions,
    });

    await session.converse('retry it');

    expect(retryStep).toHaveBeenCalledWith(undefined);
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ run is not failed or resting' });
  });

  it('a throwing retryStep fails soft: injects a generic warning turn, converse still resolves with the reply', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ reply: 'retrying now.', action: { kind: 'retry_step', stepId: 'tasks' } });
    const retryStep = vi.fn<MonitorActions['retryStep']>().mockRejectedValue(new Error('handler exploded'));
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions,
    });

    const reply = await session.converse('retry the tasks step');

    expect(reply).toBe('retrying now.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ The retry action failed unexpectedly.' });
  });

  it('malformed structured output (no reply) renders NO_ANSWER; a malformed action is dropped and retryStep is never called', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ action: { kind: 'retry_step', stepId: 42 } });
    const retryStep = vi.fn<MonitorActions['retryStep']>();
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions,
    });

    const reply = await session.converse('retry it');

    expect(reply).toBe('I could not produce an answer for that.');
    expect(retryStep).not.toHaveBeenCalled();
    expect(injected).toEqual([
      { role: 'user', text: 'retry it' },
      { role: 'assistant', text: 'I could not produce an answer for that.' },
    ]);
  });

  it('a throwing structuredQuery fails soft to ANSWER_FAILED with no action attempted', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const retryStep = vi.fn<MonitorActions['retryStep']>();
    const actions: MonitorActions = { retryStep };
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions,
    });

    const reply = await session.converse('retry it');

    expect(reply.toLowerCase()).toContain('sorry');
    expect(retryStep).not.toHaveBeenCalled();
    expect(injected.at(-1)?.text.toLowerCase()).toContain('sorry');
  });
});

describe('MonitorRegistry', () => {
  it('registers, gets, and unregisters a session by runId', () => {
    MonitorRegistry._resetForTesting();
    const reg = MonitorRegistry.getInstance();
    const fake: MonitorSession = { triage: vi.fn(), answer: vi.fn() };

    expect(reg.get('run-1')).toBeUndefined();
    reg.register('run-1', fake);
    expect(reg.get('run-1')).toBe(fake);
    reg.unregister('run-1');
    expect(reg.get('run-1')).toBeUndefined();
  });

  it('is a singleton', () => {
    MonitorRegistry._resetForTesting();
    expect(MonitorRegistry.getInstance()).toBe(MonitorRegistry.getInstance());
  });
});
