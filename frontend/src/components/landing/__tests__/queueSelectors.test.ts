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
import { compactAge, countApprovals, selectReadyToReviewRuns } from '../queueSelectors';

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
