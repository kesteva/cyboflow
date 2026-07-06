import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReviewQueueView from '../ReviewQueueView';
import { ErrorBoundary } from '../ErrorBoundary';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';
import type { ReviewItem, ReviewItemKind } from '../../../../shared/types/reviews';
import { useReviewQueueSlice } from '../../stores/reviewQueueSlice';

// Mutable state shared between mock factory and test helpers
let mockQueue: Approval[] = [];
const mockInit = vi.fn(() => () => {});
// Project-scoped review_items the (mocked) reviewItemsSlice returns.
let mockReviewItems: ReviewItem[] = [];

// Default view: map each approval to a single non-blocking QueueItem
function buildView(): { blocking: QueueItem[]; normal: QueueItem[] } {
  return {
    blocking: [],
    normal: mockQueue.map(a => ({ kind: 'single' as const, approval: a, isBlocking: false })),
  };
}

// Mock tRPC client — reviewQueueSlice uses it for subscribeToStuckEvents.
vi.mock('../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      events: {
        onStuckDetected: {
          subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
        },
      },
    },
  },
}));

// Mock the reviewQueueStore module — expose both useReviewQueueStore and useReviewQueueView
vi.mock('../../stores/reviewQueueStore', () => {
  const useReviewQueueStore = (selector: (s: { queue: Approval[]; init: () => void }) => unknown) =>
    selector({ queue: mockQueue, init: mockInit });
  useReviewQueueStore.getState = () => ({ queue: mockQueue, init: mockInit });
  return {
    useReviewQueueStore,
    useReviewQueueView: () => buildView(),
  };
});

// Capture the onDecide callback so dismissal tests can trigger the keyboard path.
let capturedOnDecide: (() => void) | undefined;

// Mock useReviewQueueKeyboard — ReviewQueueView.tsx imports this hook which in
// turn imports the real trpc client (Electron IPC bridge). Mocking it here
// keeps the test self-contained.
vi.mock('../../hooks/useReviewQueueKeyboard', () => ({
  useReviewQueueKeyboard: (_queue: QueueItem[], onDecide?: () => void) => {
    capturedOnDecide = onDecide;
    return { focusedIndex: 0, setFocusedIndex: vi.fn() };
  },
}));

// Mock the reviewQueueSlice — ReviewQueueView uses useRunStatus from this slice.
// The mock uses the real Zustand store so setState works in tests.
vi.mock('../../stores/reviewQueueSlice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/reviewQueueSlice')>();
  return actual;
});

// Mock PendingApprovalCard — uses the stuck-aware variant path.
// Exposes runStatus via data-run-status so tests can assert prop propagation.
// Exposes Approve/Reject buttons that fire onDecide so dismissal tests work.
vi.mock('../ReviewQueue/PendingApprovalCard', () => ({
  PendingApprovalCard: ({ item, runStatus, onDecide }: { item: QueueItem; runStatus?: string; onDecide?: () => void }) => {
    const toolName = item.kind === 'single' ? item.approval.toolName : item.toolName;
    return (
      <div data-testid="pending-approval-card" data-run-status={runStatus ?? ''}>
        {toolName}
        <button onClick={() => onDecide?.()}>Approve</button>
        <button onClick={() => onDecide?.()}>Reject</button>
      </div>
    );
  },
}));

// Mock the project-scoped review_items slice — return items from the mutable var
// and stub init() to a no-op cleanup (avoids the real trpc list/subscribe path).
vi.mock('../../stores/reviewItemsSlice', () => {
  const useReviewItemsSlice = (selector: (s: { items: ReviewItem[] }) => unknown) =>
    selector({ items: mockReviewItems });
  useReviewItemsSlice.getState = () => ({ init: () => () => {} });
  return { useReviewItemsSlice };
});

// Mock ReviewItemCard to a minimal stub exposing kind/blocking/id so partition +
// counting assertions don't depend on the real card's chrome.
vi.mock('../ReviewQueue/ReviewItemCard', () => ({
  ReviewItemCard: ({ item }: { item: ReviewItem }) => (
    <div data-testid="review-item" data-kind={item.kind} data-blocking={String(item.blocking)} data-id={item.id} />
  ),
}));

