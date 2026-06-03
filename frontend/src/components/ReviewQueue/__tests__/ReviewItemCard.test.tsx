/**
 * Component tests for ReviewItemCard — the kind-polymorphic review_items card.
 *
 * Covers:
 *   - all FOUR kinds render with their kind label.
 *   - the blocking badge renders only when item.blocking === true.
 *   - decision Approve routes to reviewItems.resolve (flow advancement).
 *   - finding/human_task Promote routes to reviewItems.promoteToTask.
 *   - human_task Dismiss routes to reviewItems.dismiss.
 *   - permission Approve/Reject reuse the approval resolution path
 *     (cyboflow.approvals.approve/reject via the folded approvalId).
 *
 * The tRPC client is mocked at the canonical import path so both the actions
 * hook and the card's direct approval calls route through one set of spies.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReviewItem, ReviewItemKind, ReviewItemPayload } from '../../../../../shared/types/reviews';

const {
  mockResolve,
  mockDismiss,
  mockPromote,
  mockApprovalApprove,
  mockApprovalReject,
} = vi.hoisted(() => ({
  mockResolve: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', resumed: true }),
  mockDismiss: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1' }),
  mockPromote: vi.fn().mockResolvedValue({ reviewItemId: 'rvw_1', taskId: 'tsk_1' }),
  mockApprovalApprove: vi.fn().mockResolvedValue(undefined),
  mockApprovalReject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      reviewItems: {
        resolve: { mutate: mockResolve },
        dismiss: { mutate: mockDismiss },
        promoteToTask: { mutate: mockPromote },
      },
      approvals: {
        approve: { mutate: mockApprovalApprove },
        reject: { mutate: mockApprovalReject },
      },
    },
  },
}));

import { ReviewItemCard } from '../ReviewItemCard';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function makeItem(
  kind: ReviewItemKind,
  overrides: Partial<ReviewItem> = {},
  payload: ReviewItemPayload | null = null,
): ReviewItem {
  return {
    id: overrides.id ?? `rvw_${kind}`,
    project_id: overrides.project_id ?? 5,
    run_id: overrides.run_id ?? 'run-1',
    entity_type: overrides.entity_type ?? null,
    entity_id: overrides.entity_id ?? null,
    kind,
    status: overrides.status ?? 'pending',
    blocking: overrides.blocking ?? false,
    title: overrides.title ?? `${kind} title`,
    body: overrides.body ?? null,
    severity: overrides.severity ?? null,
    source: overrides.source ?? null,
    payload,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
}

beforeEach(() => {
  mockResolve.mockClear();
  mockDismiss.mockClear();
  mockPromote.mockClear();
  mockApprovalApprove.mockClear();
  mockApprovalReject.mockClear();
});

describe('ReviewItemCard', () => {
  it('renders all four kinds with their kind label', () => {
    const kinds: Array<[ReviewItemKind, string]> = [
      ['finding', 'Finding'],
      ['permission', 'Permission'],
      ['decision', 'Decision'],
      ['human_task', 'Action'],
    ];
    for (const [kind, label] of kinds) {
      const { unmount } = render(<ReviewItemCard item={makeItem(kind)} />);
      expect(screen.getByTestId('review-item-kind')).toHaveTextContent(label);
      unmount();
    }
  });

  it('renders the blocking badge only when blocking is true', () => {
    const { rerender } = render(<ReviewItemCard item={makeItem('decision', { blocking: true })} />);
    expect(screen.getByTestId('blocking-badge')).toBeInTheDocument();

    rerender(<ReviewItemCard item={makeItem('finding', { blocking: false })} />);
    expect(screen.queryByTestId('blocking-badge')).not.toBeInTheDocument();
  });

  it('decision Approve resolves the item (flow advancement)', async () => {
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec', blocking: true })} />);
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_dec' }));
  });

  it('finding Promote mints a task via promoteToTask', async () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_find' })} />);
    fireEvent.click(screen.getByTestId('promote-to-task'));
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_find' }));
  });

  it('human_task Dismiss routes through reviewItems.dismiss', async () => {
    render(<ReviewItemCard item={makeItem('human_task', { id: 'rvw_ht' })} />);
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_ht' }));
  });

  it('permission Approve reuses the approval resolution path (folded approvalId)', async () => {
    const item = makeItem(
      'permission',
      { id: 'rvw_perm', blocking: true },
      { kind: 'permission', toolName: 'Bash', toolInput: {}, approvalId: 'apr_42' },
    );
    render(<ReviewItemCard item={item} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => expect(mockApprovalApprove).toHaveBeenCalledWith({ approvalId: 'apr_42' }));
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('permission Reject reuses the approval rejection path', async () => {
    const item = makeItem(
      'permission',
      { id: 'rvw_perm2' },
      { kind: 'permission', toolName: 'Bash', toolInput: {}, approvalId: 'apr_7' },
    );
    render(<ReviewItemCard item={item} />);
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => expect(mockApprovalReject).toHaveBeenCalledWith({ approvalId: 'apr_7' }));
  });

  it('calls onResolved after a successful triage', async () => {
    const onResolved = vi.fn();
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec2' })} onResolved={onResolved} />);
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });
});
