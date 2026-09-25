/**
 * queueSelectors — pure unit tests for the Human Review Queue's shared
 * selectors: gate-aware ready-to-review filtering, approval counting, and
 * compact age formatting.
 */
import { describe, it, expect } from 'vitest';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';
import type { QueueItem } from '../../../utils/reviewQueueSelectors';
import type { Approval } from '../../../../../shared/types/approvals';
import type { ReviewItem } from '../../../../../shared/types/reviews';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import { describeReadyState, type QuickSessionTriage } from '../../../utils/quickSessionTriage';
import {
  applyFlowRunPrecedence,
  compactAge,
  countApprovals,
  nonTerminalFlowRunBySession,
  resolveOpenTarget,
  selectReadyToReviewRuns,
  significantFlowRunBySession,
} from '../queueSelectors';

function makeRun(overrides: Partial<ActiveRunRow> & { id: string }): ActiveRunRow {
  return {
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'awaiting_review',
    worktree_path: '/wt',
    branch_name: 'quick-ship',
    permission_mode_snapshot: 'default',
    workflowName: 'Ship',
    created_at: '2026-07-06 12:00:00',
    updated_at: '2026-07-06 12:30:00',
    started_at: '2026-07-06 12:00:00',
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  };
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_1',
    project_id: 1,
    run_id: overrides.run_id ?? null,
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: overrides.blocking ?? false,
    audience: 'human',
    title: 'A gate',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: null,
    payload: null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

function makeQuickRow(overrides: Partial<QuickSessionRow> & { sessionId: string }): QuickSessionRow {
  return {
    sessionId: overrides.sessionId,
    name: overrides.name ?? 'faint-harbor',
    projectId: overrides.projectId ?? 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? null,
    unviewed: overrides.unviewed ?? false,
    restedAtIso: overrides.restedAtIso ?? null,
    rawStatus: overrides.rawStatus ?? 'completed',
    exitCode: overrides.exitCode ?? null,
    summary: overrides.summary ?? null,
    summaryState: overrides.summaryState ?? null,
    waitingOn: overrides.waitingOn ?? null,
    summarySupported: overrides.summarySupported ?? true,
    worktreeName: overrides.worktreeName ?? null,
    git: overrides.git ?? null,
  };
}

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    runId: 'run-1',
    workflowName: 'Ship',
    toolName: 'Bash',
    payloadPreview: 'rm -rf tmp',
    rationale: null,
    createdAt: '2026-07-06T00:00:00.000Z',
    status: 'pending',
    sessionName: null,
    worktreeName: null,
    agentProvider: null,
    awaited: true,
    ...overrides,
  };
}

describe('selectReadyToReviewRuns', () => {
  it('includes an awaiting_review run with no blocking gate', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    expect(selectReadyToReviewRuns(runs, [], [])).toEqual(runs);
  });

  it('excludes runs whose status is not awaiting_review', () => {
    const runs = [makeRun({ id: 'run-running', status: 'running' }), makeRun({ id: 'run-stuck', status: 'stuck' })];
    expect(selectReadyToReviewRuns(runs, [], [])).toEqual([]);
  });

  it('excludes a run with a pending blocking review item', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    const reviewItems = [makeReviewItem({ id: 'rvw-1', run_id: 'run-a', blocking: true })];
    expect(selectReadyToReviewRuns(runs, reviewItems, [])).toEqual([]);
  });

  it('keeps a run whose review item is non-blocking', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    const reviewItems = [makeReviewItem({ id: 'rvw-1', run_id: 'run-a', blocking: false })];
    expect(selectReadyToReviewRuns(runs, reviewItems, [])).toEqual(runs);
  });

  it('excludes a run with a pending permission approval (single)', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    const permissionItems: QueueItem[] = [
      { kind: 'single', approval: makeApproval({ runId: 'run-a' }), isBlocking: true },
    ];
    expect(selectReadyToReviewRuns(runs, [], permissionItems)).toEqual([]);
  });

  it('excludes a run with a pending permission approval (group)', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    const permissionItems: QueueItem[] = [
      {
        kind: 'group',
        runId: 'run-a',
        toolName: 'Bash',
        payloadSignature: 'sig',
        items: [makeApproval({ runId: 'run-a' })],
        isBlocking: true,
      },
    ];
    expect(selectReadyToReviewRuns(runs, [], permissionItems)).toEqual([]);
  });

  it('excludes a run named in landingBlockingRunIds', () => {
    const runs = [makeRun({ id: 'run-a', status: 'awaiting_review' })];
    expect(selectReadyToReviewRuns(runs, [], [], new Set(['run-a']))).toEqual([]);
  });

  it('keeps unrelated awaiting_review runs while filtering the blocked one', () => {
    const runs = [
      makeRun({ id: 'run-a', status: 'awaiting_review' }),
      makeRun({ id: 'run-b', status: 'awaiting_review' }),
    ];
    const reviewItems = [makeReviewItem({ id: 'rvw-1', run_id: 'run-a', blocking: true })];
    expect(selectReadyToReviewRuns(runs, reviewItems, []).map((r) => r.id)).toEqual(['run-b']);
  });
});

