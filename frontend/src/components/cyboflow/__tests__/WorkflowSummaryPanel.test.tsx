import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowSummaryPanel } from '../WorkflowSummaryPanel';
import type { RunUsageRollup, RunEval } from '../../../../../shared/types/insights';

const runUsageQuery = vi.fn();
const runEvalQuery = vi.fn();
const reviewItemsListQuery = vi.fn();
const relayInputMutate = vi.fn();
const showError = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: {
        runUsage: { query: (...a: unknown[]) => runUsageQuery(...a) },
        runEval: { query: (...a: unknown[]) => runEvalQuery(...a) },
      },
      reviewItems: { list: { query: (...a: unknown[]) => reviewItemsListQuery(...a) } },
      runs: { relayInput: { mutate: (...a: unknown[]) => relayInputMutate(...a) } },
    },
  },
}));

vi.mock('../../../stores/errorStore', () => ({
  useErrorStore: { getState: () => ({ showError }) },
}));

const ROLLUP: RunUsageRollup = {
  runId: 'run-1',
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
      { key: 'correctness', name: 'Correctness', weight: 0.3, score: 85, active: true, passCount: 3, failCount: 1, unknownCount: 0 },
      { key: 'security', name: 'Security', weight: 0.2, score: null, active: false, passCount: 0, failCount: 0, unknownCount: 2 },
    ],
    perSample: null,
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
  runUsageQuery.mockReset();
  runUsageQuery.mockResolvedValue(ROLLUP);
  runEvalQuery.mockReset();
  runEvalQuery.mockResolvedValue(null);
  reviewItemsListQuery.mockReset();
  reviewItemsListQuery.mockResolvedValue([]);
  relayInputMutate.mockReset();
  relayInputMutate.mockResolvedValue({ success: true });
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

  it('frames a failed run as "Workflow stopped"', async () => {
    renderPanel({ status: 'failed' });
    expect(await screen.findByText('Workflow stopped')).toBeInTheDocument();
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
  });

  it('renders the band-first hero, gates and active-dimension count when complete', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-band')).toHaveTextContent('GOOD');
    expect(screen.getByTestId('run-summary-eval-score')).toHaveTextContent('82');
    expect(screen.getByTestId('run-summary-eval-provenance')).toHaveTextContent('claude-opus-4-8');
    expect(screen.getByTestId('run-summary-eval-provenance')).toHaveTextContent('rubric v1.1');
    expect(screen.getByTestId('run-summary-eval-gate-build')).toHaveTextContent('build pass');
    expect(screen.getByTestId('run-summary-eval-gate-typecheck')).toHaveTextContent('typecheck fail');
    expect(screen.getByTestId('run-summary-eval-gate-lint')).toHaveTextContent('lint pass');
    // one active dimension of the two fixture dims.
    expect(screen.getByTestId('run-summary-eval-dims-active')).toHaveTextContent('1 / 7 dimensions active');
  });

  it('labels the score band as a sample spread, not a 95% CI', async () => {
    runEvalQuery.mockResolvedValue(makeEval());
    renderPanel();
    expect(await screen.findByTestId('run-summary-eval-ci')).toHaveTextContent('sample spread 78–86');
    expect(screen.queryByText(/95% CI/)).not.toBeInTheDocument();
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
        payload: { kind: 'finding', locations: [{ path: 'src/x.ts', line: 42 }] },
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

    expect(screen.getByTestId('run-summary-eval-dim-correctness')).toHaveTextContent('85');
    expect(screen.getByTestId('run-summary-eval-dim-security')).toHaveTextContent('inactive');
    const findings = screen.getAllByTestId('run-summary-eval-finding');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toHaveTextContent('src/x.ts:42');
    expect(findings[0]).toHaveTextContent('Null check missing');
  });
});
