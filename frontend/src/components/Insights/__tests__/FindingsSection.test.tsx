/**
 * FindingsSection — "Run compounding session" CTA tests.
 *
 * The insights store is mocked (BacklogPane.test idiom) so the section renders
 * against a fixed snapshot without a live tRPC connection; ReviewItemCard is
 * stubbed to a marker so the pending-findings list renders without the real
 * actions hook. The navigation store's `goToWizard` is captured so we assert the
 * button opens the start wizard, and `useProjectsCount` is mocked to flip the
 * has-projects gate.
 *
 * Behaviors verified:
 *   1. The CTA renders (monospace, uppercase) when at least one project exists.
 *   2. Clicking it calls navigationStore.goToWizard() — compound is now a
 *      built-in flow the wizard's picker lists, so no preselect arg is passed.
 *   3. The CTA is hidden when there are no projects (the wizard's first step is
 *      project selection).
 */
import '@testing-library/jest-dom';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReviewItemSummary } from '../../../../../shared/types/insights';
import type { ReviewItem } from '../../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Store mocks — only the slices FindingsSection reads matter here.
// ---------------------------------------------------------------------------

let mockReviewSummary: ReviewItemSummary | null = null;
let mockPendingFindings: ReviewItem[] = [];
const mockRefresh = vi.fn(async () => {});

function snapshot() {
  return {
    reviewSummary: mockReviewSummary,
    pendingFindings: mockPendingFindings,
    refresh: mockRefresh,
  };
}

vi.mock('../../../stores/insightsStore', () => {
  const useInsightsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useInsightsStore.getState = () => snapshot();
  return { useInsightsStore };
});

// navigationStore: capture goToWizard via getState(); the hook form is unused by
// FindingsSection but stubbed for completeness.
const mockGoToWizard = vi.fn();

vi.mock('../../../stores/navigationStore', () => {
  const useNavigationStore = (selector: (s: { goToWizard: typeof mockGoToWizard }) => unknown) =>
    selector({ goToWizard: mockGoToWizard });
  useNavigationStore.getState = () => ({ goToWizard: mockGoToWizard });
  return { useNavigationStore };
});

// landingStore: only useProjectsCount is consumed — flip it per test.
let mockProjectsCount = 1;

vi.mock('../../../stores/landingStore', () => ({
  useProjectsCount: () => mockProjectsCount,
}));

// Stub ReviewItemCard so the list renders without the real actions hook / trpc.
vi.mock('../../ReviewQueue/ReviewItemCard', () => ({
  ReviewItemCard: ({ item }: { item: ReviewItem }) => (
    <div data-testid="review-item-card">{item.title}</div>
  ),
}));

import { FindingsSection } from '../FindingsSection';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockReviewSummary = {
    total: 0,
    pending: 0,
    resolved: 0,
    dismissed: 0,
    pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0 },
  };
  mockPendingFindings = [];
  mockProjectsCount = 1;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FindingsSection — Run compounding session CTA', () => {
  it('renders the monospace uppercase CTA when at least one project exists', () => {
    render(<FindingsSection />);
    const cta = screen.getByTestId('run-compounding-session');
    expect(cta).toBeInTheDocument();
    expect(cta).toHaveTextContent(/run compounding session/i);
    // Style contract: monospace + uppercase.
    expect(cta.className).toContain('font-mono');
    expect(cta.className).toContain('uppercase');
  });

  it('opens the start wizard on click (goToWizard, no preselect arg)', () => {
    render(<FindingsSection />);
    fireEvent.click(screen.getByTestId('run-compounding-session'));
    expect(mockGoToWizard).toHaveBeenCalledTimes(1);
    // The picker now lists compound, so the button passes no workflow-preselect.
    expect(mockGoToWizard).toHaveBeenCalledWith();
  });

  it('hides the CTA when there are no projects', () => {
    mockProjectsCount = 0;
    render(<FindingsSection />);
    expect(screen.queryByTestId('run-compounding-session')).not.toBeInTheDocument();
  });
});
