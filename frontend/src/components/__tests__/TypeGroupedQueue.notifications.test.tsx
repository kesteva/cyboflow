/**
 * TypeGroupedQueue — "Notification" group tests.
 *
 * A dynamic-workflow finished/stalled item is a `notification` kind (never
 * blocking). These tests pin that it renders under the distinct notification
 * group — NOT the human-task group — so an informational FYI never masquerades
 * as an action item.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ReviewItem, ReviewItemKind } from '../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Shared mutable mock state
// ---------------------------------------------------------------------------

let mockReviewItems: ReviewItem[] = [];

vi.mock('../../stores/reviewQueueStore', () => ({
  useReviewQueueView: () => ({ blocking: [], normal: [] }),
}));

vi.mock('../../stores/reviewQueueSlice', () => ({
  useReviewQueueSlice: (selector: (s: { runStatusMap: Record<string, unknown> }) => unknown) =>
    selector({ runStatusMap: {} }),
}));

vi.mock('../../stores/landingStore', () => ({
  useAggregatedReviewItems: () => mockReviewItems,
  useAggregatedRuns: () => [],
  useRunProjectMap: () => ({}),
}));

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun: vi.fn() }) },
}));

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ setActiveProjectId: vi.fn(), goToSession: vi.fn() }),
  },
}));

// ReviewItemCard (rendered by ReviewItemRow) pulls in the triage hook + trpc
// client; stub them so the card mounts without a live tRPC connection.
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

function makeReviewItem(kind: ReviewItemKind, overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: overrides.id ?? `rvw_${kind}`,
    project_id: overrides.project_id ?? 1,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: null,
    entity_id: null,
    kind,
    status: overrides.status ?? 'pending',
    blocking: overrides.blocking ?? false,
    title: overrides.title ?? `${kind} title`,
    body: overrides.body ?? null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: overrides.source ?? null,
    payload: overrides.payload ?? null,
    created_at: '2026-07-06T00:00:00.000Z',
    updated_at: '2026-07-06T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
}

describe('TypeGroupedQueue — Notification group', () => {
  it('renders a pending notification under the notification group, not human-task', () => {
    mockReviewItems = [
      makeReviewItem('notification', {
        id: 'rvw_note',
        title: 'Dynamic workflow finished: audit',
        source: 'dynamic_workflow',
      }),
    ];
    render(<TypeGroupedQueue />);

    const group = screen.getByTestId('queue-group-notification');
    expect(within(group).getByText('Notification')).toBeInTheDocument();
    expect(within(group).getByText('1 pending')).toBeInTheDocument();
    expect(within(group).getByText('Dynamic workflow finished: audit')).toBeInTheDocument();

    // A notification is NOT an action item.
    expect(screen.queryByTestId('queue-group-human-task')).not.toBeInTheDocument();
  });

  it('keeps a human_task in its own group, separate from notifications', () => {
    mockReviewItems = [
      makeReviewItem('human_task', { id: 'rvw_ht', title: 'Ping the owner' }),
      makeReviewItem('notification', { id: 'rvw_note', title: 'Workflow stalled', source: 'dynamic_workflow' }),
    ];
    render(<TypeGroupedQueue />);

    const humanGroup = screen.getByTestId('queue-group-human-task');
    expect(within(humanGroup).getByText('Ping the owner')).toBeInTheDocument();
    expect(within(humanGroup).queryByText('Workflow stalled')).not.toBeInTheDocument();

    const noteGroup = screen.getByTestId('queue-group-notification');
    expect(within(noteGroup).getByText('Workflow stalled')).toBeInTheDocument();
  });
});
