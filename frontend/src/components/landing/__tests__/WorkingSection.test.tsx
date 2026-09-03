/**
 * WorkingSection — the one-line progress gutter. Covers what each source shows
 * there (flow run: phase bars + current step; dynamic workflow: agent pips +
 * counts), the fan-out overflow cap, and the "Running" pill fallback every row
 * degrades to when there is no honest progress to draw.
 */
import '@testing-library/jest-dom';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';
import type { WorkflowDefinition } from '../../../../../shared/types/workflows';
import type {
  DynamicWorkflowAgent,
  DynamicWorkflowRunState,
} from '../../../../../shared/types/dynamicWorkflows';
import type { ActiveRunRow } from '../../../stores/activeRunsStore';

const { phaseStateMock } = vi.hoisted(() => ({
  phaseStateMock: vi.fn(() => ({
    definition: null as WorkflowDefinition | null,
    currentStepId: null as string | null,
    stepStates: [],
    isLoading: false,
    error: null,
  })),
}));

vi.mock('../../../hooks/useWorkflowPhaseState', () => ({
  useWorkflowPhaseState: phaseStateMock,
}));

import { WorkingSection, type WorkingRow } from '../WorkingSection';

const NOW = Date.parse('2026-07-06T01:00:00.000Z');

const DEFINITION: WorkflowDefinition = {
  id: 'sprint',
  phases: [
    {
      id: 'plan',
      label: 'Plan',
      color: '#3b6dd6',
      steps: [{ id: 'seed', name: 'seed-tasks', agent: 'planner', mcps: [], retries: 0 }],
    },
    {
      id: 'execute',
      label: 'Execute',
      color: '#c96442',
      steps: [{ id: 'code-review', name: 'code-review', agent: 'reviewer', mcps: [], retries: 0 }],
    },
    {
      id: 'verify',
      label: 'Verify',
      color: '#a87a2c',
      steps: [{ id: 'gate', name: 'final-gate', agent: 'human', mcps: [], retries: 0 }],
    },
  ],
};

function runRow(overrides: Partial<ActiveRunRow> = {}): ActiveRunRow {
  return {
    id: 'run-1',
    project_id: 1,
    status: 'running',
    workflowName: 'Sprint',
    branch_name: 'crisp-plateau-20260903',
    started_at: '2026-07-06T00:45:28.000Z',
    updated_at: '2026-07-06T00:45:28.000Z',
    ...overrides,
  } as ActiveRunRow;
}

function agent(id: string, status: DynamicWorkflowAgent['status']): DynamicWorkflowAgent {
  return { agentId: id, status };
}

function workflow(overrides: Partial<DynamicWorkflowRunState> = {}): DynamicWorkflowRunState {
  return {
    wfRunId: 'wf_1',
    runId: 'quick-run-1',
    sessionId: 'sess-a',
    sessionName: 'curious-hawk',
    projectId: 1,
    name: 'onboarding-restructure-impl',
    description: 'Implement the onboarding restructure',
    status: 'running',
    phases: [],
    agents: [agent('a1', 'done'), agent('a2', 'running'), agent('a3', 'running')],
    startedAt: '2026-07-06T00:38:00.000Z',
    ...overrides,
  } as DynamicWorkflowRunState;
}

function quickRow(overrides: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: 'sess-q',
    name: 'wild-stone-20260903',
    projectId: 1,
    runId: 'quick-run-2',
    state: 'running',
    idleSince: null,
    unviewed: false,
    restedAtIso: null,
    rawStatus: 'running',
    exitCode: null,
    summary: 'Reworking the notifications band',
    summaryState: null,
    waitingOn: null,
    summarySupported: true,
    worktreeName: null,
    git: null,
    ...overrides,
  };
}

const baseProps = {
  rows: [] as WorkingRow[],
  nowMs: NOW,
  showWhenEmpty: false,
  onOpenQuickSession: vi.fn(),
  onOpenRun: vi.fn(),
  onOpenDynamicWorkflow: vi.fn(),
};

