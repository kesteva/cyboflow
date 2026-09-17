import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DefaultMonitorSession,
  DefaultHistoryReader,
  MonitorRegistry,
  buildTriagePrompt,
  buildAnswerPrompt,
  buildActionAnswerPrompt,
  buildLaneTriagePrompt,
  parseTriageAdvice,
  parseConverseOutput,
  parseLaneTriageOutput,
  MONITOR_TRIAGE_SCHEMA,
  MONITOR_CONVERSE_SCHEMA,
  MONITOR_LANE_TRIAGE_SCHEMA,
  type HistoryReader,
  type MonitorContext,
  type MonitorHistory,
  type MonitorSession,
  type MonitorActions,
  type LaneTriageRequest,
} from '../monitor';
import type { StructuredQueryFn, TextQueryFn } from '../monitorQuery';
import type { WorkflowStep } from '../../../../../shared/types/workflows';
import type { UnifiedMessage } from '../../../../../shared/types/unifiedMessage';
import { StepResultStore, type StepResultRow } from '../../stepResultStore';
import { SprintLaneStore } from '../../sprintLaneStore';
import type { DatabaseLike, PreparedStatement } from '../../types';
import type { SprintLaneRow } from '../../../../../shared/types/sprintBatch';

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
function laneRow(p: Partial<SprintLaneRow> & { taskId: string; status: SprintLaneRow['status'] }): SprintLaneRow {
  return {
    batchId: 'batch-1',
    currentStepId: null,
    ref: p.taskId,
    title: null,
    attempts: 0,
    blockedByRefs: [],
    // F8: the lane read-model now carries its derived visual-verification
    // outcome; the monitor never reads it, so the fixture default is "no row".
    visualVerification: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...p,
  };
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

describe('laneSection (per-task fan-out lanes in the prompt)', () => {
  const sprintCtx: MonitorContext = { ...ctx, workflowName: 'sprint' };

  it('surfaces per-task lane state and marks it authoritative over the step timeline', () => {
    // The exact trap this fix targets: the step timeline only knows the opaque
    // fan-out container step, while a task has actually integrated.
    const history: MonitorHistory = {
      conversation: [],
      // Mirrors the real programmatic-sprint trap: step_results holds only the
      // pre-fan-out step; the `execute-tasks` container has no settled row, so the
      // timeline alone looks like "nothing past analyze-dependencies has run".
      steps: [stepRow({ stepId: 'analyze-dependencies', outcome: 'done' })],
      lanes: [
        laneRow({ taskId: 'TASK-065', status: 'integrated', currentStepId: 'task-verify' }),
        laneRow({ taskId: 'TASK-066', status: 'queued' }),
      ],
    };
    for (const p of [
      buildAnswerPrompt(sprintCtx, 'is task 65 done?', history),
      buildTriagePrompt(sprintCtx, step({ id: 'execute-tasks' }), undefined, history),
      buildActionAnswerPrompt(sprintCtx, 'is task 65 done?', history),
    ]) {
      expect(p).toContain('Sprint task lanes');
      expect(p).toContain('TASK-065: integrated @ task-verify');
      expect(p).toContain('TASK-066: queued');
      // The anti-trap instruction: trust the lanes, not the step timeline.
      expect(p).toContain('trust these lanes, not the step timeline');
      // Conservative `integrated` wording (Codex finding 1): describe the configured
      // chain, never assert specific checks ran — optional steps can be skipped and
      // the chain is user-editable, so integrated ≠ "reviewed, verified".
      expect(p).toContain('configured task chain');
      expect(p).toContain('do NOT');
      expect(p).not.toContain('implemented, reviewed, verified');
    }
  });

  it('warns (not silently omits) when the lane read was unavailable', () => {
    // A read FAILURE leaves lanes empty but sets lanesUnavailable — the prompt must
    // tell the monitor NOT to fall back to the collapsed timeline (Codex finding 2).
    const history: MonitorHistory = { conversation: [], steps: [], lanes: [], lanesUnavailable: true };
    const p = buildAnswerPrompt(sprintCtx, 'is task 65 done?', history);
    expect(p).toContain('per-task progress could NOT be read');
    expect(p).toContain('temporarily unavailable');
    // It must NOT render the authoritative-lanes header (there are no lanes to show).
    expect(p).not.toContain('AUTHORITATIVE for per-task state');
  });

  it('renders attempts (re-delegation) and in-batch blockers', () => {
    const history: MonitorHistory = {
      conversation: [],
      steps: [],
      lanes: [
        laneRow({ taskId: 'TASK-064', status: 'running', currentStepId: 'implement', attempts: 3 }),
        laneRow({ taskId: 'TASK-066', status: 'queued', blockedByRefs: ['TASK-065'] }),
      ],
    };
    const p = buildAnswerPrompt(sprintCtx, 'status?', history);
    expect(p).toContain('TASK-064: running @ implement, attempt 3');
    expect(p).toContain('TASK-066: queued — blocked on TASK-065');
  });

  it('omits the lane section entirely for a non-sprint run (byte-identical prompt)', () => {
    const withUndefined: MonitorHistory = { conversation: [], steps: [] };
    const withEmpty: MonitorHistory = { conversation: [], steps: [], lanes: [] };
    for (const h of [withUndefined, withEmpty]) {
      const p = buildAnswerPrompt(ctx, 'why did it stop?', h);
      expect(p).not.toContain('Sprint task lanes');
    }
    // The undefined-lanes prompt must equal the pre-fix output (no added whitespace).
    expect(buildAnswerPrompt(ctx, 'q', withUndefined)).toEqual(buildAnswerPrompt(ctx, 'q', withEmpty));
  });
});

describe('DefaultHistoryReader lane read (failure vs. genuine no-lanes)', () => {
  beforeEach(() => {
    SprintLaneStore._resetForTesting();
    StepResultStore._resetForTesting();
  });
  afterEach(() => {
    SprintLaneStore._resetForTesting();
    StepResultStore._resetForTesting();
  });

  /** A stmt whose reads return canned values — serves raw_events (.all) + the batch lookup (.get). */
  function okStmt(batchId: string | null): PreparedStatement {
    return {
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      get: () => (batchId === null ? {} : { batchId }),
      all: () => [],
    };
  }
  /** A stmt whose reads THROW — simulates a schema/corruption/query error in listLanes. */
  const throwingStmt: PreparedStatement = {
    run: () => ({ changes: 0, lastInsertRowid: 0 }),
    get: () => {
      throw new Error('db corrupt');
    },
    all: () => {
      throw new Error('db corrupt');
    },
  };
  function fakeDb(stmt: PreparedStatement): DatabaseLike {
    return { prepare: () => stmt, transaction: (fn: () => unknown) => fn } as unknown as DatabaseLike;
  }

  it('marks lanes UNAVAILABLE (not empty) when the lane read throws', async () => {
    // Reader db resolves a batch id (so we are past the non-sprint short-circuit); the
    // store's own db throws, so listLanes fails — the exact silent-fallback hole.
    SprintLaneStore.initialize(fakeDb(throwingStmt));
    const reader = new DefaultHistoryReader(fakeDb(okStmt('batch-1')));

    const history = await reader.read('run-1');

    expect(history.lanes).toEqual([]);
    expect(history.lanesUnavailable).toBe(true);
    // And it renders as a warning, not a silently-dropped section.
    const p = buildAnswerPrompt({ ...ctx, workflowName: 'sprint' }, 'is task 65 done?', history);
    expect(p).toContain('per-task progress could NOT be read');
  });

  it('reports a genuine non-sprint run as available with no lanes (no warning)', async () => {
    SprintLaneStore.initialize(fakeDb(okStmt(null)));
    const reader = new DefaultHistoryReader(fakeDb(okStmt(null)));

    const history = await reader.read('run-1');

    expect(history.lanes).toEqual([]);
    expect(history.lanesUnavailable).toBeUndefined();
    expect(buildAnswerPrompt(ctx, 'q', history)).not.toContain('Sprint task lanes');
  });

  it('does not flag unavailable when the store is uninitialized (early boot / tests)', async () => {
    // No SprintLaneStore.initialize — tryGetInstance() is null. That is NOT a failure.
    const reader = new DefaultHistoryReader(fakeDb(okStmt('batch-1')));

    const history = await reader.read('run-1');

    expect(history.lanes).toEqual([]);
    expect(history.lanesUnavailable).toBeUndefined();
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

  it('parses a switch_to_orchestrated action with a reason (stored verbatim)', () => {
    expect(
      parseConverseOutput({
        reply: 'handing over',
        action: { kind: 'switch_to_orchestrated', reason: '  Fix the merge conflict by hand, then keep going.  ' },
      }),
    ).toEqual({
      reply: 'handing over',
      // reason is validated on its trimmed form but stored verbatim (surrounding whitespace preserved).
      action: { kind: 'switch_to_orchestrated', reason: '  Fix the merge conflict by hand, then keep going.  ' },
    });
  });

  it('drops a switch_to_orchestrated action with a missing / blank / non-string reason', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'switch_to_orchestrated' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'switch_to_orchestrated', reason: '   ' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'switch_to_orchestrated', reason: 42 } })).toEqual({ reply: 'ok' });
  });

  it('parses a valid add_task action (title required; body/priority optional)', () => {
    expect(parseConverseOutput({ reply: 'adding it.', action: { kind: 'add_task', title: 'New task' } })).toEqual({
      reply: 'adding it.',
      action: { kind: 'add_task', title: 'New task' },
    });
    expect(
      parseConverseOutput({
        reply: 'adding it.',
        action: { kind: 'add_task', title: 'New task', body: 'details', priority: 'high' },
      }),
    ).toEqual({
      reply: 'adding it.',
      action: { kind: 'add_task', title: 'New task', body: 'details', priority: 'high' },
    });
  });

  it('drops add_task when title is missing/blank/non-string', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'add_task' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'add_task', title: '   ' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'add_task', title: 42 } })).toEqual({ reply: 'ok' });
  });

  it('parses a valid remove_task action', () => {
    expect(parseConverseOutput({ reply: 'removing it.', action: { kind: 'remove_task', taskRef: 'TASK-1' } })).toEqual({
      reply: 'removing it.',
      action: { kind: 'remove_task', taskRef: 'TASK-1' },
    });
  });

  it('drops remove_task when taskRef is missing/blank', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'remove_task' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'remove_task', taskRef: '' } })).toEqual({ reply: 'ok' });
  });

  it('parses a valid edit_task action (taskRef + at least one of title/body/priority)', () => {
    expect(
      parseConverseOutput({ reply: 'editing it.', action: { kind: 'edit_task', taskRef: 'TASK-1', title: 'Renamed' } }),
    ).toEqual({ reply: 'editing it.', action: { kind: 'edit_task', taskRef: 'TASK-1', title: 'Renamed' } });
    expect(
      parseConverseOutput({ reply: 'editing it.', action: { kind: 'edit_task', taskRef: 'TASK-1', priority: 'low' } }),
    ).toEqual({ reply: 'editing it.', action: { kind: 'edit_task', taskRef: 'TASK-1', priority: 'low' } });
  });

  it('drops edit_task when taskRef is missing or no field to change is present', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'edit_task', title: 'Renamed' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'edit_task', taskRef: 'TASK-1' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'edit_task', taskRef: 'TASK-1', title: '   ' } })).toEqual({
      reply: 'ok',
    });
  });

  it('parses valid skip_step / unskip_step actions', () => {
    expect(parseConverseOutput({ reply: 'skipping.', action: { kind: 'skip_step', stepId: 'tasks' } })).toEqual({
      reply: 'skipping.',
      action: { kind: 'skip_step', stepId: 'tasks' },
    });
    expect(parseConverseOutput({ reply: 'unskipping.', action: { kind: 'unskip_step', stepId: 'tasks' } })).toEqual({
      reply: 'unskipping.',
      action: { kind: 'unskip_step', stepId: 'tasks' },
    });
  });

  it('drops skip_step / unskip_step when stepId is missing/blank', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'skip_step' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'unskip_step', stepId: '' } })).toEqual({ reply: 'ok' });
  });

  it('parses a valid steer_step action (stepId + guidance both required)', () => {
    expect(
      parseConverseOutput({
        reply: 'steering it.',
        action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful with the migration' },
      }),
    ).toEqual({
      reply: 'steering it.',
      action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful with the migration' },
    });
  });

  it('drops steer_step when stepId or guidance is missing/blank', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'steer_step', stepId: 'tasks' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'steer_step', guidance: 'be careful' } })).toEqual({
      reply: 'ok',
    });
    expect(
      parseConverseOutput({ reply: 'ok', action: { kind: 'steer_step', stepId: 'tasks', guidance: '   ' } }),
    ).toEqual({ reply: 'ok' });
  });

  it('parses a valid steer_step action with taskRef passed through verbatim', () => {
    expect(
      parseConverseOutput({
        reply: 'steering it.',
        action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful', taskRef: 'TASK-3' },
      }),
    ).toEqual({
      reply: 'steering it.',
      action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful', taskRef: 'TASK-3' },
    });
  });

  it('leaves taskRef absent on steer_step when not provided (and drops a blank one without dropping the action)', () => {
    // Absent taskRef stays absent — no key at all.
    expect(
      parseConverseOutput({ reply: 'ok', action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful' } }),
    ).toEqual({ reply: 'ok', action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful' } });
    // A blank taskRef is optional, so it does not invalidate the whole action — it is simply dropped.
    expect(
      parseConverseOutput({
        reply: 'ok',
        action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful', taskRef: '   ' },
      }),
    ).toEqual({ reply: 'ok', action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful' } });
    // A non-string taskRef drops the whole action, mirroring every other optional-field type check.
    expect(
      parseConverseOutput({
        reply: 'ok',
        action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be careful', taskRef: 42 },
      }),
    ).toEqual({ reply: 'ok' });
  });

  it('parses a valid rewind_to_step action', () => {
    expect(parseConverseOutput({ reply: 'rewinding it.', action: { kind: 'rewind_to_step', stepId: 'analyze' } })).toEqual({
      reply: 'rewinding it.',
      action: { kind: 'rewind_to_step', stepId: 'analyze' },
    });
  });

  it('parses a valid rewind_lane_to_step action', () => {
    expect(
      parseConverseOutput({
        reply: 'sending that lane back.',
        action: { kind: 'rewind_lane_to_step', taskRef: 'TASK-003', stepId: 'implement' },
      }),
    ).toEqual({
      reply: 'sending that lane back.',
      action: { kind: 'rewind_lane_to_step', taskRef: 'TASK-003', stepId: 'implement' },
    });
  });

  it('drops rewind_lane_to_step when EITHER taskRef or stepId is missing/blank', () => {
    // Unlike steer_step's optional lane narrowing, a lane rewind without a lane is
    // meaningless — so a missing taskRef drops the whole action.
    const drop = (action: unknown): unknown => parseConverseOutput({ reply: 'ok', action });
    expect(drop({ kind: 'rewind_lane_to_step', stepId: 'implement' })).toEqual({ reply: 'ok' });
    expect(drop({ kind: 'rewind_lane_to_step', taskRef: 'TASK-003' })).toEqual({ reply: 'ok' });
    expect(drop({ kind: 'rewind_lane_to_step', taskRef: '  ', stepId: 'implement' })).toEqual({ reply: 'ok' });
    expect(drop({ kind: 'rewind_lane_to_step', taskRef: 'TASK-003', stepId: '  ' })).toEqual({ reply: 'ok' });
    expect(drop({ kind: 'rewind_lane_to_step', taskRef: 7, stepId: 'implement' })).toEqual({ reply: 'ok' });
  });

  it('drops rewind_to_step when stepId is missing/blank/non-string', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'rewind_to_step' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'rewind_to_step', stepId: '   ' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'rewind_to_step', stepId: 42 } })).toEqual({ reply: 'ok' });
  });

  it('parses a valid resolve_review_item action (outcome/resolution optional)', () => {
    expect(
      parseConverseOutput({ reply: 'resolving it.', action: { kind: 'resolve_review_item', reviewItemId: 'RI-1' } }),
    ).toEqual({ reply: 'resolving it.', action: { kind: 'resolve_review_item', reviewItemId: 'RI-1' } });
    expect(
      parseConverseOutput({
        reply: 'resolving it.',
        action: { kind: 'resolve_review_item', reviewItemId: 'RI-1', outcome: 'approve', resolution: 'looks fine' },
      }),
    ).toEqual({
      reply: 'resolving it.',
      action: { kind: 'resolve_review_item', reviewItemId: 'RI-1', outcome: 'approve', resolution: 'looks fine' },
    });
  });

  it('drops resolve_review_item when reviewItemId is missing/blank', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'resolve_review_item' } })).toEqual({ reply: 'ok' });
  });

  it('keeps a resolve_review_item action but drops an invalid outcome', () => {
    expect(
      parseConverseOutput({
        reply: 'resolving it.',
        action: { kind: 'resolve_review_item', reviewItemId: 'RI-1', outcome: 'maybe' },
      }),
    ).toEqual({ reply: 'resolving it.', action: { kind: 'resolve_review_item', reviewItemId: 'RI-1' } });
  });

  it('parses a valid file_note action (title required; body optional)', () => {
    expect(parseConverseOutput({ reply: 'filing it.', action: { kind: 'file_note', title: 'Heads up' } })).toEqual({
      reply: 'filing it.',
      action: { kind: 'file_note', title: 'Heads up' },
    });
    expect(
      parseConverseOutput({ reply: 'filing it.', action: { kind: 'file_note', title: 'Heads up', body: 'some detail' } }),
    ).toEqual({ reply: 'filing it.', action: { kind: 'file_note', title: 'Heads up', body: 'some detail' } });
  });

  it('drops file_note when title is missing/blank', () => {
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'file_note' } })).toEqual({ reply: 'ok' });
    expect(parseConverseOutput({ reply: 'ok', action: { kind: 'file_note', title: '' } })).toEqual({ reply: 'ok' });
  });

  it('maps a confirm signal to control (never a ConverseAction)', () => {
    expect(parseConverseOutput({ reply: 'confirming.', action: { kind: 'confirm' } })).toEqual({
      reply: 'confirming.',
      control: 'confirm',
    });
  });

  it('maps a cancel signal to control (never a ConverseAction)', () => {
    expect(parseConverseOutput({ reply: 'discarding.', action: { kind: 'cancel' } })).toEqual({
      reply: 'discarding.',
      control: 'cancel',
    });
  });
});