describe('countApprovals', () => {
  it('counts a single item as 1', () => {
    const items: QueueItem[] = [{ kind: 'single', approval: makeApproval(), isBlocking: false }];
    expect(countApprovals(items)).toBe(1);
  });

  it('counts a group by its member count', () => {
    const items: QueueItem[] = [
      {
        kind: 'group',
        runId: 'run-1',
        toolName: 'Bash',
        payloadSignature: 'sig',
        items: [makeApproval({ id: 'a1' }), makeApproval({ id: 'a2' }), makeApproval({ id: 'a3' })],
        isBlocking: false,
      },
    ];
    expect(countApprovals(items)).toBe(3);
  });

  it('sums across mixed single and group items', () => {
    const items: QueueItem[] = [
      { kind: 'single', approval: makeApproval({ id: 'a1' }), isBlocking: false },
      {
        kind: 'group',
        runId: 'run-1',
        toolName: 'Bash',
        payloadSignature: 'sig',
        items: [makeApproval({ id: 'a2' }), makeApproval({ id: 'a3' })],
        isBlocking: false,
      },
    ];
    expect(countApprovals(items)).toBe(3);
  });

  it('returns 0 for an empty list', () => {
    expect(countApprovals([])).toBe(0);
  });
});

describe('compactAge', () => {
  const nowMs = Date.parse('2026-07-06T12:00:00.000Z');

  it('formats sub-hour ages in minutes, floored to at least 1', () => {
    expect(compactAge('2026-07-06T11:59:30.000Z', nowMs)).toBe('1m');
    expect(compactAge('2026-07-06T11:30:00.000Z', nowMs)).toBe('30m');
  });

  it('formats sub-two-day ages in hours', () => {
    expect(compactAge('2026-07-06T06:00:00.000Z', nowMs)).toBe('6h');
    expect(compactAge('2026-07-05T13:00:00.000Z', nowMs)).toBe('23h');
  });

  it('formats ages of 48h or more in days', () => {
    expect(compactAge('2026-07-03T12:00:00.000Z', nowMs)).toBe('3d');
  });

  it('treats a zone-less SQLite timestamp as UTC', () => {
    expect(compactAge('2026-07-06 11:00:00', nowMs)).toBe('1h');
  });

  it('returns the placeholder for an unparseable timestamp', () => {
    expect(compactAge('not-a-date', nowMs)).toBe('—');
  });
});

