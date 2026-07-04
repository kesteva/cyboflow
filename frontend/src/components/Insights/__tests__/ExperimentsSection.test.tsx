/**
 * ExperimentsSection tests (Insights mockup section 04, A/B testing slice C).
 *
 * Covers: the per-workflow variant stats table (all VariantStats columns) with
 * the low-sample ("n<5, provisional") annotation and a deleted-variant
 * "(deleted)" label; the rotation status line sourced from variantsStore; the
 * past-experiments list grouped by seriesKey with an aggregate preference-count
 * line; and row click routing to `navigationStore.openExperimentComparison`.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExperimentsSection } from '../ExperimentsSection';
import type { VariantStats, ExperimentSummary } from '../../../../../shared/types/experiments';
import type { WorkflowRunStats } from '../../../../../shared/types/insights';

const variantStatsQuery = vi.fn();
const listForDashboardQuery = vi.fn();
const openExperimentComparison = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: { variantStats: { query: (...a: unknown[]) => variantStatsQuery(...a) } },
      experiments: { listForDashboard: { query: (...a: unknown[]) => listForDashboardQuery(...a) } },
    },
  },
}));

let mockWorkflowStats: WorkflowRunStats[] = [];
let mockProjectFilter: number | null = null;

vi.mock('../../../stores/insightsStore', () => ({
  useInsightsStore: (selector: (s: { workflowStats: WorkflowRunStats[]; projectFilter: number | null }) => unknown) =>
    selector({ workflowStats: mockWorkflowStats, projectFilter: mockProjectFilter }),
}));

vi.mock('../../../stores/variantsStore', () => ({
  useWorkflowVariants: () => ({
    variants: [
      { id: 'wfv_a', workflow_id: 'wf-1', label: 'variant-a', spec_json: '{}', agent_overrides_json: null, model: null, execution_model: null, weight: 3, status: 'active', created_at: '', updated_at: '' },
      { id: 'wfv_b', workflow_id: 'wf-1', label: 'variant-b', spec_json: '{}', agent_overrides_json: null, model: null, execution_model: null, weight: 1, status: 'paused', created_at: '', updated_at: '' },
    ],
    loaded: true,
    loading: false,
    error: null,
  }),
}));

vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ openExperimentComparison }) },
}));

function makeWorkflowStatsRow(over: Partial<WorkflowRunStats> = {}): WorkflowRunStats {
  return {
    workflowId: 'wf-1',
    workflowName: 'planner',
    projectId: 5,
    totalRuns: 10,
    activeRuns: 0,
    completedRuns: 8,
    failedRuns: 1,
    canceledRuns: 1,
    mergedRuns: 6,
    dismissedRuns: 2,
    nullOutcomeRuns: 0,
    ...over,
  } as WorkflowRunStats;
}

function makeVariantStats(over: Partial<VariantStats> = {}): VariantStats {
  return {
    variantId: 'wfv_a',
    variantLabel: 'variant-a',
    variantStatus: 'active',
    weight: 3,
    runs: 10,
    completedRuns: 9,
    failedRuns: 1,
    canceledRuns: 0,
    activeRuns: 0,
    mergedRuns: 8,
    dismissedRuns: 1,
    nullOutcomeRuns: 0,
    successRatePct: 90,
    avgDurationMs: 120_000,
    avgTotalTokens: 15000,
    avgCostUsd: 1.5,
    avgEvalScore: 85,
    findingsCount: 2,
    postMergeBugCount: 0,
    lowSample: false,
    ...over,
  };
}

function makeExperimentSummary(over: Partial<ExperimentSummary> = {}): ExperimentSummary {
  return {
    experimentId: 'exp_1',
    workflowId: 'wf-1',
    baseBranch: 'main',
    variantAId: 'wfv_a',
    variantBId: 'wfv_b',
    armALabel: 'variant-a',
    armBLabel: 'variant-b',
    verdictPreference: 'A',
    verdictConfidence: 0.8,
    decision: 'promote_a',
    status: 'decided',
    decidedAt: '2026-07-02T00:00:00.000Z',
    createdAt: '2026-07-01T00:00:00.000Z',
    rerunOfExperimentId: null,
    seriesKey: 'wf-1:wfv_a|wfv_b',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkflowStats = [];
  mockProjectFilter = null;
});

describe('ExperimentsSection', () => {
  it('renders "no workflow activity yet" when workflowStats is empty', async () => {
    listForDashboardQuery.mockResolvedValue([]);
    render(<ExperimentsSection />);
    expect(screen.getByText('No workflow activity yet.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('No A/B experiments have been run yet.')).toBeInTheDocument());
  });

  it('renders the per-variant stats table with every column + the low-sample annotation + a deleted-variant label', async () => {
    mockWorkflowStats = [makeWorkflowStatsRow()];
    variantStatsQuery.mockResolvedValue([
      makeVariantStats(),
      makeVariantStats({ variantId: 'wfv_c', variantLabel: 'retired-variant', variantStatus: null, weight: null, runs: 2, lowSample: true }),
    ]);
    listForDashboardQuery.mockResolvedValue([]);

    render(<ExperimentsSection />);

    const row = await screen.findByTestId('experiments-variant-row-wfv_a');
    expect(row).toHaveTextContent('90%');
    expect(row).toHaveTextContent('$1.50');
    expect(row).toHaveTextContent('85');

    const deletedRow = screen.getByTestId('experiments-variant-row-wfv_c');
    expect(deletedRow).toHaveTextContent('(deleted)');
    expect(screen.getByTestId('experiments-variant-lowsample-wfv_c')).toHaveTextContent('n<5, provisional');
  });

  it('renders the rotation status line from variantsStore (active variants + weights)', async () => {
    mockWorkflowStats = [makeWorkflowStatsRow()];
    variantStatsQuery.mockResolvedValue([makeVariantStats()]);
    listForDashboardQuery.mockResolvedValue([]);

    render(<ExperimentsSection />);
    const line = await screen.findByTestId('experiments-rotation-status-wf-1');
    expect(line).toHaveTextContent('variant-a (3)');
    expect(line).not.toHaveTextContent('variant-b');
  });

  it('does not render a table for a workflow with zero variants', async () => {
    mockWorkflowStats = [makeWorkflowStatsRow()];
    variantStatsQuery.mockResolvedValue([]);
    listForDashboardQuery.mockResolvedValue([]);

    render(<ExperimentsSection />);
    await waitFor(() => expect(variantStatsQuery).toHaveBeenCalled());
    expect(screen.queryByTestId('experiments-variant-table-planner')).not.toBeInTheDocument();
  });

  it('groups past experiments by seriesKey with an aggregate preference line, and routes row click to openExperimentComparison', async () => {
    mockWorkflowStats = [];
    listForDashboardQuery.mockResolvedValue([
      makeExperimentSummary({ experimentId: 'exp_3', decision: 'promote_b', createdAt: '2026-07-04T00:00:00.000Z' }),
      makeExperimentSummary({ experimentId: 'exp_2', decision: 'promote_b', createdAt: '2026-07-03T00:00:00.000Z' }),
      makeExperimentSummary({ experimentId: 'exp_1', decision: 'promote_a', createdAt: '2026-07-01T00:00:00.000Z' }),
    ]);

    render(<ExperimentsSection />);

    const aggregate = await screen.findByTestId('experiments-series-aggregate-wf-1:wfv_a|wfv_b');
    expect(aggregate).toHaveTextContent('variant-b preferred 2 of 3');

    fireEvent.click(screen.getByTestId('experiments-row-exp_2'));
    expect(openExperimentComparison).toHaveBeenCalledWith('exp_2');
  });

  it('does not render an aggregate line for a series with only one experiment', async () => {
    mockWorkflowStats = [];
    listForDashboardQuery.mockResolvedValue([makeExperimentSummary()]);

    render(<ExperimentsSection />);
    await screen.findByTestId('experiments-row-exp_1');
    expect(screen.queryByTestId('experiments-series-aggregate-wf-1:wfv_a|wfv_b')).not.toBeInTheDocument();
  });
});
