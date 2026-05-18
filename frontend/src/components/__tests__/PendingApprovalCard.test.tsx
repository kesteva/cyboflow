/**
 * Tests for PendingApprovalCard (and the approvalFormatters utilities).
 *
 * The component renders a QueueItem (either kind: 'single' or kind: 'group').
 * Pure-function tests (formatAge, truncatePayload) run without DOM rendering.
 * Component tests use @testing-library/react + jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { formatAge, truncatePayload } from '../../utils/approvalFormatters';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const baseApproval: Approval = {
  id: 'fixture-id',
  runId: 'run-fixture-id',
  workflowName: 'Refactor auth module',
  toolName: 'Bash',
  payloadPreview: 'git diff HEAD~1 -- src/auth.ts',
  rationale: 'Checking what changed in auth before patching.',
  createdAt: new Date(Date.now() - 120_000).toISOString(), // 2 minutes ago
  status: 'pending',
};

const singleItem: QueueItem = { kind: 'single', approval: baseApproval, isBlocking: false };

const blockingSingleItem: QueueItem = { kind: 'single', approval: baseApproval, isBlocking: true };

const groupApprovals: Approval[] = Array.from({ length: 7 }, (_, i) => ({
  id: `group-id-${i}`,
  runId: 'run-group',
  workflowName: 'Bulk Bash run',
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

// Fixture for the approveRestOfRun test — 3-item group all from run-X.
const runXApprovals: Approval[] = Array.from({ length: 3 }, (_, i) => ({
  id: `run-x-id-${i}`,
  runId: 'run-X',
  workflowName: 'run-x workflow',
  toolName: 'Bash',
  payloadPreview: 'echo hello',
  rationale: null,
  createdAt: new Date(Date.now() - 120_000).toISOString(),
  status: 'pending' as const,
}));

const groupItemRunX: QueueItem = {
  kind: 'group',
  runId: 'run-X',
  toolName: 'Bash',
  payloadSignature: 'echo hello',
  items: runXApprovals,
  isBlocking: false,
};

// ---------------------------------------------------------------------------
// tRPC mock
// ---------------------------------------------------------------------------

const { mockApproveMutate, mockRejectMutate, mockApproveRestOfRunMutate } = vi.hoisted(() => ({
  mockApproveMutate:          vi.fn().mockResolvedValue(undefined),
  mockRejectMutate:           vi.fn().mockResolvedValue(undefined),
  mockApproveRestOfRunMutate: vi.fn().mockResolvedValue({ decided: 0 }),
}));

vi.mock('../../utils/trpcClient', () => ({
  trpc: {
    cyboflow: {
      approvals: {
        approve:           { mutate: mockApproveMutate          },
        reject:            { mutate: mockRejectMutate           },
        approveRestOfRun:  { mutate: mockApproveRestOfRunMutate },
      },
    },
  },
}));

// ---------------------------------------------------------------------------
// Unit tests: formatAge
// ---------------------------------------------------------------------------

describe('formatAge', () => {
  it("returns '<1m' for a timestamp 30 seconds ago", () => {
    const createdAt = new Date(Date.now() - 30_000).toISOString();
    expect(formatAge(createdAt)).toBe('<1m');
  });

  it("returns '2m' for a timestamp 120 seconds ago", () => {
    const createdAt = new Date(Date.now() - 120_000).toISOString();
    expect(formatAge(createdAt)).toBe('2m');
  });

  it("returns '1h' for a timestamp 3600 seconds ago", () => {
    const createdAt = new Date(Date.now() - 3_600_000).toISOString();
    expect(formatAge(createdAt)).toBe('1h');
  });

  it("returns '1d' for a timestamp 24 hours ago", () => {
    const createdAt = new Date(Date.now() - 86_400_000).toISOString();
    expect(formatAge(createdAt)).toBe('1d');
  });

  it("returns '14m' for a timestamp 14 minutes ago", () => {
    const createdAt = new Date(Date.now() - 14 * 60_000).toISOString();
    expect(formatAge(createdAt)).toBe('14m');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: truncatePayload
// ---------------------------------------------------------------------------

describe('truncatePayload', () => {
  it('returns truncated: false and full text when input is shorter than maxLen', () => {
    const short = 'x'.repeat(50);
    const result = truncatePayload(short);
    expect(result.text).toBe(short);
    expect(result.truncated).toBe(false);
  });

  it('returns truncated: true and sliced text when input exceeds maxLen', () => {
    const long = 'x'.repeat(300);
    const result = truncatePayload(long, 200);
    expect(result.text).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it('returns truncated: false when input is exactly maxLen', () => {
    const exact = 'x'.repeat(200);
    const result = truncatePayload(exact, 200);
    expect(result.text).toBe(exact);
    expect(result.truncated).toBe(false);
  });

  it('respects a custom maxLen', () => {
    const input = 'hello world and more text here';
    const result = truncatePayload(input, 10);
    expect(result.text).toBe('hello worl');
    expect(result.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: formatAge integration with fixture
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — unit behaviour (no DOM)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('formatAge integration: baseApproval.createdAt 2 min ago → "2m"', () => {
    const age = formatAge(baseApproval.createdAt);
    expect(age).toBe('2m');
  });

  it('truncatePayload: baseApproval.payloadPreview ≤ 200 chars → not truncated', () => {
    const result = truncatePayload(baseApproval.payloadPreview);
    expect(result.truncated).toBe(false);
    expect(result.text).toBe(baseApproval.payloadPreview);
  });

  it('truncatePayload: long payload is truncated to 200 chars', () => {
    const longPayload = 'a'.repeat(300);
    const result = truncatePayload(longPayload);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Component tests: PendingApprovalCard — single variant
// ---------------------------------------------------------------------------

// Import after mock is set up
import { PendingApprovalCard } from '../PendingApprovalCard';

describe('PendingApprovalCard — single variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the tool name', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Bash')).toBeInTheDocument();
  });

  it('renders the workflow name', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Refactor auth module')).toBeInTheDocument();
  });

  it('renders the rationale when present', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Checking what changed in auth before patching.')).toBeInTheDocument();
  });

  it('does not render a rationale element when rationale is null', () => {
    const noRationaleItem: QueueItem = {
      kind: 'single',
      approval: { ...baseApproval, rationale: null },
      isBlocking: false,
    };
    render(<PendingApprovalCard item={noRationaleItem} />);
    expect(screen.queryByText(/Checking/)).not.toBeInTheDocument();
  });

  it('renders the Approve and Reject buttons', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('Approve button calls approve.mutate with the approval id', async () => {
    render(<PendingApprovalCard item={singleItem} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => {
      expect(mockApproveMutate).toHaveBeenCalledWith({ approvalId: 'fixture-id' });
    });
  });

  it('Reject button calls reject.mutate with the approval id', async () => {
    render(<PendingApprovalCard item={singleItem} />);
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => {
      expect(mockRejectMutate).toHaveBeenCalledWith({ approvalId: 'fixture-id' });
    });
  });

  it('does not show "blocked" badge when isBlocking is false', () => {
    render(<PendingApprovalCard item={singleItem} />);
    expect(screen.queryByText(/blocked/)).not.toBeInTheDocument();
  });

  it('shows "blocked Nm" badge when isBlocking is true', () => {
    render(<PendingApprovalCard item={blockingSingleItem} />);
    expect(screen.getByText(/blocked/)).toBeInTheDocument();
  });

  it('applies focus ring class when isFocused is true', () => {
    const { container } = render(<PendingApprovalCard item={singleItem} isFocused={true} />);
    expect(container.firstChild).toHaveClass('ring-2');
  });
});

// ---------------------------------------------------------------------------
// Component tests: PendingApprovalCard — group variant
// ---------------------------------------------------------------------------

describe('PendingApprovalCard — group variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Bash (×7 in this run)" as the header', () => {
    render(<PendingApprovalCard item={groupItem} />);
    expect(screen.getByText('Bash (×7 in this run)')).toBeInTheDocument();
  });

  it('renders the count via the × symbol', () => {
    render(<PendingApprovalCard item={groupItem} />);
    expect(screen.getByText(/×7/)).toBeInTheDocument();
  });

  it('renders Approve and Reject buttons', () => {
    render(<PendingApprovalCard item={groupItem} />);
    expect(screen.getByText('Approve')).toBeInTheDocument();
    expect(screen.getByText('Reject')).toBeInTheDocument();
  });

  it('Approve calls approveRestOfRun.mutate with the group runId — not per-item approve', async () => {
    render(<PendingApprovalCard item={groupItem} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => {
      expect(mockApproveRestOfRunMutate).toHaveBeenCalledTimes(1);
    });
    expect(mockApproveRestOfRunMutate).toHaveBeenCalledWith({ runId: 'run-group' });
    // Per-item approve must NOT be called for a group card.
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });

  it('Reject calls reject.mutate once per group member', async () => {
    render(<PendingApprovalCard item={groupItem} />);
    fireEvent.click(screen.getByText('Reject'));
    await waitFor(() => {
      expect(mockRejectMutate).toHaveBeenCalledTimes(7);
    });
  });

  it('shows "blocked Nm" badge when isBlocking is true', () => {
    const blockingGroup: QueueItem = { ...groupItem, isBlocking: true };
    render(<PendingApprovalCard item={blockingGroup} />);
    expect(screen.getByText(/blocked/)).toBeInTheDocument();
  });

  it('does not show "blocked" badge when isBlocking is false', () => {
    render(<PendingApprovalCard item={groupItem} />);
    expect(screen.queryByText(/blocked/)).not.toBeInTheDocument();
  });

  // TASK-406: group card with 3 items from run-X → Approve calls approveRestOfRun once with runId
  it('group card with 3 items from run-X → Approve calls approveRestOfRun({ runId: run-X }) exactly once', async () => {
    render(<PendingApprovalCard item={groupItemRunX} />);
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() => {
      expect(mockApproveRestOfRunMutate).toHaveBeenCalledTimes(1);
    });
    expect(mockApproveRestOfRunMutate).toHaveBeenCalledWith({ runId: 'run-X' });
    expect(mockApproveMutate).not.toHaveBeenCalled();
  });
});