describe('nonTerminalFlowRunBySession', () => {
  it('includes a running run, keyed by its session id', () => {
    const run = makeRun({ id: 'run-a', status: 'running', session_id: 'sess-a' });
    expect(nonTerminalFlowRunBySession([run])).toEqual(new Map([['sess-a', run]]));
  });

  it('includes a blocked run (awaiting_review/stuck/paused/awaiting_input) — not just active', () => {
    for (const status of ['awaiting_review', 'stuck', 'paused', 'awaiting_input'] as const) {
      const run = makeRun({ id: `run-${status}`, status, session_id: 'sess-a' });
      expect(nonTerminalFlowRunBySession([run]).get('sess-a')).toEqual(run);
    }
  });

  it('excludes a terminal run (completed/failed/canceled)', () => {
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const run = makeRun({ id: `run-${status}`, status, session_id: 'sess-a' });
      expect(nonTerminalFlowRunBySession([run]).has('sess-a')).toBe(false);
    }
  });

  it('excludes a run with no session_id', () => {
    const run = makeRun({ id: 'run-a', status: 'running', session_id: null });
    expect(nonTerminalFlowRunBySession([run]).size).toBe(0);
  });
});

describe('significantFlowRunBySession (TASK-226 — Ready-for-review navigation/label map)', () => {
  it('includes a terminal run, keyed by its session id', () => {
    for (const status of ['completed', 'failed', 'canceled'] as const) {
      const run = makeRun({ id: `run-${status}`, status, session_id: 'sess-a' });
      expect(significantFlowRunBySession([run]).get('sess-a')).toEqual(run);
    }
  });

  it('prefers a non-terminal run over a terminal one for the same session, regardless of order', () => {
    const done = makeRun({ id: 'run-done', status: 'completed', session_id: 'sess-a', created_at: '2026-07-06 13:00:00' });
    const live = makeRun({ id: 'run-live', status: 'running', session_id: 'sess-a', created_at: '2026-07-06 12:00:00' });
    expect(significantFlowRunBySession([done, live]).get('sess-a')).toEqual(live);
    expect(significantFlowRunBySession([live, done]).get('sess-a')).toEqual(live);
  });

  it('picks the NEWEST terminal run when a session has only terminal runs', () => {
    const older = makeRun({ id: 'run-old', status: 'failed', session_id: 'sess-a', created_at: '2026-07-06 12:00:00' });
    const newer = makeRun({ id: 'run-new', status: 'completed', session_id: 'sess-a', created_at: '2026-07-06 13:00:00' });
    expect(significantFlowRunBySession([older, newer]).get('sess-a')).toEqual(newer);
    expect(significantFlowRunBySession([newer, older]).get('sess-a')).toEqual(newer);
  });

  it('excludes a run with no session_id', () => {
    const run = makeRun({ id: 'run-a', status: 'completed', session_id: null });
    expect(significantFlowRunBySession([run]).size).toBe(0);
  });

  it('routes a Ready row of a session whose flow run finished to THAT run via resolveOpenTarget', () => {
    const done = makeRun({ id: 'run-done', status: 'completed', session_id: 'sess-a', project_id: 4 });
    const target = resolveOpenTarget(
      makeQuickRow({ sessionId: 'sess-a', runId: 'wf-6-__quick__', projectId: 4 }),
      significantFlowRunBySession([done]),
    );
    expect(target).toEqual({ kind: 'run', runId: 'run-done', projectId: 4 });
  });

  describe('"most recent activity wins" (product decision 2026-09-25)', () => {
    it('keeps flow precedence when the flow run finished at/after the chat\'s own last activity', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'completed',
        session_id: 'sess-a',
        created_at: '2026-07-06 12:00:00',
        ended_at: '2026-07-06 13:00:00',
      });
      const chatActivityBySession = new Map([['sess-a', '2026-07-06T13:00:00.000Z']]);
      expect(significantFlowRunBySession([done], chatActivityBySession).get('sess-a')).toEqual(done);
    });

    it('drops flow precedence when the chat has fresher activity than the flow run\'s finish', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'completed',
        session_id: 'sess-a',
        created_at: '2026-07-06 12:00:00',
        ended_at: '2026-07-06 13:00:00',
      });
      const chatActivityBySession = new Map([['sess-a', '2026-07-06T14:00:00.000Z']]);
      expect(significantFlowRunBySession([done], chatActivityBySession).has('sess-a')).toBe(false);
    });

    it('falls back to created_at when the flow run never ended', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'canceled',
        session_id: 'sess-a',
        created_at: '2026-07-06 12:00:00',
        ended_at: null,
      });
      const staleActivity = new Map([['sess-a', '2026-07-06T11:00:00.000Z']]);
      expect(significantFlowRunBySession([done], staleActivity).get('sess-a')).toEqual(done);

      const freshActivity = new Map([['sess-a', '2026-07-06T13:00:00.000Z']]);
      expect(significantFlowRunBySession([done], freshActivity).has('sess-a')).toBe(false);
    });

    it('fails open to flow precedence when the session has no chat-activity entry', () => {
      const done = makeRun({ id: 'run-done', status: 'completed', session_id: 'sess-a' });
      expect(significantFlowRunBySession([done], new Map()).get('sess-a')).toEqual(done);
      expect(significantFlowRunBySession([done]).get('sess-a')).toEqual(done);
    });

    it('fails open when the chat-activity entry is null or unparseable', () => {
      const done = makeRun({ id: 'run-done', status: 'completed', session_id: 'sess-a' });
      expect(
        significantFlowRunBySession([done], new Map([['sess-a', null]])).get('sess-a'),
      ).toEqual(done);
      expect(
        significantFlowRunBySession([done], new Map([['sess-a', 'not-a-date']])).get('sess-a'),
      ).toEqual(done);
    });

    it('never gates a NON-terminal run behind chat recency', () => {
      const live = makeRun({ id: 'run-live', status: 'running', session_id: 'sess-a' });
      const freshActivity = new Map([['sess-a', '2099-01-01T00:00:00.000Z']]);
      expect(significantFlowRunBySession([live], freshActivity).get('sess-a')).toEqual(live);
    });

    it('end-to-end: resolveOpenTarget falls back to the quick session once the chat outpaces the finished flow run', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'completed',
        session_id: 'sess-a',
        project_id: 4,
        ended_at: '2026-07-06 13:00:00',
      });
      const chatActivityBySession = new Map([['sess-a', '2026-07-06T14:00:00.000Z']]);
      const target = resolveOpenTarget(
        { sessionId: 'sess-a', runId: 'quick-run-1', projectId: 4 },
        significantFlowRunBySession([done], chatActivityBySession),
      );
      expect(target).toEqual({ kind: 'quick', sessionId: 'sess-a', runId: 'quick-run-1', projectId: 4 });
    });

    it('end-to-end: describeReadyState reflects the chat\'s own failed state once the chat outpaces the finished flow run', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'completed',
        session_id: 'sess-a',
        ended_at: '2026-07-06 13:00:00',
      });
      const freshFailedChat = makeQuickRow({
        sessionId: 'sess-a',
        rawStatus: 'failed',
        restedAtIso: '2026-07-06T14:00:00.000Z',
      });
      const map = significantFlowRunBySession([done], new Map([['sess-a', freshFailedChat.restedAtIso]]));
      const flowRun = map.get('sess-a');
      // Not present -> ReadyForReviewSection's readFacts passes `undefined`,
      // so describeReadyState reads the row's OWN failed/exitCode signal.
      expect(flowRun).toBeUndefined();
      expect(describeReadyState(freshFailedChat, flowRun)).toEqual({ label: 'stopped early', tone: 'error' });
    });

    it('end-to-end: describeReadyState still reads the flow run when it postdates the chat', () => {
      const done = makeRun({
        id: 'run-done',
        status: 'canceled',
        session_id: 'sess-a',
        ended_at: '2026-07-06 13:00:00',
      });
      const staleChat = makeQuickRow({
        sessionId: 'sess-a',
        rawStatus: 'failed', // the interrupted __quick__ chat's own dead status
        restedAtIso: '2026-07-06T12:00:00.000Z',
      });
      const map = significantFlowRunBySession([done], new Map([['sess-a', staleChat.restedAtIso]]));
      const flowRun = map.get('sess-a');
      expect(flowRun).toEqual(done);
      // The row's own `failed` status is ignored — the flow run's `canceled`
      // status is what actually happened (TASK-226).
      expect(describeReadyState(staleChat, flowRun)).toEqual({ label: 'stopped by you', tone: 'neutral' });
    });
  });
});