beforeEach(() => {
  phaseStateMock.mockReturnValue({
    definition: null,
    currentStepId: null,
    stepStates: [],
    isLoading: false,
    error: null,
  });
});

describe('WorkingSection', () => {
  it('renders nothing when empty and showWhenEmpty is false', () => {
    const { container } = render(<WorkingSection {...baseProps} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a flow run as phase bars plus its current step, not the Running pill', () => {
    phaseStateMock.mockReturnValue({
      definition: DEFINITION,
      currentStepId: 'code-review',
      stepStates: [],
      isLoading: false,
      error: null,
    });
    const run = runRow();
    render(<WorkingSection {...baseProps} rows={[{ kind: 'run', id: run.id, run }]} />);

    const row = screen.getByTestId('rq-working-row');
    expect(within(row).getByLabelText('Phase plan: Plan → Execute → Verify')).toBeInTheDocument();
    expect(within(row).getByText('code-review')).toBeInTheDocument();
    expect(within(row).getByText('14m 32s')).toBeInTheDocument();
    expect(within(row).queryByText('Running')).not.toBeInTheDocument();
  });

  it('falls back to the Running pill when the run definition has not resolved', () => {
    const run = runRow();
    render(<WorkingSection {...baseProps} rows={[{ kind: 'run', id: run.id, run }]} />);

    const row = screen.getByTestId('rq-working-row');
    expect(within(row).getByText('Running')).toBeInTheDocument();
    expect(within(row).queryByLabelText(/Phase plan/)).not.toBeInTheDocument();
  });

  it('shows a dynamic workflow as one pip per subagent plus the live tally', () => {
    const wf = workflow();
    render(<WorkingSection {...baseProps} rows={[{ kind: 'dynamic', id: wf.wfRunId, workflow: wf }]} />);

    const row = screen.getByTestId('rq-working-row');
    expect(within(row).getByText('2')).toBeInTheDocument();
    expect(within(row).getByText(/running · 1 done/)).toBeInTheDocument();
    expect(within(row).getByText('22m 0s')).toBeInTheDocument();
    expect(within(row).queryByText('Running')).not.toBeInTheDocument();
  });

  it('collapses a wide fan-out past the pip cap', () => {
    const agents = Array.from({ length: 18 }, (_, i) => agent(`a${i}`, i < 17 ? 'done' : 'running'));
    const wf = workflow({ agents });
    render(<WorkingSection {...baseProps} rows={[{ kind: 'dynamic', id: wf.wfRunId, workflow: wf }]} />);

    const row = screen.getByTestId('rq-working-row');
    expect(within(row).getByText('+6')).toBeInTheDocument();
    expect(within(row).getByText(/running · 17 done/)).toBeInTheDocument();
  });

  it('falls back to the Running pill for a workflow whose journal has no lines yet', () => {
    const wf = workflow({ agents: [] });
    render(<WorkingSection {...baseProps} rows={[{ kind: 'dynamic', id: wf.wfRunId, workflow: wf }]} />);
    expect(within(screen.getByTestId('rq-working-row')).getByText('Running')).toBeInTheDocument();
  });

  it('leaves a quick session on the Running pill and opens it on click', async () => {
    const user = userEvent.setup();
    const onOpenQuickSession = vi.fn();
    const row = quickRow();
    render(
      <WorkingSection
        {...baseProps}
        rows={[{ kind: 'quick', id: row.sessionId, row }]}
        onOpenQuickSession={onOpenQuickSession}
      />,
    );

    const rendered = screen.getByTestId('rq-working-row');
    expect(within(rendered).getByText('Running')).toBeInTheDocument();
    expect(within(rendered).getByText('Reworking the notifications band')).toBeInTheDocument();
    await user.click(rendered);
    expect(onOpenQuickSession).toHaveBeenCalledWith(row);
  });
});
