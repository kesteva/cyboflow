/**
 * Component tests for OnboardingCard.
 *
 * Three scenarios cover the one-shot dismissal contract:
 *   1. Preference already 'true' → card renders nothing.
 *   2. Preference absent/undefined → card shows welcome text; "Got it" dismisses.
 *   3. First y/n keypress in ReviewQueueView auto-dismisses the card.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { Approval } from '../../../shared/types/approvals';
import type { QueueItem } from '../utils/reviewQueueSelectors';

// ---------------------------------------------------------------------------
// window.electron mock
// ---------------------------------------------------------------------------

const mockInvoke = vi.fn();

beforeEach(() => {
  mockInvoke.mockReset();
  // Default: preferences:get returns absent (no preference set)
  mockInvoke.mockImplementation(
    (channel: string, _key?: string, _value?: string) => {
      if (channel === 'preferences:get') {
        return Promise.resolve({ success: true, data: undefined });
      }
      if (channel === 'preferences:set') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: true });
    },
  );

  Object.defineProperty(window, 'electron', {
    value: { invoke: mockInvoke },
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Store mocks (needed for ReviewQueueView in test 3)
// ---------------------------------------------------------------------------

let mockQueue: Approval[] = [];
const mockInit = vi.fn();

function buildView(): { blocking: QueueItem[]; normal: QueueItem[] } {
  return {
    blocking: [],
    normal: mockQueue.map(a => ({ kind: 'single' as const, approval: a, isBlocking: false })),
  };
}

vi.mock('../stores/reviewQueueStore', () => {
  const useReviewQueueStore = (selector: (s: { queue: Approval[]; init: () => void }) => unknown) =>
    selector({ queue: mockQueue, init: mockInit });
  useReviewQueueStore.getState = () => ({ queue: mockQueue, init: mockInit });
  return {
    useReviewQueueStore,
    useReviewQueueView: () => buildView(),
  };
});

vi.mock('../hooks/useReviewQueueKeyboard', () => ({
  useReviewQueueKeyboard: () => ({ focusedIndex: 0, setFocusedIndex: vi.fn() }),
}));

vi.mock('./PendingApprovalCard', () => ({
  PendingApprovalCard: ({ item }: { item: QueueItem }) => {
    const toolName = item.kind === 'single' ? item.approval.toolName : item.toolName;
    return <div data-testid="pending-approval-card">{toolName}</div>;
  },
}));

// ---------------------------------------------------------------------------
// Test 1: Card is hidden when preference is 'true'
// ---------------------------------------------------------------------------

import OnboardingCard from './OnboardingCard';

describe('OnboardingCard — hidden when preference is already set', () => {
  it('renders nothing when preferences:get returns data: "true"', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'preferences:get') {
        return Promise.resolve({ success: true, data: 'true' });
      }
      return Promise.resolve({ success: true });
    });

    const { container } = render(<OnboardingCard />);

    // Wait for the async mount effect to resolve
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Test 2: Clicking "Got it" writes preferences:set and unmounts the card
// ---------------------------------------------------------------------------

describe('OnboardingCard — explicit dismissal via "Got it"', () => {
  it('renders welcome text when preference is absent, then dismisses on "Got it"', async () => {
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'preferences:get') {
        return Promise.resolve({ success: true, data: undefined });
      }
      if (channel === 'preferences:set') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: true });
    });

    const { container } = render(<OnboardingCard />);

    // Card should show welcome content once preference check resolves
    await waitFor(() => {
      expect(
        screen.getByText(/Cyboflow pauses Claude when it needs to take an action\./),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(/j\/k navigate, y\/n decide/)).toBeInTheDocument();

    // Click "Got it"
    await act(async () => {
      fireEvent.click(screen.getByText('Got it'));
    });

    // preferences:set must have been called with the dismissal key
    expect(mockInvoke).toHaveBeenCalledWith(
      'preferences:set',
      'cyboflow_onboarding_dismissed',
      'true',
    );

    // Card should now be gone
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Test 3: First y/n keypress in ReviewQueueView auto-dismisses the card
// ---------------------------------------------------------------------------

import ReviewQueueView from './ReviewQueueView';

const fakeApproval: Approval = {
  id: 'onboarding-test-id',
  runId: 'run-onboarding',
  workflowName: 'Test workflow',
  toolName: 'Bash',
  payloadPreview: 'echo hello',
  rationale: null,
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  status: 'pending',
};

describe('ReviewQueueView — first approve/reject auto-dismisses OnboardingCard', () => {
  beforeEach(() => {
    mockQueue = [fakeApproval];
    mockInit.mockClear();

    // Default: preference not set
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'preferences:get') {
        return Promise.resolve({ success: true, data: undefined });
      }
      if (channel === 'preferences:set') {
        return Promise.resolve({ success: true });
      }
      return Promise.resolve({ success: true });
    });
  });

  afterEach(() => {
    mockQueue = [];
  });

  it('pressing y with pending approvals calls preferences:set with cyboflow_onboarding_dismissed and unmounts the card', async () => {
    render(<ReviewQueueView />);

    // Wait for the onboarding card to finish checking its preference
    await waitFor(() => {
      expect(screen.getByText(/Cyboflow pauses Claude/)).toBeInTheDocument();
    });

    // Simulate pressing y
    await act(async () => {
      fireEvent.keyDown(window, { key: 'y', bubbles: true });
    });

    expect(mockInvoke).toHaveBeenCalledWith(
      'preferences:set',
      'cyboflow_onboarding_dismissed',
      'true',
    );

    // Card must be unmounted in the same session — not just the preference written.
    await waitFor(() => expect(screen.queryByText(/Cyboflow pauses Claude/)).not.toBeInTheDocument());
  });
});
