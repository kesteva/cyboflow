/**
 * RotationComparisonBody tests (rotation-experiment UI, slice B).
 *
 * Covers: per-arm stats rows (incl. a zero-run arm), the declare-winner confirm
 * gate + decideRotation mutation + onReload, the end-rotation abandon flow, the
 * settled-state summary hiding the footer buttons, and run-row click/no-click
 * behavior keyed on `sessionId`.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RotationComparisonBody } from '../RotationComparisonBody';
import type { ExperimentRow, RotationArmStats, RotationExperimentRun } from '../../../../../shared/types/experiments';

const rotationStatsQuery = vi.fn();
const rotationRunsQuery = vi.fn();
const decideRotationMutate = vi.fn();
const abandonRotationMutate = vi.fn();
const goToSession = vi.fn();
const setActiveRun = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        rotationStats: { query: (...a: unknown[]) => rotationStatsQuery(...a) },
        rotationRuns: { query: (...a: unknown[]) => rotationRunsQuery(...a) },
        decideRotation: { mutate: (...a: unknown[]) => decideRotationMutate(...a) },
        abandonRotation: { mutate: (...a: unknown[]) => abandonRotationMutate(...a) },
      },
    },
  },
}));

vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: { getState: () => ({ goToSession }) },
}));

vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun }) },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExp(over: Partial<ExperimentRow> = {}): ExperimentRow {
  return {
    id: 'exp_rot_1',
    project_id: null,
    workflow_id: 'wf-1',
    kind: 'rotation',
    base_branch: null,
    base_sha: null,
    variant_a_id: null,
    variant_b_id: null,
    run_a_id: null,
    run_b_id: null,
    session_a_id: null,
    session_b_id: null,
    seed_idea_id: null,
    seed_idea_clone_a_id: null,
    seed_idea_clone_b_id: null,
    status: 'running',
    winner_run_id: null,
    winner_arm: null,
    merge_sha: null,
    decided_at: null,
    rerun_of_experiment_id: null,
    promoted_variant_id: null,
    promoted_arm: null,
    promoted_at: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

function makeStats(over: Partial<RotationArmStats> = {}): RotationArmStats {
  return {
    armVariantId: 'wfv_a',
    label: 'variant-a',
    runs: 8,
    completedRuns: 7,
    failedRuns: 1,
    canceledRuns: 0,
    activeRuns: 0,
    mergedRuns: 5,
    dismissedRuns: 2,
    nullOutcomeRuns: 0,
    successRatePct: 87,
    avgDurationMs: 60_000,
    avgTotalTokens: 12_000,
    avgCostUsd: 1.2,
    avgEvalScore: 8.5,
    findingsCount: 3,
    postMergeBugCount: 0,
    lowSample: false,
    ...over,
  };
}

function makeRun(over: Partial<RotationExperimentRun> = {}): RotationExperimentRun {
  return {
    runId: 'run-1',
    armVariantId: 'wfv_a',
    armLabel: 'variant-a',
    status: 'completed',
    outcome: 'merged',
    sessionId: 'sess-1',
    projectId: 5,
    createdAt: '2026-07-01T00:00:00.000Z',
    durationMs: 60_000,
    totalTokens: 12_000,
    costUsd: 1.2,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RotationComparisonBody', () => {
  it('renders a stats row per arm, including a zero-run arm', async () => {
    rotationStatsQuery.mockResolvedValue([
      makeStats({ armVariantId: 'wfv_a', label: 'variant-a', runs: 8 }),
      makeStats({ armVariantId: '__baseline__', label: 'Baseline', runs: 0, lowSample: true }),
    ]);
    rotationRunsQuery.mockResolvedValue([]);

    render(<RotationComparisonBody exp={makeExp()} onReload={vi.fn()} />);

    expect(await screen.findByTestId('rotation-stats-row-wfv_a')).toHaveTextContent('87%');
    expect(screen.getByTestId('rotation-stats-row-__baseline__')).toHaveTextContent('0');
    expect(screen.getByTestId('rotation-lowsample-__baseline__')).toHaveTextContent('n<5, provisional');
    expect(screen.getByTestId('rotation-arm-labels')).toHaveTextContent('variant-a vs Baseline');
  });

  it('opens a confirm dialog on "Declare winner" and fires decideRotation only on confirm, then reloads', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats({ armVariantId: 'wfv_a', label: 'variant-a' })]);
    rotationRunsQuery.mockResolvedValue([]);
    decideRotationMutate.mockResolvedValue({ experimentId: 'exp_rot_1', status: 'decided', promotedVariantId: 'wfv_a' });
    const onReload = vi.fn().mockResolvedValue(undefined);

    render(<RotationComparisonBody exp={makeExp()} onReload={onReload} />);

    const btn = await screen.findByTestId('rotation-declare-winner-wfv_a');
    fireEvent.click(btn);
    expect(decideRotationMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Declare winner'));
    await waitFor(() =>
      expect(decideRotationMutate).toHaveBeenCalledWith({ experimentId: 'exp_rot_1', winnerVariantId: 'wfv_a' }),
    );
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('opens a confirm dialog on "End rotation" and fires abandonRotation only on confirm, then reloads', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats()]);
    rotationRunsQuery.mockResolvedValue([]);
    abandonRotationMutate.mockResolvedValue({ experimentId: 'exp_rot_1', status: 'abandoned' });
    const onReload = vi.fn().mockResolvedValue(undefined);

    render(<RotationComparisonBody exp={makeExp()} onReload={onReload} />);

    const btn = await screen.findByTestId('rotation-abandon');
    fireEvent.click(btn);
    expect(abandonRotationMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('End rotation'));
    await waitFor(() => expect(abandonRotationMutate).toHaveBeenCalledWith({ experimentId: 'exp_rot_1' }));
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1));
  });

  it('hides the winner/abandon buttons and shows the outcome summary once decided', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats({ armVariantId: 'wfv_a', label: 'variant-a' })]);
    rotationRunsQuery.mockResolvedValue([]);

    render(
      <RotationComparisonBody
        exp={makeExp({ status: 'decided', promoted_variant_id: 'wfv_a', decided_at: '2026-07-05T00:00:00.000Z' })}
        onReload={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('rotation-outcome-summary')).toHaveTextContent('Decided');
    expect(screen.getByTestId('rotation-outcome-summary')).toHaveTextContent('variant-a');
    expect(screen.queryByTestId('rotation-declare-winner-wfv_a')).not.toBeInTheDocument();
    expect(screen.queryByTestId('rotation-abandon')).not.toBeInTheDocument();
  });

  it('shows "Baseline" as the winner label when the baseline sentinel was promoted', async () => {
    rotationStatsQuery.mockResolvedValue([
      makeStats({ armVariantId: 'wfv_a', label: 'variant-a' }),
      makeStats({ armVariantId: '__baseline__', label: 'Baseline' }),
    ]);
    rotationRunsQuery.mockResolvedValue([]);

    render(
      <RotationComparisonBody
        exp={makeExp({ status: 'decided', promoted_variant_id: '__baseline__', decided_at: '2026-07-05T00:00:00.000Z' })}
        onReload={vi.fn()}
      />,
    );

    expect(await screen.findByTestId('rotation-outcome-summary')).toHaveTextContent('Baseline');
  });

  it('shows the abandoned summary with no winner mentioned', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats()]);
    rotationRunsQuery.mockResolvedValue([]);

    render(<RotationComparisonBody exp={makeExp({ status: 'abandoned' })} onReload={vi.fn()} />);

    expect(await screen.findByTestId('rotation-outcome-summary')).toHaveTextContent('Abandoned');
    expect(screen.queryByTestId('rotation-declare-winner-wfv_a')).not.toBeInTheDocument();
  });

  it('a run row with a sessionId is clickable and sets the active run + navigates', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats({ armVariantId: 'wfv_a', label: 'variant-a' })]);
    rotationRunsQuery.mockResolvedValue([makeRun({ runId: 'run-clickable', armVariantId: 'wfv_a', sessionId: 'sess-9' })]);

    render(<RotationComparisonBody exp={makeExp()} onReload={vi.fn()} />);

    const row = await screen.findByTestId('rotation-run-row-run-clickable');
    expect(row.tagName).toBe('BUTTON');
    fireEvent.click(row);

    expect(setActiveRun).toHaveBeenCalledWith('run-clickable', 'sess-9');
    expect(goToSession).toHaveBeenCalledTimes(1);
  });

  it('a run row with a null sessionId is not clickable', async () => {
    rotationStatsQuery.mockResolvedValue([makeStats({ armVariantId: 'wfv_a', label: 'variant-a' })]);
    rotationRunsQuery.mockResolvedValue([makeRun({ runId: 'run-no-session', armVariantId: 'wfv_a', sessionId: null })]);

    render(<RotationComparisonBody exp={makeExp()} onReload={vi.fn()} />);

    const row = await screen.findByTestId('rotation-run-row-run-no-session');
    expect(row.tagName).toBe('DIV');
    fireEvent.click(row);

    expect(setActiveRun).not.toHaveBeenCalled();
    expect(goToSession).not.toHaveBeenCalled();
  });
});
