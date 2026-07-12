/**
 * TypeGroupedQueue — "Ready to review" group tests.
 *
 * A run drained to `awaiting_review` mints NO review_item (clean-drain), so the
 * landing queue is the only surface that catches it. These tests pin that a run
 * in `awaiting_review` surfaces under the distinct ready-to-review group (and
 * ONLY that status does), separate from permission/decision/human_task.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import type { WorkflowRunStatus } from '../../../../shared/types/cyboflow';
import type { ReviewItem } from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

let mockRuns: ActiveRunRow[] = [];
let mockReviewItems: ReviewItem[] = [];
let mockBlockingFindings: ReviewItem[] = [];
let mockBlockingRunIds: ReadonlySet<string> = new Set();

vi.mock('../../stores/reviewQueueStore', () => ({
  useReviewQueueView: () => ({ blocking: [], normal: [] }),
}));

vi.mock('../../stores/reviewQueueSlice', () => ({
  useReviewQueueSlice: (selector: (s: { runStatusMap: Record<string, unknown> }) => unknown) =>
    selector({ runStatusMap: {} }),
}));

vi.mock('../../stores/landingStore', () => ({
  useAggregatedBlockingFindings: () => mockBlockingFindings,
  useAggregatedBlockingRunIds: () => mockBlockingRunIds,
  useAggregatedReviewItems: () => mockReviewItems,
  useAggregatedRuns: () => mockRuns,
  useRunProjectMap: () => ({}),
}));

vi.mock('../ReviewQueue/ReviewItemCard', () => ({
  ReviewItemCard: ({ item }: { item: ReviewItem }) => (
    <div data-testid="review-item" data-kind={item.kind}>
      {item.title}
    </div>
  ),
}));

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun: vi.fn() }) },
}));

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }),
  },
}));

import { TypeGroupedQueue } from '../landing/TypeGroupedQueue';

function makeRun(overrides: Partial<ActiveRunRow> & { id: string; status: WorkflowRunStatus }): ActiveRunRow {
  return {
    workflow_id: 'wf-1-ship',
    project_id: 1,
    worktree_path: '/wt',
    branch_name: 'quick-ship',
    session_id: 'sess-1',
    permission_mode_snapshot: 'default',
    created_at: '2026-07-06 12:00:00',
    updated_at: '2026-07-06 12:30:00',
    started_at: '2026-07-06 12:00:00',
    ended_at: null,
    stuck_reason: null,
    workflowName: 'Ship',
    ...overrides,
  } as ActiveRunRow;
}

function makeReviewItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: 'review-1',
    project_id: 1,
    run_id: 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'decision',
    status: 'pending',
    blocking: true,
    title: 'Approve workflow output',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: 'gate:approve-plan',
    payload: null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
    ...overrides,
  };
}

describe('TypeGroupedQueue — Ready to review group', () => {
  beforeEach(() => {
    mockRuns = [];
    mockReviewItems = [];
    mockBlockingFindings = [];
    mockBlockingRunIds = new Set();
  });

  it('renders an awaiting_review run under the ready-to-review group', () => {
    mockRuns = [makeRun({ id: 'run-a', status: 'awaiting_review', workflowName: 'Ship', branch_name: 'ship/feature-x' })];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-ready-to-review');
    expect(within(group).getByText('Ready to review')).toBeInTheDocument();
    expect(within(group).getByText('1 pending')).toBeInTheDocument();
    expect(within(group).getByText('Ship')).toBeInTheDocument();
    expect(within(group).getByText('⌥ ship/feature-x')).toBeInTheDocument();
    // Distinct from the blocked/urgent groups.
    expect(screen.queryByTestId('queue-group-permission')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-decision')).not.toBeInTheDocument();
  });

  it('does NOT surface non-awaiting_review runs (running/stuck) in the queue', () => {
    mockRuns = [
      makeRun({ id: 'run-run', status: 'running' }),
      makeRun({ id: 'run-stuck', status: 'stuck' }),
    ];
    render(<TypeGroupedQueue />);

    expect(screen.queryByTestId('queue-group-ready-to-review')).not.toBeInTheDocument();
    // No pending items of any kind → empty state.
    expect(screen.getByText('No pending reviews')).toBeInTheDocument();
  });

  it('counts multiple awaiting_review runs', () => {
    mockRuns = [
      makeRun({ id: 'run-a', status: 'awaiting_review' }),
      makeRun({ id: 'run-b', status: 'awaiting_review', workflowName: 'Sprint' }),
      makeRun({ id: 'run-c', status: 'running' }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-ready-to-review');
    expect(within(group).getByText('2 pending')).toBeInTheDocument();
  });

  it('surfaces a blocking finding as actionable and suppresses Ready to review', () => {
    mockRuns = [makeRun({ id: 'run-finding', status: 'awaiting_review' })];
    mockBlockingFindings = [makeReviewItem({
      id: 'finding-blocking',
      run_id: 'run-finding',
      kind: 'finding',
      title: 'Fix the README',
    })];
    mockBlockingRunIds = new Set(['run-finding']);

    render(<TypeGroupedQueue />);

    expect(screen.queryByTestId('queue-group-ready-to-review')).not.toBeInTheDocument();
    const group = screen.getByTestId('queue-group-blocking-finding');
    expect(within(group).getByText('Blocking finding')).toBeInTheDocument();
    expect(within(group).getByText('Fix the README')).toBeInTheDocument();
  });

  it('keeps a nonblocking finding hidden while showing the clean drain as Ready to review', () => {
    mockRuns = [makeRun({ id: 'run-finding', status: 'awaiting_review' })];

    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-ready-to-review');
    expect(within(group).getByText('1 pending')).toBeInTheDocument();
    expect(screen.queryByTestId('review-item')).not.toBeInTheDocument();
  });

  it.each(['approve-idea', 'approve-design', 'approve-plan'])(
    'keeps the intermediate %s gate in Decision instead of Ready to review',
    (gate) => {
      mockRuns = [makeRun({ id: 'run-gate', status: 'awaiting_review' })];
      mockReviewItems = [
        makeReviewItem({
          id: `review-${gate}`,
          run_id: 'run-gate',
          source: `gate:${gate}`,
          title: `Approve ${gate}`,
        }),
      ];
      render(<TypeGroupedQueue />);

      const decisionGroup = screen.getByTestId('queue-group-decision');
      expect(within(decisionGroup).getByText(`Approve ${gate}`)).toBeInTheDocument();
      expect(screen.queryByTestId('queue-group-ready-to-review')).not.toBeInTheDocument();
    },
  );
});