describe('MONITOR_CONVERSE_SCHEMA', () => {
  it('requires reply, makes action optional, and enforces the kind enum (12 actions + 2 control signals)', () => {
    expect(MONITOR_CONVERSE_SCHEMA.required).toEqual(['reply']);
    expect(MONITOR_CONVERSE_SCHEMA.additionalProperties).toBe(false);
    const props = MONITOR_CONVERSE_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props.action.additionalProperties).toBe(false);
    expect(props.action.required).toEqual(['kind']);
    const actionProps = props.action.properties as Record<string, { type?: string; enum?: string[] }>;
    expect(actionProps.kind.enum).toEqual([
      'retry_step',
      'switch_to_orchestrated',
      'add_task',
      'remove_task',
      'edit_task',
      'skip_step',
      'unskip_step',
      'steer_step',
      'rewind_to_step',
      'rewind_lane_to_step',
      'resolve_review_item',
      'file_note',
      'confirm',
      'cancel',
    ]);
    // Every kind-specific field is declared and optional at the schema level (only
    // the fields relevant to the chosen `kind` should be set).
    for (const field of [
      'stepId',
      'reason',
      'title',
      'body',
      'priority',
      'taskRef',
      'guidance',
      'reviewItemId',
      'resolution',
    ]) {
      expect(actionProps[field].type).toBe('string');
    }
    expect(actionProps.outcome.enum).toEqual(['approve', 'reject']);
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
    expect(p).not.toContain('(for example, after a usage-limit reset)');
    expect(p).toContain('PAUSED on a usage-limit item');
    expect(p).toContain('host resolves that pause');
  });

  it('offers switch_to_orchestrated with the explicit-confirmation + one-way framing', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'fix the conflict by hand then continue', history);
    expect(p).toContain('switch_to_orchestrated');
    expect(p).toContain('EXPLICIT confirmation'); // must wait for a later-turn confirmation
    expect(p).toContain('ONE-WAY'); // the run does not return to step-by-step execution
    expect(p).toContain('reason'); // attach a faithful summary
    // Existing framing stays intact: explicit-ask-only + never-claim-success.
    expect(p).toContain('you never claim it succeeded yourself');
    // Warns that per-step separate-runtime (e.g. Codex-pinned) agents fold into the handover agent.
    expect(p).toContain('switched to this one');
  });

  it('describes all 12 action kinds, grouped by task edits / step control / review queue', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'what can you do?', history);
    for (const kind of [
      'retry_step',
      'switch_to_orchestrated',
      'add_task',
      'remove_task',
      'edit_task',
      'skip_step',
      'unskip_step',
      'steer_step',
      'rewind_to_step',
      'rewind_lane_to_step',
      'resolve_review_item',
      'file_note',
    ]) {
      expect(p).toContain(`"${kind}"`);
    }
    // Task edits: not-yet-started + next-wave framing.
    expect(p).toContain('NOT-YET-STARTED');
    expect(p).toContain('NEXT wave');
    // Step control: upcoming/not-reached framing (still true for skip_step/unskip_step).
    expect(p).toContain("HASN'T reached yet");
    // Return-shape contract lists all 12 kinds and defers to per-kind fields.
    expect(p).toContain('fields relevant to the chosen');
  });

  it('describes rewind_to_step as a confirm-gated whole-run rewind, distinct from retry_step', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'rewind the run to the analyze step', history);
    expect(p).toContain('"rewind_to_step"');
    expect(p).toContain('rewind the WHOLE run to an earlier step');
    expect(p).toContain("a step at or before the run's current step");
    expect(p).toContain('the host safely stops current work first');
    expect(p).toContain('prefer "retry_step" for simply re-running a failed step');
    // It follows the same staged-confirm contract as the other steering kinds.
    expect(p).toContain('"rewind_to_step" and "rewind_lane_to_step" follow the same staged-confirm contract');
  });

  it('describes rewind_lane_to_step as a per-LANE rewind, preferred over the whole-run one', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'TASK-003 is stuck, send it back to implement', history);
    expect(p).toContain('"rewind_lane_to_step"');
    expect(p).toContain("rewind ONE sprint task's lane to an earlier step");
    expect(p).toContain('leaving the run and every other lane running');
    // It takes an INNER lane step, not a phase step from the timeline.
    expect(p).toContain('INNER lane step');
    // The lane-liveness precondition is stated, so the monitor can pre-empt a refusal.
    expect(p).toContain('must be RUNNING right now');
    // And it is explicitly preferred over the whole-run rewind for a one-task problem.
    expect(p).toContain('Prefer it over "rewind_to_step"');
  });

  it('describes steer_step live-delivery to a currently-running step, with optional taskRef narrowing', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'steer the running step', history);
    expect(p).toContain('"steer_step"');
    expect(p).toContain('If that step is CURRENTLY RUNNING the host also delivers the guidance live');
    expect(p).toContain('mid-flight');
    expect(p).toContain('every future spawn of that step (including retries)');
    expect(p).toContain("Setting `taskRef` narrows to ONE sprint task's currently-running agent and is LIVE-ONLY");
  });

  it('describes the host-enforced two-phase confirmation protocol (stage → confirm/cancel) for mutating actions, including the low-risk file_note', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'add a task to fix the flaky test', history);
    expect(p).toContain('CONFIRM BEFORE YOU ACT (host-enforced)');
    expect(p).toContain('STAGE it'); // host stages, does not execute on the first turn
    expect(p).toContain('kind "confirm"'); // model confirms on the next turn
    expect(p).toContain('kind "cancel"'); // or discards
    expect(p).toContain('EXPIRES'); // a staged proposal expires if the next turn isn't a confirmation
    expect(p).toContain('file_note');
    expect(p).toContain('low-risk');
    // The excluded kinds are called out as NOT staged.
    expect(p).toContain('"retry_step" and "switch_to_orchestrated" are NOT staged');
    // The return-shape enum now lists the two control signals.
    expect(p).toContain('"confirm" | "cancel"');
  });

  it('allows proactively staging a confirm-gated action when the monitor is confident of the fix, while keeping the one-action-per-reply and staging contract', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'the build keeps failing on the same step', history);
    // Proactive staging is now allowed alongside the explicit-ask path — not a replacement for it.
    expect(p).toContain('EXPLICITLY asks for it');
    expect(p).toContain('PROACTIVELY');
    expect(p).toContain('without being asked');
    expect(p).toContain('describes a problem');
    expect(p).toContain('CONFIDENT which single action fixes it');
    // The reply must justify a proactive stage so the user can judge it before confirming.
    expect(p).toContain('your reply MUST explain WHY you staged it');
    // Still at most one action, still host-staged behind the confirm/cancel gate either way.
    expect(p).toContain('AT MOST ONE action per reply');
    expect(p).toContain('host-staged behind the confirm/cancel gate');
    // retry_step / switch_to_orchestrated keep their own stricter, explicit-only contracts.
    expect(p).toContain('must NEVER be attached proactively');
    expect(p).toContain('"switch_to_orchestrated" also keeps its own stricter contract');
  });

  it('notes that sprint-lane failures are auto-triaged by the host, so the monitor should not promise manual intervention or duplicate a rescue', () => {
    const history: MonitorHistory = { conversation: [], steps: [] };
    const p = buildActionAnswerPrompt(ctx, 'TASK-004 just failed, what do I need to do?', history);
    expect(p).toContain('AUTO-TRIAGED by the host supervisor itself');
    expect(p).toContain('logged as a finding in the run\'s review queue');
    expect(p).toContain('do NOT tell the user a just-failed lane needs manual intervention');
    expect(p).toContain('do NOT proactively stage an action that would duplicate a rescue');
    expect(p).toContain("check the step timeline / review queue for that lane's triage outcome");
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

/**
 * Build a fully-populated fake `MonitorActions` bag (a no-op `vi.fn()` per
 * method), with any subset overridden. All 12 methods are required members of
 * the interface, so every test constructing a bag needs the full shape.
 */
function makeActions(overrides: Partial<MonitorActions> = {}): MonitorActions {
  return {
    retryStep: vi.fn<MonitorActions['retryStep']>(),
    switchToOrchestrated: vi.fn<MonitorActions['switchToOrchestrated']>(),
    addTask: vi.fn<MonitorActions['addTask']>(),
    removeTask: vi.fn<MonitorActions['removeTask']>(),
    editTask: vi.fn<MonitorActions['editTask']>(),
    skipStep: vi.fn<MonitorActions['skipStep']>(),
    unskipStep: vi.fn<MonitorActions['unskipStep']>(),
    steerStep: vi.fn<MonitorActions['steerStep']>(),
    rewindToStep: vi.fn<MonitorActions['rewindToStep']>(),
    rewindLaneToStep: vi.fn<MonitorActions['rewindLaneToStep']>(),
    resolveReviewItem: vi.fn<MonitorActions['resolveReviewItem']>(),
    fileNote: vi.fn<MonitorActions['fileNote']>(),
    ...overrides,
  };
}

/**
 * A `structuredQuery` that returns one queued value per successive turn (for
 * multi-turn stage → confirm flows). Falls back to the LAST value once the queue is
 * exhausted so any extra calls stay well-defined.
 */
function seqStructuredQuery(...values: unknown[]): StructuredQueryFn {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    const v = values[Math.min(i, values.length - 1)];
    i += 1;
    return Promise.resolve(v);
  }) as unknown as StructuredQueryFn;
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
    const actions = makeActions({ retryStep });
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
    const actions = makeActions({ retryStep });
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
    const actions = makeActions({ retryStep });
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
    const actions = makeActions({ retryStep });
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
    const actions = makeActions({ retryStep });
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
    const actions = makeActions({ retryStep });
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

  it('a switch_to_orchestrated action calls switchToOrchestrated(reason) and injects a ▶-prefixed success turn; retryStep untouched', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      reply: 'Handing this run over to an interactive agent now.',
      action: { kind: 'switch_to_orchestrated', reason: 'Fix the conflict by hand, then finish the remaining steps.' },
    });
    const retryStep = vi.fn<MonitorActions['retryStep']>();
    const switchToOrchestrated = vi
      .fn<MonitorActions['switchToOrchestrated']>()
      .mockResolvedValue({ ok: true, message: 'run handed over to the orchestrated plane' });
    const actions = makeActions({ retryStep, switchToOrchestrated });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    const reply = await session.converse('fix the conflict by hand then continue');

    expect(reply).toBe('Handing this run over to an interactive agent now.');
    expect(switchToOrchestrated).toHaveBeenCalledTimes(1);
    expect(switchToOrchestrated).toHaveBeenCalledWith('Fix the conflict by hand, then finish the remaining steps.');
    expect(retryStep).not.toHaveBeenCalled();
    expect(injected).toEqual([
      { role: 'user', text: 'fix the conflict by hand then continue' },
      { role: 'assistant', text: 'Handing this run over to an interactive agent now.' },
      { role: 'assistant', text: '▶ run handed over to the orchestrated plane' },
    ]);
  });

  it('a switch_to_orchestrated action resolving ok:false injects a ⚠-prefixed turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      reply: 'attempting handover.',
      action: { kind: 'switch_to_orchestrated', reason: 'take over the rest of the run' },
    });
    const switchToOrchestrated = vi
      .fn<MonitorActions['switchToOrchestrated']>()
      .mockResolvedValue({ ok: false, message: 'run is already terminal' });
    const actions = makeActions({ switchToOrchestrated });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('take over the rest');

    expect(switchToOrchestrated).toHaveBeenCalledWith('take over the rest of the run');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ run is already terminal' });
  });

  it('a throwing switchToOrchestrated fails soft: injects a generic handover-warning turn, converse still resolves with the reply', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      reply: 'handing over.',
      action: { kind: 'switch_to_orchestrated', reason: 'take over' },
    });
    const switchToOrchestrated = vi
      .fn<MonitorActions['switchToOrchestrated']>()
      .mockRejectedValue(new Error('handover exploded'));
    const actions = makeActions({ switchToOrchestrated });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    const reply = await session.converse('take over the run');

    expect(reply).toBe('handing over.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ The handover action failed unexpectedly.' });
  });
});