describe('applyFlowRunPrecedence', () => {
  it('strips a session from needsInput/readyForReview/working alike when a flow run represents it', () => {
    const flowRunBySession = new Map([['sess-a', makeRun({ id: 'run-a', status: 'running', session_id: 'sess-a' })]]);
    const triage: QuickSessionTriage = {
      needsInput: [makeQuickRow({ sessionId: 'sess-a', state: 'blocked' })],
      readyForReview: [makeQuickRow({ sessionId: 'sess-a', rawStatus: 'stopped' })],
      working: [makeQuickRow({ sessionId: 'sess-a', state: 'running' })],
    };
    expect(applyFlowRunPrecedence(triage, flowRunBySession)).toEqual({
      needsInput: [],
      readyForReview: [],
      working: [],
    });
  });

  it('the swift-bison case: a failed __quick__ run beside a running flow run never lands in Ready for review', () => {
    const flowRunBySession = new Map([
      ['swift-bison', makeRun({ id: 'wf-global-planner', status: 'running', session_id: 'swift-bison' })],
    ]);
    // deriveQuickSessionTriage classifies an interrupted/failed __quick__ run as idle -> readyForReview.
    const triage: QuickSessionTriage = {
      needsInput: [],
      readyForReview: [makeQuickRow({ sessionId: 'swift-bison', rawStatus: 'stopped', runId: 'wf-6-__quick__' })],
      working: [],
    };
    expect(applyFlowRunPrecedence(triage, flowRunBySession).readyForReview).toEqual([]);
  });

  it('leaves an unrelated session untouched in every bucket', () => {
    const flowRunBySession = new Map([['sess-a', makeRun({ id: 'run-a', status: 'running', session_id: 'sess-a' })]]);
    const untouchedRow = makeQuickRow({ sessionId: 'sess-b' });
    const triage: QuickSessionTriage = {
      needsInput: [],
      readyForReview: [untouchedRow],
      working: [],
    };
    expect(applyFlowRunPrecedence(triage, flowRunBySession).readyForReview).toEqual([untouchedRow]);
  });

  it('gives a session back to its own row once its flow run is terminal (not in the map)', () => {
    const flowRunBySession = new Map<string, ActiveRunRow>(); // the flow run finished -> excluded upstream
    const row = makeQuickRow({ sessionId: 'sess-a', rawStatus: 'stopped' });
    const triage: QuickSessionTriage = { needsInput: [], readyForReview: [row], working: [] };
    expect(applyFlowRunPrecedence(triage, flowRunBySession).readyForReview).toEqual([row]);
  });
});

describe('resolveOpenTarget', () => {
  it('routes to the flow run when the session hosts one, ignoring the row\'s own (possibly dead) runId', () => {
    const flowRun = makeRun({ id: 'wf-global-planner', status: 'running', session_id: 'swift-bison', project_id: 7 });
    const flowRunBySession = new Map([['swift-bison', flowRun]]);
    const row = { sessionId: 'swift-bison', runId: 'wf-6-__quick__', projectId: 1 };

    expect(resolveOpenTarget(row, flowRunBySession)).toEqual({
      kind: 'run',
      runId: 'wf-global-planner',
      projectId: 7,
    });
  });

  it('falls back to the quick session when no flow run represents it', () => {
    const row = { sessionId: 'sess-a', runId: 'quick-run-1', projectId: 1 };
    expect(resolveOpenTarget(row, new Map())).toEqual({
      kind: 'quick',
      sessionId: 'sess-a',
      runId: 'quick-run-1',
      projectId: 1,
    });
  });
});
