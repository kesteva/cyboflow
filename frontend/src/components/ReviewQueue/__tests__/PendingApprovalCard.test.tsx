/**
 * Component tests for ReviewQueue/PendingApprovalCard.
 *
 * Covers TASK-504 acceptance criteria:
 *   - "Why stuck?" button absent for non-stuck runs
 *   - "Why stuck?" button present for stuck runs
 *   - Clicking "Why stuck?" opens StuckInspectorModal
 *
 * Also covers baseline card behavior (approve/reject, group variant, etc.)
 * to ensure the ReviewQueue version maintains parity with the root-level card.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Approval } from '../../../../../shared/types/approvals';
import type { QueueItem } from '../../../utils/reviewQueueSelectors';

// ---------------------------------------------------------------------------
// tRPC mock
// ---------------------------------------------------------------------------

const {
  mockApproveMutate,
  mockRejectMutate,
  mockApproveRestOfRunMutate,
  mockGetStuckInspectionQuery,
  mockCancelAndRestartMutate,
} =
  vi.hoisted(() => ({
    mockApproveMutate: vi.fn().mockResolvedValue(undefined),
    mockRejectMutate: vi.fn().mockResolvedValue(undefined),
    mockApproveRestOfRunMutate: vi.fn().mockResolvedValue({ decided: 0 }),
    mockGetStuckInspectionQuery: vi.fn().mockReturnValue(new Promise(() => undefined)),
    mockCancelAndRestartMutate: vi.fn().mockResolvedValue({ newRunId: 'new-run-id' }),
  }));

vi.mock('../../../utils/trpcClient', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve: { mutate: mockApproveMutate },
        reject: { mutate: mockRejectMutate },
        approveRestOfRun: { mutate: mockApproveRestOfRunMutate },
      },
      runs: {
        getStuckInspection: {
          query: mockGetStuckInspectionQuery,
        },
        cancelAndRestart: {
          mutate: mockCancelAndRestartMutate,
        },
      },
      events: {
        onStuckDetected: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
      },
    },
  },
}));

import { PendingApprovalCard } from '../PendingApprovalCard';
import { useReviewQueueSlice } from '../../../stores/reviewQueueSlice';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseApproval: Approval = {
  id: 'fixture-id',
  runId: 'run-fixture-id',
  workflowName: 'Refactor auth module',
  toolName: 'Bash',
  payloadPreview: 'git diff HEAD~1 -- src/auth.ts',
  rationale: null,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  status: 'pending',
};

const singleItem: QueueItem = { kind: 'single', approval: baseApproval, isBlocking: false };

const groupApprovals: Approval[] = Array.from({ length: 3 }, (_, i) => ({
  id: `group-id-${i}`,
  runId: 'run-group',
  workflowName: 'Bulk run',
  toolName: 'Bash',
  payloadPreview: 'npm test',
  rationale: null,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  status: 'pending' as const,
}));

const groupItem: QueueItem = {
  kind: 'group',
  runId: 'run-group',
  toolName: 'Bash',
  payloadSignature: 'npm test',
  items: groupApprovals,
  isBlocking: false,
};

// ---------------------------------------------------------------------------
// Tests: "Why stuck?" button visibility
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — "Why stuck?" button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT render "Why stuck?" button when runStatus is undefined', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.queryByRole('button', { name: /why stuck/i })).not.toBeInTheDocument();
  });

  it('does NOT render "Why stuck?" button when runStatus is "running"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="running" />);
    expect(screen.queryByRole('button', { name: /why stuck/i })).not.toBeInTheDocument();
  });

  it('does NOT render "Why stuck?" button when runStatus is "awaiting_review"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="awaiting_review" />);
    expect(screen.queryByRole('button', { name: /why stuck/i })).not.toBeInTheDocument();
  });

  it('renders "Why stuck?" button when runStatus is "stuck"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    expect(screen.getByRole('button', { name: /why stuck/i })).toBeInTheDocument();
  });

  it('renders "Why stuck?" button for group items when runStatus is "stuck"', () => {
    render(<PendingApprovalCard item={groupItem} runStatus="stuck" />);
    expect(screen.getByRole('button', { name: /why stuck/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests: StuckInspectorModal opens on click
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — modal open/close behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Keep query pending so modal stays in loading state.
    mockGetStuckInspectionQuery.mockReturnValue(new Promise(() => undefined));
  });

  it('StuckInspectorModal is NOT mounted before "Why stuck?" is clicked', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    // Modal is unmounted when closed — no dialog role in DOM.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking "Why stuck?" opens StuckInspectorModal', async () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);

    const button = screen.getByRole('button', { name: /why stuck/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  it('clicking "Why stuck?" calls getStuckInspection with the correct runId', async () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);

    fireEvent.click(screen.getByRole('button', { name: /why stuck/i }));

    await waitFor(() => {
      expect(mockGetStuckInspectionQuery).toHaveBeenCalledWith({
        runId: baseApproval.runId,
      });
    });
  });

  it('clicking "Why stuck?" on a group card calls getStuckInspection with group runId', async () => {
    render(<PendingApprovalCard item={groupItem} runStatus="stuck" />);

    fireEvent.click(screen.getByRole('button', { name: /why stuck/i }));

    await waitFor(() => {
      expect(mockGetStuckInspectionQuery).toHaveBeenCalledWith({
        runId: 'run-group',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: STUCK badge renders (TASK-502 AC1)
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — StuckBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset all slice maps so tests start with clean state.
    useReviewQueueSlice.setState({ runStatusMap: {}, runReasonMap: {}, runDetectedAtMap: {} });
  });

  it('renders STUCK badge when runStatus is "stuck"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    expect(screen.getByText('STUCK')).toBeInTheDocument();
  });

  it('does not render STUCK badge when runStatus is "running"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="running" />);
    expect(screen.queryByText('STUCK')).not.toBeInTheDocument();
  });

  it('does not render STUCK badge when runStatus is undefined', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.queryByText('STUCK')).not.toBeInTheDocument();
  });

  it('StuckBadge shows stuckReason as tooltip title attribute (legacy prop fallback)', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" stuckReason="cross_run_deadlock" />);
    const badge = screen.getByText('STUCK');
    expect(badge).toHaveAttribute('title', 'cross_run_deadlock');
  });

  it('StuckBadge title includes both reason kind and relative-time suffix when detectedAt is in the slice', () => {
    // Seed the slice with reason + detectedAt (2 minutes ago)
    useReviewQueueSlice.setState({
      runStatusMap: { [baseApproval.runId]: 'stuck' },
      runReasonMap: { [baseApproval.runId]: { kind: 'cross_run_deadlock', conflictingRunId: 'run-other' } },
      runDetectedAtMap: { [baseApproval.runId]: Date.now() - 120_000 },
    });

    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    const badge = screen.getByText('STUCK');
    const title = badge.getAttribute('title') ?? '';
    expect(title).toContain('cross_run_deadlock');
    // 120 seconds = 2 minutes → formatAge returns '2m'
    expect(title).toContain('2m');
  });

  it('StuckBadge title contains only reason kind when runDetectedAtMap has no entry for runId', () => {
    // Seed reason only — no detectedAt
    useReviewQueueSlice.setState({
      runStatusMap: { [baseApproval.runId]: 'stuck' },
      runReasonMap: { [baseApproval.runId]: { kind: 'orphan_pty' } },
      runDetectedAtMap: {},
    });

    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    const badge = screen.getByText('STUCK');
    const title = badge.getAttribute('title') ?? '';
    expect(title).toBe('orphan_pty');
    // Should NOT contain a relative time suffix separator
    expect(title).not.toContain('·');
  });
});

// ---------------------------------------------------------------------------
// Tests: red border on stuck cards (TASK-502 AC2)
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — alert border for stuck runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stuck card root element has a class containing "red"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    // The listitem is the card root
    const card = screen.getByRole('listitem');
    expect(card.className).toMatch(/red/);
  });

  it('non-stuck card root element does not have a "red" class', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="running" />);
    const card = screen.getByRole('listitem');
    expect(card.className).not.toMatch(/red/);
  });
});

// ---------------------------------------------------------------------------
// Tests: Cancel-and-restart button (TASK-502 AC3)
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — Cancel and restart button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does NOT render "Cancel and restart" button for a running run', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="running" />);
    expect(screen.queryByRole('button', { name: /cancel and restart/i })).not.toBeInTheDocument();
  });

  it('does NOT render "Cancel and restart" button when runStatus is undefined', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.queryByRole('button', { name: /cancel and restart/i })).not.toBeInTheDocument();
  });

  it('renders "Cancel and restart" button when runStatus is "stuck"', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    expect(screen.getByRole('button', { name: /cancel and restart/i })).toBeInTheDocument();
  });

  it('clicking "Cancel and restart" calls cancelAndRestart.mutate with correct runId', async () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    fireEvent.click(screen.getByRole('button', { name: /cancel and restart/i }));
    await waitFor(() => {
      expect(mockCancelAndRestartMutate).toHaveBeenCalledWith({ runId: baseApproval.runId });
    });
  });

  it('clicking "Cancel and restart" on group card passes group runId', async () => {
    render(<PendingApprovalCard item={groupItem} runStatus="stuck" />);
    fireEvent.click(screen.getByRole('button', { name: /cancel and restart/i }));
    await waitFor(() => {
      expect(mockCancelAndRestartMutate).toHaveBeenCalledWith({ runId: 'run-group' });
    });
  });

  it('Cancel and restart button title attribute documents partial functionality (TASK-627)', () => {
    render(<PendingApprovalCard item={singleItem} runStatus="stuck" />);
    const button = screen.getByRole('button', { name: /cancel and restart/i });
    expect(button).toHaveAttribute('title', expect.stringContaining('TASK-304'));
  });
});

// ---------------------------------------------------------------------------
// Tests: onDecide callback (TASK-625)
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — onDecide callback (single variant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('onDecide is called once after successful Approve mutation', async () => {
    const onDecide = vi.fn();
    mockApproveMutate.mockResolvedValueOnce(undefined);
    render(<PendingApprovalCard item={singleItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
  });

  it('onDecide is called once after successful Reject mutation', async () => {
    const onDecide = vi.fn();
    mockRejectMutate.mockResolvedValueOnce(undefined);
    render(<PendingApprovalCard item={singleItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
  });

  it('onDecide is not called when the prop is omitted (no errors thrown)', async () => {
    render(<PendingApprovalCard item={singleItem} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    });
    // No assertion on onDecide — just ensure no throw
  });

  it('onDecide is NOT called when the Approve mutation rejects', async () => {
    const onDecide = vi.fn();
    mockApproveMutate.mockRejectedValueOnce(new Error('network error'));
    render(<PendingApprovalCard item={singleItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(mockApproveMutate).toHaveBeenCalledTimes(1);
    });
    expect(onDecide).not.toHaveBeenCalled();
  });

  it('onDecide is NOT called when the Reject mutation rejects', async () => {
    const onDecide = vi.fn();
    mockRejectMutate.mockRejectedValueOnce(new Error('network error'));
    render(<PendingApprovalCard item={singleItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(mockRejectMutate).toHaveBeenCalledTimes(1);
    });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('PendingApprovalCard — onDecide callback (group variant)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('onDecide is called once after successful group Approve mutation', async () => {
    const onDecide = vi.fn();
    mockApproveRestOfRunMutate.mockResolvedValueOnce({ decided: 1 });
    render(<PendingApprovalCard item={groupItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
  });

  it('onDecide is called once after successful group Reject mutation', async () => {
    const onDecide = vi.fn();
    // group reject calls Promise.all(items.map(a => reject.mutate(...))), not rejectRestOfRun
    mockRejectMutate.mockResolvedValue(undefined);
    render(<PendingApprovalCard item={groupItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(onDecide).toHaveBeenCalledTimes(1);
    });
  });

  it('onDecide is NOT called when the group Approve mutation rejects', async () => {
    const onDecide = vi.fn();
    mockApproveRestOfRunMutate.mockRejectedValueOnce(new Error('server error'));
    render(<PendingApprovalCard item={groupItem} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(mockApproveRestOfRunMutate).toHaveBeenCalledTimes(1);
    });
    expect(onDecide).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests: baseline card behavior (parity with root-level card)
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — baseline behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders tool name', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('renders workflow name', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Refactor auth module')).toBeInTheDocument();
  });

  it('renders Approve and Reject buttons', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
  });

  it('Approve calls approve.mutate with approval id', async () => {
    render(<PendingApprovalCard item={singleItem} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'fixture-id' });
    });
  });

  it('Reject calls reject.mutate with approval id', async () => {
    render(<PendingApprovalCard item={singleItem} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => {
      expect(mockRejectMutate).toHaveBeenCalledWith({ approvalId: 'fixture-id' });
    });
  });

  it('group: Approve calls approveRestOfRun with group runId', async () => {
    render(<PendingApprovalCard item={groupItem} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(mockApproveRestOfRunMutate).toHaveBeenCalledWith({ runId: 'run-group' });
    });
  });
});
