/**
 * TypeGroupedQueue — "Idle sessions" group tests.
 *
 * Idle-quick-session items are kind `human_task` tagged with a source of
 * `idle-session:<id>`. These tests pin that they render in their OWN "Idle
 * sessions" group (not the generic Human task group) and are ordered oldest-idle
 * first (earliest created_at at the top).
 */
import '@testing-library/jest-dom';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IDLE_REVIEW_SOURCE_PREFIX, type ReviewItem } from '../../../../shared/types/reviews';

let mockReviewItems: ReviewItem[] = [];

const mockSetActiveRun = vi.fn();
const mockSetActiveQuickSession = vi.fn();

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
  useCyboflowStore: {
    getState: () => ({
      setActiveRun: mockSetActiveRun,
      setActiveQuickSession: mockSetActiveQuickSession,
    }),
  },
}));
vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }),
  },
}));

beforeEach(() => {
  mockSetActiveRun.mockClear();
  mockSetActiveQuickSession.mockClear();
});
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
    title: overrides.title ?? 'Idle session needs your attention: quick-x',
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

describe('TypeGroupedQueue — Idle sessions group', () => {
  it('renders an idle-session item in the Idle sessions group, not Human task', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention: quick-a', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-idle');
    expect(within(group).getByText('Idle sessions')).toBeInTheDocument();
    expect(within(group).getByText('Idle session needs your attention: quick-a')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-group-human-task')).not.toBeInTheDocument();
  });

  it('keeps a generic human_task separate from idle-session items', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_ht', title: 'Ping the owner', source: 'monitor', blocking: false }),
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention: quick-a', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);

    const humanGroup = screen.getByTestId('queue-group-human-task');
    expect(within(humanGroup).getByText('Ping the owner')).toBeInTheDocument();
    expect(within(humanGroup).queryByText(/Idle session needs your attention/)).not.toBeInTheDocument();

    const idleGroup = screen.getByTestId('queue-group-idle');
    expect(within(idleGroup).getByText('Idle session needs your attention: quick-a')).toBeInTheDocument();
  });

  it('renders no triage CTAs on an idle item (open is the only action)', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_idle', title: 'Idle session needs your attention: quick-a', source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a` }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-idle');
    expect(within(group).queryByRole('button', { name: /resolve/i })).not.toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /promote to task/i })).not.toBeInTheDocument();
  });

  it('still renders triage CTAs on a NON-idle human_task', () => {
    mockReviewItems = [makeItem({ id: 'rvw_ht', title: 'Ping the owner', source: 'monitor' })];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-human-task');
    expect(within(group).getByRole('button', { name: /resolve/i })).toBeInTheDocument();
  });

  it('opens an idle item via setActiveQuickSession (quick host), NOT setActiveRun', () => {
    // The idle item's run_id is a __quick__ sentinel with no resolvable workflow
    // definition; routing it through setActiveRun (the flow-run host) hangs the
    // pane on "Loading workflow…". It must open via the quick-session host, keyed
    // by the sessionId parsed from the `idle-session:<sessionId>` source.
    mockReviewItems = [
      makeItem({
        id: 'rvw_idle',
        title: 'Idle session needs your attention: quick-a',
        source: `${IDLE_REVIEW_SOURCE_PREFIX}sess-a`,
        run_id: 'quick-run-1',
      }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-idle');
    fireEvent.click(within(group).getByRole('button', { name: /open session/i }));

    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-a', 'quick-run-1');
    expect(mockSetActiveRun).not.toHaveBeenCalled();
  });

  it('orders idle items oldest-idle first (earliest created_at at the top)', () => {
    mockReviewItems = [
      makeItem({ id: 'rvw_new', title: 'Idle session needs your attention: newer', source: `${IDLE_REVIEW_SOURCE_PREFIX}newer`, created_at: '2026-07-06T10:00:00.000Z' }),
      makeItem({ id: 'rvw_old', title: 'Idle session needs your attention: older', source: `${IDLE_REVIEW_SOURCE_PREFIX}older`, created_at: '2026-07-06T08:00:00.000Z' }),
      makeItem({ id: 'rvw_mid', title: 'Idle session needs your attention: middle', source: `${IDLE_REVIEW_SOURCE_PREFIX}middle`, created_at: '2026-07-06T09:00:00.000Z' }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-idle');
    const titles = within(group)
      .getAllByText(/Idle session needs your attention:/)
      .map((el) => el.textContent);
    expect(titles).toEqual([
      'Idle session needs your attention: older',
      'Idle session needs your attention: middle',
      'Idle session needs your attention: newer',
    ]);
  });
});
