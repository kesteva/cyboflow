/**
 * ExperimentComparisonView tests (A/B testing slice C).
 *
 * Covers: loading/not-found states; the verdict card for A/B/tie preferences and
 * the failed/skipped/absent no-verdict messages; footer CTA gating on both arms
 * settled + decide's winnerRunId mapping (Promote A/B → the arm's runId,
 * Discard both → null) followed by closeExperimentComparison; the "Re-run
 * comparison" gate on experiment status running|grading; the "Switch to
 * randomized" gate on the experiment being settled + its confirm-then-mutate
 * flow; and the shared changed-file list rendering per-arm DiffBody from the
 * FROZEN diff text.
 */
import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExperimentComparisonView } from '../ExperimentComparisonView';
import type {
  ExperimentRow,
  ExperimentComparisonPayload,
  ExperimentComparisonDiffs,
  ExperimentArmView,
} from '../../../../../shared/types/experiments';

const getQuery = vi.fn();
const getComparisonQuery = vi.fn();
const getComparisonDiffsQuery = vi.fn();
const decideMutate = vi.fn();
const abandonMutate = vi.fn();
const rerunComparisonMutate = vi.fn();
const rerunMutate = vi.fn();
const switchToRotationMutate = vi.fn();
const promoteVariantMutate = vi.fn();
const closeExperimentComparison = vi.fn();
const setActiveProjectId = vi.fn();
const goToSession = vi.fn();
const setActiveRun = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      experiments: {
        get: { query: (...a: unknown[]) => getQuery(...a) },
        getComparison: { query: (...a: unknown[]) => getComparisonQuery(...a) },
        getComparisonDiffs: { query: (...a: unknown[]) => getComparisonDiffsQuery(...a) },
        decide: { mutate: (...a: unknown[]) => decideMutate(...a) },
        abandon: { mutate: (...a: unknown[]) => abandonMutate(...a) },
        rerunComparison: { mutate: (...a: unknown[]) => rerunComparisonMutate(...a) },
        rerun: { mutate: (...a: unknown[]) => rerunMutate(...a) },
        switchToRotation: { mutate: (...a: unknown[]) => switchToRotationMutate(...a) },
        promoteVariant: { mutate: (...a: unknown[]) => promoteVariantMutate(...a) },
      },
      tasks: { get: { query: vi.fn().mockResolvedValue(null) } },
    },
  },
}));

vi.mock('../../../stores/navigationStore', () => ({
  useNavigationStore: {
    getState: () => ({ closeExperimentComparison, setActiveProjectId, goToSession }),
  },
}));

vi.mock('../../../stores/cyboflowStore', () => ({
  useCyboflowStore: { getState: () => ({ setActiveRun }) },
}));

