/**
 * ProposalCard tests (S1.3).
 *
 * `useAgentThreadStore` is mocked (selector-applying stub, mirrors
 * AgentThreadView.test.tsx) so confirmProposal/dismissProposal are pure spies
 * — the store's own reconciliation logic (refreshProposals after the mutate
 * call) is covered by agentThreadStore.test.ts, not here. This file instead
 * simulates that reconciliation the way the REAL parent (ProposalCardList,
 * driven by the store's `proposals` array) would: by re-rendering with a new
 * `proposal` prop reflecting the server's post-mutation truth.
 *
 * Navigation (open-session Confirm) uses the REAL proposalNavigation module
 * against the REAL cyboflowStore/navigationStore, with only
 * setActiveRun/setActiveQuickSession stubbed out (they open a run-event IPC
 * subscription jsdom lacks) — mirrors ReviewItemCard.test.tsx's
 * "Review ideas navigates" precedent, so `setActiveQuickSession` being used
 * for quick sessions (never `setActiveRun`) is asserted against the real
 * store dispatch, not a mocked pass-through.
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AgentProposal,
  LaunchRunProposalPayload,
  ReprioritizeBacklogProposalPayload,
  EditWorkflowProposalPayload,
  OpenSessionProposalPayload,
  AgentProposalStatus,
} from '../../../../shared/types/agentThread';

// ---------------------------------------------------------------------------
// agentThreadStore stub — confirmProposal/dismissProposal spies only.
// ---------------------------------------------------------------------------

const mockConfirmProposal = vi.fn();
const mockDismissProposal = vi.fn();

interface FakeAgentThreadActions {
  confirmProposal: typeof mockConfirmProposal;
  dismissProposal: typeof mockDismissProposal;
}

vi.mock('../../stores/agentThreadStore', () => ({
  useAgentThreadStore: (selector: (s: FakeAgentThreadActions) => unknown) =>
    selector({ confirmProposal: mockConfirmProposal, dismissProposal: mockDismissProposal }),
}));

import { ProposalCard } from './ProposalCard';
import { useCyboflowStore } from '../../stores/cyboflowStore';
import { useNavigationStore } from '../../stores/navigationStore';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function baseProposal(overrides: Partial<AgentProposal> & { id?: string } = {}): AgentProposal {
  return {
    id: 'p1',
    threadId: 'thread-1',
    kind: 'open-session',
    payload: { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
    preconditions: null,
    status: 'proposed',
    result: null,
    idempotencyKey: null,
    createdAt: '2026-07-17T00:00:00.000Z',
    decidedAt: null,
    ...overrides,
  };
}

function makeLaunchRunProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  payload?: Partial<LaunchRunProposalPayload>;
} = {}): AgentProposal {
  const payload: LaunchRunProposalPayload = {
    kind: 'launch-run',
    projectId: 1,
    workflowName: 'sprint',
    substrate: 'sdk',
    taskIds: ['TASK-041', 'TASK-042'],
    note: 'seeded from the top of the backlog',
    ...overrides.payload,
  };
  return baseProposal({
    kind: 'launch-run',
    payload,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
  });
}

function makeReprioritizeProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  items?: ReprioritizeBacklogProposalPayload['items'];
} = {}): AgentProposal {
  const payload: ReprioritizeBacklogProposalPayload = {
    kind: 'reprioritize-backlog',
    projectId: 1,
    items: overrides.items ?? [
      { taskId: 'TASK-1', priority: 'P0' },
      { taskId: 'TASK-2', stageId: 'in-progress' },
    ],
  };
  return baseProposal({
    kind: 'reprioritize-backlog',
    payload,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
  });
}

function makeEditWorkflowProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  payload?: Partial<EditWorkflowProposalPayload>;
} = {}): AgentProposal {
  const payload: EditWorkflowProposalPayload = {
    kind: 'edit-workflow',
    workflowId: 'wf-sprint',
    summary: 'Add a review gate before merge',
    definitionJson: JSON.stringify({
      id: 'wf-sprint',
      phases: [{ id: 'plan', label: 'Plan', color: '#3b6dd6', steps: [{ id: 's1' }] }],
    }),
    ...overrides.payload,
  };
  return baseProposal({
    kind: 'edit-workflow',
    payload,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
  });
}

function makeOpenSessionProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  payload?: OpenSessionProposalPayload;
} = {}): AgentProposal {
  return baseProposal({
    kind: 'open-session',
    payload: overrides.payload ?? { kind: 'open-session', navigation: { target: 'run', runId: 'run-1' } },
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
  });
}

beforeEach(() => {
  mockConfirmProposal.mockReset();
  mockDismissProposal.mockReset();
});

// ---------------------------------------------------------------------------
// Per-kind OPEN body rendering
// ---------------------------------------------------------------------------

describe('ProposalCard — open state, per-kind body', () => {
  it('launch-run: workflow, project fallback label, substrate, seed refs, note', () => {
    render(<ProposalCard proposal={makeLaunchRunProposal()} />);

    expect(screen.getByTestId('proposal-body-launch-run')).toHaveTextContent('Launch Sprint');
    expect(screen.getByText('Project #1')).toBeInTheDocument();
    expect(screen.getByText('sdk')).toBeInTheDocument();
    expect(screen.getByText('TASK-041, TASK-042')).toBeInTheDocument();
    expect(screen.getByText('seeded from the top of the backlog')).toBeInTheDocument();
  });

  it('reprioritize-backlog: ranked rows with priority/stage badges', () => {
    render(<ProposalCard proposal={makeReprioritizeProposal()} />);

    const rows = screen.getAllByTestId('reprioritize-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('reprioritize-priority')).toHaveTextContent('P0 ↑');
    expect(within(rows[1]).getByTestId('reprioritize-stage')).toHaveTextContent('in-progress');
    // No result yet — no per-row outcome markers in the open state.
    expect(screen.queryByTestId('reprioritize-outcome')).not.toBeInTheDocument();
  });

  it('edit-workflow: summary, workflowId, parsed phase/step counts', () => {
    render(<ProposalCard proposal={makeEditWorkflowProposal()} />);

    const body = screen.getByTestId('proposal-body-edit-workflow');
    expect(body).toHaveTextContent('Add a review gate before merge');
    expect(body).toHaveTextContent('wf-sprint');
    expect(body).toHaveTextContent('1 phase');
    expect(body).toHaveTextContent('1 step');
  });

  it('open-session: read-only chrome for a run target', () => {
    render(<ProposalCard proposal={makeOpenSessionProposal()} />);

    const body = screen.getByTestId('proposal-body-open-session');
    expect(body).toHaveTextContent('Open flow run');
    expect(body).toHaveTextContent('run-1');
    expect(body).toHaveTextContent('Read-only navigation');
  });

  it('open-session: read-only chrome for a quick-session target', () => {
    render(
      <ProposalCard
        proposal={makeOpenSessionProposal({
          payload: { kind: 'open-session', navigation: { target: 'quick-session', sessionId: 'sess-9' } },
        })}
      />,
    );

    const body = screen.getByTestId('proposal-body-open-session');
    expect(body).toHaveTextContent('Open quick session');
    expect(body).toHaveTextContent('sess-9');
  });

  it('shows the head bar with "needs confirm" while proposed', () => {
    render(<ProposalCard proposal={makeOpenSessionProposal()} />);
    expect(screen.getByTestId('proposal-card-needs-confirm')).toBeInTheDocument();
    expect(screen.queryByTestId('proposal-card-confirming')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Confirm / optimistic executing / reconciliation
// ---------------------------------------------------------------------------

describe('ProposalCard — confirm wiring', () => {
  it('Confirm sets optimistic executing immediately, then reconciles to the executed prop on rerender', async () => {
    let resolveConfirm: ((v: unknown) => void) | undefined;
    mockConfirmProposal.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveConfirm = resolve;
      }),
    );
    const proposal = makeLaunchRunProposal({ status: 'proposed' });
    const { rerender } = render(<ProposalCard proposal={proposal} />);

    fireEvent.click(screen.getByTestId('proposal-card-confirm'));

    // Optimistic 'executing' shows before the mutation resolves.
    expect(screen.getByTestId('proposal-card-confirming')).toBeInTheDocument();
    expect(screen.getByTestId('proposal-card-confirm')).toBeDisabled();
    expect(screen.getByTestId('proposal-card-dismiss')).toBeDisabled();

    resolveConfirm?.({
      ok: true,
      proposalId: proposal.id,
      kind: 'launch-run',
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-9' },
    });
    await waitFor(() => expect(screen.queryByTestId('proposal-card-confirming')).not.toBeInTheDocument());

    // Simulates the parent's store-driven refresh delivering the resolved proposal.
    const resolved = makeLaunchRunProposal({
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-9' },
    });
    rerender(<ProposalCard proposal={resolved} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Run launched.');
    expect(screen.queryByTestId('proposal-card-confirm')).not.toBeInTheDocument();
  });

  it('a claimed-loser response shows no error UI and reconciles cleanly to the refreshed winner state', async () => {
    mockConfirmProposal.mockResolvedValueOnce({ ok: false, reason: 'claimed' });
    const proposal = makeOpenSessionProposal({ status: 'proposed' });
    const { rerender } = render(<ProposalCard proposal={proposal} />);

    fireEvent.click(screen.getByTestId('proposal-card-confirm'));
    await waitFor(() => expect(mockConfirmProposal).toHaveBeenCalledWith('p1'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    const resolved = makeOpenSessionProposal({ status: 'executed' });
    rerender(<ProposalCard proposal={resolved} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Opened.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline error only when the mutation itself throws (transport failure), not on a discriminated ok:false', async () => {
    mockConfirmProposal.mockRejectedValueOnce(new Error('network down'));
    render(<ProposalCard proposal={makeOpenSessionProposal()} />);

    fireEvent.click(screen.getByTestId('proposal-card-confirm'));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('network down'));
  });
});

// ---------------------------------------------------------------------------
// Dismiss
// ---------------------------------------------------------------------------

describe('ProposalCard — dismiss', () => {
  it('Dismiss calls store.dismissProposal with the proposal id', async () => {
    mockDismissProposal.mockResolvedValueOnce({ ok: true, dismissed: true });
    render(<ProposalCard proposal={makeOpenSessionProposal()} />);

    fireEvent.click(screen.getByTestId('proposal-card-dismiss'));

    await waitFor(() => expect(mockDismissProposal).toHaveBeenCalledWith('p1'));
  });

  it('renders a neutral resolved row for a dismissed proposal, with no Confirm/Dismiss buttons', () => {
    render(<ProposalCard proposal={makeLaunchRunProposal({ status: 'dismissed' })} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Dismissed.');
    expect(screen.queryByTestId('proposal-card-confirm')).not.toBeInTheDocument();
    expect(screen.queryByTestId('proposal-card-dismiss')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// reprioritize-backlog — per-row ✓/✕ from the executor result
// ---------------------------------------------------------------------------

describe('ProposalCard — reprioritize-backlog resolved', () => {
  it('renders per-row ✓/✕ and a partial-success summary from result.items', () => {
    const proposal = makeReprioritizeProposal({
      status: 'failed',
      result: {
        kind: 'reprioritize-backlog',
        status: 'failed',
        items: [
          { taskId: 'TASK-1', ok: true },
          { taskId: 'TASK-2', ok: false, error: 'stale version' },
        ],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByText('Reprioritized 1 of 2 tasks.')).toBeInTheDocument();
    const rows = screen.getAllByTestId('reprioritize-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('reprioritize-outcome')).toHaveAttribute('data-ok', 'true');
    expect(within(rows[1]).getByTestId('reprioritize-outcome')).toHaveAttribute('data-ok', 'false');
  });
});

// ---------------------------------------------------------------------------
// edit-workflow — superseded / validation-failed states
// ---------------------------------------------------------------------------

describe('ProposalCard — edit-workflow resolved states', () => {
  it('renders the superseded state with a refreshed-diff hint', () => {
    const proposal = makeEditWorkflowProposal({
      status: 'superseded',
      result: {
        kind: 'edit-workflow',
        status: 'superseded',
        workflowId: 'wf-sprint',
        reason: 'spec-hash-mismatch',
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByText(/Changed since drafted/)).toBeInTheDocument();
    expect(screen.getByText(/refreshed diff is coming/i)).toBeInTheDocument();
  });

  it('renders the validation-failed state with the issues list', () => {
    const proposal = makeEditWorkflowProposal({
      status: 'failed',
      result: {
        kind: 'edit-workflow',
        status: 'failed',
        workflowId: 'wf-sprint',
        reason: 'validation-failed',
        issues: ['phases.0.id: required'],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByTestId('proposal-validation-issues')).toBeInTheDocument();
    expect(screen.getByText('phases.0.id: required')).toBeInTheDocument();
  });

  it('renders a plain success row when the edit executed cleanly', () => {
    const proposal = makeEditWorkflowProposal({
      status: 'executed',
      result: { kind: 'edit-workflow', status: 'executed', workflowId: 'wf-sprint', appliedHash: 'abc' },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Workflow updated.');
  });
});

// ---------------------------------------------------------------------------
// open-session — Confirm performs navigation, per the discriminant
// ---------------------------------------------------------------------------

describe('ProposalCard — open-session Confirm navigation', () => {
  const realSetActiveRun = useCyboflowStore.getState().setActiveRun;
  const realSetActiveQuickSession = useCyboflowStore.getState().setActiveQuickSession;

  afterEach(() => {
    useCyboflowStore.setState({ setActiveRun: realSetActiveRun, setActiveQuickSession: realSetActiveQuickSession });
    useNavigationStore.setState({ view: 'home' });
  });

  it("a {target: 'run'} result navigates via setActiveRun, never setActiveQuickSession", async () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });
    mockConfirmProposal.mockResolvedValueOnce({
      ok: true,
      kind: 'open-session',
      proposalId: 'p1',
      status: 'executed',
      navigation: { target: 'run', runId: 'run-42' },
    });

    render(<ProposalCard proposal={makeOpenSessionProposal()} />);
    fireEvent.click(screen.getByTestId('proposal-card-confirm'));

    await waitFor(() => expect(setActiveRun).toHaveBeenCalledWith('run-42'));
    expect(setActiveQuickSession).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it("a {target: 'quick-session'} result navigates via setActiveQuickSession, never setActiveRun", async () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });
    mockConfirmProposal.mockResolvedValueOnce({
      ok: true,
      kind: 'open-session',
      proposalId: 'p1',
      status: 'executed',
      navigation: { target: 'quick-session', sessionId: 'sess-9' },
    });

    render(
      <ProposalCard
        proposal={makeOpenSessionProposal({
          payload: { kind: 'open-session', navigation: { target: 'quick-session', sessionId: 'sess-9' } },
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('proposal-card-confirm'));

    await waitFor(() => expect(setActiveQuickSession).toHaveBeenCalledWith('sess-9', undefined));
    expect(setActiveRun).not.toHaveBeenCalled();
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it('does NOT navigate when confirmProposal rejects the open-session claim (claimed)', async () => {
    const setActiveRun = vi.fn();
    const setActiveQuickSession = vi.fn();
    useCyboflowStore.setState({ setActiveRun, setActiveQuickSession });
    mockConfirmProposal.mockResolvedValueOnce({ ok: false, reason: 'claimed' });

    render(<ProposalCard proposal={makeOpenSessionProposal()} />);
    fireEvent.click(screen.getByTestId('proposal-card-confirm'));

    await waitFor(() => expect(mockConfirmProposal).toHaveBeenCalled());
    expect(setActiveRun).not.toHaveBeenCalled();
    expect(setActiveQuickSession).not.toHaveBeenCalled();
  });
});
