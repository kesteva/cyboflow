/**
 * Export-smoke test: WorkflowSummaryPanel's `ScoreSummary` (A/B testing slice C
 * reuses it in ExperimentComparisonView for each arm's quality module). Confirms
 * the export exists and renders its complete/pending/failed states — the full
 * behavioral suite lives in WorkflowSummaryPanel.test.tsx via the parent panel.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScoreSummary } from '../WorkflowSummaryPanel';
import type { RunEval } from '../../../../../shared/types/insights';

function makeEval(over: Partial<RunEval> = {}): RunEval {
  return {
    runId: 'run-1',
    rubricVersion: '1.1',
    evalStatus: 'complete',
    baseSha: null,
    diffText: null,
    diffStats: null,
    gateResults: { build: true, test: true, typecheck: true, lint: 'pass' },
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
      { key: 'correctness', name: 'Correctness', weight: 100, score: 82, active: true, passCount: 3, failCount: 1, unknownCount: 0 },
    ],
    perSample: null,
    judgeModel: 'claude-opus-4-8',
    sampleCount: 3,
    promptHash: null,
    judgeBuildId: '0.1.15',
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

describe('WorkflowSummaryPanel — ScoreSummary export smoke', () => {
  it('is exported and renders the complete-state hero', () => {
    render(
      <ScoreSummary runEval={makeEval()} findings={[]} breakdownOpen={false} onToggleBreakdown={vi.fn()} />,
    );
    expect(screen.getByTestId('run-summary-eval')).toBeInTheDocument();
    expect(screen.getByTestId('run-summary-eval-band')).toHaveTextContent(/good/i);
  });

  it('renders the pending state', () => {
    render(
      <ScoreSummary
        runEval={makeEval({ evalStatus: 'pending', overallScore: null, band: null })}
        findings={[]}
        breakdownOpen={false}
        onToggleBreakdown={vi.fn()}
      />,
    );
    expect(screen.getByTestId('run-summary-eval-progress')).toBeInTheDocument();
  });

  it('renders the GATED sentinel when the eval is gated', () => {
    render(
      <ScoreSummary
        runEval={makeEval({ gated: true, overallScore: null, band: null })}
        findings={[]}
        breakdownOpen={false}
        onToggleBreakdown={vi.fn()}
      />,
    );
    expect(screen.getByTestId('run-summary-eval-gated')).toBeInTheDocument();
  });
});
