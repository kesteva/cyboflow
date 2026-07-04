/**
 * WorkflowSummaryPanel — experiment banner tests (A/B testing slice C).
 *
 * Covers: the banner is absent for a non-experiment run; present + "View
 * comparison" gated ("Awaiting other arm") while no comparison row exists yet
 * (`comparisonStatus: 'absent'`); enabled once a comparison row exists in any
 * status; and clicking it calls `navigationStore.openExperimentComparison`.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowSummaryPanel } from '../WorkflowSummaryPanel';
import type { RunUsageRollup } from '../../../../../shared/types/insights';
import type { ComparisonStatus } from '../../../../../shared/types/experiments';

const runUsageQuery = vi.fn();
const runEvalQuery = vi.fn();
const comparisonStatusQuery = vi.fn();
const openExperimentComparison = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: {
        runUsage: { query: (...a: unknown[]) => runUsageQuery(...a) },
        runEval: { query: (...a: unknown[]) => runEvalQuery(...a) },
      },
      reviewItems: { list: { query: vi.fn().mockResolvedValue([]) } },
      runs: {
        relayInput: { mutate: vi.fn() },
        restart: { mutate: vi.fn() },
      },
      experiments: {
        comparisonStatus: { query: (...a: unknown[]) => comparisonStatusQuery(...a) },
      },
    },
  },
}));

vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ openExperimentComparison }) },
}));

vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: { getState: () => ({ showError: vi.fn() }) },
}));

const ROLLUP: RunUsageRollup = {
  runId: 'run-1',
  inputTokens: 100,
  outputTokens: 50,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  totalTokens: 150,
  costUsd: 0.1,
  numTurns: 1,
  assistantMessageCount: 1,
  startedAt: null,
  endedAt: null,
};

beforeEach(() => {
  runUsageQuery.mockReset().mockResolvedValue(ROLLUP);
  runEvalQuery.mockReset().mockResolvedValue(null);
  comparisonStatusQuery.mockReset();
  openExperimentComparison.mockReset();
});

function renderPanel(over: Partial<React.ComponentProps<typeof WorkflowSummaryPanel>> = {}) {
  return render(
    <WorkflowSummaryPanel
      runId="run-1"
      status="awaiting_review"
      substrate="sdk"
      workflowLabel="planner"
      onComplete={vi.fn()}
      {...over}
    />,
  );
}

describe('WorkflowSummaryPanel — experiment banner', () => {
  it('renders no banner for a non-experiment run', async () => {
    renderPanel();
    await screen.findByTestId('run-summary-complete');
    expect(screen.queryByTestId('run-summary-experiment-banner')).not.toBeInTheDocument();
    expect(comparisonStatusQuery).not.toHaveBeenCalled();
  });

  it('shows the banner disabled ("Awaiting other arm") while no comparison row exists', async () => {
    comparisonStatusQuery.mockResolvedValue({ status: 'absent' as ComparisonStatus | 'absent' });
    renderPanel({ experimentId: 'exp_1', experimentArm: 'A' });
    const banner = await screen.findByTestId('run-summary-experiment-banner');
    expect(banner).toHaveTextContent('Part of experiment — Arm A');
    const button = await screen.findByTestId('run-summary-view-comparison');
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Awaiting other arm');
  });

  it('enables "View comparison" once a comparison row exists (any non-absent status)', async () => {
    comparisonStatusQuery.mockResolvedValue({ status: 'running' as ComparisonStatus | 'absent' });
    renderPanel({ experimentId: 'exp_1', experimentArm: 'B' });
    const button = await screen.findByTestId('run-summary-view-comparison');
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent('View comparison');

    fireEvent.click(button);
    expect(openExperimentComparison).toHaveBeenCalledWith('exp_1');
  });
});
