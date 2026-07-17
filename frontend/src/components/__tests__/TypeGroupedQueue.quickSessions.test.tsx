/**
 * TypeGroupedQueue — quick-session board integration.
 *
 * The old idle-session review_item group was replaced by the live
 * QuickSessionsTable. These tests pin the two behaviors that matter at the
 * TypeGroupedQueue seam:
 *   1. A LEGACY `idle-session:<id>` human_task row (pending until the startup
 *      drain resolves it) is filtered OUT — it never renders as a stray "Human
 *      task", and there is no "Idle sessions" group any more.
 *   2. The quick-session board renders its rows and keeps the queue mounted when
 *      a quick session needs attention.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDLE_REVIEW_SOURCE_PREFIX, type ReviewItem } from '../../../../shared/types/reviews';
import type { QuickSessionRow } from '../../../../shared/types/quickSessions';

let mockReviewItems: ReviewItem[] = [];
let mockQuickRows: QuickSessionRow[] = [];

vi.mock('../../stores/reviewQueueStore', () => ({
  useReviewQueueView: () => ({ blocking: [], normal: [] }),
}));
vi.mock('../../stores/reviewQueueSlice', () => ({
  useReviewQueueSlice: (selector: (s: { runStatusMap: Record<string, unknown> }) => unknown) =>
    selector({ runStatusMap: {} }),
}));
vi.mock('../../stores/landingStore', () => ({
  useAggregatedBlockingFindings: () => [],
  useAggregatedBlockingRunIds: () => new Set<string>(),
  useAggregatedReviewItems: () => mockReviewItems,
  useAggregatedRuns: () => [],
  useRunProjectMap: () => ({}),
}));
vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun: vi.fn(), setActiveQuickSession: vi.fn() }) },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }) },
}));
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ markSessionAsViewed: vi.fn().mockResolvedValue(undefined) }) },
}));
vi.mock('../../hooks/useReviewItemActions', () => ({
  useReviewItemActions: () => ({
    pendingItemId: null,
    error: null,
    resolve: vi.fn(),
    acceptFinding: vi.fn(),
    dismiss: vi.fn(),
    promoteToTask: vi.fn(),
  }),
}));

// The quick-session board store — actual selector logic (needsAttention) is kept
// real; only the data source + polling side effects are stubbed.
vi.mock('../../stores/quickSessionsStore', () => ({
  useQuickSessionRows: () => mockQuickRows,
  needsAttention: (row: QuickSessionRow) =>
    row.state === 'blocked' || (row.state === 'idle' && row.unviewed),
  useQuickSessionsStore: { getState: () => ({ init: () => () => undefined, refresh: vi.fn() }) },
}));

// The dynamic-workflow feed drives the idle→running override; no live workflows
// here, so the board reflects the mocked quick rows verbatim.
vi.mock('../../stores/dynamicWorkflowStore', () => ({
  useActiveDynamicWorkflows: () => [],
}));

import { TypeGroupedQueue } from '../landing/TypeGroupedQueue';

function makeItem(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? 'rvw_1',
    project_id: 1,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: null,
    entity_id: null,
    kind: 'human_task',
    status: 'pending',
    blocking: overrides.blocking ?? true,
    title: overrides.title ?? 'A task',
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: overrides.source ?? null,
    payload: null,
    created_at: overrides.created_at ?? '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
}

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: overrides.sessionId ?? 'sess-a',
    name: overrides.name ?? 'smooth-falcon',
    projectId: 1,
    runId: overrides.runId ?? 'quick-run-1',
    state: overrides.state ?? 'idle',
    idleSince: overrides.idleSince ?? '2026-07-06T00:00:00.000Z',
    unviewed: overrides.unviewed ?? true,
  };
}

beforeEach(() => {
  mockReviewItems = [];
  mockQuickRows = [];
});

describe('TypeGroupedQueue — quick-session board', () => {
  it('filters a legacy idle-session item out (no Idle group, not a Human task)', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);
    expect(screen.queryByTestId('queue-group-idle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-human-task')).not.toBeInTheDocument();
    // With only a filtered legacy item and no quick rows, the queue is empty.
    expect(screen.getByText('No pending reviews')).toBeInTheDocument();
  });

  it('keeps a generic human_task while filtering the idle-session sibling', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_ht', title: 'Ping the owner', source: 'monitor', blocking: false }),
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);
    const humanGroup = screen.getByTestId('queue-group-human-task');
    expect(within(humanGroup).getByText('Ping the owner')).toBeInTheDocument();
    expect(within(humanGroup).queryByText(/Idle session needs your attention/)).not.toBeInTheDocument();
  });

  it('renders the quick-session board and keeps the queue mounted for an attention row', () => {
    mockQuickRows = [quickRow({ name: 'tidy-valley', state: 'blocked', idleSince: null, unviewed: false })];
    render(<TypeGroupedQueue />);
    const board = screen.getByTestId('queue-group-quick-sessions');
    expect(within(board).getByText('tidy-valley')).toBeInTheDocument();
    expect(within(board).getByText('blocked')).toBeInTheDocument();
    // A blocked quick session alone keeps the queue up (not the empty state).
    expect(screen.queryByText('No pending reviews')).not.toBeInTheDocument();
  });

  it('shows running quick sessions on the board too (full status board)', () => {
    mockQuickRows = [
      quickRow({ sessionId: 's1', name: 'busy-otter', state: 'running', idleSince: null, unviewed: false }),
      quickRow({ sessionId: 's2', name: 'quiet-mesa', state: 'idle', unviewed: true }),
    ];
    render(<TypeGroupedQueue />);
    const board = screen.getByTestId('queue-group-quick-sessions');
    expect(within(board).getByText('busy-otter')).toBeInTheDocument();
    expect(within(board).getByText('running')).toBeInTheDocument();
    expect(within(board).getByText('quiet-mesa')).toBeInTheDocument();
  });
});
