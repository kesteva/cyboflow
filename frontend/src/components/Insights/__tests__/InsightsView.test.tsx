/**
 * InsightsView render tests.
 *
 * The insights store is mocked (mirrors BacklogPane.test.tsx) so we render
 * against a fixed snapshot without a live tRPC connection. ReviewItemCard is
 * stubbed to a minimal marker so FindingsSection's list renders without pulling
 * in the real review-item actions hook / trpc client. The chart primitives are
 * stubbed to inert SVGs (they are unit-tested in their own suite).
 *
 * Behaviors verified:
 *   1. Renders all three section headers (01 Findings / 02 Statistics /
 *      03 Code quality) once initialized.
 *   2. Calls the store's init() exactly once on mount.
 *   3. Shows the first-load skeleton when loading && !initialized (and NOT the
 *      sections), and the reverse once initialized.
 *   4. Surfaces a NON-FATAL error banner while still rendering the sections.
 *   5. Renders the three numbered section-index chips.
 *   6. Renders the project filter, lists fetched projects, reflects the store
 *      value, and routes changes (id / null) back through setProjectFilter — with
 *      a project-load failure degrading to "All projects" alone.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Project } from '../../../types/project';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  ReviewItemSummary,
  QualityFinding,
  StepTokenBucket,
  UsageTrendPoint,
} from '../../../../../shared/types/insights';
import type { ReviewItem } from '../../../../../shared/types/reviews';

// ---------------------------------------------------------------------------
// Mutable store snapshot shared with the mock factory (BacklogPane.test idiom).
// ---------------------------------------------------------------------------

let mockInitialized = true;
let mockLoading = false;
let mockError: string | null = null;
let mockProjectFilter: number | null = null;
let mockWorkflowStats: WorkflowRunStats[] = [];
let mockWorkflowUsage: WorkflowUsageStats[] = [];
let mockReviewSummary: ReviewItemSummary | null = null;
let mockQualityFindings: QualityFinding[] = [];
let mockPendingFindings: ReviewItem[] = [];
let mockStepTokens: Record<string, StepTokenBucket[]> = {};
let mockUsageTrends: Record<string, UsageTrendPoint[]> = {};

const mockInit = vi.fn(async () => {});
const mockRefresh = vi.fn(async () => {});
const mockSetProjectFilter = vi.fn(async () => {});
const mockEnsureWorkflowDetail = vi.fn(async () => {});

function snapshot() {
  return {
    initialized: mockInitialized,
    loading: mockLoading,
    error: mockError,
    projectFilter: mockProjectFilter,
    workflowStats: mockWorkflowStats,
    workflowUsage: mockWorkflowUsage,
    reviewSummary: mockReviewSummary,
    qualityFindings: mockQualityFindings,
    pendingFindings: mockPendingFindings,
    stepTokens: mockStepTokens,
    usageTrends: mockUsageTrends,
    // Static at this integration level — StatsSection.test owns their behavior.
    dailyUsage: [],
    revisionHistory: {},
    init: mockInit,
    refresh: mockRefresh,
    setProjectFilter: mockSetProjectFilter,
    ensureWorkflowDetail: mockEnsureWorkflowDetail,
  };
}

vi.mock('../../../stores/insightsStore', () => {
  const useInsightsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useInsightsStore.getState = () => snapshot();
  return { useInsightsStore };
});

// ---------------------------------------------------------------------------
// API mock — drives the ProjectFilter's one-shot project load. `mockGetAll` is
// reassigned per-test to model success / failure / empty responses.
// ---------------------------------------------------------------------------

let mockGetAll: () => Promise<{ success: boolean; data?: Project[]; error?: string }> = async () => ({
  success: true,
  data: [],
});

vi.mock('../../../utils/api', () => ({
  API: {
    projects: {
      getAll: () => mockGetAll(),
    },
  },
}));

/** Build a minimal Project fixture for the filter's options. */
function buildProject(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Project',
    path: '/tmp/project',
    active: true,
    created_at: '2026-06-10T00:00:00.000Z',
    updated_at: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

// Stub ReviewItemCard to a marker so FindingsSection renders without the real
// actions hook / trpc client.
vi.mock('../../ReviewQueue/ReviewItemCard', () => ({
  ReviewItemCard: ({ item }: { item: ReviewItem }) => (
    <div data-testid="review-item-card">{item.title}</div>
  ),
}));

// Inert chart stubs — the real charts are unit-tested in their own suite.
vi.mock('../charts/BarRow', () => ({
  BarRow: ({ label }: { label: string }) => <div data-testid="bar-row">{label}</div>,
}));
vi.mock('../charts/Sparkline', () => ({
  Sparkline: () => <svg data-testid="sparkline" />,
}));

import { InsightsView } from '../InsightsView';

// ---------------------------------------------------------------------------
// Setup — reset the snapshot to a benign "initialized, empty" state.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockInitialized = true;
  mockLoading = false;
  mockError = null;
  mockProjectFilter = null;
  mockGetAll = async () => ({ success: true, data: [] });
  mockWorkflowStats = [];
  mockWorkflowUsage = [];
  mockReviewSummary = { total: 0, pending: 0, resolved: 0, dismissed: 0, pendingByKind: { finding: 0, permission: 0, decision: 0, human_task: 0 } };
  mockQualityFindings = [];
  mockPendingFindings = [];
  mockStepTokens = {};
  mockUsageTrends = {};
  // jsdom does not implement scrollIntoView — stub it for the chip handlers.
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InsightsView', () => {
  it('renders all three section headers once initialized', () => {
    render(<InsightsView />);
    expect(screen.getByTestId('findings-section')).toBeInTheDocument();
    expect(screen.getByTestId('stats-section')).toBeInTheDocument();
    expect(screen.getByTestId('code-quality-section')).toBeInTheDocument();
    // Section labels present.
    expect(screen.getByText('01 Findings')).toBeInTheDocument();
    expect(screen.getByText('02 Statistics')).toBeInTheDocument();
    expect(screen.getByText('03 Code quality')).toBeInTheDocument();
  });

  it('calls the store init() exactly once on mount', () => {
    render(<InsightsView />);
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('renders the three numbered section-index chips', () => {
    render(<InsightsView />);
    expect(screen.getByTestId('insights-index-insights-findings')).toBeInTheDocument();
    expect(screen.getByTestId('insights-index-insights-statistics')).toBeInTheDocument();
    expect(screen.getByTestId('insights-index-insights-code-quality')).toBeInTheDocument();
  });

  it('renders the project filter with an "All projects" option plus fetched projects', async () => {
    mockGetAll = async () => ({
      success: true,
      data: [buildProject({ id: 7, name: 'Acme Notes' }), buildProject({ id: 9, name: 'Widgets' })],
    });
    render(<InsightsView />);
    const filter = screen.getByTestId('insights-project-filter');
    expect(filter).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All projects' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Acme Notes' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Widgets' })).toBeInTheDocument();
  });

  it('reflects the current store projectFilter value', async () => {
    mockProjectFilter = 9;
    mockGetAll = async () => ({
      success: true,
      data: [buildProject({ id: 7, name: 'Acme Notes' }), buildProject({ id: 9, name: 'Widgets' })],
    });
    render(<InsightsView />);
    const filter = screen.getByTestId('insights-project-filter') as HTMLSelectElement;
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Widgets' })).toBeInTheDocument();
    });
    expect(filter.value).toBe('9');
  });

  it('calls setProjectFilter with the picked project id on change', async () => {
    mockGetAll = async () => ({
      success: true,
      data: [buildProject({ id: 7, name: 'Acme Notes' })],
    });
    render(<InsightsView />);
    const filter = screen.getByTestId('insights-project-filter');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Acme Notes' })).toBeInTheDocument();
    });
    fireEvent.change(filter, { target: { value: '7' } });
    expect(mockSetProjectFilter).toHaveBeenCalledWith(7);
  });

  it('calls setProjectFilter with null when "All projects" is picked', async () => {
    mockProjectFilter = 7;
    mockGetAll = async () => ({
      success: true,
      data: [buildProject({ id: 7, name: 'Acme Notes' })],
    });
    render(<InsightsView />);
    const filter = screen.getByTestId('insights-project-filter');
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Acme Notes' })).toBeInTheDocument();
    });
    fireEvent.change(filter, { target: { value: 'all' } });
    expect(mockSetProjectFilter).toHaveBeenCalledWith(null);
  });

  it('degrades to "All projects" alone when the project load fails', async () => {
    mockGetAll = async () => {
      throw new Error('projects.getAll failed');
    };
    render(<InsightsView />);
    // The control still renders; the only option is the "All projects" sentinel.
    expect(screen.getByTestId('insights-project-filter')).toBeInTheDocument();
    // Give the rejected load a tick to settle, then assert no project options arrived.
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'All projects' })).toBeInTheDocument();
    });
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('shows the first-load skeleton (and no sections) when loading && !initialized', () => {
    mockInitialized = false;
    mockLoading = true;
    render(<InsightsView />);
    expect(screen.getByTestId('insights-loading')).toBeInTheDocument();
    expect(screen.queryByTestId('findings-section')).not.toBeInTheDocument();
  });

  it('does NOT show the skeleton on a background refresh (loading && initialized)', () => {
    mockInitialized = true;
    mockLoading = true;
    render(<InsightsView />);
    expect(screen.queryByTestId('insights-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('findings-section')).toBeInTheDocument();
  });

  it('surfaces a non-fatal error banner while still rendering the sections', () => {
    mockError = 'network down';
    render(<InsightsView />);
    const banner = screen.getByTestId('insights-error');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent(/network down/);
    // Content stays — the error is non-fatal.
    expect(screen.getByTestId('stats-section')).toBeInTheDocument();
  });

  it('renders pending findings through ReviewItemCard, else the empty state', () => {
    // Empty first.
    const { unmount } = render(<InsightsView />);
    expect(screen.getByTestId('findings-empty')).toBeInTheDocument();
    unmount();

    mockPendingFindings = [
      {
        id: 'ri-1',
        project_id: 1,
        run_id: 'run-1',
        entity_type: null,
        entity_id: null,
        kind: 'finding',
        status: 'pending',
        blocking: false,
        title: 'Unhandled promise rejection',
        body: null,
        severity: 'warning',
        priority: null,
        staged_at: null,
        selected: false,
        source: 'agent:executor',
        payload: { kind: 'finding' },
        created_at: '2026-06-10T00:00:00.000Z',
        updated_at: '2026-06-10T00:00:00.000Z',
        resolved_by: null,
        resolution: null,
      },
    ];
    render(<InsightsView />);
    expect(screen.getByTestId('review-item-card')).toHaveTextContent('Unhandled promise rejection');
    expect(screen.queryByTestId('findings-empty')).not.toBeInTheDocument();
  });

  it('renders a workflow stats card merging run-stats + usage by workflowId', () => {
    mockWorkflowStats = [
      buildRunStats({ workflowId: 'wf-sprint', workflowName: 'Sprint', totalRuns: 12, errorRatePct: 8.3 }),
    ];
    mockWorkflowUsage = [
      { workflowId: 'wf-sprint', workflowName: 'Sprint', runsWithUsage: 10, avgTotalTokens: 184000, totalTokens: 1840000, totalCostUsd: 4.2, avgCostUsd: 0.42 },
    ];
    render(<InsightsView />);
    const card = screen.getByTestId('stats-card-wf-sprint');
    expect(card).toBeInTheDocument();
    // Headline is the TOTAL (m-tier compact: 1840000 → '1.8m'); the per-run
    // average rides beside it in k-form (184000 → '184k').
    expect(screen.getByTestId('stats-total-tokens')).toHaveTextContent('1.8m');
    expect(screen.getByTestId('stats-avg-tokens')).toHaveTextContent('avg 184k');
    // Meta line: error % · runs · cost (2dp).
    expect(screen.getByTestId('stats-meta')).toHaveTextContent('error 8.3% · runs 12 · cost $4.20');
  });

  it('surfaces the null-outcome integrity hint when any workflow has nullOutcomeRuns', () => {
    mockWorkflowStats = [buildRunStats({ workflowId: 'wf-a', nullOutcomeRuns: 3 })];
    render(<InsightsView />);
    expect(screen.getByTestId('stats-integrity-hint')).toHaveTextContent('3 runs missing outcome');
  });

  it('renders the token-by-step panel after a workflow card is selected', () => {
    mockWorkflowStats = [
      buildRunStats({ workflowId: 'wf-busy', workflowName: 'Busy', totalRuns: 20 }),
      buildRunStats({ workflowId: 'wf-quiet', workflowName: 'Quiet', totalRuns: 2 }),
    ];
    mockStepTokens = {
      'wf-busy': [
        { stepId: 'execute', totalTokens: 64000, assistantMessageCount: 9 },
        { stepId: 'verify', totalTokens: 12000, assistantMessageCount: 3 },
      ],
    };
    render(<InsightsView />);
    // Default (no selection) state shows the by-flow panel, never by-step.
    expect(screen.queryByTestId('stats-token-by-step')).not.toBeInTheDocument();
    // Drill in: selecting a card switches the panel to that flow's steps.
    fireEvent.click(screen.getByTestId('stats-card-wf-busy'));
    const panel = screen.getByTestId('stats-token-by-step');
    expect(panel).toBeInTheDocument();
    // BarRow stub renders its label; both step ids present.
    expect(screen.getAllByTestId('bar-row').map((n) => n.textContent)).toEqual(['execute', 'verify']);
  });
});

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

function buildRunStats(over: Partial<WorkflowRunStats> = {}): WorkflowRunStats {
  return {
    workflowId: 'wf',
    workflowName: 'WF',
    projectId: 1,
    totalRuns: 1,
    activeRuns: 0,
    completedRuns: 1,
    failedRuns: 0,
    canceledRuns: 0,
    mergedRuns: 1,
    dismissedRuns: 0,
    nullOutcomeRuns: 0,
    errorRatePct: 0,
    avgDurationMs: null,
    lastRunAt: null,
    ...over,
  };
}
