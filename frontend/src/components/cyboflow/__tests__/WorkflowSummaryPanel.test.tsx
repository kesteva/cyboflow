import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkflowSummaryPanel } from '../WorkflowSummaryPanel';
import type { RunUsageRollup } from '../../../../../shared/types/insights';

const runUsageQuery = vi.fn();
const relayInputMutate = vi.fn();
const showError = vi.fn();

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: { runUsage: { query: (...a: unknown[]) => runUsageQuery(...a) } },
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
};

beforeEach(() => {
  runUsageQuery.mockReset();
  runUsageQuery.mockResolvedValue(ROLLUP);
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
});
