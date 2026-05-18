// @vitest-environment jsdom
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReviewQueueView from '../ReviewQueueView';
import { ErrorBoundary } from '../ErrorBoundary';
import type { Approval } from '../../../../shared/types/approvals';
import type { QueueItem } from '../../utils/reviewQueueSelectors';

// Mutable state shared between mock factory and test helpers
let mockQueue: Approval[] = [];
const mockInit = vi.fn(() => () => {});

// Default view: map each approval to a single non-blocking QueueItem
function buildView(): { blocking: QueueItem[]; normal: QueueItem[] } {
  return {
    blocking: [],
    normal: mockQueue.map(a => ({ kind: 'single' as const, approval: a, isBlocking: false })),
  };
}

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

// Mock useReviewQueueKeyboard — ReviewQueueView.tsx imports this hook which in
// turn imports the real trpc client (Electron IPC bridge). Mocking it here
// keeps the test self-contained.
vi.mock('../../hooks/useReviewQueueKeyboard', () => ({
  useReviewQueueKeyboard: () => ({ focusedIndex: 0, setFocusedIndex: vi.fn() }),
}));

// Mock PendingApprovalCard — accepts the new `item: QueueItem` prop shape.
vi.mock('../PendingApprovalCard', () => ({
  PendingApprovalCard: ({ item }: { item: QueueItem }) => {
    const toolName = item.kind === 'single' ? item.approval.toolName : item.toolName;
    return <div data-testid="pending-approval-card">{toolName}</div>;
  },
}));

describe('ReviewQueueView', () => {
  beforeEach(() => {
    mockQueue = [];
    mockInit.mockClear();
  });

  it('renders "No pending approvals" when queue is empty', () => {
    render(<ReviewQueueView />);
    expect(screen.getByText('No pending approvals')).toBeInTheDocument();
  });

  it('calls init() once on mount', () => {
    render(<ReviewQueueView />);
    expect(mockInit).toHaveBeenCalledTimes(1);
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

  it('renders "Review Queue" heading text', () => {
    render(<ReviewQueueView />);
    expect(screen.getByText('Review Queue')).toBeInTheDocument();
  });

  it('shows "0 pending" count in header when queue is empty', () => {
    render(<ReviewQueueView />);
    expect(screen.getByText('0 pending')).toBeInTheDocument();
  });

  it('shows correct pending count in header when queue is populated', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
      { id: '2', runId: 'run-1', workflowName: 'wf', toolName: 'Read', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.getByText('2 pending')).toBeInTheDocument();
  });

  it('does not render "No pending approvals" when queue is populated', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.queryByText('No pending approvals')).not.toBeInTheDocument();
  });

  it('renders "Pending" section header when queue is non-empty', () => {
    mockQueue = [
      { id: '1', runId: 'run-1', workflowName: 'wf', toolName: 'Bash', payloadPreview: '', rationale: null, createdAt: '2026-01-01T00:00:00Z', status: 'pending' },
    ];
    render(<ReviewQueueView />);
    expect(screen.getByText('Pending')).toBeInTheDocument();
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
