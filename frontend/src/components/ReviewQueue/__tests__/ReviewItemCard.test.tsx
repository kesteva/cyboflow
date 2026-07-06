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
 *   - finding accept-routing: a proposedTarget renders the '→ TARGET' chip and
 *     makes the primary action contextual ('backlog' → Promote-to-task relabel,
 *     'docs'/'prompt' → Accept resolving 'triaged:accepted-<target>'); a finding
 *     with no / malformed proposedTarget renders the legacy actions unchanged.
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
    priority: overrides.priority ?? null,
    staged_at: overrides.staged_at ?? null,
    selected: overrides.selected ?? false,
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

  it('decision Approve resolves the item with outcome=approve (flow advancement)', async () => {
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec', blocking: true })} />);
    fireEvent.click(screen.getByTestId('decision-resolve'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_dec', outcome: 'approve' }),
    );
  });

  it('decision Reject resolves the item with outcome=reject (no dismiss)', async () => {
    render(<ReviewItemCard item={makeItem('decision', { id: 'rvw_dec_r', blocking: true })} />);
    fireEvent.click(screen.getByTestId('decision-reject'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_dec_r', outcome: 'reject' }),
    );
    expect(mockDismiss).not.toHaveBeenCalled();
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

  it('a dynamic-workflow human_task offers ONLY Dismiss (no Resolve / Promote)', async () => {
    render(<ReviewItemCard item={makeItem('human_task', { id: 'rvw_dyn', source: 'dynamic_workflow' })} />);
    expect(screen.queryByText('Resolve')).not.toBeInTheDocument();
    expect(screen.queryByTestId('promote-to-task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Dismiss'));
    await waitFor(() => expect(mockDismiss).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_dyn' }));
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

  // -- Accept-routing (proposedTarget) ------------------------------------

  it('renders the target chip per proposedTarget', () => {
    const cases: Array<['backlog' | 'docs' | 'prompt', string]> = [
      ['backlog', '→ Backlog'],
      ['docs', '→ Docs'],
      ['prompt', '→ Prompt'],
    ];
    for (const [target, label] of cases) {
      const { unmount } = render(
        <ReviewItemCard
          item={makeItem('finding', { id: `rvw_${target}` }, { kind: 'finding', proposedTarget: target })}
        />,
      );
      const chip = screen.getByTestId('proposed-target-chip');
      expect(chip).toHaveTextContent(label);
      expect(chip).toHaveAttribute('data-target', target);
      unmount();
    }
  });

  it("renders the proposed-target chip for a 'fix' finding (runtime guard widened)", () => {
    // Regression: the findingProposedTarget runtime guard must admit 'fix' (the
    // D3 union widening) — a missing branch would SILENTLY DROP the chip and fall
    // the card back to legacy Promote (FIND-SPRINT-024-4 class), not crash.
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_fix' }, { kind: 'finding', proposedTarget: 'fix' })}
      />,
    );
    const chip = screen.getByTestId('proposed-target-chip');
    expect(chip).toHaveAttribute('data-target', 'fix');
    expect(chip).toHaveTextContent('→ Quick fix');
  });

  it("proposedTarget 'docs' Accept resolves with triaged:accepted-docs", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_docs' }, { kind: 'finding', proposedTarget: 'docs' })}
      />,
    );
    fireEvent.click(screen.getByTestId('accept-finding'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_docs',
        resolution: 'triaged:accepted-docs',
      }),
    );
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it("proposedTarget 'prompt' Accept resolves with triaged:accepted-prompt", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_prompt' }, { kind: 'finding', proposedTarget: 'prompt' })}
      />,
    );
    fireEvent.click(screen.getByTestId('accept-finding'));
    await waitFor(() =>
      expect(mockResolve).toHaveBeenCalledWith({
        projectId: 5,
        reviewItemId: 'rvw_prompt',
        resolution: 'triaged:accepted-prompt',
      }),
    );
  });

  it("proposedTarget 'backlog' keeps promote-to-task (relabelled Accept → task)", async () => {
    render(
      <ReviewItemCard
        item={makeItem('finding', { id: 'rvw_bk' }, { kind: 'finding', proposedTarget: 'backlog' })}
      />,
    );
    const btn = screen.getByTestId('promote-to-task');
    expect(btn).toHaveTextContent('Accept → task');
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(mockPromote).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_bk' }));
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('a BLOCKING finding renders Resolve & resume (routes to resolve, no outcome)', async () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_bf', blocking: true })} />);
    // Blocking findings get a distinct resolve-and-resume affordance (not the
    // accept-routing legacy actions).
    expect(screen.getByTestId('finding-resolve')).toHaveTextContent('Resolve');
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('finding-resolve'));
    await waitFor(() => expect(mockResolve).toHaveBeenCalledWith({ projectId: 5, reviewItemId: 'rvw_bf' }));
  });

  it('a non-blocking finding does NOT render the resolve-and-resume affordance', () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_nbf', blocking: false })} />);
    expect(screen.queryByTestId('finding-resolve')).not.toBeInTheDocument();
    expect(screen.getByTestId('promote-to-task')).toBeInTheDocument();
  });

  it('a finding with NO proposedTarget renders the legacy actions unchanged', () => {
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_legacy' })} />);
    expect(screen.queryByTestId('proposed-target-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    const promote = screen.getByTestId('promote-to-task');
    expect(promote).toHaveTextContent('Promote to task');
    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('a malformed proposedTarget behaves exactly like no payload', () => {
    // A non-union proposedTarget must fall through the defensive guard so the
    // card keeps its legacy actions (zero behavior change).
    const payload = { kind: 'finding', proposedTarget: 'editor' } as unknown as ReviewItemPayload;
    render(<ReviewItemCard item={makeItem('finding', { id: 'rvw_bad' }, payload)} />);
    expect(screen.queryByTestId('proposed-target-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('accept-finding')).not.toBeInTheDocument();
    expect(screen.getByTestId('promote-to-task')).toHaveTextContent('Promote to task');
  });
});
