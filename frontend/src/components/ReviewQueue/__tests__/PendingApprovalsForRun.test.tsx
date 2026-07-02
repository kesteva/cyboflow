/**
 * PendingApprovalsForRun — the inline per-run pending-approval strip.
 *
 * Covers: null on runId=null; null when no queue item matches; renders only cards
 * whose approval.runId === runId (no cross-run leak); reactive to queue changes.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Approval } from '../../../../../shared/types/approvals';

// Drive the store selector from a mutable queue.
let mockQueue: Approval[] = [];
vi.mock('../../../stores/reviewQueueStore', () => ({
  useReviewQueueStore: (selector: (s: { queue: Approval[] }) => unknown) => selector({ queue: mockQueue }),
}));

// Render a stable, identifiable stand-in per card so we can count/attribute them.
vi.mock('../PendingApprovalCard', () => ({
  PendingApprovalCard: ({ item }: { item: { approval: Approval } }) => (
    <div data-testid="approval-card" data-approval-id={item.approval.id} data-run-id={item.approval.runId} />
  ),
}));

import { PendingApprovalsForRun } from '../PendingApprovalsForRun';

function makeApproval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'a-1',
    runId: 'run-1',
    workflowName: 'sprint',
    toolName: 'Bash',
    payloadPreview: 'ls',
    rationale: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    ...over,
  };
}

beforeEach(() => {
  mockQueue = [];
});

describe('PendingApprovalsForRun', () => {
  it('renders null when runId is null (even with a populated queue)', () => {
    mockQueue = [makeApproval()];
    const { container } = render(<PendingApprovalsForRun runId={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders null when no queued approval matches the run', () => {
    mockQueue = [makeApproval({ id: 'a-1', runId: 'other-run' })];
    const { container } = render(<PendingApprovalsForRun runId="run-1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders only the cards whose approval.runId matches (no cross-run leak)', () => {
    mockQueue = [
      makeApproval({ id: 'a-mine-1', runId: 'run-1' }),
      makeApproval({ id: 'a-other', runId: 'run-2' }),
      makeApproval({ id: 'a-mine-2', runId: 'run-1' }),
    ];
    render(<PendingApprovalsForRun runId="run-1" />);
    const cards = screen.getAllByTestId('approval-card');
    expect(cards).toHaveLength(2);
    expect(cards.map((c) => c.getAttribute('data-approval-id')).sort()).toEqual(['a-mine-1', 'a-mine-2']);
    expect(cards.every((c) => c.getAttribute('data-run-id') === 'run-1')).toBe(true);
  });

  it('is reactive: a re-render with an added matching approval surfaces a new card', () => {
    mockQueue = [makeApproval({ id: 'a-1', runId: 'run-1' })];
    const { rerender } = render(<PendingApprovalsForRun runId="run-1" />);
    expect(screen.getAllByTestId('approval-card')).toHaveLength(1);
    mockQueue = [...mockQueue, makeApproval({ id: 'a-2', runId: 'run-1' })];
    rerender(<PendingApprovalsForRun runId="run-1" />);
    expect(screen.getAllByTestId('approval-card')).toHaveLength(2);
  });
});