describe('DefaultMonitorSession.converse — expanded actuation (9 steering actions, host-staged)', () => {
  const steeringCases = [
    {
      name: 'add_task',
      action: { kind: 'add_task', title: 'Fix flaky test', body: 'see CI run 123', priority: 'high' },
      method: 'addTask' as const,
      expectedInput: { title: 'Fix flaky test', body: 'see CI run 123', priority: 'high' },
      stageText: 'Ready to add task "Fix flaky test".',
    },
    {
      name: 'remove_task',
      action: { kind: 'remove_task', taskRef: 'TASK-1' },
      method: 'removeTask' as const,
      expectedInput: { taskRef: 'TASK-1' },
      stageText: 'Ready to remove task TASK-1.',
    },
    {
      name: 'edit_task',
      action: { kind: 'edit_task', taskRef: 'TASK-1', title: 'Renamed task' },
      method: 'editTask' as const,
      expectedInput: { taskRef: 'TASK-1', title: 'Renamed task', body: undefined, priority: undefined },
      stageText: 'Ready to edit task TASK-1.',
    },
    {
      name: 'skip_step',
      action: { kind: 'skip_step', stepId: 'tasks' },
      method: 'skipStep' as const,
      expectedInput: { stepId: 'tasks' },
      stageText: 'Ready to skip step tasks.',
    },
    {
      name: 'unskip_step',
      action: { kind: 'unskip_step', stepId: 'tasks' },
      method: 'unskipStep' as const,
      expectedInput: { stepId: 'tasks' },
      stageText: 'Ready to un-skip step tasks.',
    },
    {
      name: 'steer_step',
      action: { kind: 'steer_step', stepId: 'tasks', guidance: 'be extra careful with the migration' },
      method: 'steerStep' as const,
      expectedInput: { stepId: 'tasks', guidance: 'be extra careful with the migration' },
      stageText: 'Ready to steer step tasks.',
    },
    {
      name: 'rewind_to_step',
      action: { kind: 'rewind_to_step', stepId: 'analyze' },
      method: 'rewindToStep' as const,
      expectedInput: { stepId: 'analyze' },
      stageText:
        'Ready to rewind the run to step analyze — current work will be stopped and every step from there on re-runs.',
    },
    {
      name: 'rewind_lane_to_step',
      action: { kind: 'rewind_lane_to_step', taskRef: 'TASK-003', stepId: 'implement' },
      method: 'rewindLaneToStep' as const,
      expectedInput: { taskRef: 'TASK-003', stepId: 'implement' },
      stageText:
        "Ready to rewind TASK-003's lane to step implement — that lane's current agent will be stopped and it re-runs from there. Other lanes and the run keep going.",
    },
    {
      name: 'resolve_review_item',
      action: { kind: 'resolve_review_item', reviewItemId: 'RI-1', outcome: 'approve' },
      method: 'resolveReviewItem' as const,
      expectedInput: { reviewItemId: 'RI-1', outcome: 'approve', resolution: undefined },
      stageText: 'Ready to resolve review item RI-1.',
    },
    {
      name: 'file_note',
      action: { kind: 'file_note', title: 'Heads up about the flaky test' },
      method: 'fileNote' as const,
      expectedInput: { title: 'Heads up about the flaky test', body: undefined },
      stageText: 'Ready to file a note titled "Heads up about the flaky test".',
    },
  ];

  it.each(steeringCases)(
    'a $name action STAGES on the first turn (no actuation) and injects a ⏸ pause turn',
    async ({ action, method, stageText }) => {
      const { reader } = fakeHistory({ conversation: [], steps: [] });
      const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({ reply: 'doing it.', action });
      const fn = vi.fn().mockResolvedValue({ ok: true, message: 'done' });
      const actions = makeActions({ [method]: fn } as Partial<MonitorActions>);
      const { injectEvent, injected } = collectInjected();
      const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

      const reply = await session.converse('please do the thing');

      expect(reply).toBe('doing it.');
      // The actuator is NOT called on the first turn — the action is staged pending.
      expect(fn).not.toHaveBeenCalled();
      expect(injected).toEqual([
        { role: 'user', text: 'please do the thing' },
        { role: 'assistant', text: 'doing it.' },
        { role: 'assistant', text: `⏸ ${stageText} Reply to confirm, or say cancel.` },
      ]);
    },
  );

  it.each(steeringCases)(
    'a $name action, once confirmed on the next turn, routes to actions.$method with the mapped input and injects a ▶ success turn',
    async ({ action, method, expectedInput }) => {
      const { reader } = fakeHistory({ conversation: [], steps: [] });
      const structuredQuery = seqStructuredQuery(
        { reply: 'staging it.', action },
        { reply: 'confirmed.', action: { kind: 'confirm' } },
      );
      const fn = vi.fn().mockResolvedValue({ ok: true, message: 'done' });
      const actions = makeActions({ [method]: fn } as Partial<MonitorActions>);
      const { injectEvent, injected } = collectInjected();
      const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

      await session.converse('please do the thing');
      await session.converse('yes, do it');

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(expectedInput);
      expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ done' });
    },
  );

  it('a resolve_review_item action, once confirmed, resolving ok:false injects a ⚠-prefixed turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'resolving it.', action: { kind: 'resolve_review_item', reviewItemId: 'RI-1', outcome: 'reject' } },
      { reply: 'confirmed.', action: { kind: 'confirm' } },
    );
    const resolveReviewItem = vi
      .fn<MonitorActions['resolveReviewItem']>()
      .mockResolvedValue({ ok: false, message: 'review item already resolved' });
    const actions = makeActions({ resolveReviewItem });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('reject it');
    await session.converse('yes, reject it');

    expect(resolveReviewItem).toHaveBeenCalledWith({ reviewItemId: 'RI-1', outcome: 'reject', resolution: undefined });
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ review item already resolved' });
  });

  it('a throwing addTask, once confirmed, fails soft: injects the add_task-specific apology, converse still resolves with the reply', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the task.', action: { kind: 'add_task', title: 'New task' } },
      { reply: 'adding the task now.', action: { kind: 'confirm' } },
    );
    const addTask = vi.fn<MonitorActions['addTask']>().mockRejectedValue(new Error('router exploded'));
    const actions = makeActions({ addTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('add a task for this');
    const reply = await session.converse('yes, add it');

    expect(reply).toBe('adding the task now.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ Adding the task failed unexpectedly.' });
  });

  it('a bag missing the corresponding method, once confirmed, resolves to the graceful "not available" fallback instead of throwing', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the skip.', action: { kind: 'skip_step', stepId: 'tasks' } },
      { reply: 'skipping it.', action: { kind: 'confirm' } },
    );
    // A bag that type-satisfies MonitorActions but was constructed without skipStep
    // wired (e.g. an older host binding) — the defensive `typeof === 'function'`
    // guard in `runAction` must catch this rather than throwing. Cast through
    // Record<string, unknown> since `skipStep` is a required (non-optional) member
    // of `MonitorActions` and TS forbids `delete` on a non-optional property.
    const bag = makeActions() as unknown as Record<string, unknown>;
    delete bag.skipStep;
    const partialActions = bag as unknown as MonitorActions;
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions: partialActions,
    });

    await session.converse('skip that step');
    const reply = await session.converse('yes, skip it');

    expect(reply).toBe('skipping it.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ That action is not available for this run.' });
  });
});

