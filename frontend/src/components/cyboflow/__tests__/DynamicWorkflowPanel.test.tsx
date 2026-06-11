/**
 * DynamicWorkflowPanel tests — presentational rendering of one tracked
 * dynamic-workflow snapshot (no store wiring; the prop is the contract).
 *
 * Covers: running badge + live agent tally + elapsed, the static phase plan,
 * optional description, and the terminal block (summary + totals) replacing
 * the elapsed ticker once the workflow completes/fails.
 */
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DynamicWorkflowPanel } from '../DynamicWorkflowPanel';
import type { DynamicWorkflowRunState } from '../../../../../shared/types/dynamicWorkflows';

function makeState(overrides: Partial<DynamicWorkflowRunState> = {}): DynamicWorkflowRunState {
  return {
    wfRunId: 'wf_a',
    taskId: 'w1',
    runId: 'run-1',
    sessionId: 'sess-1',
    projectId: 1,
    sessionName: 'tester-mctest',
    name: 'refactor-blitz',
    phases: [],
    agents: [],
    status: 'running',
    startedAt: '2026-06-11T10:00:00.000Z',
    ...overrides,
  };
}

describe('DynamicWorkflowPanel', () => {
  it('renders name, running status, agent tally and elapsed while running', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          agents: [
            { agentId: 'a1', status: 'running' },
            { agentId: 'a2', status: 'running' },
            { agentId: 'a3', status: 'done' },
          ],
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-name')).toHaveTextContent('refactor-blitz');
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('running');
    expect(screen.getByTestId('dynamic-workflow-agent-tally')).toHaveTextContent(
      '2 running · 1 done',
    );
    // Elapsed ticker only exists while running.
    expect(screen.getByTestId('dynamic-workflow-elapsed')).toBeInTheDocument();
    // No terminal block yet.
    expect(screen.queryByTestId('dynamic-workflow-summary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dynamic-workflow-totals')).not.toBeInTheDocument();
  });

  it('renders the static phase plan as chips and the description when present', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          description: 'Parallel refactor of the parser',
          phases: [{ title: 'Plan' }, { title: 'Execute', detail: 'fan out' }],
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-description')).toHaveTextContent(
      'Parallel refactor of the parser',
    );
    const phases = screen.getByTestId('dynamic-workflow-phases');
    expect(phases).toHaveTextContent('plan');
    expect(phases).toHaveTextContent('1 · Plan');
    expect(phases).toHaveTextContent('2 · Execute');
  });

  it('omits the phase plan and description blocks when absent', () => {
    render(<DynamicWorkflowPanel state={makeState()} />);
    expect(screen.queryByTestId('dynamic-workflow-phases')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dynamic-workflow-description')).not.toBeInTheDocument();
  });

  it('renders summary + totals (and drops elapsed) once terminal', () => {
    render(
      <DynamicWorkflowPanel
        state={makeState({
          status: 'completed',
          completedAt: '2026-06-11T10:06:36.000Z',
          summary: 'Refactored 12 files across 3 agents.',
          agents: [
            { agentId: 'a1', status: 'done' },
            { agentId: 'a2', status: 'done' },
          ],
          totals: {
            agentCount: 3,
            totalTokens: 123456,
            totalToolCalls: 42,
            durationMs: 396_000,
          },
        })}
      />,
    );
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('completed');
    expect(screen.queryByTestId('dynamic-workflow-elapsed')).not.toBeInTheDocument();
    expect(screen.getByTestId('dynamic-workflow-summary')).toHaveTextContent(
      'Refactored 12 files across 3 agents.',
    );
    expect(screen.getByTestId('dynamic-workflow-total-agents')).toHaveTextContent('3');
    expect(screen.getByTestId('dynamic-workflow-total-tokens')).toHaveTextContent(
      (123456).toLocaleString(),
    );
    expect(screen.getByTestId('dynamic-workflow-total-tools')).toHaveTextContent('42');
    expect(screen.getByTestId('dynamic-workflow-total-duration')).toHaveTextContent('6m 36s');
  });

  it('shows the failed status without fabricating totals', () => {
    render(<DynamicWorkflowPanel state={makeState({ status: 'failed' })} />);
    expect(screen.getByTestId('dynamic-workflow-status')).toHaveTextContent('failed');
    expect(screen.queryByTestId('dynamic-workflow-totals')).not.toBeInTheDocument();
  });
});