function makeRI(kind: ReviewItemKind, id: string, blocking: boolean): ReviewItem {
  return {
    id,
    project_id: 5,
    run_id: 'run-x',
    entity_type: null,
    entity_id: null,
    kind,
    status: 'pending',
    blocking,
    title: `${kind} ${id}`,
    body: null,
    severity: null,
    priority: null,
    staged_at: null,
    selected: false,
    source: null,
    payload: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    resolved_by: null,
    resolution: null,
  };
}

// Fixture approval for onboarding dismissal tests
const onboardingApproval: Approval = {
  id: 'onb-1',
  runId: 'run-onb',
  workflowName: 'Onboarding WF',
  toolName: 'Bash',
  payloadPreview: 'echo hello',
  rationale: null,
  createdAt: '2026-01-01T00:00:00Z',
  status: 'pending',
};

describe('ReviewQueueView', () => {
  beforeEach(() => {
    mockQueue = [];
    mockReviewItems = [];
    capturedOnDecide = undefined;
    mockInit.mockClear();
    // Reset the slice's runStatusMap so tests start from a clean state.
    useReviewQueueSlice.setState({ runStatusMap: {} });
  });

  it('renders "No pending reviews" when queue is empty', () => {
    render(<ReviewQueueView />);
    expect(screen.getByText('No pending reviews')).toBeInTheDocument();
  });

  it('calls init() once on mount', () => {
    render(<ReviewQueueView />);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('invokes the unsubscribe returned by init() when the component unmounts', () => {
    // mockInit returns a fresh spy unsubscribe for each render so we can
    // assert that React called it as the useEffect cleanup.
    const mockUnsubscribe = vi.fn();
    mockInit.mockReturnValueOnce(mockUnsubscribe);

    const { unmount } = render(<ReviewQueueView />);

    // Before unmount the cleanup must not have fired yet.
    expect(mockUnsubscribe).not.toHaveBeenCalled();

    // Unmounting triggers React's useEffect cleanup → should invoke the
    // unsubscribe returned by init().
    unmount();

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it('renders one card per approval in queue', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: '2', runId: 'run-1', workflowName: 'wf', toolName: 'Read', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: '3', runId: 'run-1', workflowName: 'wf', toolName: 'Write', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    const cards = screen.getAllByTestId('pending-approval-card');
    expect(cards).toHaveLength(3);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
  });

  it('renders "Human review" heading text', () => {
    render(<ReviewQueueView />);
    expect(screen.getByText('Human review')).toBeInTheDocument();
  });

  it('shows "0 total" count in header when queue is empty', () => {
    render(<ReviewQueueView />);
    expect(screen.getByTestId('review-total-count')).toHaveTextContent('0 total');
  });

  it('shows correct total count in header when queue is populated', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: '2', runId: 'run-1', workflowName: 'wf', toolName: 'Read', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.getByTestId('review-total-count')).toHaveTextContent('2 total');
  });

  it('does not render "No pending reviews" when queue is populated', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.queryByText('No pending reviews')).not.toBeInTheDocument();
  });

  it('renders "Pending" section header when queue is non-empty', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
  });

  it('passes runStatus="stuck" to PendingApprovalCard when run is in runStatusMap as stuck', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    // Set the slice state before rendering so the QueueRow component picks it up.
    useReviewQueueSlice.setState({ runStatusMap: { 'run-1': 'stuck' } });
    render(<ReviewQueueView />);
    const cards = screen.getAllByTestId('pending-approval-card');
    expect(cards[0]).toHaveAttribute('data-run-status', 'stuck');
  });

  it('passes runStatus="" (undefined) to PendingApprovalCard when runStatusMap is empty', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: '2', runId: 'run-2', workflowName: 'wf', toolName: 'Read', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    useReviewQueueSlice.setState({ runStatusMap: {} });
    render(<ReviewQueueView />);
    const cards = screen.getAllByTestId('pending-approval-card');
    expect(cards[0]).toHaveAttribute('data-run-status', '');
    expect(cards[1]).toHaveAttribute('data-run-status', '');
  });

  // ---------------------------------------------------------------------------
  // Onboarding card dismissal tests (TASK-625)
  // ---------------------------------------------------------------------------

  it('OnboardingCard is visible by default when queue is non-empty and preference is unset', () => {
    mockQueue = [onboardingApproval];
    render(<ReviewQueueView />);
    // OnboardingCard renders with role="status" when not dismissed
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('clicking Approve in a PendingApprovalCard dismisses the OnboardingCard', async () => {
    mockQueue = [onboardingApproval];
    render(<ReviewQueueView />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    // The mock PendingApprovalCard renders an Approve button that fires onDecide
    const approveButtons = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(approveButtons[0]);

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('clicking Reject in a PendingApprovalCard dismisses the OnboardingCard', async () => {
    mockQueue = [onboardingApproval];
    render(<ReviewQueueView />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    // The mock PendingApprovalCard renders a Reject button that fires onDecide
    const rejectButtons = screen.getAllByRole('button', { name: 'Reject' });
    fireEvent.click(rejectButtons[0]);

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('keyboard-path onDecide callback dismisses the OnboardingCard', async () => {
    mockQueue = [onboardingApproval];
    render(<ReviewQueueView />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    // Trigger the captured onDecide callback (the keyboard hook's path)
    expect(capturedOnDecide).toBeDefined();
    act(() => { capturedOnDecide?.(); });

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('onDecide is idempotent — multiple calls do not re-show the card', async () => {
    mockQueue = [onboardingApproval];
    render(<ReviewQueueView />);
    expect(screen.getByRole('status')).toBeInTheDocument();

    // First call dismisses
    act(() => { capturedOnDecide?.(); });
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    // Subsequent calls are no-ops (card stays dismissed)
    act(() => { capturedOnDecide?.(); });
    act(() => { capturedOnDecide?.(); });
    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // FIX 2 — blocking findings surface in the Blocking section + are counted
  // ---------------------------------------------------------------------------

  it('renders a BLOCKING finding in the Blocking section and counts it as blocking', () => {
    mockReviewItems = [makeRI('finding', 'rvw_bf', true)];
    render(<ReviewQueueView projectId={5} />);

    const blockingSection = screen.getByTestId('review-blocking-section');
    const card = screen.getByTestId('review-item');
    expect(blockingSection).toContainElement(card);
    expect(card).toHaveAttribute('data-kind', 'finding');
    expect(card).toHaveAttribute('data-blocking', 'true');
    // Counted as blocking (1) and does NOT appear in the collapsed Findings section.
    expect(screen.getByTestId('review-blocking-count')).toHaveTextContent('1 blocking');
    expect(screen.queryByTestId('review-findings-section')).not.toBeInTheDocument();
  });

  it('keeps a NON-blocking finding in the collapsed Findings section (not blocking)', () => {
    mockReviewItems = [makeRI('finding', 'rvw_nbf', false)];
    render(<ReviewQueueView projectId={5} />);

    expect(screen.getByTestId('review-findings-section')).toBeInTheDocument();
    expect(screen.queryByTestId('review-blocking-section')).not.toBeInTheDocument();
    expect(screen.getByTestId('review-blocking-count')).toHaveTextContent('0 blocking');
    expect(screen.getByTestId('review-finding-count')).toHaveTextContent('1 findings');
  });
});

describe('ErrorBoundary with ReviewQueueView fallback', () => {
  // Suppress expected error boundary console errors during this test
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('shows "Review queue error — restart app" fallback on child throw', () => {
    const ThrowingComponent = () => {
      throw new Error('Simulated queue failure');
      // eslint-disable-next-line no-unreachable
      return null;
    };

    render(
      <ErrorBoundary
        fallback={(error) => (
          <div className="w-[360px] h-full flex items-center justify-center p-4 border-r border-border-primary bg-bg-secondary">
            <div className="text-center">
              <p className="text-sm text-status-error font-semibold mb-2">
                Review queue error — restart app
              </p>
              <p className="text-xs text-text-muted">{error.message}</p>
            </div>
          </div>
        )}
      >
        <ThrowingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Review queue error/)).toBeInTheDocument();
    expect(screen.getByText('Simulated queue failure')).toBeInTheDocument();
  });
});
