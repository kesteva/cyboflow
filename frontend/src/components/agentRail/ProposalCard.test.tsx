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
  CreateBacklogItemsProposalPayload,
  CreateWorkflowProposalPayload,
  AgentProposalStatus,
  TriageFindingsProposalPayload,
} from '../../../../shared/types/agentThread';
import type { BacklogTaskItem, Board } from '../../../../shared/types/tasks';
import type { ActiveRunRow } from '../../stores/activeRunsStore';
import type { Session } from '../../types/session';

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
import { useBacklogStore } from '../../stores/backlogStore';
import { useActiveRunsStore } from '../../stores/activeRunsStore';
import { useSessionStore } from '../../stores/sessionStore';
import { trpc } from '../../trpc/client';

// setup.ts stubs `reviewItems.get` to resolve `null` by default (see its
// comment) — findings tests below override that per-call with
// mockResolvedValueOnce so they never leak into other tests in this file.
const mockReviewItemsGet = vi.mocked(trpc.cyboflow.reviewItems.get.query);

// ---------------------------------------------------------------------------
// backlogStore / activeRunsStore / sessionStore fixtures — TASK-221's
// resolver hook reads task/epic/idea refs+titles and board-stage labels off
// the REAL (unmocked) backlogStore, and the launch-run resolved row's session
// name off the REAL activeRunsStore/sessionStore, mirroring how ProposalCard
// already exercises the real cyboflowStore/navigationStore above.
// ---------------------------------------------------------------------------

function makeBacklogTask(overrides: Partial<BacklogTaskItem> & { id: string; ref: string; title: string }): BacklogTaskItem {
  return {
    project_id: 1,
    type: 'task',
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    executor: 'agent',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'ready',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-07-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: 'board-1',
    project_id: 1,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      { id: 'done', label: 'Done', color_oklch: 'oklch(0.7 0.15 145)', hint: null, position: 9, write_policy: 'asserted', is_terminal: true, hidden_by_default: false },
    ],
    ...overrides,
  };
}

function makeActiveRun(overrides: Partial<ActiveRunRow> & { id: string }): ActiveRunRow {
  return {
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'running',
    worktree_path: '/wt',
    branch_name: 'sprint/x',
    permission_mode_snapshot: 'default',
    workflowName: 'Sprint',
    created_at: '2026-07-06T12:00:00.000Z',
    updated_at: '2026-07-06T12:30:00.000Z',
    started_at: '2026-07-06T12:00:00.000Z',
    ended_at: null,
    stuck_reason: null,
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> & { id: string; name: string }): Session {
  return {
    worktreePath: '/wt',
    prompt: '',
    status: 'running',
    createdAt: '2026-07-06T12:00:00.000Z',
    output: [],
    jsonMessages: [],
    ...overrides,
  };
}

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

function makeCreateBacklogProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  items?: CreateBacklogItemsProposalPayload['items'];
} = {}): AgentProposal {
  const payload: CreateBacklogItemsProposalPayload = {
    kind: 'create-backlog-items',
    projectId: 1,
    items: overrides.items ?? [
      { taskType: 'idea', title: 'Rework the rail' },
      { taskType: 'task', title: 'Add the toggle', priority: 'P1' },
    ],
  };
  return baseProposal({
    kind: 'create-backlog-items',
    payload,
    status: overrides.status ?? 'proposed',
    result: overrides.result ?? null,
  });
}

function makeCreateWorkflowProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  payload?: Partial<CreateWorkflowProposalPayload>;
} = {}): AgentProposal {
  const payload: CreateWorkflowProposalPayload = {
    kind: 'create-workflow',
    projectId: 1,
    name: 'Docs Review',
    summary: 'A docs-review flow with its own writer',
    definitionJson: JSON.stringify({
      id: 'docs-review',
      phases: [{ id: 'review', label: 'Review', color: '#3b6dd6', steps: [{ id: 'write' }, { id: 'approve' }] }],
    }),
    permissionMode: 'acceptEdits',
    agents: [
      { name: 'Docs Writer', description: 'Writes docs.', systemPrompt: 'Write docs.', tools: ['Read', 'Edit'] },
      { name: 'Docs Checker', description: 'Checks docs.', systemPrompt: 'Check docs.', tools: ['Read'] },
    ],
    ...overrides.payload,
  };
  return baseProposal({
    kind: 'create-workflow',
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
  // Reset to empty on every test so an unresolved-id assertion in one test
  // never rides on a fixture a PRIOR test seeded.
  useBacklogStore.setState({ tasks: [], boards: [] });
  useActiveRunsStore.setState({ runsByProject: {} });
  useSessionStore.setState({ sessions: [] });
});

// ---------------------------------------------------------------------------
// Per-kind OPEN body rendering
// ---------------------------------------------------------------------------

describe('ProposalCard — open state, per-kind body', () => {
  it('launch-run: workflow, project fallback label, substrate, unresolved seed ids, note', () => {
    render(<ProposalCard proposal={makeLaunchRunProposal()} />);

    expect(screen.getByTestId('proposal-body-launch-run')).toHaveTextContent('Launch Sprint');
    expect(screen.getByText('Project #1')).toBeInTheDocument();
    expect(screen.getByText('sdk')).toBeInTheDocument();
    // Neither seed id is in the (empty) backlogStore — both degrade to the
    // muted unresolved marker, never a blank cell.
    const unresolved = screen.getAllByTestId('proposal-entity-unresolved');
    expect(unresolved).toHaveLength(2);
    expect(unresolved[0]).toHaveTextContent('TASK-041 (unresolved)');
    expect(unresolved[0]).toHaveAttribute('data-id', 'TASK-041');
    expect(unresolved[1]).toHaveTextContent('TASK-042 (unresolved)');
    expect(screen.getByText('seeded from the top of the backlog')).toBeInTheDocument();
  });

  it('launch-run: resolves seed ids to refs + titles, and a custom (non-built-in) workflow name to itself', () => {
    useBacklogStore.setState({
      tasks: [
        makeBacklogTask({ id: 'tsk_041', ref: 'TASK-041', title: 'Fix the flaky retry test' }),
        makeBacklogTask({ id: 'idea_008', ref: 'IDEA-008', title: 'Faster cold start', type: 'idea' }),
      ],
    });
    const proposal = makeLaunchRunProposal({
      payload: {
        taskIds: ['tsk_041'],
        ideaIds: ['idea_008'],
        workflowName: 'speedboat' as unknown as LaunchRunProposalPayload['workflowName'],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByTestId('proposal-body-launch-run')).toHaveTextContent('Launch speedboat');
    // A custom name carries the muted "custom" tag; with no stamped scope it
    // says just that (an older row the propose handler never stamped).
    const tag = screen.getByTestId('launch-run-custom-tag');
    expect(tag).toHaveTextContent(/^custom$/);
    expect(tag).toHaveAttribute('data-scope', '');
    const labels = screen.getAllByTestId('proposal-entity-label');
    expect(labels[0]).toHaveTextContent('TASK-041');
    expect(labels[0]).toHaveTextContent('Fix the flaky retry test');
    expect(labels[0]).toHaveAttribute('title', 'Fix the flaky retry test');
    expect(labels[1]).toHaveTextContent('IDEA-008');
    expect(labels[1]).toHaveTextContent('Faster cold start');
    expect(screen.queryByTestId('proposal-entity-unresolved')).not.toBeInTheDocument();
  });

  it('launch-run: a custom flow with a stamped scope shows "custom · global|project"; a built-in shows no tag (TASK-294)', () => {
    const { rerender } = render(
      <ProposalCard
        proposal={makeLaunchRunProposal({
          payload: { workflowName: 'dash', workflowId: 'wf-global-custom-e253eb7b', workflowScope: 'global' },
        })}
      />,
    );
    expect(screen.getByTestId('proposal-body-launch-run')).toHaveTextContent('Launch dash');
    const tag = screen.getByTestId('launch-run-custom-tag');
    expect(tag).toHaveTextContent('custom · global');
    expect(tag).toHaveAttribute('data-scope', 'global');
    expect(tag).toHaveAttribute('title', 'wf-global-custom-e253eb7b');

    rerender(<ProposalCard proposal={makeLaunchRunProposal({ payload: { workflowName: 'docs-review', workflowScope: 'project' } })} />);
    expect(screen.getByTestId('launch-run-custom-tag')).toHaveTextContent('custom · project');

    rerender(<ProposalCard proposal={makeLaunchRunProposal()} />);
    expect(screen.getByTestId('proposal-body-launch-run')).toHaveTextContent('Launch Sprint');
    expect(screen.queryByTestId('launch-run-custom-tag')).not.toBeInTheDocument();
  });

  it('launch-run: a finding seed id resolves its title (no ref) via a batched reviewItems.get fetch', async () => {
    // A distinct id (module-scoped findingCache in useProposalEntityLabels
    // persists across tests in this file) so a cache hit from another test
    // can never mask this one actually calling the query.
    mockReviewItemsGet.mockResolvedValueOnce({
      id: 'rvw_findings_test',
      project_id: 1,
      title: 'Stale worktree lock leaks on crash',
    } as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>);
    const proposal = makeLaunchRunProposal({
      payload: { taskIds: [], findingIds: ['rvw_findings_test'] },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(mockReviewItemsGet).toHaveBeenCalledWith({ reviewItemId: 'rvw_findings_test' });
    const label = await screen.findByTestId('proposal-entity-label');
    expect(label).toHaveTextContent('Stale worktree lock leaks on crash');
    // Findings have no ref — the bold-ref span used for tasks/epics/ideas
    // must not appear for a finding row.
    expect(within(label).queryByText(/^TASK-|^IDEA-|^EPIC-/)).not.toBeInTheDocument();
  });

  it('launch-run: an unresolvable finding id degrades to the muted unresolved marker, not a blank cell', async () => {
    // setup.ts's default resolves `null`, i.e. "not found" — no override needed.
    const proposal = makeLaunchRunProposal({
      payload: { taskIds: [], findingIds: ['rvw_findings_missing'] },
    });
    render(<ProposalCard proposal={proposal} />);

    await waitFor(() => expect(mockReviewItemsGet).toHaveBeenCalledWith({ reviewItemId: 'rvw_findings_missing' }));
    expect(await screen.findByTestId('proposal-entity-unresolved')).toHaveTextContent('rvw_findings_missing (unresolved)');
  });

  it('reprioritize-backlog: ranked rows with priority/stage badges, resolved to refs + titles + stage labels', () => {
    useBacklogStore.setState({
      tasks: [
        makeBacklogTask({ id: 'TASK-1', ref: 'TASK-001', title: 'Promote the flaky-test fix' }),
        makeBacklogTask({ id: 'TASK-2', ref: 'TASK-002', title: 'Move to in-progress', stage_id: 'in-progress' }),
      ],
      boards: [
        makeBoard({
          stages: [
            { id: 'in-progress', label: 'In progress', color_oklch: 'oklch(0.7 0.15 250)', hint: null, position: 7, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
          ],
        }),
      ],
    });
    render(<ProposalCard proposal={makeReprioritizeProposal()} />);

    const rows = screen.getAllByTestId('reprioritize-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('reprioritize-priority')).toHaveTextContent('P0 ↑');
    expect(within(rows[0]).getByTestId('proposal-entity-label')).toHaveTextContent('TASK-001');
    expect(within(rows[0]).getByTestId('proposal-entity-label')).toHaveTextContent('Promote the flaky-test fix');
    expect(within(rows[1]).getByTestId('reprioritize-stage')).toHaveTextContent('In progress');
    expect(within(rows[1]).getByTestId('proposal-entity-label')).toHaveTextContent('TASK-002');
    // The opaque id only ever surfaces in a tooltip/data attribute, never as row text.
    expect(rows[1]).toHaveAttribute('data-task-id', 'TASK-2');
    expect(screen.queryByText('TASK-2', { exact: false })).not.toBeInTheDocument();
    // No result yet — no per-row outcome markers in the open state.
    expect(screen.queryByTestId('reprioritize-outcome')).not.toBeInTheDocument();
  });

  it('launch-run: a seed id that belongs to ANOTHER project degrades to the muted unresolved marker, never a convincing ref', () => {
    useBacklogStore.setState({
      tasks: [makeBacklogTask({ id: 'tsk_foreign', ref: 'TASK-900', title: 'Someone else\'s task', project_id: 2 })],
    });
    render(<ProposalCard proposal={makeLaunchRunProposal({ payload: { taskIds: ['tsk_foreign'] } })} />);

    expect(screen.getByTestId('proposal-entity-unresolved')).toHaveTextContent('tsk_foreign (unresolved)');
    expect(screen.queryByText('TASK-900')).not.toBeInTheDocument();
  });

  it('launch-run: a finding that belongs to ANOTHER project degrades to the muted unresolved marker', async () => {
    mockReviewItemsGet.mockResolvedValueOnce({
      id: 'rvw_findings_foreign',
      project_id: 2,
      title: 'Cross-project finding',
    } as unknown as Awaited<ReturnType<typeof trpc.cyboflow.reviewItems.get.query>>);
    render(<ProposalCard proposal={makeLaunchRunProposal({ payload: { taskIds: [], findingIds: ['rvw_findings_foreign'] } })} />);

    await waitFor(() => expect(mockReviewItemsGet).toHaveBeenCalledWith({ reviewItemId: 'rvw_findings_foreign' }));
    expect(await screen.findByTestId('proposal-entity-unresolved')).toHaveTextContent('rvw_findings_foreign (unresolved)');
    expect(screen.queryByText('Cross-project finding')).not.toBeInTheDocument();
  });

  it('reprioritize-backlog: a task and a stage from ANOTHER project degrade to the muted unresolved markers', () => {
    useBacklogStore.setState({
      tasks: [makeBacklogTask({ id: 'TASK-1', ref: 'TASK-001', title: 'Foreign task', project_id: 2 })],
      boards: [
        makeBoard({
          id: 'board-2',
          project_id: 2,
          stages: [
            { id: 'in-progress', label: 'Foreign in progress', color_oklch: 'oklch(0.7 0.15 250)', hint: null, position: 7, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
          ],
        }),
      ],
    });
    render(<ProposalCard proposal={makeReprioritizeProposal()} />);

    const rows = screen.getAllByTestId('reprioritize-row');
    expect(within(rows[0]).getByTestId('proposal-entity-unresolved')).toHaveTextContent('TASK-1 (unresolved)');
    expect(within(rows[1]).getByTestId('proposal-stage-unresolved')).toHaveTextContent('in-progress (unresolved)');
    expect(screen.queryByText('Foreign in progress')).not.toBeInTheDocument();
  });

  it('reprioritize-backlog: an id absent from the backlog degrades to a muted unresolved marker, never a blank cell', () => {
    render(<ProposalCard proposal={makeReprioritizeProposal()} />);

    const rows = screen.getAllByTestId('reprioritize-row');
    expect(within(rows[0]).getByTestId('proposal-entity-unresolved')).toHaveTextContent('TASK-1 (unresolved)');
    expect(within(rows[1]).getByTestId('proposal-stage-unresolved')).toHaveTextContent('in-progress (unresolved)');
  });

  it('reprioritize-backlog: groups a task under its parent epic when both are in the payload', () => {
    useBacklogStore.setState({
      tasks: [
        makeBacklogTask({
          id: 'epc_1',
          ref: 'EPIC-033',
          title: 'Onboarding rework',
          type: 'epic',
          children: [
            makeBacklogTask({ id: 'tsk_a', ref: 'TASK-201', title: 'Step one', parent_epic_id: 'epc_1' }),
            makeBacklogTask({ id: 'tsk_b', ref: 'TASK-202', title: 'Step two', parent_epic_id: 'epc_1' }),
          ],
        }),
      ],
    });
    const proposal = makeReprioritizeProposal({
      items: [
        { taskId: 'epc_1', priority: 'P1' },
        { taskId: 'tsk_a', stageId: 'done' },
        { taskId: 'tsk_b', stageId: 'done' },
      ],
    });
    render(<ProposalCard proposal={proposal} />);

    const rows = screen.getAllByTestId('reprioritize-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByTestId('proposal-entity-label')).toHaveTextContent('EPIC-033');
    expect(rows[0]).toHaveAttribute('data-depth', '0');
    expect(within(rows[1]).getByTestId('proposal-entity-label')).toHaveTextContent('TASK-201');
    expect(rows[1]).toHaveAttribute('data-depth', '1');
    expect(within(rows[2]).getByTestId('proposal-entity-label')).toHaveTextContent('TASK-202');
    expect(rows[2]).toHaveAttribute('data-depth', '1');
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

  it('narrow-rail layout: a long title truncates while the rank column and the ✓/✕ overlay stay fixed-width alongside priority/stage', () => {
    useBacklogStore.setState({
      tasks: [
        makeBacklogTask({
          id: 'TASK-1',
          ref: 'TASK-001',
          title:
            'A deliberately very long task title that would overflow the narrow agent rail column if it were not truncated by the row layout',
          stage_id: 'in-progress',
        }),
      ],
      boards: [
        makeBoard({
          stages: [
            { id: 'in-progress', label: 'In progress', color_oklch: 'oklch(0.7 0.15 250)', hint: null, position: 7, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
          ],
        }),
      ],
    });
    const proposal = makeReprioritizeProposal({
      status: 'executed',
      items: [{ taskId: 'TASK-1', priority: 'P0', stageId: 'in-progress' }],
      result: {
        kind: 'reprioritize-backlog',
        status: 'executed',
        items: [{ taskId: 'TASK-1', ok: true }],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    const row = screen.getByTestId('reprioritize-row');
    // Rank number and the ✓/✕ overlay are fixed-width (shrink-0) so a long
    // title never squeezes them out of the row.
    expect(within(row).getByText('1')).toHaveClass('shrink-0');
    expect(within(row).getByTestId('reprioritize-outcome')).toHaveClass('shrink-0');
    // The ref/title label truncates (flex-1 so it's the column that yields).
    const label = within(row).getByTestId('proposal-entity-label');
    expect(label).toHaveClass('truncate');
    expect(label).toHaveClass('flex-1');
    // Priority and stage badges still render alongside the outcome overlay —
    // all four columns coexist in the same row without one crowding another out.
    expect(within(row).getByTestId('reprioritize-priority')).toHaveTextContent('P0 ↑');
    expect(within(row).getByTestId('reprioritize-stage')).toHaveTextContent('In progress');
    expect(within(row).getByTestId('reprioritize-outcome')).toHaveAttribute('data-ok', 'true');
  });
});

// ---------------------------------------------------------------------------
// launch-run resolved — names the session/workflow instead of the raw run id,
// and is clickable to open the run.
// ---------------------------------------------------------------------------

describe('ProposalCard — launch-run resolved', () => {
  const realSetActiveRun = useCyboflowStore.getState().setActiveRun;

  afterEach(() => {
    useCyboflowStore.setState({ setActiveRun: realSetActiveRun });
    useNavigationStore.setState({ view: 'home' });
  });

  it('names the session + workflow and opens the run on click', () => {
    useActiveRunsStore.setState({
      runsByProject: { 1: [makeActiveRun({ id: 'run-9', session_id: 'sess-9', workflowName: 'Sprint' })] },
    });
    useSessionStore.setState({ sessions: [makeSession({ id: 'sess-9', name: 'brisk-otter' })] });
    const setActiveRun = vi.fn();
    useCyboflowStore.setState({ setActiveRun });

    const proposal = makeLaunchRunProposal({
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-9' },
    });
    render(<ProposalCard proposal={proposal} />);

    const row = screen.getByTestId('proposal-card-resolved-row');
    expect(row).toHaveTextContent('Run launched.');
    expect(row).toHaveTextContent('brisk-otter');
    expect(row).toHaveTextContent('Sprint');
    expect(row).not.toHaveTextContent('run-9');

    fireEvent.click(row);
    expect(setActiveRun).toHaveBeenCalledWith('run-9');
    expect(useNavigationStore.getState().view).toBe('session');
  });

  it('names the session off result.sessionId before activeRunsStore has hydrated the new run', () => {
    // The normal state right after Confirm: the executor's result already
    // carries the minted sessionId + runId, the session row is in the session
    // store, but the run has not yet landed in activeRunsStore.
    useSessionStore.setState({ sessions: [makeSession({ id: 'sess-new', name: 'calm-heron' })] });
    const setActiveRun = vi.fn();
    useCyboflowStore.setState({ setActiveRun });

    const proposal = makeLaunchRunProposal({
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-new', sessionId: 'sess-new' },
    });
    render(<ProposalCard proposal={proposal} />);

    const row = screen.getByTestId('proposal-card-resolved-row');
    expect(row).toHaveTextContent('Run launched.');
    expect(row).toHaveTextContent('calm-heron');
    expect(row).toHaveTextContent('Sprint');
    expect(row).not.toHaveTextContent('run-new');

    fireEvent.click(row);
    expect(setActiveRun).toHaveBeenCalledWith('run-new');
  });

  it('says which seeds the flow ignored, when the executor reports any (TASK-294)', () => {
    const proposal = makeLaunchRunProposal({
      payload: { workflowName: 'dash', workflowScope: 'global', taskIds: ['tsk_1'], findingIds: ['rvw_1'] },
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-d', sessionId: 'sess-d', ignoredSeeds: ['findingIds'] },
    });
    render(<ProposalCard proposal={proposal} />);
    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Run launched.');
    expect(screen.getByTestId('launch-run-ignored-seeds')).toHaveTextContent('Ignored findings — this flow takes no such seed.');
  });

  it('shows no ignored-seeds note when nothing was dropped', () => {
    render(
      <ProposalCard
        proposal={makeLaunchRunProposal({ status: 'executed', result: { kind: 'launch-run', status: 'executed', runId: 'run-1' } })}
      />,
    );
    expect(screen.queryByTestId('launch-run-ignored-seeds')).not.toBeInTheDocument();
  });

  it('shows a readable workflow + "loading session" label — never the opaque run id — while nothing has hydrated yet', () => {
    const proposal = makeLaunchRunProposal({
      status: 'executed',
      result: { kind: 'launch-run', status: 'executed', runId: 'run-unknown', sessionId: 'sess-unknown' },
    });
    render(<ProposalCard proposal={proposal} />);

    const row = screen.getByTestId('proposal-card-resolved-row');
    expect(row).toHaveTextContent('Run launched.');
    expect(row).toHaveTextContent('Sprint · loading session…');
    expect(row).not.toHaveTextContent('run-unknown');
    expect(row).not.toHaveTextContent('sess-unknown');
  });
});

// ---------------------------------------------------------------------------
// create-backlog-items — open rows + per-row ✓/✕ + minted refs
// ---------------------------------------------------------------------------

describe('ProposalCard — create-backlog-items', () => {
  it('open state: one row per proposed entity, typed, with no outcome markers yet', () => {
    render(<ProposalCard proposal={makeCreateBacklogProposal()} />);

    expect(screen.getByText('Add 2 items to the backlog')).toBeInTheDocument();
    const rows = screen.getAllByTestId('create-backlog-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute('data-task-type', 'idea');
    expect(rows[1]).toHaveAttribute('data-task-type', 'task');
    expect(within(rows[1]).getByTestId('create-backlog-priority')).toHaveTextContent('P1');
    expect(screen.queryByTestId('create-backlog-outcome')).not.toBeInTheDocument();
  });

  it('resolved: per-row ✓/✕ keyed by index, the minted ref, and a partial-success summary', () => {
    const proposal = makeCreateBacklogProposal({
      status: 'failed',
      result: {
        kind: 'create-backlog-items',
        status: 'failed',
        items: [
          { index: 0, title: 'Rework the rail', taskType: 'idea', ok: true, taskId: 'idea_1', ref: 'IDEA-012' },
          { index: 1, title: 'Add the toggle', taskType: 'task', ok: false, error: 'idea_needs_epic' },
        ],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByText('Created 1 of 2 items.')).toBeInTheDocument();
    const rows = screen.getAllByTestId('create-backlog-row');
    expect(within(rows[0]).getByTestId('create-backlog-outcome')).toHaveAttribute('data-ok', 'true');
    expect(within(rows[0]).getByTestId('create-backlog-ref')).toHaveTextContent('IDEA-012');
    expect(within(rows[1]).getByTestId('create-backlog-outcome')).toHaveAttribute('data-ok', 'false');
    // A failed row mints nothing, so it carries no ref.
    expect(within(rows[1]).queryByTestId('create-backlog-ref')).not.toBeInTheDocument();
  });

  it('dismissed collapses to the neutral resolved line without rows', () => {
    render(<ProposalCard proposal={makeCreateBacklogProposal({ status: 'dismissed' })} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Dismissed.');
    expect(screen.queryByTestId('create-backlog-row')).not.toBeInTheDocument();
  });
});

describe('ProposalCard — create-workflow', () => {
  it('open state: summary, name, parsed phase/step counts, permission mode, and one row per new agent', () => {
    render(<ProposalCard proposal={makeCreateWorkflowProposal()} />);

    expect(screen.getByTestId('proposal-card')).toHaveTextContent('create workflow');
    expect(screen.getByText('A docs-review flow with its own writer')).toBeInTheDocument();
    expect(screen.getByText('Docs Review')).toBeInTheDocument();
    expect(screen.getByText('1 phase · 2 steps')).toBeInTheDocument();
    expect(screen.getByText('acceptEdits')).toBeInTheDocument();
    expect(screen.getByText('2 agents')).toBeInTheDocument();
    const rows = screen.getAllByTestId('create-workflow-agent-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByTestId('create-workflow-agent-tools')).toHaveTextContent('Read · Edit');
    expect(screen.queryByTestId('create-workflow-agent-outcome')).not.toBeInTheDocument();
  });

  it('open state: a global-scoped flow says so instead of naming a project', () => {
    render(<ProposalCard proposal={makeCreateWorkflowProposal({ payload: { scope: 'global', agents: [], summary: undefined } })} />);

    expect(screen.getByText('Create workflow "Docs Review"')).toBeInTheDocument();
    expect(screen.getByText('Global — every project')).toBeInTheDocument();
    expect(screen.queryByTestId('create-workflow-agent-row')).not.toBeInTheDocument();
  });

  it('resolved executed: the minted workflow id and a ✓ + key per agent', () => {
    const proposal = makeCreateWorkflowProposal({
      status: 'executed',
      result: {
        kind: 'create-workflow',
        status: 'executed',
        name: 'Docs Review',
        workflowId: 'wf-1-custom-abcd1234',
        agents: [
          { index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' },
          { index: 1, name: 'Docs Checker', ok: true, agentKey: 'docs-checker' },
        ],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByText('Workflow "Docs Review" created with 2 agents.')).toBeInTheDocument();
    expect(screen.getByText('wf-1-custom-abcd1234')).toBeInTheDocument();
    const rows = screen.getAllByTestId('create-workflow-agent-row');
    expect(within(rows[0]).getByTestId('create-workflow-agent-key')).toHaveTextContent('docs-writer');
    expect(within(rows[1]).getByTestId('create-workflow-agent-outcome')).toHaveAttribute('data-ok', 'true');
  });

  it('resolved failed: the error, per-agent ✓/✕, and whether the unwind completed', () => {
    const proposal = makeCreateWorkflowProposal({
      status: 'failed',
      result: {
        kind: 'create-workflow',
        status: 'failed',
        name: 'Docs Review',
        error: 'agent "Docs Checker" was not created: duplicate_key',
        agents: [
          { index: 0, name: 'Docs Writer', ok: true, agentKey: 'docs-writer' },
          { index: 1, name: 'Docs Checker', ok: false, error: 'duplicate_key' },
        ],
        compensations: [{ agentKey: 'docs-writer', ok: false, error: 'referenced' }],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByText('Workflow not created.')).toBeInTheDocument();
    expect(screen.getByText('agent "Docs Checker" was not created: duplicate_key')).toBeInTheDocument();
    const rows = screen.getAllByTestId('create-workflow-agent-row');
    expect(within(rows[0]).getByTestId('create-workflow-agent-outcome')).toHaveAttribute('data-ok', 'true');
    expect(within(rows[1]).getByTestId('create-workflow-agent-outcome')).toHaveAttribute('data-ok', 'false');
    expect(screen.getByTestId('proposal-create-workflow-unwind')).toHaveTextContent('could not be removed again');
  });

  it('dismissed collapses to the neutral resolved line without agent rows', () => {
    render(<ProposalCard proposal={makeCreateWorkflowProposal({ status: 'dismissed' })} />);

    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Dismissed.');
    expect(screen.queryByTestId('create-workflow-agent-row')).not.toBeInTheDocument();
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

// ---------------------------------------------------------------------------
// triage-findings — grouped counts + expandable titles, per-group outcomes
// (TASK-292)
// ---------------------------------------------------------------------------

function makeTriageProposal(overrides: {
  status?: AgentProposalStatus;
  result?: unknown;
  items?: TriageFindingsProposalPayload['items'];
  summary?: string;
} = {}): AgentProposal {
  const payload: TriageFindingsProposalPayload = {
    kind: 'triage-findings',
    projectId: 1,
    items: overrides.items ?? [
      { reviewItemId: 'rvw_a', op: 'dismiss', resolution: 'eval noise', title: 'Unused import in foo.ts' },
      { reviewItemId: 'rvw_b', op: 'dismiss', title: 'Trailing whitespace' },
      { reviewItemId: 'rvw_c', op: 'resolve', title: 'Fixed in #42' },
      { reviewItemId: 'rvw_d', op: 'set-selected', selected: true, title: 'Worktree lock leaks on crash' },
      { reviewItemId: 'rvw_e', op: 'approve', title: 'Retry storm on 429' },
    ],
    ...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
  };
  return baseProposal({ kind: 'triage-findings', payload, status: overrides.status ?? 'proposed', result: overrides.result ?? null });
}

describe('ProposalCard — triage-findings', () => {
  it('open state: a grouped headline with counts, no per-item rows until a group is expanded', () => {
    render(<ProposalCard proposal={makeTriageProposal()} />);

    expect(screen.getByTestId('proposal-card')).toHaveAttribute('data-kind', 'triage-findings');
    expect(screen.getByText(/Proposed action · triage findings/i)).toBeInTheDocument();
    expect(screen.getByTestId('triage-headline')).toHaveTextContent('Dismiss 2 · Resolve 1 · Stage for Compound 1 · Select for Compound 1');

    const groups = screen.getAllByTestId('triage-group');
    expect(groups.map((g) => g.getAttribute('data-group'))).toEqual(['dismiss', 'resolve', 'approve', 'select']);
    expect(within(groups[0]).getByTestId('triage-group-count')).toHaveTextContent('2');
    expect(screen.queryAllByTestId('triage-row')).toHaveLength(0);

    fireEvent.click(within(groups[0]).getByTestId('triage-group-toggle'));
    const rows = within(groups[0]).getAllByTestId('triage-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Unused import in foo.ts');
    expect(rows[0]).toHaveTextContent('eval noise');
    expect(rows[0]).toHaveAttribute('data-review-item-id', 'rvw_a');
    // Still no outcome markers before confirm.
    expect(screen.queryAllByTestId('triage-outcome')).toHaveLength(0);
  });

  it('open state: a summary replaces the headline and the counts move to the caption', () => {
    render(<ProposalCard proposal={makeTriageProposal({ summary: 'Sweep the eval noise' })} />);
    expect(screen.getByTestId('triage-headline')).toHaveTextContent('Sweep the eval noise');
    expect(screen.getByText(/Project #1 · Dismiss 2/)).toBeInTheDocument();
  });

  it('resolved: applied / skipped counts plus per-group ✓ / skipped / ✕ tallies', () => {
    const proposal = makeTriageProposal({
      status: 'failed',
      result: {
        kind: 'triage-findings',
        status: 'failed',
        applied: 3,
        skipped: 1,
        items: [
          { reviewItemId: 'rvw_a', op: 'dismiss', ok: true },
          { reviewItemId: 'rvw_b', op: 'dismiss', ok: false, skipped: 'already resolved' },
          { reviewItemId: 'rvw_c', op: 'resolve', ok: true },
          { reviewItemId: 'rvw_d', op: 'set-selected', ok: true },
          { reviewItemId: 'rvw_e', op: 'approve', ok: false, error: 'not untriaged' },
        ],
      },
    });
    render(<ProposalCard proposal={proposal} />);

    expect(screen.getByTestId('triage-resolved-summary')).toHaveTextContent('Triaged 3 of 5 findings · 1 skipped (already triaged) · 1 failed.');
    expect(screen.queryByTestId('proposal-card-confirm')).not.toBeInTheDocument();

    const groups = screen.getAllByTestId('triage-group');
    expect(within(groups[0]).getByTestId('triage-group-outcome')).toHaveTextContent('✓ 1skipped 1');
    expect(within(groups[2]).getByTestId('triage-group-outcome')).toHaveTextContent('✕ 1');

    fireEvent.click(within(groups[0]).getByTestId('triage-group-toggle'));
    const outcomes = within(groups[0]).getAllByTestId('triage-outcome');
    expect(outcomes[0]).toHaveTextContent('✓');
    expect(outcomes[1]).toHaveTextContent('skipped');
    expect(outcomes[1]).toHaveAttribute('title', 'already resolved');
  });

  it('resolved executed: a clean sweep reads as fully triaged', () => {
    const proposal = makeTriageProposal({
      status: 'executed',
      items: [{ reviewItemId: 'rvw_a', op: 'dismiss', title: 'x' }],
      result: { kind: 'triage-findings', status: 'executed', applied: 1, skipped: 0, items: [{ reviewItemId: 'rvw_a', op: 'dismiss', ok: true }] },
    });
    render(<ProposalCard proposal={proposal} />);
    expect(screen.getByTestId('triage-resolved-summary')).toHaveTextContent('Triaged 1 of 1 finding.');
    expect(screen.getByTestId('proposal-status-circle')).toHaveAttribute('data-tone', 'success');
  });

  it('dismissed collapses to the neutral resolved row', () => {
    render(<ProposalCard proposal={makeTriageProposal({ status: 'dismissed' })} />);
    expect(screen.getByTestId('proposal-card-resolved-row')).toHaveTextContent('Dismissed.');
  });
});