describe('DefaultMonitorSession.converse — rewind_to_step (confirm-gated whole-run rewind)', () => {
  it('a cancel after staging a rewind clears pending, does not actuate, and injects a discard turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the rewind.', action: { kind: 'rewind_to_step', stepId: 'analyze' } },
      { reply: 'okay, never mind.', action: { kind: 'cancel' } },
    );
    const rewindToStep = vi.fn<MonitorActions['rewindToStep']>().mockResolvedValue({ ok: true, message: 'rewound' });
    const actions = makeActions({ rewindToStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('rewind the run to analyze');
    await session.converse('actually never mind');

    expect(rewindToStep).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '✖ Discarded the proposed action.' });
  });

  it('a staged rewind EXPIRES: after a plain-answer turn, a confirm finds nothing to confirm', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the rewind.', action: { kind: 'rewind_to_step', stepId: 'analyze' } },
      { reply: 'here is a plain answer.' }, // no action, no control → clears the stale proposal
      { reply: 'confirming.', action: { kind: 'confirm' } },
    );
    const rewindToStep = vi.fn<MonitorActions['rewindToStep']>().mockResolvedValue({ ok: true, message: 'rewound' });
    const actions = makeActions({ rewindToStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('rewind the run to analyze');
    await session.converse('wait, what is the run doing?');
    await session.converse('okay, confirm the rewind');

    expect(rewindToStep).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: 'There is no pending action to confirm.' });
  });

  it('once confirmed, calls rewindToStep(stepId) with the mapped input', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the rewind.', action: { kind: 'rewind_to_step', stepId: 'analyze' } },
      { reply: 'confirmed.', action: { kind: 'confirm' } },
    );
    const rewindToStep = vi
      .fn<MonitorActions['rewindToStep']>()
      .mockResolvedValue({ ok: true, message: 'run rewound to analyze' });
    const actions = makeActions({ rewindToStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('rewind the run to analyze');
    await session.converse('yes, do it');

    expect(rewindToStep).toHaveBeenCalledTimes(1);
    expect(rewindToStep).toHaveBeenCalledWith({ stepId: 'analyze' });
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ run rewound to analyze' });
  });

  it('a bag missing rewindToStep, once confirmed, resolves to the graceful "not available" fallback instead of throwing', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the rewind.', action: { kind: 'rewind_to_step', stepId: 'analyze' } },
      { reply: 'rewinding it.', action: { kind: 'confirm' } },
    );
    // A bag that type-satisfies MonitorActions but was constructed without
    // rewindToStep wired — the defensive `typeof === 'function'` guard in
    // `runAction` must catch this rather than throwing.
    const bag = makeActions() as unknown as Record<string, unknown>;
    delete bag.rewindToStep;
    const partialActions = bag as unknown as MonitorActions;
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      actions: partialActions,
    });

    await session.converse('rewind the run to analyze');
    const reply = await session.converse('yes, do it');

    expect(reply).toBe('rewinding it.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ That action is not available for this run.' });
  });

  it('a throwing rewindToStep, once confirmed, fails soft: injects the rewind-specific apology, converse still resolves with the reply', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging the rewind.', action: { kind: 'rewind_to_step', stepId: 'analyze' } },
      { reply: 'rewinding now.', action: { kind: 'confirm' } },
    );
    const rewindToStep = vi.fn<MonitorActions['rewindToStep']>().mockRejectedValue(new Error('handler exploded'));
    const actions = makeActions({ rewindToStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('rewind the run to analyze');
    const reply = await session.converse('yes, do it');

    expect(reply).toBe('rewinding now.');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '⚠ The rewind action failed unexpectedly.' });
  });
});