vi.mock('../../../utils/bootstrapArmSessionPanels', () => ({
  bootstrapArmSessionPanels: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../IdeaPickerModal', () => ({
  IdeaPickerModal: () => null,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeExp(over: Partial<ExperimentRow> = {}): ExperimentRow {
  return {
    id: 'exp_1',
    project_id: 5,
    workflow_id: 'wf-1',
    kind: 'side_by_side',
    base_branch: 'main',
    base_sha: 'abc123',
    variant_a_id: 'wfv_a',
    variant_b_id: 'wfv_b',
    run_a_id: 'run-a',
    run_b_id: 'run-b',
    session_a_id: 'sess-a',
    session_b_id: 'sess-b',
    seed_idea_id: null,
    seed_idea_clone_a_id: null,
    seed_idea_clone_b_id: null,
    status: 'grading',
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

function makeArm(over: Partial<ExperimentArmView> = {}): ExperimentArmView {
  return {
    runId: 'run-a',
    arm: 'A',
    variantLabel: 'variant-a',
    status: 'awaiting_review',
    usage: null,
    evalSummary: null,
    findings: [],
    entitySummary: { ideas: 0, epics: 0, tasks: 0 },
    ...over,
  };
}

function makePayload(over: Partial<ExperimentComparisonPayload> = {}): ExperimentComparisonPayload {
  return {
    experimentId: 'exp_1',
    comparisonStatus: 'complete',
    baseSha: 'abc123',
    snapshotAt: '2026-07-02T00:00:00.000Z',
    verdict: {
      preference: 'A',
      confidence: 0.8,
      rationale: 'Arm A handles the edge case correctly.',
      aCount: 2,
      bCount: 1,
      tieCount: 0,
      sampleCount: 3,
      perSample: [
        { sampleIndex: 0, positionAFirst: true, rawPreference: '1', preference: 'A', confidence: 0.9, rationale: 'r1' },
        { sampleIndex: 1, positionAFirst: false, rawPreference: '2', preference: 'A', confidence: 0.85, rationale: 'r2' },
        { sampleIndex: 2, positionAFirst: true, rawPreference: '2', preference: 'B', confidence: 0.6, rationale: 'r3' },
      ],
    },
    armA: makeArm({ runId: 'run-a', arm: 'A', variantLabel: 'variant-a', status: 'awaiting_review' }),
    armB: makeArm({ runId: 'run-b', arm: 'B', variantLabel: 'variant-b', status: 'awaiting_review' }),
    ...over,
  };
}

const DIFF_A = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old line A',
  '+new line A',
  '',
].join('\n');

const DIFF_B = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..333 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  '-old line A',
  '+new line B',
  '',
].join('\n');

function makeDiffs(over: Partial<ExperimentComparisonDiffs> = {}): ExperimentComparisonDiffs {
  return {
    baseSha: 'abc123',
    armA: { runId: 'run-a', label: 'variant-a', diff: DIFF_A },
    armB: { runId: 'run-b', label: 'variant-b', diff: DIFF_B },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ExperimentComparisonView', () => {
  it('shows a loading state, then the not-found state when the experiment is absent', async () => {
    getQuery.mockResolvedValue(null);
    getComparisonQuery.mockResolvedValue(null);
    getComparisonDiffsQuery.mockResolvedValue(null);

    render(<ExperimentComparisonView experimentId="exp_missing" />);
    expect(screen.getByTestId('experiment-comparison-loading')).toBeInTheDocument();

    expect(await screen.findByTestId('experiment-comparison-error')).toBeInTheDocument();
  });

  it('renders the verdict card (preference/confidence/rationale/sample chips) and the two arm columns', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'decided', decided_at: '2026-07-02T00:00:00.000Z' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);

    expect(await screen.findByTestId('experiment-verdict-preference')).toHaveTextContent('Prefers A');
    expect(screen.getByTestId('experiment-verdict-confidence')).toHaveTextContent('80%');
    expect(screen.getByTestId('experiment-verdict-rationale')).toHaveTextContent('edge case');
    expect(screen.getAllByTestId('experiment-sample-chip')).toHaveLength(3);
    expect(screen.getByTestId('experiment-arm-a')).toBeInTheDocument();
    expect(screen.getByTestId('experiment-arm-b')).toBeInTheDocument();
  });

  it('shows the "did not complete" message when an arm failed and grading failed', async () => {
    getQuery.mockResolvedValue(makeExp());
    getComparisonQuery.mockResolvedValue(
      makePayload({
        comparisonStatus: 'failed',
        verdict: null,
        armB: makeArm({ runId: 'run-b', arm: 'B', variantLabel: 'variant-b', status: 'failed' }),
      }),
    );
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-verdict-absent')).toHaveTextContent('Arm B did not complete');
  });

  it('shows the disabled-grading message when eval is skipped', async () => {
    getQuery.mockResolvedValue(makeExp());
    getComparisonQuery.mockResolvedValue(makePayload({ comparisonStatus: 'skipped', verdict: null }));
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-verdict-absent')).toHaveTextContent('disabled');
  });

  it('disables the decide CTAs until both arms are settled, then maps Accept A/B and Discard both to decide()', async () => {
    getQuery.mockResolvedValue(makeExp());
    getComparisonQuery.mockResolvedValueOnce(
      makePayload({ armB: makeArm({ runId: 'run-b', arm: 'B', variantLabel: 'variant-b', status: 'running' }) }),
    );
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    await screen.findByTestId('experiment-verdict-card');
    expect(screen.getByTestId('experiment-accept-a')).toBeDisabled();
    expect(screen.getByTestId('experiment-accept-b')).toBeDisabled();
    expect(screen.getByTestId('experiment-discard-both')).toBeDisabled();
  });

  it('Accept A calls decide with armA.runId, keeps the view open, and enables the variant-outcome group', async () => {
    // Mount sees a not-yet-settled experiment; after decide the re-fetch returns
    // the settled row so piece 2 ("Which version wins?") enables IN PLACE. The view
    // must NOT close — that previously stranded the user before the variant decision.
    getQuery
      .mockResolvedValueOnce(makeExp())
      .mockResolvedValue(makeExp({ status: 'decided', winner_run_id: 'run-a', winner_arm: 'A' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    decideMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'decided', winnerRunId: 'run-a' });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-accept-a');
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(decideMutate).toHaveBeenCalledWith({ experimentId: 'exp_1', winnerRunId: 'run-a' }),
    );
    // View stays open: the changes summary renders and the promote CTAs enable.
    expect(await screen.findByTestId('experiment-changes-decision-summary')).toHaveTextContent(
      "Accepted arm A's changes",
    );
    await waitFor(() =>
      expect(screen.getByTestId('experiment-promote-variant-a')).not.toBeDisabled(),
    );
    expect(closeExperimentComparison).not.toHaveBeenCalled();
  });

  it('Discard both calls decide with winnerRunId: null', async () => {
    getQuery.mockResolvedValue(makeExp());
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    decideMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'decided', winnerRunId: null });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-discard-both');
    await waitFor(() => expect(btn).not.toBeDisabled());
    fireEvent.click(btn);

    await waitFor(() =>
      expect(decideMutate).toHaveBeenCalledWith({ experimentId: 'exp_1', winnerRunId: null }),
    );
  });

  it('gates "Re-run comparison" on the experiment status (running|grading only)', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'decided' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-rerun-comparison')).toBeDisabled();
  });

  it('"Re-run comparison" is enabled while grading and re-fetches on success', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'grading' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    rerunComparisonMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'running' });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-rerun-comparison');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(rerunComparisonMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' }));
  });

  it('"Re-run comparison" re-arms the polling loop even after it had already stopped', async () => {
    // Regression: the mount effect's own poll stops once comparisonStatus is
    // resolved ('complete'), leaving no outstanding timer. A prior bug called the
    // bare `load()` once here, so the verdict card got stuck on the stale
    // pending/in-progress state until the view was closed and reopened. The fix
    // re-arms the SAME `tick` loop, so a fresh 'pending' status re-schedules polling.
    vi.useFakeTimers();
    try {
      getQuery.mockResolvedValue(makeExp({ status: 'grading' }));
      getComparisonQuery
        .mockResolvedValueOnce(makePayload({ comparisonStatus: 'complete' }))
        .mockResolvedValueOnce(makePayload({ comparisonStatus: 'pending', verdict: null }));
      getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
      rerunComparisonMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'pending' });

      render(<ExperimentComparisonView experimentId="exp_1" />);
      // Flush the mount effect's initial tick without firing any timer it may
      // schedule (advancing by 0ms drains microtasks but can't reach a 10s poll).
      await vi.advanceTimersByTimeAsync(0);

      expect(getComparisonQuery).toHaveBeenCalledTimes(1);
      // comparisonStatus was 'complete' — the mount tick did not re-arm polling.
      expect(vi.getTimerCount()).toBe(0);

      fireEvent.click(screen.getByTestId('experiment-rerun-comparison'));
      await vi.advanceTimersByTimeAsync(0);

      expect(rerunComparisonMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' });
      expect(getComparisonQuery).toHaveBeenCalledTimes(2);
      // The re-armed tick observed 'pending' and scheduled the next poll timer.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('"Switch to randomized" is disabled until the experiment is settled, then confirms before mutating', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'decided' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    switchToRotationMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'decided', winnerRunId: null });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-switch-to-rotation');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    // Confirmation dialog gates the mutation — not called until confirmed.
    expect(switchToRotationMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Switch to rotation'));
    await waitFor(() =>
      expect(switchToRotationMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' }),
    );
  });

  it('"Switch to randomized" is disabled while the experiment is still running/grading', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'running' }));
    getComparisonQuery.mockResolvedValue(makePayload({ armB: makeArm({ runId: 'run-b', arm: 'B', status: 'running' }) }));
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-switch-to-rotation')).toBeDisabled();
  });

  it('enables "Switch to randomized" when an arm is the baseline (baseline vs variant rotation)', async () => {
    // Settled experiment where arm A is the current-workflow baseline (sentinel).
    // "Switch to randomized" turns this into a baseline-vs-variant rotation — the
    // baseline opts into rotation server-side — so the button is ENABLED, not greyed.
    getQuery.mockResolvedValue(makeExp({ status: 'decided', variant_a_id: '__baseline__' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    switchToRotationMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'decided', winnerRunId: null });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-switch-to-rotation');
    expect(btn).not.toBeDisabled();
    expect(screen.queryByTestId('experiment-rotation-baseline-hint')).not.toBeInTheDocument();
    fireEvent.click(btn);
    expect(switchToRotationMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Switch to rotation'));
    await waitFor(() => expect(switchToRotationMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' }));
  });

  it('"Run another experiment" is disabled until the experiment is settled', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'grading' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-run-again-open')).toBeDisabled();
  });

  it('"Run another experiment" starts a rerun (no decide/abandon composition) once settled', async () => {
    // The variant-outcome group (which "Run another experiment" now belongs to) is
    // reachable only once the changes decision (piece 1) is already recorded, so the
    // trigger no longer needs to compose a decide(null)/abandon pre-step.
    getQuery.mockResolvedValue(makeExp({ status: 'decided' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    rerunMutate.mockResolvedValue({
      experimentId: 'exp_2',
      armA: { runId: 'run-a2', sessionId: 'sess-a2' },
      armB: { runId: 'run-b2', sessionId: 'sess-b2' },
    });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const openBtn = await screen.findByTestId('experiment-run-again-open');
    expect(openBtn).not.toBeDisabled();
    fireEvent.click(openBtn);
    fireEvent.click(screen.getByTestId('experiment-run-again-start'));

    await waitFor(() => expect(rerunMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' }));
    expect(decideMutate).not.toHaveBeenCalled();
    expect(abandonMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(goToSession).toHaveBeenCalledTimes(1));
    expect(setActiveRun).toHaveBeenCalledWith('run-a2', 'sess-a2');
  });

  it('"Abandon experiment" is offered while an arm is still running and tears the experiment down', async () => {
    // Preserves the old "Discard both & run again" abandon-reachability contract:
    // a still-running experiment (an arm not yet settled) can be torn down without
    // waiting for a changes decision, now via a dedicated Abandon control.
    getQuery.mockResolvedValue(makeExp({ status: 'running' }));
    getComparisonQuery.mockResolvedValue(
      makePayload({ armB: makeArm({ runId: 'run-b', arm: 'B', status: 'running' }) }),
    );
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    abandonMutate.mockResolvedValue({ experimentId: 'exp_1', status: 'abandoned', winnerRunId: null });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-abandon');
    fireEvent.click(btn);

    await waitFor(() => expect(abandonMutate).toHaveBeenCalledWith({ experimentId: 'exp_1' }));
    expect(decideMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(closeExperimentComparison).toHaveBeenCalledTimes(1));
  });

  it('a settled experiment enables the variant-outcome Promote buttons and calls experiments.promoteVariant with the chosen arm', async () => {
    getQuery.mockResolvedValue(makeExp({ status: 'decided', winner_arm: 'A', winner_run_id: 'run-a' }));
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());
    promoteVariantMutate.mockResolvedValue({ experimentId: 'exp_1', promotedVariantId: 'wfv_a', promotedArm: 'A' });

    render(<ExperimentComparisonView experimentId="exp_1" />);
    const btn = await screen.findByTestId('experiment-promote-variant-a');
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    // Confirmation dialog gates the mutation — not called until confirmed.
    expect(promoteVariantMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Promote'));

    await waitFor(() =>
      expect(promoteVariantMutate).toHaveBeenCalledWith({ experimentId: 'exp_1', arm: 'A' }),
    );
  });

  it('renders the shared changed-file list with per-arm frozen diffs via DiffBody', async () => {
    getQuery.mockResolvedValue(makeExp());
    getComparisonQuery.mockResolvedValue(makePayload());
    getComparisonDiffsQuery.mockResolvedValue(makeDiffs());

    render(<ExperimentComparisonView experimentId="exp_1" />);
    expect(await screen.findByTestId('experiment-file-tab-src/a.ts')).toBeInTheDocument();
    // The diff columns render off a SEPARATE effect-driven `selectedFilePath`
    // (defaulted once `filePaths` resolves) — await it rather than asserting
    // synchronously right after the file-tab appears (avoids a real render race).
    expect(await screen.findByText(/new line A/)).toBeInTheDocument();
    expect(await screen.findByText(/new line B/)).toBeInTheDocument();
  });
});
