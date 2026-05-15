import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReviewQueueView from '../ReviewQueueView';
import { ErrorBoundary } from '../ErrorBoundary';
import type { Approval } from '../../../../shared/types/approvals';

// Mutable state shared between mock factory and test helpers
let mockQueue: Approval[] = [];
const mockInit = vi.fn();

// Mock the reviewQueueStore module
vi.mock('../../stores/reviewQueueStore', () => {
  const useReviewQueueStore = (selector: (s: { queue: Approval[]; init: () => void }) => unknown) =>
    selector({ queue: mockQueue, init: mockInit });
  useReviewQueueStore.getState = () => ({ queue: mockQueue, init: mockInit });
  return { useReviewQueueStore };
});

// Mock PendingApprovalCard stub so tests don't depend on TASK-403
vi.mock('../PendingApprovalCard', () => ({
  default: ({ approval }: { approval: Approval }) => (
    <div data-testid="pending-approval-card">{approval.toolName}</div>
  ),
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
      { id: '1', runId: 'run-1', toolName: 'Bash', input: {}, timestamp: 1 },
      { id: '2', runId: 'run-1', toolName: 'Read', input: {}, timestamp: 2 },
      { id: '3', runId: 'run-1', toolName: 'Write', input: {}, timestamp: 3 },
    ];
    render(<ReviewQueueView />);
    const cards = screen.getAllByTestId('pending-approval-card');
    expect(cards).toHaveLength(3);
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Write')).toBeInTheDocument();
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