describe('DefaultMonitorSession.converse — two-phase confirmation gate', () => {
  it('(a) a mutating action on the first turn does NOT actuate; stages pending and injects a ⏸ pause turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      reply: 'sure, I can add that.',
      action: { kind: 'add_task', title: 'Fix flaky test' },
    });
    const addTask = vi.fn<MonitorActions['addTask']>().mockResolvedValue({ ok: true, message: 'task added' });
    const actions = makeActions({ addTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    const reply = await session.converse('add a task to fix the flaky test');

    expect(reply).toBe('sure, I can add that.');
    expect(addTask).not.toHaveBeenCalled();
    expect(injected).toEqual([
      { role: 'user', text: 'add a task to fix the flaky test' },
      { role: 'assistant', text: 'sure, I can add that.' },
      { role: 'assistant', text: '⏸ Ready to add task "Fix flaky test". Reply to confirm, or say cancel.' },
    ]);
  });

  it('(b) a following confirm actuates once with the staged action, then clears pending', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging it.', action: { kind: 'add_task', title: 'Fix flaky test' } },
      { reply: 'confirmed, adding it.', action: { kind: 'confirm' } },
      { reply: 'confirming again.', action: { kind: 'confirm' } },
    );
    const addTask = vi.fn<MonitorActions['addTask']>().mockResolvedValue({ ok: true, message: 'task added' });
    const actions = makeActions({ addTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('add a task to fix the flaky test');
    await session.converse('yes, add it');

    expect(addTask).toHaveBeenCalledTimes(1);
    expect(addTask).toHaveBeenCalledWith({ title: 'Fix flaky test', body: undefined, priority: undefined });
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ task added' });

    // Pending is cleared by the confirm: a further confirm has nothing staged.
    await session.converse('confirm again');
    expect(addTask).toHaveBeenCalledTimes(1);
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: 'There is no pending action to confirm.' });
  });

  it('(c) a confirm with nothing staged does not actuate and injects a no-pending message', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({ reply: 'ok.', action: { kind: 'confirm' } });
    const addTask = vi.fn<MonitorActions['addTask']>();
    const actions = makeActions({ addTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('yes');

    expect(addTask).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: 'There is no pending action to confirm.' });
  });

  it('(d) a cancel after a stage clears pending, does not actuate, and injects a discard turn', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging it.', action: { kind: 'remove_task', taskRef: 'TASK-9' } },
      { reply: 'okay, dropping it.', action: { kind: 'cancel' } },
      { reply: 'confirming.', action: { kind: 'confirm' } },
    );
    const removeTask = vi.fn<MonitorActions['removeTask']>().mockResolvedValue({ ok: true, message: 'removed' });
    const actions = makeActions({ removeTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('remove TASK-9');
    await session.converse('actually never mind');

    expect(removeTask).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '✖ Discarded the proposed action.' });

    // Pending is cleared by the cancel: a later confirm finds nothing to confirm.
    await session.converse('confirm');
    expect(removeTask).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: 'There is no pending action to confirm.' });
  });

  it('(e) a different mutating action supersedes a staged one; a following confirm executes the NEW action', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging add.', action: { kind: 'add_task', title: 'First' } },
      { reply: 'staging remove instead.', action: { kind: 'remove_task', taskRef: 'TASK-1' } },
      { reply: 'confirmed.', action: { kind: 'confirm' } },
    );
    const addTask = vi.fn<MonitorActions['addTask']>().mockResolvedValue({ ok: true, message: 'added' });
    const removeTask = vi.fn<MonitorActions['removeTask']>().mockResolvedValue({ ok: true, message: 'removed' });
    const actions = makeActions({ addTask, removeTask });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('add a task First');
    await session.converse('actually remove TASK-1 instead');
    await session.converse('yes do it');

    expect(addTask).not.toHaveBeenCalled();
    expect(removeTask).toHaveBeenCalledTimes(1);
    expect(removeTask).toHaveBeenCalledWith({ taskRef: 'TASK-1' });
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ removed' });
  });

  it('(f) re-attaching the identical staged action does NOT confirm it — execution needs an explicit confirm control', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const action = { kind: 'skip_step', stepId: 'tasks' };
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging skip.', action },
      { reply: 'still want to skip.', action },
    );
    const skipStep = vi.fn<MonitorActions['skipStep']>().mockResolvedValue({ ok: true, message: 'skip queued' });
    const actions = makeActions({ skipStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('skip the tasks step');
    await session.converse('skip the tasks step');

    // No `confirm` control was ever sent, so the mutating action NEVER executes —
    // a re-attach only re-stages and re-asks (closes the persistent-injection self-confirm hole).
    expect(skipStep).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({
      role: 'assistant',
      text: '⏸ Ready to skip step tasks. Reply to confirm, or say cancel.',
    });
  });

  it('(g) retry_step executes on the FIRST turn (not staged)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ reply: 'retrying.', action: { kind: 'retry_step', stepId: 'tasks' } });
    const retryStep = vi.fn<MonitorActions['retryStep']>().mockResolvedValue({ ok: true, message: 'resumed' });
    const actions = makeActions({ retryStep });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('retry it');

    expect(retryStep).toHaveBeenCalledTimes(1);
    expect(retryStep).toHaveBeenCalledWith('tasks');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ resumed' });
  });

  it('(g) switch_to_orchestrated executes on the FIRST turn (not staged)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ reply: 'handing over.', action: { kind: 'switch_to_orchestrated', reason: 'take over' } });
    const switchToOrchestrated = vi
      .fn<MonitorActions['switchToOrchestrated']>()
      .mockResolvedValue({ ok: true, message: 'handed over' });
    const actions = makeActions({ switchToOrchestrated });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('take over the run');

    expect(switchToOrchestrated).toHaveBeenCalledTimes(1);
    expect(switchToOrchestrated).toHaveBeenCalledWith('take over');
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: '▶ handed over' });
  });

  it('(h) a staged proposal EXPIRES: after a plain-answer turn, a confirm finds nothing to confirm', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery = seqStructuredQuery(
      { reply: 'staging it.', action: { kind: 'file_note', title: 'Heads up' } },
      { reply: 'here is a plain answer.' }, // no action, no control → clears the stale proposal
      { reply: 'confirming.', action: { kind: 'confirm' } },
    );
    const fileNote = vi.fn<MonitorActions['fileNote']>().mockResolvedValue({ ok: true, message: 'filed' });
    const actions = makeActions({ fileNote });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent, actions });

    await session.converse('file a note titled Heads up');
    await session.converse('wait, what is the run doing?');
    await session.converse('okay, confirm the note');

    expect(fileNote).not.toHaveBeenCalled();
    expect(injected.at(-1)).toEqual({ role: 'assistant', text: 'There is no pending action to confirm.' });
  });

  it('(i) with no actuator wired, the confirmation gate is inert (plain answer path unchanged)', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('plain answer');
    const structuredQuery: StructuredQueryFn = vi.fn();
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery, injectEvent });

    const reply = await session.converse('add a task to fix the flaky test');

    expect(reply).toBe('plain answer');
    expect(structuredQuery).not.toHaveBeenCalled();
    expect(injected).toEqual([
      { role: 'user', text: 'add a task to fix the flaky test' },
      { role: 'assistant', text: 'plain answer' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Lane triage (autonomous sprint-lane rescue)
// ---------------------------------------------------------------------------

/** A canonical lane-triage request; override any field per test. */
function laneReq(p: Partial<LaneTriageRequest> = {}): LaneTriageRequest {
  return {
    taskRef: 'TASK-014',
    itemId: 'item-14',
    stepId: 'task-verify',
    attempt: 3,
    failureKind: 'task-verify',
    errorExcerpt: 'FAIL: expected the exporter to emit UTC timestamps',
    innerStepIds: ['implement', 'write-tests', 'code-review', 'task-verify'],
    taskTitle: 'Export timestamps as UTC',
    taskBody: '## AC\n- The exporter emits ISO-8601 UTC timestamps.',
    ...p,
  };
}

describe('MONITOR_LANE_TRIAGE_SCHEMA', () => {
  it('enforces the four-verdict enum, requires verdict + reason, and forbids extra fields', () => {
    const props = MONITOR_LANE_TRIAGE_SCHEMA.properties as Record<
      string,
      { enum?: string[]; description?: string }
    >;
    expect(props.verdict.enum).toEqual(['give_up', 'retry', 'adjust_and_retry', 'append_correction']);
    // The enum's own description is what the model reads first, so it must say
    // what append_correction COSTS (nothing) and what give_up is FOR (escalation).
    expect(props.verdict.description).toContain('append_correction');
    expect(props.verdict.description).toContain('no rescue budget');
    expect(props.verdict.description).toContain('escalate to the human gate');
    expect(MONITOR_LANE_TRIAGE_SCHEMA.required).toEqual(['verdict', 'reason']);
    expect(MONITOR_LANE_TRIAGE_SCHEMA.additionalProperties).toBe(false);
    // The rescue-only fields exist but are NOT schema-required — parseLaneTriageOutput
    // enforces them per-verdict with a fail-safe downgrade instead of an SDK error.
    for (const key of ['targetStepId', 'guidance', 'taskBody']) expect(props[key]).toBeDefined();
  });
});

describe('buildLaneTriagePrompt', () => {
  const sprintCtx: MonitorContext = { ...ctx, workflowName: 'sprint' };
  const history: MonitorHistory = {
    conversation: [assistantMsg('fanning out over tasks')],
    steps: [stepRow({ stepId: 'execute-tasks', outcome: 'failed', error: 'a task lane failed' })],
    lanes: [laneRow({ taskId: 'TASK-014', status: 'running', currentStepId: 'task-verify', attempts: 3 })],
  };

  it('presents the lane, the failure, the inner chain, and the current task body', () => {
    const p = buildLaneTriagePrompt(sprintCtx, history, laneReq());
    expect(p).toContain('SUPERVISOR');
    expect(p).toContain('TASK-014');
    expect(p).toContain('Export timestamps as UTC');
    // The CURRENT task body — the acceptance criteria an adjust verdict would rewrite.
    expect(p).toContain('The exporter emits ISO-8601 UTC timestamps.');
    // Failing step + attempt + failure kind + error excerpt.
    expect(p).toContain('`task-verify`');
    expect(p).toContain('attempt 3');
    expect(p).toContain('task-verify gate kept returning FAIL');
    expect(p).toContain('expected the exporter to emit UTC timestamps');
    // The lane's inner chain, in order.
    expect(p).toContain('`implement` → `write-tests` → `code-review` → `task-verify`');
  });

  it('reuses the shared digests (step timeline, lane section, recent conversation)', () => {
    const p = buildLaneTriagePrompt(sprintCtx, history, laneReq());
    expect(p).toContain('execute-tasks'); // step timeline digest
    expect(p).toContain('fanning out over tasks'); // conversation digest
    expect(p).toContain('Sprint task lanes'); // laneSection
    expect(p).toContain('trust these lanes, not the step timeline');
    expect(p).toContain('Read/Grep/Glob'); // read-only investigation encouraged
  });

  it('offers all four verdicts and keeps the guidance / minimal-edit contracts', () => {
    const p = buildLaneTriagePrompt(sprintCtx, history, laneReq());
    expect(p).toContain('"give_up"');
    expect(p).toContain('"retry"');
    expect(p).toContain('"adjust_and_retry"');
    expect(p).toContain('"append_correction"');
    expect(p).toContain('"try again" is not guidance');
    // adjust_and_retry's evidence + minimal-edit contract.
    expect(p).toContain('CONFLICT');
    expect(p).toContain('file:line');
    expect(p).toContain('FULL replacement body');
    expect(p).toContain('never silently drop a security- or correctness-relevant one');
  });

  it('draws the ESCALATION LINE: give_up is an escalation, not the safe default', () => {
    // The old prompt called give_up "the DEFAULT ... whenever you are unsure",
    // and an agent told a verdict is the safe default takes it — throwing away
    // diagnoses it had actually made. The menu now names what give_up is FOR and
    // offers append_correction as the cheap way to decline a rescue.
    const p = buildLaneTriagePrompt(sprintCtx, history, laneReq());
    expect(p).not.toContain('the DEFAULT');
    expect(p).not.toContain('Choose this whenever you are unsure');
    expect(p).toContain('ESCALATE to the human');
    expect(p).toContain('a product decision the task brief does not settle');
    expect(p).toContain("needs a human's own hands or account");
    expect(p).toContain('TWO autonomous corrections have already failed');
    expect(p).toContain('bias hard toward resolving');
    expect(p).toContain('give_up" is an escalation, not a safe default');
    // append_correction's two load-bearing properties.
    expect(p).toContain('costs NO rescue budget');
    expect(p).toContain('recorded as a non-blocking finding');
  });

  it('carries the autonomous-execution notice and the targetStepId constraint', () => {
    const p = buildLaneTriagePrompt(sprintCtx, history, laneReq());
    expect(p).toContain('AUTONOMOUS EXECUTION');
    expect(p).toContain('no human confirmation');
    expect(p).toContain('review queue');
    expect(p).toContain('rescued at most once');
    expect(p).toContain('at or before the failing step');
    // The default target is named explicitly (the first inner step).
    expect(p).toContain('default to the FIRST inner step (`implement`)');
  });

  it('degrades gracefully with an empty chain / body / error excerpt', () => {
    const p = buildLaneTriagePrompt(
      sprintCtx,
      history,
      laneReq({ innerStepIds: [], taskBody: '   ', errorExcerpt: '' }),
    );
    expect(p).toContain('(unknown)');
    expect(p).toContain('(empty)');
    expect(p).toContain('(no error text captured)');
    expect(p).toContain('(`(none)`)');
  });
});

describe('parseLaneTriageOutput (fail-safe downgrade ladder)', () => {
  it('parses a well-formed retry', () => {
    expect(
      parseLaneTriageOutput(
        { verdict: 'retry', reason: 'the fixture is stale', targetStepId: 'write-tests', guidance: 'regenerate the fixture' },
        laneReq(),
      ),
    ).toEqual({ verdict: 'retry', targetStepId: 'write-tests', guidance: 'regenerate the fixture', reason: 'the fixture is stale' });
  });

  it('parses a well-formed adjust_and_retry', () => {
    expect(
      parseLaneTriageOutput(
        {
          verdict: 'adjust_and_retry',
          reason: 'exporter.ts:42 has no UTC mode',
          targetStepId: 'implement',
          guidance: 'narrow the AC to local time',
          taskBody: '## AC\n- The exporter emits local timestamps.',
        },
        laneReq(),
      ),
    ).toEqual({
      verdict: 'adjust_and_retry',
      targetStepId: 'implement',
      guidance: 'narrow the AC to local time',
      taskBody: '## AC\n- The exporter emits local timestamps.',
      reason: 'exporter.ts:42 has no UTC mode',
    });
  });

  it('keeps an explicit give_up (with its reason)', () => {
    expect(parseLaneTriageOutput({ verdict: 'give_up', reason: 'genuinely broken' }, laneReq())).toEqual({
      verdict: 'give_up',
      reason: 'genuinely broken',
    });
    expect(parseLaneTriageOutput({ verdict: 'give_up' }, laneReq())).toEqual({ verdict: 'give_up' });
  });

  it('accepts append_correction on its reason alone — it names no step and re-drives nothing', () => {
    expect(
      parseLaneTriageOutput(
        { verdict: 'append_correction', reason: 'the shared fixture writes UTC only in CI' },
        laneReq(),
      ),
    ).toEqual({ verdict: 'append_correction', reason: 'the shared fixture writes UTC only in CI' });
  });

  it('keeps append_correction\'s optional guidance and drops a blank one', () => {
    expect(
      parseLaneTriageOutput(
        { verdict: 'append_correction', reason: 'r', guidance: 'pin the TZ in the fixture' },
        laneReq(),
      ),
    ).toEqual({ verdict: 'append_correction', reason: 'r', guidance: 'pin the TZ in the fixture' });
    for (const guidance of [undefined, '', '   ', 42]) {
      expect(parseLaneTriageOutput({ verdict: 'append_correction', reason: 'r', guidance }, laneReq())).toEqual(
        { verdict: 'append_correction', reason: 'r' },
      );
    }
  });

  it('does NOT apply the rescue constraints to append_correction', () => {
    // No targetStepId, an unusable one, and one AFTER the failing step are all
    // fine: nothing is re-driven, so there is no step to constrain.
    for (const targetStepId of [undefined, 'not-a-step', 'implement']) {
      expect(
        parseLaneTriageOutput({ verdict: 'append_correction', reason: 'r', targetStepId }, laneReq()).verdict,
      ).toBe('append_correction');
    }
    // An empty inner chain forces every RESCUE verdict to give_up; this one survives.
    expect(
      parseLaneTriageOutput({ verdict: 'append_correction', reason: 'r' }, laneReq({ innerStepIds: [] }))
        .verdict,
    ).toBe('append_correction');
  });

  it('downgrades append_correction with a blank reason to give_up (nothing to record)', () => {
    for (const reason of [undefined, '', '   ', 42]) {
      const d = parseLaneTriageOutput({ verdict: 'append_correction', reason }, laneReq());
      expect(d.verdict).toBe('give_up');
      expect(d.reason).toContain('no diagnosis');
    }
  });

  it('downgrades malformed / unknown output to give_up', () => {
    for (const bad of [null, undefined, 'garbage', 42, {}, { verdict: 'nope' }, { verdict: 'retry ' }]) {
      expect(parseLaneTriageOutput(bad, laneReq()).verdict).toBe('give_up');
    }
    expect(parseLaneTriageOutput(null, laneReq()).reason).toContain('unparseable');
    expect(parseLaneTriageOutput({ verdict: 'nope' }, laneReq()).reason).toContain('unrecognized');
  });

  it('downgrades a retry/adjust with blank or non-string guidance to give_up', () => {
    for (const guidance of [undefined, '', '   ', 42]) {
      for (const verdict of ['retry', 'adjust_and_retry']) {
        const d = parseLaneTriageOutput(
          { verdict, reason: 'r', targetStepId: 'implement', guidance, taskBody: 'body' },
          laneReq(),
        );
        expect(d.verdict).toBe('give_up');
        expect(d.reason).toContain('without guidance');
      }
    }
  });

  it('downgrades an unknown targetStepId to give_up', () => {
    const d = parseLaneTriageOutput(
      { verdict: 'retry', reason: 'r', targetStepId: 'not-a-step', guidance: 'do it differently' },
      laneReq(),
    );
    expect(d.verdict).toBe('give_up');
    expect(d.reason).toContain('unusable target step');
    // A non-string target is equally unusable.
    expect(
      parseLaneTriageOutput({ verdict: 'retry', reason: 'r', targetStepId: 7, guidance: 'g' }, laneReq()).verdict,
    ).toBe('give_up');
  });

  it('downgrades a target AFTER the failing step to give_up (a rescue must not skip the failure)', () => {
    // `code-review` is a real inner step but comes AFTER the failing `implement`.
    const d = parseLaneTriageOutput(
      { verdict: 'retry', reason: 'r', targetStepId: 'code-review', guidance: 'g' },
      laneReq({ stepId: 'implement', failureKind: 'inner-step' }),
    );
    expect(d.verdict).toBe('give_up');
    // ...but at-or-before the failing step is accepted.
    expect(
      parseLaneTriageOutput(
        { verdict: 'retry', reason: 'r', targetStepId: 'write-tests', guidance: 'g' },
        laneReq({ stepId: 'code-review', failureKind: 'code-review' }),
      ).verdict,
    ).toBe('retry');
  });

  it('allows the whole chain when the failing step is not itself an inner step (merge gate)', () => {
    const d = parseLaneTriageOutput(
      { verdict: 'retry', reason: 'r', targetStepId: 'task-verify', guidance: 'g' },
      laneReq({ stepId: 'awaiting-verify', failureKind: 'merge-gate' }),
    );
    expect(d).toMatchObject({ verdict: 'retry', targetStepId: 'task-verify' });
  });

  it('defaults an absent/blank targetStepId to the FIRST inner step', () => {
    for (const targetStepId of [undefined, '', '   ']) {
      expect(
        parseLaneTriageOutput({ verdict: 'retry', reason: 'r', guidance: 'g', targetStepId }, laneReq()),
      ).toMatchObject({ verdict: 'retry', targetStepId: 'implement' });
    }
  });

  it('gives up when the lane has no inner chain to re-drive from', () => {
    expect(
      parseLaneTriageOutput(
        { verdict: 'retry', reason: 'r', guidance: 'g' },
        laneReq({ innerStepIds: [] }),
      ).verdict,
    ).toBe('give_up');
  });

  it('downgrades adjust_and_retry with a blank taskBody to a plain retry (guidance survives)', () => {
    for (const taskBody of [undefined, '', '   ', 42]) {
      expect(
        parseLaneTriageOutput(
          { verdict: 'adjust_and_retry', reason: 'r', targetStepId: 'implement', guidance: 'narrow the AC', taskBody },
          laneReq(),
        ),
      ).toEqual({ verdict: 'retry', targetStepId: 'implement', guidance: 'narrow the AC', reason: 'r' });
    }
  });

  it('tolerates a missing/non-string reason on a rescue verdict', () => {
    expect(
      parseLaneTriageOutput({ verdict: 'retry', targetStepId: 'implement', guidance: 'g' }, laneReq()),
    ).toEqual({ verdict: 'retry', targetStepId: 'implement', guidance: 'g', reason: '' });
  });
});

describe('DefaultMonitorSession.triageLane', () => {
  it('reads the history fresh, runs the lane schema query, and returns a parsed rescue', async () => {
    const { reader, reads } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      verdict: 'retry',
      reason: 'the fixture is stale',
      targetStepId: 'write-tests',
      guidance: 'regenerate the fixture from the new schema',
    });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({
      ctx,
      history: reader,
      structuredQuery,
      textQuery: vi.fn(),
      injectEvent,
      model: 'opus',
    });
    const controller = new AbortController();

    const decision = await session.triageLane(laneReq(), controller.signal);

    expect(decision).toEqual({
      verdict: 'retry',
      targetStepId: 'write-tests',
      guidance: 'regenerate the fixture from the new schema',
      reason: 'the fixture is stale',
    });
    expect(reads).toEqual(['run-1']);
    const args = (structuredQuery as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.schema).toBe(MONITOR_LANE_TRIAGE_SCHEMA);
    expect(args.cwd).toBe('/wt');
    expect(args.model).toBe('opus');
    expect(args.signal).toBe(controller.signal);
    expect(args.prompt).toContain('TASK-014');
    // Announcement BEFORE the decision turn, both as assistant turns.
    expect(injected.map((m) => m.role)).toEqual(['assistant', 'assistant']);
    expect(injected[0].text).toContain('TASK-014');
    expect(injected[0].text).toContain('Triaging the lane');
    expect(injected[1].text).toContain('rescue');
    expect(injected[1].text).toContain('`write-tests`');
    expect(injected[1].text).toContain('regenerate the fixture from the new schema');
  });

  it('reports an adjust_and_retry verdict as an ADJUSTED-body rescue', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockResolvedValue({
      verdict: 'adjust_and_retry',
      reason: 'exporter.ts:42 has no UTC mode',
      targetStepId: 'implement',
      guidance: 'narrow the AC to local time',
      taskBody: '## AC\n- local timestamps',
    });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent });

    const decision = await session.triageLane(laneReq());

    expect(decision).toEqual({
      verdict: 'adjust_and_retry',
      targetStepId: 'implement',
      guidance: 'narrow the AC to local time',
      taskBody: '## AC\n- local timestamps',
      reason: 'exporter.ts:42 has no UTC mode',
    });
    expect(injected[1].text).toContain('ADJUSTED task body');
    expect(injected[1].text).toContain('exporter.ts:42');
  });

  it('reports a give_up verdict without claiming a rescue', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ verdict: 'give_up', reason: 'the requirement is genuinely unimplementable here' });
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent });

    const decision = await session.triageLane(laneReq());

    expect(decision).toEqual({ verdict: 'give_up', reason: 'the requirement is genuinely unimplementable here' });
    expect(injected[1].text).toContain('no rescue');
    expect(injected[1].text).toContain('genuinely unimplementable');
    expect(injected[1].text).not.toContain('re-drive');
  });

  it('fails-soft to give_up (with a chat note) when the query throws', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent });

    const decision = await session.triageLane(laneReq());

    expect(decision.verdict).toBe('give_up');
    expect(decision.reason).toContain('lane triage failed');
    // The failure announcement still rendered, plus an explicit could-not-run note.
    expect(injected).toHaveLength(2);
    expect(injected[1].text).toContain('could not run');
    expect(injected[1].text).toContain('sdk down');
  });

  it('tags the give_up with the SYSTEMIC error text when the triage query dies on a dead quota', async () => {
    // The 2026-09-05 cascade shape: the supervisor's OWN turn hits the limit, so
    // it judges nothing. An untagged give_up here fails the lane for something
    // the lane did not do (and, concurrently, every one of its siblings).
    const limit = "You've hit your session limit · resets 6pm (America/Los_Angeles)";
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockRejectedValue(new Error(limit));
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent });

    const decision = await session.triageLane(laneReq());

    expect(decision).toMatchObject({ verdict: 'give_up', systemicError: limit });
    expect(injected[1].text).toContain('environment-level');
    expect(injected[1].text).not.toContain('letting the lane fail');
  });

  it('leaves systemicError unset for an ORDINARY triage failure', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi.fn().mockRejectedValue(new Error('sdk down'));
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn() });

    const decision = await session.triageLane(laneReq());

    expect(decision.verdict).toBe('give_up');
    expect(decision).not.toHaveProperty('systemicError');
  });

  it('fails-soft to give_up when the history read throws', async () => {
    const reader: HistoryReader = { read: vi.fn().mockRejectedValue(new Error('db gone')) };
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery: vi.fn(), textQuery: vi.fn() });

    expect((await session.triageLane(laneReq())).verdict).toBe('give_up');
  });

  it('never throws out of triageLane when injectEvent throws', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    const structuredQuery: StructuredQueryFn = vi
      .fn()
      .mockResolvedValue({ verdict: 'retry', reason: 'r', targetStepId: 'implement', guidance: 'g' });
    const injectEvent = (): void => {
      throw new Error('bridge gone');
    };
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery: vi.fn(), injectEvent });

    await expect(session.triageLane(laneReq())).resolves.toMatchObject({ verdict: 'retry' });
  });

  it('serializes against converse so a rescue never interleaves with a human exchange', async () => {
    const { reader } = fakeHistory({ conversation: [], steps: [] });
    // A SLOW lane-triage query: were triageLane not on converse's sendChain, the
    // human's user turn + reply would inject between its two turns.
    const structuredQuery: StructuredQueryFn = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ verdict: 'give_up', reason: 'genuine' }), 20),
        ),
    );
    const textQuery: TextQueryFn = vi.fn().mockResolvedValue('human reply');
    const { injectEvent, injected } = collectInjected();
    const session = new DefaultMonitorSession({ ctx, history: reader, structuredQuery, textQuery, injectEvent });

    const triage = session.triageLane(laneReq());
    const chat = session.converse('what happened?');
    await Promise.all([triage, chat]);

    expect(injected.map((m) => m.role)).toEqual(['assistant', 'assistant', 'user', 'assistant']);
    expect(injected[1].text).toContain('no rescue');
    expect(injected[2].text).toBe('what happened?');
    expect(injected[3].text).toBe('human reply');
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
