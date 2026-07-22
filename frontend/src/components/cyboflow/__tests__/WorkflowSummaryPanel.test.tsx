import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ScoreSummary, WorkflowSummaryPanel } from '../WorkflowSummaryPanel';
import type { RunUsageRollup, RunEval } from '../../../../../shared/types/insights';
import { useConfigStore } from '../../../stores/configStore';
import type { AppConfig } from '../../../types/config';

const runUsageQuery = vi.fn();
const runEvalQuery = vi.fn();
const reviewItemsListQuery = vi.fn();
const relayInputMutate = vi.fn();
const restartMutate = vi.fn();
const retryStepMutate = vi.fn();
const retryEvalMutate = vi.fn();
const showError = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: {
        runUsage: { query: (...a: unknown[]) => runUsageQuery(...a) },
        runEval: { query: (...a: unknown[]) => runEvalQuery(...a) },
      },
      reviewItems: { list: { query: (...a: unknown[]) => reviewItemsListQuery(...a) } },
      runs: {
        relayInput: { mutate: (...a: unknown[]) => relayInputMutate(...a) },
        restart: { mutate: (...a: unknown[]) => restartMutate(...a) },
        retryStep: { mutate: (...a: unknown[]) => retryStepMutate(...a) },
        retryEval: { mutate: (...a: unknown[]) => retryEvalMutate(...a) },
      },
    },
  },
}));

vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: { getState: () => ({ showError }) },
}));

const ROLLUP: RunUsageRollup = {
  runId: 'run-1',
  model: 'claude-opus-4-5',
  multiModel: false,
  perModelUsage: [
    {
      model: 'claude-opus-4-5',
      inputTokens: 13000,
      outputTokens: 3000,
      cacheCreationTokens: 640000,
      cacheReadTokens: 7674110,
    },
  ],
  inputTokens: 13000,
  outputTokens: 3000,
  cacheCreationTokens: 640000,
  cacheReadTokens: 7674110,
  totalTokens: 16000,
  costUsd: 3.95,
  numTurns: 173,
  assistantMessageCount: 173,
  startedAt: null,
  endedAt: null,
};

