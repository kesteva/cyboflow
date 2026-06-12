/**
 * StatsSection rework tests — daily chart on top, click-to-drill cards, by-flow
 * default panel.
 *
 * The insights store is mocked (CodeQualitySection.test idiom) with a mutable
 * snapshot plus a spied `ensureWorkflowDetail` action exposed on `getState`, so
 * the card-selection drill-down can be asserted without a live tRPC connection.
 * The chart primitives are stubbed to inert markers that echo their inputs
 * (BarRow → its label, DailyUsageChart → a point-count marker, Sparkline →
 * an empty SVG) — they are unit-tested in their own suites.
 *
 * Coverage:
 *   - the daily-usage chart mounts above the cards (wired to `dailyUsage`).
 *   - DEFAULT (no selection): the "Token by flow" panel ranks workflows by
 *     totalTokens DESC, skipping null/0 sums; the busiest workflow still drives
 *     VersionHistory.
 *   - SELECTION: clicking a card switches to that flow's "Token by step" panel,
 *     sets aria-pressed, calls ensureWorkflowDetail, and points VersionHistory at
 *     the selected flow; a flow with no step buckets shows the muted note.
 *   - DESELECTION: clicking the selected card again (or the "← all flows"
 *     affordance) returns to the by-flow panel.
 *   - the null-outcome integrity hint and the empty state are preserved.
 */
import '@testing-library/jest-dom';
import { cleanup, render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  WorkflowRunStats,
  WorkflowUsageStats,
  StepTokenBucket,
  UsageTrendPoint,
  WorkflowRevisionStats,
  DailyModelUsagePoint,
} from '../../../../../shared/types/insights';

// ---------------------------------------------------------------------------
// Store mock — a mutable snapshot plus a spied ensureWorkflowDetail action.
// ---------------------------------------------------------------------------

let mockWorkflowStats: WorkflowRunStats[] = [];
let mockWorkflowUsage: WorkflowUsageStats[] = [];
let mockStepTokens: Record<string, StepTokenBucket[]> = {};
let mockUsageTrends: Record<string, UsageTrendPoint[]> = {};
let mockRevisionHistory: Record<string, WorkflowRevisionStats[]> = {};
let mockDailyUsage: DailyModelUsagePoint[] = [];

const mockEnsureWorkflowDetail = vi.fn(async () => {});

function snapshot() {
  return {
    workflowStats: mockWorkflowStats,
    workflowUsage: mockWorkflowUsage,
    stepTokens: mockStepTokens,
    usageTrends: mockUsageTrends,
    revisionHistory: mockRevisionHistory,
    dailyUsage: mockDailyUsage,
    ensureWorkflowDetail: mockEnsureWorkflowDetail,
  };
}

vi.mock('../../../stores/insightsStore', () => {
  const useInsightsStore = (selector: (s: ReturnType<typeof snapshot>) => unknown) =>
    selector(snapshot());
  useInsightsStore.getState = () => snapshot();
  return { useInsightsStore };
});

// Inert chart stubs — the real charts are unit-tested in their own suites.
vi.mock('../charts/BarRow', () => ({
  BarRow: ({ label, valueLabel }: { label: string; valueLabel?: string }) => (
    <div data-testid="bar-row" data-value={valueLabel}>
      {label}
    </div>
  ),
}));
vi.mock('../charts/Sparkline', () => ({
  Sparkline: () => <svg data-testid="sparkline" />,
}));
vi.mock('../charts/DailyUsageChart', () => ({
  DailyUsageChart: ({ points }: { points: DailyModelUsagePoint[] }) => (
    <div data-testid="daily-usage-chart" data-points={points.length} />
  ),
}));

import { StatsSection } from '../StatsSection';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function runStats(over: Partial<WorkflowRunStats> = {}): WorkflowRunStats {
  return {
    workflowId: 'wf',
    workflowName: 'WF',
    projectId: 1,
    totalRuns: 5,
    activeRuns: 0,
    completedRuns: 5,
    failedRuns: 0,
    canceledRuns: 0,
    mergedRuns: 5,
    dismissedRuns: 0,
    nullOutcomeRuns: 0,
    errorRatePct: 0,
    avgDurationMs: 1000,
    lastRunAt: '2026-06-10T00:00:00.000Z',
    ...over,
  };
}