/** A complete eval fixture; override per-test. */
function makeEval(over: Partial<RunEval> = {}): RunEval {
  return {
    runId: 'run-1',
    rubricVersion: '1.1',
    evalStatus: 'complete',
    baseSha: null,
    diffText: null,
    diffStats: null,
    gateResults: { build: true, test: true, typecheck: false, lint: 'pass' },
    humanInfluenced: false,
    snapshotAt: '2026-07-01T00:00:00.000Z',
    overallScore: 82,
    band: 'Good',
    ciLow: 78,
    ciHigh: 86,
    gated: false,
    securityFlag: false,
    requirementsUnmet: false,
    capTriggers: null,
    dimensions: [
      { key: 'correctness', name: 'Correctness', weight: 30, score: 85, active: true, passCount: 3, failCount: 1, unknownCount: 0 },
      { key: 'security', name: 'Security', weight: 20, score: null, active: false, passCount: 0, failCount: 0, unknownCount: 2 },
    ],
    perSample: null,
    jury: null,
    judgeModel: 'claude-opus-4-8',
    sampleCount: 3,
    promptHash: null,
    judgeBuildId: '0.1.11',
    workflowId: 'wf-1',
    workflowName: 'sprint',
    specHash: null,
    runModel: null,
    subagentModels: null,
    difficultyProxyPrerun: null,
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  useConfigStore.setState({ config: null, isLoading: false, error: null });
  runUsageQuery.mockReset();
  runUsageQuery.mockResolvedValue(ROLLUP);
  runEvalQuery.mockReset();
  runEvalQuery.mockResolvedValue(null);
  reviewItemsListQuery.mockReset();
  reviewItemsListQuery.mockResolvedValue([]);
  relayInputMutate.mockReset();
  relayInputMutate.mockResolvedValue({ success: true });
  restartMutate.mockReset();
  restartMutate.mockResolvedValue({ runId: 'run-2', worktreePath: '/w', branchName: 'b' });
  retryStepMutate.mockReset();
  retryStepMutate.mockResolvedValue({ delivered: true, stepId: 'step-1' });
  retryEvalMutate.mockReset();
  retryEvalMutate.mockResolvedValue(undefined);
  showError.mockReset();
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

describe('WorkflowSummaryPanel', () => {
  it('renders the four token categories and the grand total from the rollup', async () => {
    renderPanel();
    expect(await screen.findByTestId('run-summary-categories')).toBeInTheDocument();
    expect(screen.getByTestId('run-summary-cat-input')).toHaveTextContent('13k');
    expect(screen.getByTestId('run-summary-cat-output')).toHaveTextContent('3k');
    expect(screen.getByTestId('run-summary-cat-cache-write')).toHaveTextContent('640k');
    expect(screen.getByTestId('run-summary-cat-cache-read')).toHaveTextContent('7.7m');
    // total = sum of ALL four buckets (input+output+cache), not totalTokens.
    expect(screen.getByTestId('run-summary-total')).toHaveTextContent('8.3m');
    expect(screen.getByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.getByTestId('run-summary-meta')).toHaveTextContent('173 turns');
  });

  it('shows the provider-reported cost when computed cost is explicitly off', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: false } as AppConfig,
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
  });

  it('shows the provider-reported cost when computed cost is unset by default', async () => {
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
  });

  it('computes a single-model run cost from its token breakdown when enabled', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $7.98');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
  });

  it('falls back to reported cost with a note when EVERY model in a multi-model breakdown is unpriced', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    // All-unknown breakdown — nothing sensible to sum, so this must behave
    // exactly like the pre-TASK-092 "mixed models" fallback.
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      model: null,
      multiModel: true,
      perModelUsage: [
        { model: 'unknown-model-a', inputTokens: 13000, outputTokens: 3000, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { model: 'unknown-model-b', inputTokens: 5000, outputTokens: 1000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.getByTestId('run-summary-mixed-model-cost-note')).toHaveTextContent(
      'mixed models — showing reported cost',
    );
    expect(screen.queryByTestId('run-summary-partial-model-cost-note')).not.toBeInTheDocument();
  });

  it('sums the rate-card cost per model for a multi-model run with 2+ known models', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      model: null,
      multiModel: true,
      costUsd: 3.95, // must NOT be what renders — proves the sum wins over the reported total.
      perModelUsage: [
        // opus: 1,000,000 * $5/MTok + 100,000 * $25/MTok = $5 + $2.5 = $7.50
        { model: 'claude-opus-4-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
        // sonnet: 2,000,000 * $3/MTok + 200,000 * $15/MTok = $6 + $3 = $9.00
        { model: 'claude-sonnet-4-5', inputTokens: 2_000_000, outputTokens: 200_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $16.50');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-partial-model-cost-note')).not.toBeInTheDocument();
  });

  it('sums only the priced models and flags a PARTIAL estimate when one model in the breakdown is unpriced', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      model: null,
      multiModel: true,
      perModelUsage: [
        // opus: $7.50 (as above) — priced, included.
        { model: 'claude-opus-4-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
        // unpriced model — excluded from the sum (contributes $0), not silently
        // folded into it, but the run's cost is not corrupted by it either.
        { model: 'some-unpriced-model', inputTokens: 5_000_000, outputTokens: 500_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $7.50');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-summary-partial-model-cost-note')).toHaveTextContent(
      'partial estimate — includes 1 unpriced model',
    );
  });

  it('leaves the toggle-OFF behavior unchanged for a multi-model run (verbatim reported cost, no note)', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: false } as AppConfig,
    });
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      model: null,
      multiModel: true,
      perModelUsage: [
        { model: 'claude-opus-4-5', inputTokens: 1_000_000, outputTokens: 100_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
        { model: 'claude-sonnet-4-5', inputTokens: 2_000_000, outputTokens: 200_000, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-partial-model-cost-note')).not.toBeInTheDocument();
  });

  it('falls back to reported cost when the model is unresolved (pruned raw_events), without the mixed note', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    // A materialized run whose raw_events were pruned: model null but NOT
    // multiModel. The durable reported cost must win over an em dash.
    runUsageQuery.mockResolvedValue({ ...ROLLUP, model: null, multiModel: false });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost $3.95');
    expect(screen.queryByTestId('run-summary-mixed-model-cost-note')).not.toBeInTheDocument();
  });

  it('shows an em dash when an enabled single-model recompute has unknown pricing', async () => {
    useConfigStore.setState({
      config: { computeCostFromRates: true } as AppConfig,
    });
    runUsageQuery.mockResolvedValue({ ...ROLLUP, model: 'unknown-model' });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('cost —');
  });

  it('fires onComplete when the primary CTA is clicked', async () => {
    const onComplete = vi.fn();
    renderPanel({ onComplete });
    fireEvent.click(await screen.findByTestId('run-summary-complete'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('hides "Request changes" for an SDK run (no live agent to continue)', async () => {
    renderPanel({ substrate: 'sdk' });
    await screen.findByTestId('run-summary-complete');
    expect(screen.queryByTestId('run-summary-request-changes')).not.toBeInTheDocument();
  });

  it('shows "Request changes" for an interactive run and relays feedback to the live agent', async () => {
    renderPanel({ substrate: 'interactive' });
    fireEvent.click(await screen.findByTestId('run-summary-request-changes'));

    const textarea = screen.getByTestId('run-summary-change-text');
    fireEvent.change(textarea, { target: { value: 'tighten the error copy' } });
    fireEvent.click(screen.getByTestId('run-summary-change-send'));

    // Two-step relay: the text, then the Enter keystroke.
    await waitFor(() => expect(relayInputMutate).toHaveBeenCalledTimes(2));
    expect(relayInputMutate).toHaveBeenNthCalledWith(1, { runId: 'run-1', text: 'tighten the error copy' });
    expect(relayInputMutate).toHaveBeenNthCalledWith(2, { runId: 'run-1', text: '\r' });
    expect(await screen.findByTestId('run-summary-sent')).toBeInTheDocument();
  });

  it('does not relay an empty change request', async () => {
    renderPanel({ substrate: 'interactive' });
    fireEvent.click(await screen.findByTestId('run-summary-request-changes'));
    // Send is disabled with empty text; clicking is a no-op.
    fireEvent.click(screen.getByTestId('run-summary-change-send'));
    expect(relayInputMutate).not.toHaveBeenCalled();
  });

  // ---- Three header states (one panel) --------------------------------------

  it('titles the complete state "Workflow complete" with the Complete CTA', async () => {
    renderPanel({ variant: 'complete' });
    expect(await screen.findByTestId('run-summary-title')).toHaveTextContent('Workflow complete');
    expect(screen.getByTestId('run-summary-complete')).toBeInTheDocument();
  });

  it('titles the failed state "Workflow failed" and surfaces the error reason', async () => {
    renderPanel({ variant: 'failed', errorMessage: "You've hit your limit · resets 7:10pm" });
    expect(await screen.findByTestId('run-summary-title')).toHaveTextContent('Workflow failed');
    expect(screen.getByTestId('run-summary-error')).toHaveTextContent("You've hit your limit · resets 7:10pm");
    // The happy-path Complete primary is NOT the lead action on a failed run.
    expect(screen.queryByTestId('run-summary-complete')).not.toBeInTheDocument();
  });

  it('degrades gracefully when a failed run has no error reason', async () => {
    renderPanel({ variant: 'failed', errorMessage: null });
    expect(await screen.findByTestId('run-summary-error')).toHaveTextContent('The run ended on an error');
  });

  it('titles the review state "Ready for review" with a hint and no action CTAs', async () => {
    renderPanel({ variant: 'review', status: 'running' });
    expect(await screen.findByTestId('run-summary-title')).toHaveTextContent('Ready for review');
    expect(screen.getByTestId('run-summary-review-hint')).toBeInTheDocument();
    // No Complete / Restart primary — the decision is the pending question below.
    expect(screen.queryByTestId('run-summary-complete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-restart')).not.toBeInTheDocument();
    // Token usage still renders (it is input to the review decision).
    expect(await screen.findByTestId('run-summary-categories')).toBeInTheDocument();
  });

  // ---- Restart flow (failed state) ------------------------------------------

  it('restarts a failed run via runs.restart and hands the new run id to onRestarted', async () => {
    const onRestarted = vi.fn();
    renderPanel({ variant: 'failed', onRestarted });
    fireEvent.click(await screen.findByTestId('run-summary-restart'));
    await waitFor(() => expect(restartMutate).toHaveBeenCalledWith({ runId: 'run-1' }));
    await waitFor(() => expect(onRestarted).toHaveBeenCalledWith('run-2'));
  });

  it('surfaces a no-op restart as an error and does not swap the run', async () => {
    restartMutate.mockResolvedValue({ noOp: true, reason: 'not_failed' });
    const onRestarted = vi.fn();
    renderPanel({ variant: 'failed', onRestarted });
    fireEvent.click(await screen.findByTestId('run-summary-restart'));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    expect(onRestarted).not.toHaveBeenCalled();
  });

  it('omits the Restart CTA when no onRestarted handler is provided', async () => {
    renderPanel({ variant: 'failed' });
    // Close out is always available; Restart requires the swap handler.
    expect(await screen.findByTestId('run-summary-close-out')).toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-restart')).not.toBeInTheDocument();
  });

  // ---- Retry failed step (failed + programmatic state only) -----------------

  it('shows the Retry-failed-step CTA for a failed programmatic run', async () => {
    renderPanel({ variant: 'failed', executionModel: 'programmatic' });
    expect(await screen.findByTestId('run-summary-retry-step')).toBeInTheDocument();
  });

  it('hides the Retry-failed-step CTA for an orchestrated run', async () => {
    renderPanel({ variant: 'failed', executionModel: 'orchestrated' });
    await screen.findByTestId('run-summary-failed-ctas');
    expect(screen.queryByTestId('run-summary-retry-step')).not.toBeInTheDocument();
  });

  it('hides the Retry-failed-step CTA when executionModel is not provided', async () => {
    renderPanel({ variant: 'failed' });
    await screen.findByTestId('run-summary-failed-ctas');
    expect(screen.queryByTestId('run-summary-retry-step')).not.toBeInTheDocument();
  });

  it('calls runs.retryStep with the runId when the Retry CTA is clicked', async () => {
    renderPanel({ variant: 'failed', executionModel: 'programmatic' });
    fireEvent.click(await screen.findByTestId('run-summary-retry-step'));
    await waitFor(() => expect(retryStepMutate).toHaveBeenCalledWith({ runId: 'run-1' }));
    expect(showError).not.toHaveBeenCalled();
  });

  it('surfaces a no-op retry as an error', async () => {
    retryStepMutate.mockResolvedValue({ noOp: true, reason: 'not_retryable' });
    renderPanel({ variant: 'failed', executionModel: 'programmatic' });
    fireEvent.click(await screen.findByTestId('run-summary-retry-step'));
    await waitFor(() => expect(showError).toHaveBeenCalled());
  });

  it('shows a no-usage note when the run recorded zero tokens', async () => {
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-no-usage')).toBeInTheDocument();
  });

  it('appends runtime to the meta line from the rollup timestamps', async () => {
    runUsageQuery.mockResolvedValue({
      ...ROLLUP,
      startedAt: '2026-07-01T00:00:00.000Z',
      endedAt: '2026-07-01T00:02:05.000Z',
    });
    renderPanel();
    expect(await screen.findByTestId('run-summary-meta')).toHaveTextContent('runtime 2m 5s');
  });

  it('renders no Score-summary section when there is no eval row', async () => {
    runEvalQuery.mockResolvedValue(null);
    renderPanel();
    await screen.findByTestId('run-summary-categories');
    expect(screen.queryByTestId('run-summary-eval')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-eval-advisory')).not.toBeInTheDocument();
  });

  it('shows a running line while the eval is pending/running', async () => {
    runEvalQuery.mockResolvedValue(makeEval({ evalStatus: 'running', band: null, overallScore: null }));
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-progress')).toHaveTextContent('running');
    expect(screen.getByTestId('run-summary-eval-advisory')).toBeInTheDocument();
  });

  it('shows an unavailable line when the eval failed', async () => {
    runEvalQuery.mockResolvedValue(makeEval({ evalStatus: 'failed', band: null, overallScore: null, error: 'boom' }));
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-failed')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('run-summary-eval-retry')).toHaveTextContent('Retry quality assessment');
  });

  it('hides the eval retry button when ScoreSummary has no owning run', () => {
    render(
      <ScoreSummary
        runEval={makeEval({ evalStatus: 'failed', band: null, overallScore: null })}
        findings={[]}
        breakdownOpen={false}
        onToggleBreakdown={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('run-summary-eval-retry')).not.toBeInTheDocument();
  });

  it.each(['pending', 'running', 'complete'] as const)(
    'hides the eval retry button when the eval status is %s',
    (evalStatus) => {
      render(
        <ScoreSummary
          runId="run-1"
          runEval={makeEval({
            evalStatus,
            ...(evalStatus === 'complete' ? {} : { band: null, overallScore: null }),
          })}
          findings={[]}
          breakdownOpen={false}
          onToggleBreakdown={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('run-summary-eval-retry')).not.toBeInTheDocument();
    },
  );

  it('latches the retry button and resumes eval polling through a terminal status', async () => {
    let resolveRetry: (() => void) | undefined;
    let resolveResumedPoll: ((value: RunEval) => void) | undefined;
    const retryPromise = new Promise<void>((resolve) => {
      resolveRetry = resolve;
    });
    const resumedPollPromise = new Promise<RunEval>((resolve) => {
      resolveResumedPoll = resolve;
    });
    runEvalQuery
      .mockResolvedValueOnce(makeEval({ evalStatus: 'failed', band: null, overallScore: null, error: 'boom' }))
      .mockReturnValueOnce(resumedPollPromise);
    retryEvalMutate.mockReturnValue(retryPromise);
    renderPanel();

    const retryButton = await screen.findByTestId('run-summary-eval-retry');
    fireEvent.click(retryButton);
    expect(retryButton).toBeDisabled();
    expect(retryButton).toHaveTextContent('Retrying…');
    fireEvent.click(retryButton);
    expect(retryEvalMutate).toHaveBeenCalledTimes(1);
    expect(retryEvalMutate).toHaveBeenCalledWith({ runId: 'run-1' });

    await act(async () => {
      resolveRetry?.();
      await retryPromise;
    });
    expect(await screen.findByTestId('run-summary-eval-progress')).toHaveTextContent('running');
    await waitFor(() => expect(runEvalQuery).toHaveBeenCalledTimes(2));
    expect(runEvalQuery).toHaveBeenNthCalledWith(2, { runId: 'run-1' });

    await act(async () => {
      resolveResumedPoll?.(makeEval());
      await resumedPollPromise;
    });
    expect(await screen.findByTestId('run-summary-eval-band')).toHaveTextContent('GOOD');
  });

  it('re-enables the retry button when the retried eval fails again', async () => {
    const failedEval = makeEval({ evalStatus: 'failed', band: null, overallScore: null, error: 'boom' });
    // First poll: failed → retry → resumed poll returns failed AGAIN.
    runEvalQuery
      .mockResolvedValueOnce(failedEval)
      .mockResolvedValueOnce(makeEval({ evalStatus: 'failed', band: null, overallScore: null, error: 'boom again' }));
    retryEvalMutate.mockResolvedValue(undefined);
    renderPanel();

    fireEvent.click(await screen.findByTestId('run-summary-eval-retry'));
    await waitFor(() => expect(retryEvalMutate).toHaveBeenCalledTimes(1));
    // The resumed poll lands the second failure; the latch must have been
    // released by the intermediate pending transition, so the button is
    // enabled and can submit a second retry.
    await waitFor(() => expect(runEvalQuery).toHaveBeenCalledTimes(2));
    const retryButton = await screen.findByTestId('run-summary-eval-retry');
    await waitFor(() => expect(retryButton).toBeEnabled());
    expect(retryButton).toHaveTextContent('Retry quality assessment');
    fireEvent.click(retryButton);
    await waitFor(() => expect(retryEvalMutate).toHaveBeenCalledTimes(2));
  });

  it('renders the band-first hero, gates and active-dimension count when complete', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-band')).toHaveTextContent('GOOD');
    expect(screen.getByTestId('run-summary-eval-score')).toHaveTextContent('82');
    expect(screen.getByTestId('run-summary-eval-provenance')).toHaveTextContent('claude-opus-4-8');
    // The rubric version lives in the module eyebrow, not the provenance block.
    expect(screen.getByTestId('run-summary-eval-eyebrow')).toHaveTextContent('rubric v1.1');
    // Gate chips carry the label; pass/fail is conveyed via data-gate-status (+ dot color).
    expect(screen.getByTestId('run-summary-eval-gate-build')).toHaveTextContent('build');
    expect(screen.getByTestId('run-summary-eval-gate-build')).toHaveAttribute('data-gate-status', 'pass');
    expect(screen.getByTestId('run-summary-eval-gate-typecheck')).toHaveAttribute('data-gate-status', 'fail');
    expect(screen.getByTestId('run-summary-eval-gate-lint')).toHaveAttribute('data-gate-status', 'pass');
    // one active dimension of the two fixture dims.
    expect(screen.getByTestId('run-summary-eval-dims-active')).toHaveTextContent('1 / 7 dimensions active');
  });

  it('renders heterogeneous jury composition and warns when Codex was unavailable', async () => {
    runEvalQuery.mockResolvedValue(makeEval({
      sampleCount: 2,
      jury: [
        { slot: 'claude-1', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 0 },
        { slot: 'claude-2', provider: 'claude', model: 'claude-opus-4-8', status: 'ok', sampleIndex: 1 },
        { slot: 'codex-1', provider: 'codex', model: null, status: 'unavailable', errorCode: 'logged-out' },
      ],
    }));
    renderPanel();

    expect(await screen.findByText(/Opus ×2 \+ Codex/)).toBeInTheDocument();
    expect(screen.getByTestId('run-summary-eval-codex-unavailable')).toHaveTextContent(
      'Codex juror unavailable — scored on Claude only',
    );
    expect(screen.queryByText(/single-family v1/)).not.toBeInTheDocument();
  });

  it('shows a PASSED deterministic-gate sentinel chip for a non-gated eval', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-gate-summary')).toHaveTextContent('Deterministic gate: PASSED');
  });

  it('labels the score band as a sample spread, not a 95% CI', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    renderPanel();
    const ci = await screen.findByTestId('run-summary-eval-ci');
    expect(ci).toHaveTextContent(/sample spread/i);
    // The spread bounds and the score-in-a-range explanatory note are both present.
    expect(ci).toHaveTextContent('78');
    expect(ci).toHaveTextContent('86');
    expect(ci).toHaveTextContent('82 sits inside a plausible 78–86');
    expect(screen.queryByText(/95% CI/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence interval/i)).not.toBeInTheDocument();
  });

  it('surfaces cap provenance so a capped 69 is distinguishable from an organic Fair', async () => {
    runEvalQuery.mockResolvedValue(
      makeEval({ overallScore: 69, band: 'Fair', capTriggers: ['SCP-1', 'security'], requirementsUnmet: true }),
    );
    renderPanel();
    const capped = await screen.findByTestId('run-summary-eval-capped');
    expect(capped).toHaveTextContent('SCP-1');
    expect(capped).toHaveTextContent('security');
  });

  it('shows the GATED sentinel instead of a numeric hero when gated', async () => {
    runEvalQuery.mockResolvedValue(makeEval({ gated: true }));
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-gated')).toHaveTextContent('GATED');
    expect(screen.queryByTestId('run-summary-eval-band')).not.toBeInTheDocument();
    // The header sentinel chip flips to GATED too.
    expect(screen.getByTestId('run-summary-eval-gate-summary')).toHaveTextContent('Deterministic gate: GATED');
  });

  it('expands the breakdown to dimension rows and eval-authored findings', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    reviewItemsListQuery.mockResolvedValue([
      {
        id: 'ri-1',
        project_id: 7,
        run_id: 'run-1',
        entity_type: null,
        entity_id: null,
        kind: 'finding',
        status: 'pending',
        blocking: false,
        title: 'Null check missing',
        body: null,
        severity: 'warning',
        priority: null,
        staged_at: null,
        selected: false,
        source: 'agent:eval',
        payload: { kind: 'finding', category: 'Robustness', locations: [{ path: 'src/x.ts', line: 42 }] },
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        resolved_by: null,
        resolution: null,
      },
      // A non-eval finding is filtered out of the eval drill-down.
      {
        id: 'ri-2',
        project_id: 7,
        run_id: 'run-1',
        entity_type: null,
        entity_id: null,
        kind: 'finding',
        status: 'pending',
        blocking: false,
        title: 'Sprint agent note',
        body: null,
        severity: 'info',
        priority: null,
        staged_at: null,
        selected: false,
        source: 'agent:executor',
        payload: { kind: 'finding' },
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        resolved_by: null,
        resolution: null,
      },
    ]);
    renderPanel({ projectId: 7 });

    const toggle = await screen.findByTestId('run-summary-eval-toggle');
    await waitFor(() => expect(toggle).toHaveTextContent('1 finding'));
    fireEvent.click(toggle);

    const correctness = screen.getByTestId('run-summary-eval-dim-correctness');
    expect(correctness).toHaveTextContent('85');
    // weight column (0-100 scale) and derived band word render alongside the score.
    expect(correctness).toHaveTextContent('30%');
    expect(correctness).toHaveTextContent('Good');
    expect(screen.getByTestId('run-summary-eval-dim-security')).toHaveTextContent('inactive');
    // the inactive label explains the thin-evidence rule on hover.
    expect(screen.getByTestId('run-summary-eval-dim-security-inactive')).toHaveAttribute(
      'title',
      expect.stringContaining('excluded from the overall score'),
    );
    const findings = screen.getAllByTestId('run-summary-eval-finding');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toHaveTextContent('src/x.ts:42');
    expect(findings[0]).toHaveTextContent('Null check missing');
    // warning severity surfaces as the GUIDELINE chip label; category is the tag.
    expect(findings[0]).toHaveTextContent('GUIDELINE');
    expect(findings[0]).toHaveTextContent('Robustness');
  });
});

describe('WorkflowSummaryPanel — dismiss / continue-in-chat controls', () => {
  it('renders "Back to run" and fires onDismiss (complete variant)', async () => {
    const onDismiss = vi.fn();
    renderPanel({ variant: 'complete', onDismiss });
    fireEvent.click(await screen.findByTestId('run-summary-dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders "Continue in chat" and fires onContinueInChat', async () => {
    const onContinueInChat = vi.fn();
    renderPanel({ variant: 'complete', onContinueInChat });
    fireEvent.click(await screen.findByTestId('run-summary-continue-in-chat'));
    expect(onContinueInChat).toHaveBeenCalledTimes(1);
  });

  it('offers the controls in the failed variant too', async () => {
    renderPanel({ variant: 'failed', onDismiss: vi.fn(), onContinueInChat: vi.fn() });
    expect(await screen.findByTestId('run-summary-dismiss')).toBeInTheDocument();
    expect(screen.getByTestId('run-summary-continue-in-chat')).toBeInTheDocument();
  });

  it('never offers dismiss in the review variant (a live decision gate)', async () => {
    // Even if a caller wrongly wired onDismiss, the review state must not hide itself.
    renderPanel({ variant: 'review', onDismiss: vi.fn(), onContinueInChat: vi.fn() });
    await screen.findByTestId('run-summary-total');
    expect(screen.queryByTestId('run-summary-dismiss')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-continue-in-chat')).not.toBeInTheDocument();
  });

  it('omits the controls when the caller wires no handlers', async () => {
    renderPanel({ variant: 'complete' });
    await screen.findByTestId('run-summary-complete');
    expect(screen.queryByTestId('run-summary-dismiss')).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-summary-continue-in-chat')).not.toBeInTheDocument();
  });
});