function usageStats(over: Partial<WorkflowUsageStats> = {}): WorkflowUsageStats {
  return {
    workflowId: 'wf',
    workflowName: 'WF',
    runsWithUsage: 5,
    avgTotalTokens: 1000,
    totalTokens: 5000,
    totalCostUsd: 1,
    avgCostUsd: 0.2,
    ...over,
  };
}

function revision(over: Partial<WorkflowRevisionStats> = {}): WorkflowRevisionStats {
  return {
    workflowId: 'wf',
    specHash: 'abcdef0123456789',
    firstSeenAt: '2026-06-10T00:00:00.000Z',
    isCurrent: true,
    runs: 3,
    mergedRuns: 2,
    failedRuns: 1,
    successRatePct: 66.7,
    avgTotalTokens: 1500,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWorkflowStats = [];
  mockWorkflowUsage = [];
  mockStepTokens = {};
  mockUsageTrends = {};
  mockRevisionHistory = {};
  mockDailyUsage = [];
});

// ---------------------------------------------------------------------------
// Daily chart on top
// ---------------------------------------------------------------------------

describe('StatsSection daily chart', () => {
  it('mounts the daily-usage chart above the cards, wired to the dailyUsage slice', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockDailyUsage = [
      { day: '2026-06-10', model: 'claude-sonnet-4', inputTokens: 100, outputTokens: 50, totalTokens: 150, assistantMessageCount: 2 },
    ];
    render(<StatsSection />);
    const chart = screen.getByTestId('daily-usage-chart');
    expect(chart).toBeInTheDocument();
    // The stub echoes the point count it received from the slice.
    expect(chart).toHaveAttribute('data-points', '1');
  });

  it('still renders the daily chart container when there are no workflow cards', () => {
    render(<StatsSection />);
    expect(screen.getByTestId('stats-daily-usage')).toBeInTheDocument();
    expect(screen.getByTestId('stats-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Card grid — spendiest-first ordering + the total/avg token headline
// ---------------------------------------------------------------------------

describe('StatsSection card grid', () => {
  it('sorts cards by total cost DESC with null-cost cards last', () => {
    mockWorkflowStats = [
      runStats({ workflowId: 'wf-cheap', workflowName: 'Cheap' }),
      runStats({ workflowId: 'wf-pricey', workflowName: 'Pricey' }),
      runStats({ workflowId: 'wf-free', workflowName: 'Free' }),
    ];
    mockWorkflowUsage = [
      usageStats({ workflowId: 'wf-cheap', workflowName: 'Cheap', totalCostUsd: 1.5 }),
      usageStats({ workflowId: 'wf-pricey', workflowName: 'Pricey', totalCostUsd: 32.96 }),
      usageStats({ workflowId: 'wf-free', workflowName: 'Free', totalCostUsd: null }),
    ];
    render(<StatsSection />);
    const ids = screen
      .getAllByTestId(/^stats-card-/)
      .map((n) => n.getAttribute('data-testid'));
    expect(ids).toEqual(['stats-card-wf-pricey', 'stats-card-wf-cheap', 'stats-card-wf-free']);
  });

  it('headlines TOTAL tokens with a smaller avg figure beside it', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [
      usageStats({
        workflowId: 'wf-a',
        workflowName: 'Alpha',
        totalTokens: 1_840_000,
        avgTotalTokens: 184_000,
      }),
    ];
    render(<StatsSection />);
    // m-tier compact form for the big total; k-form for the per-run average.
    expect(screen.getByTestId('stats-total-tokens')).toHaveTextContent('1.8m');
    expect(screen.getByTestId('stats-avg-tokens')).toHaveTextContent('avg 184k');
  });

  it('renders an em-dash headline and no avg figure for a card without usage', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [];
    render(<StatsSection />);
    expect(screen.getByTestId('stats-total-tokens')).toHaveTextContent('—');
    expect(screen.queryByTestId('stats-avg-tokens')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Default (no selection) → token by flow
// ---------------------------------------------------------------------------

describe('StatsSection default by-flow panel', () => {
  it('ranks workflows by totalTokens DESC and skips null/0 sums', () => {
    mockWorkflowStats = [
      runStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalRuns: 3 }),
      runStats({ workflowId: 'wf-b', workflowName: 'Beta', totalRuns: 2 }),
      runStats({ workflowId: 'wf-c', workflowName: 'Gamma', totalRuns: 1 }),
      runStats({ workflowId: 'wf-d', workflowName: 'Delta', totalRuns: 1 }),
    ];
    mockWorkflowUsage = [
      usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: 30000 }),
      usageStats({ workflowId: 'wf-b', workflowName: 'Beta', totalTokens: 90000 }),
      usageStats({ workflowId: 'wf-c', workflowName: 'Gamma', totalTokens: null }),
      usageStats({ workflowId: 'wf-d', workflowName: 'Delta', totalTokens: 0 }),
    ];
    render(<StatsSection />);
    const panel = screen.getByTestId('stats-token-by-flow');
    expect(panel).toBeInTheDocument();
    // Beta (90k) before Alpha (30k); Gamma (null) and Delta (0) dropped.
    const rows = within(panel).getAllByTestId('bar-row').map((n) => n.textContent);
    expect(rows).toEqual(['Beta', 'Alpha']);
    // Compact value labels carried through.
    const beta = within(panel).getAllByTestId('bar-row')[0];
    expect(beta).toHaveAttribute('data-value', '90k');
  });

  it('shows the no-token-usage note when no flow has a positive total', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: null })];
    render(<StatsSection />);
    expect(screen.getByTestId('stats-no-flow-tokens')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-token-by-step')).toBeNull();
  });

  it('drives VersionHistory off the BUSIEST workflow in the default state', () => {
    mockWorkflowStats = [
      runStats({ workflowId: 'wf-busy', workflowName: 'Busy', totalRuns: 20 }),
      runStats({ workflowId: 'wf-quiet', workflowName: 'Quiet', totalRuns: 2 }),
    ];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-busy', workflowName: 'Busy', totalTokens: 5000 })];
    mockRevisionHistory = {
      'wf-busy': [revision({ workflowId: 'wf-busy', specHash: 'busyhash000' })],
      'wf-quiet': [revision({ workflowId: 'wf-quiet', specHash: 'quiethash00' })],
    };
    render(<StatsSection />);
    const vh = screen.getByTestId('version-history');
    expect(within(vh).getByText('Version history · Busy')).toBeInTheDocument();
    // The busiest revision row, not the quiet one.
    expect(screen.getByTestId('revision-row-busyhash000')).toBeInTheDocument();
    expect(screen.queryByTestId('revision-row-quiethash00')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Selection → token by step
// ---------------------------------------------------------------------------

describe('StatsSection card selection', () => {
  it('clicking a card switches to its by-step panel, sets aria-pressed, and calls ensureWorkflowDetail', () => {
    mockWorkflowStats = [
      runStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalRuns: 3 }),
      runStats({ workflowId: 'wf-b', workflowName: 'Beta', totalRuns: 20 }),
    ];
    mockWorkflowUsage = [
      usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: 30000 }),
      usageStats({ workflowId: 'wf-b', workflowName: 'Beta', totalTokens: 90000 }),
    ];
    mockStepTokens = {
      'wf-a': [
        { stepId: 'execute', totalTokens: 64000, assistantMessageCount: 9 },
        { stepId: 'verify', totalTokens: 12000, assistantMessageCount: 3 },
      ],
    };
    render(<StatsSection />);

    // Default state shows the by-flow panel.
    expect(screen.getByTestId('stats-token-by-flow')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-token-by-step')).toBeNull();

    const card = screen.getByTestId('stats-card-wf-a');
    expect(card).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(card);

    // Now the by-step panel for the SELECTED workflow.
    expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('stats-token-by-flow')).toBeNull();
    const stepPanel = screen.getByTestId('stats-token-by-step');
    expect(within(stepPanel).getByText('Token by step · Alpha')).toBeInTheDocument();
    expect(within(stepPanel).getAllByTestId('bar-row').map((n) => n.textContent)).toEqual([
      'execute',
      'verify',
    ]);
    // Drill-down detail ensured for the selected id.
    expect(mockEnsureWorkflowDetail).toHaveBeenCalledWith('wf-a');
  });

  it('shows the muted no-steps note when the selected flow has no step buckets', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: 30000 })];
    // No stepTokens entry for wf-a.
    render(<StatsSection />);
    fireEvent.click(screen.getByTestId('stats-card-wf-a'));
    expect(screen.getByTestId('stats-no-steps')).toHaveTextContent(
      'No step attribution for this flow yet.',
    );
  });

  it('points VersionHistory at the SELECTED flow once a card is chosen', () => {
    mockWorkflowStats = [
      runStats({ workflowId: 'wf-busy', workflowName: 'Busy', totalRuns: 20 }),
      runStats({ workflowId: 'wf-quiet', workflowName: 'Quiet', totalRuns: 2 }),
    ];
    mockWorkflowUsage = [
      usageStats({ workflowId: 'wf-busy', workflowName: 'Busy', totalTokens: 9000 }),
      usageStats({ workflowId: 'wf-quiet', workflowName: 'Quiet', totalTokens: 3000 }),
    ];
    mockRevisionHistory = {
      'wf-busy': [revision({ workflowId: 'wf-busy', specHash: 'busyhash000' })],
      'wf-quiet': [revision({ workflowId: 'wf-quiet', specHash: 'quiethash00' })],
    };
    render(<StatsSection />);
    // Select the QUIET (non-busiest) workflow.
    fireEvent.click(screen.getByTestId('stats-card-wf-quiet'));
    const vh = screen.getByTestId('version-history');
    expect(within(vh).getByText('Version history · Quiet')).toBeInTheDocument();
    expect(screen.getByTestId('revision-row-quiethash00')).toBeInTheDocument();
    expect(screen.queryByTestId('revision-row-busyhash000')).toBeNull();
  });

  it('clicking the selected card again deselects, returning to the by-flow panel', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: 30000 })];
    mockStepTokens = { 'wf-a': [{ stepId: 'execute', totalTokens: 64000, assistantMessageCount: 9 }] };
    render(<StatsSection />);
    const card = screen.getByTestId('stats-card-wf-a');

    fireEvent.click(card);
    expect(screen.getByTestId('stats-token-by-step')).toBeInTheDocument();

    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByTestId('stats-token-by-step')).toBeNull();
    expect(screen.getByTestId('stats-token-by-flow')).toBeInTheDocument();
  });

  it('the "← all flows" affordance deselects back to the by-flow panel', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', workflowName: 'Alpha' })];
    mockWorkflowUsage = [usageStats({ workflowId: 'wf-a', workflowName: 'Alpha', totalTokens: 30000 })];
    mockStepTokens = { 'wf-a': [{ stepId: 'execute', totalTokens: 64000, assistantMessageCount: 9 }] };
    render(<StatsSection />);
    fireEvent.click(screen.getByTestId('stats-card-wf-a'));
    fireEvent.click(screen.getByTestId('stats-deselect'));
    expect(screen.queryByTestId('stats-token-by-step')).toBeNull();
    expect(screen.getByTestId('stats-token-by-flow')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Preserved behaviors — integrity hint + empty state.
// ---------------------------------------------------------------------------

describe('StatsSection preserved behaviors', () => {
  it('surfaces the null-outcome integrity hint when any workflow has nullOutcomeRuns', () => {
    mockWorkflowStats = [runStats({ workflowId: 'wf-a', nullOutcomeRuns: 3 })];
    render(<StatsSection />);
    expect(screen.getByTestId('stats-integrity-hint')).toHaveTextContent('3 runs missing outcome');
  });

  it('renders the empty state when there are no workflow runs', () => {
    render(<StatsSection />);
    expect(screen.getByTestId('stats-empty')).toBeInTheDocument();
    cleanup();
  });
});
