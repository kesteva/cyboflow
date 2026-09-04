/**
 * Component tests for ProjectOverviewPage — the page's OWN wiring:
 *   1. Page-state routing: each of the six {@link OverviewPageState} values
 *      renders the variant the design specifies (the recommended-actions
 *      descriptor line + the backlog body that goes with it).
 *   2. Recommended-action dismissal: clicking Dismiss removes the card AND
 *      persists the id under OVERVIEW_DISMISSED_KEY(projectId), so it stays
 *      gone on the next mount.
 *
 * Everything the page reads is mocked at the LEAF (the four stores, the tRPC
 * client, the idea-session opener) so these tests exercise the page's own
 * derivation + routing rather than any store's fetch lifecycle. The pure model
 * is NOT mocked — routing is the thing under test, and stubbing the selector
 * would test the stub.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

// ---------------------------------------------------------------------------
// Store mocks — a tiny zustand-shaped double: callable with a selector, plus
// a getState() for the imperative `useX.getState().init()` call sites.
// ---------------------------------------------------------------------------

interface MockStore<T> {
  (selector?: (s: T) => unknown): unknown;
  getState: () => T;
  __set: (next: Partial<T>) => void;
}

const {
  backlogStore,
  activeRunsStore,
  quickSessionsStore,
  reviewQueueStore,
  navigationStore,
  configStore,
  cyboflowStore,
  quickInitDisposer,
} = vi.hoisted(() => {
  function makeStore<T extends object>(initial: T): MockStore<T> {
    let state = initial;
    const hook = ((selector?: (s: T) => unknown) =>
      selector ? selector(state) : state) as MockStore<T>;
    hook.getState = () => state;
    hook.__set = (next: Partial<T>) => {
      state = { ...state, ...next };
    };
    return hook;
  }
  // App-owned singleton stores: their init() must NEVER be called by the page
  // (calling + returning it as effect cleanup would tear down APP-level
  // subscriptions on unmount — the Codex-review regression). Spies so the
  // ownership test can assert zero calls.
  const disposer = vi.fn();
  return {
    quickInitDisposer: disposer,
    backlogStore: makeStore({
      tasks: [] as BacklogTaskItem[],
      boards: [] as Board[],
      projects: [{ id: 1, name: 'cyboflow' }],
      init: vi.fn(() => () => {}),
      setFilterProject: vi.fn(),
    }),
    activeRunsStore: makeStore({
      runsByProject: {} as Record<number, unknown[]>,
      init: vi.fn(() => () => {}),
      refresh: vi.fn().mockResolvedValue(undefined),
    }),
    quickSessionsStore: makeStore({ rows: [] as unknown[], init: vi.fn(() => disposer) }),
    reviewQueueStore: makeStore({ queue: [] as unknown[], init: vi.fn(() => () => {}) }),
    navigationStore: makeStore({
      openHumanReview: vi.fn(),
      openBacklog: vi.fn(),
      openSettings: vi.fn(),
      goToWizard: vi.fn(),
      setActiveProjectId: vi.fn(),
      goToSession: vi.fn(),
    }),
    configStore: makeStore({ config: { sprintMaxTasks: undefined } }),
    cyboflowStore: makeStore({
      activeRunId: null,
      initModel: null,
      setActiveRun: vi.fn(),
      setActiveQuickSession: vi.fn(),
    }),
  };
});

vi.mock('../../../stores/backlogStore', () => ({ useBacklogStore: backlogStore }));
vi.mock('../../../stores/activeRunsStore', () => ({
  useActiveRunsStore: activeRunsStore,
  isTerminalRunStatus: (s: string) => ['completed', 'failed', 'canceled'].includes(s),
}));
vi.mock('../../../stores/quickSessionsStore', () => ({ useQuickSessionsStore: quickSessionsStore }));
vi.mock('../../../stores/reviewQueueStore', () => ({ useReviewQueueStore: reviewQueueStore }));
vi.mock('../../../stores/navigationStore', () => ({ useNavigationStore: navigationStore }));
vi.mock('../../../stores/configStore', () => ({ useConfigStore: configStore }));
vi.mock('../../../stores/cyboflowStore', () => ({ useCyboflowStore: cyboflowStore }));

vi.mock('../../../hooks/useIdeaSessionOpener', () => ({
  useIdeaSessionOpener: () => ({ openingTaskId: null, error: null, openIdeaSession: vi.fn() }),
}));

// The sprint batch picker owns its own data fetching + eligibility (covered by
// its own suite); the page tests only assert that the CTA OPENS it.
vi.mock('../../cyboflow/TaskBatchPickerModal', () => ({
  TaskBatchPickerModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div data-testid="task-batch-picker-modal" /> : null,
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      insights: { workflowStats: { query: vi.fn().mockResolvedValue([]) } },
      verificationRequests: { setupByProject: { query: vi.fn().mockResolvedValue([]) } },
      tracker: { connections: { query: vi.fn().mockResolvedValue([]) } },
      substrates: { resolveEffective: { query: vi.fn().mockResolvedValue({ substrate: 'sdk' }) } },
      workflows: { list: { query: vi.fn().mockResolvedValue([]) } },
      runs: { start: { mutate: vi.fn() } },
      approvals: { approve: { mutate: vi.fn() }, reject: { mutate: vi.fn() } },
    },
  },
}));

import { ProjectOverviewPage } from '../ProjectOverviewPage';
import { OVERVIEW_DISMISSED_KEY } from '../overviewModel';
import type { Approval } from '../../../../../shared/types/approvals';
import type { QuickSessionRow } from '../../../../../shared/types/quickSessions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function stage(position: number, label: string, over: Partial<BoardStage> = {}): BoardStage {
  return {
    id: over.id ?? `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: over.hint ?? null,
    position,
    write_policy: over.write_policy ?? 'asserted',
    is_terminal: over.is_terminal ?? false,
    hidden_by_default: over.hidden_by_default ?? false,
  };
}

const STAGES: BoardStage[] = [
  stage(1, 'Idea'),
  stage(6, 'Ready for development'),
  stage(7, 'In development', { write_policy: 'derived' }),
  stage(9, 'Done', { is_terminal: true }),
];

const BOARD: Board = {
  id: 'board-1',
  project_id: 1,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: STAGES,
};

let idCounter = 0;
function item(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  idCounter += 1;
  const n = idCounter;
  return {
    id: `id-${n}`,
    project_id: 1,
    type: 'task',
    ref: `TASK-${n}`,
    title: `Item ${n}`,
    summary: null,
    body: null,
    priority: 'P2',
    category: 'feature',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-6',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    memberships: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

const idea = (over: Partial<BacklogTaskItem> = {}): BacklogTaskItem =>
  item({ type: 'idea', ref: 'IDEA-1', stage_id: 's-1', stage_position: 1, approved_at: null, ...over });

const doneTask = (over: Partial<BacklogTaskItem> = {}): BacklogTaskItem =>
  item({ stage_id: 's-9', stage_position: 9, isDone: true, ...over });

function mount(tasks: BacklogTaskItem[]): void {
  backlogStore.__set({ tasks, boards: [BOARD] });
  render(<ProjectOverviewPage projectId={1} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  backlogStore.__set({ tasks: [], boards: [BOARD] });
});

// ---------------------------------------------------------------------------
// 1. Page-state routing
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — page-state routing', () => {
  it('empty-new-existing: an empty backlog with unknown codebase freshness shows the existing-codebase card set', async () => {
    mount([]);
    expect(await screen.findByTestId('overview-backlog-empty')).toBeInTheDocument();
    // The hardcoded existing-codebase card set (capture-idea only exists there).
    expect(screen.getByTestId('overview-action-launch-planner')).toBeInTheDocument();
    expect(screen.getByTestId('overview-action-capture-idea')).toBeInTheDocument();
  });

  it('empty-ideas: open ideas with no tasks keeps the ideas list and shows the no-tasks well', async () => {
    mount([idea({ title: 'Project overview page' })]);
    expect(await screen.findByText('Project overview page')).toBeInTheDocument();
    expect(screen.getByTestId('overview-nextup-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-backlog-empty')).not.toBeInTheDocument();
    // Derived (not hardcoded) card set for this state — capture-idea exists
    // only in the hardcoded sets.
    expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();
  });

  it('empty-drained: shipped tasks + open ideas + a dry queue shows the drained next-up well', async () => {
    mount([idea({ title: 'Notification digest' }), doneTask({ title: 'Shipped thing' })]);
    expect(await screen.findByTestId('overview-nextup-empty')).toBeInTheDocument();
    expect(
      screen.getByText('Task queue is empty — everything captured has shipped'),
    ).toBeInTheDocument();
  });

  it('empty-done: everything shipped renders the Backlog-clear banner and the milestone card set', async () => {
    mount([doneTask({ title: 'Shipped thing' })]);
    expect(await screen.findByTestId('overview-backlog-clear')).toBeInTheDocument();
    expect(screen.getByTestId('overview-action-plan-next-milestone')).toBeInTheDocument();
    // The two selectable lists are replaced by the banner in this state.
    expect(screen.queryByText('Top ideas')).not.toBeInTheDocument();
  });

  it('normal: ready tasks render the Next-up list, no empty wells', async () => {
    mount([idea({ title: 'An idea' }), item({ title: 'A ready task' })]);
    expect(await screen.findByText('A ready task')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-nextup-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('overview-backlog-empty')).not.toBeInTheDocument();
    expect(screen.getByText('Next up · Ready for development')).toBeInTheDocument();
  });

  it('renders the project name in the header and the active-agents empty well when nothing is live', async () => {
    mount([]);
    expect(await screen.findByRole('heading', { name: 'cyboflow' })).toBeInTheDocument();
    expect(screen.getByTestId('overview-active-agents-empty')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Dismissal
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — recommended-action dismissal', () => {
  it('hides the card and persists its id → fingerprint under the per-project key', async () => {
    const user = userEvent.setup();
    mount([]);

    const card = await screen.findByTestId('overview-action-capture-idea');
    expect(card).toBeInTheDocument();

    await user.click(screen.getByTestId('overview-action-dismiss-capture-idea'));

    await waitFor(() => {
      expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();
    });
    expect(
      JSON.parse(localStorage.getItem(OVERVIEW_DISMISSED_KEY(1)) ?? '{}') as Record<
        string,
        string
      >,
    ).toHaveProperty('capture-idea');
  });

  it('stays dismissed on a fresh mount (the persisted record is read back at init)', async () => {
    // The hardcoded empty-state cards carry the constant fingerprint 'static'.
    localStorage.setItem(OVERVIEW_DISMISSED_KEY(1), JSON.stringify({ 'capture-idea': 'static' }));
    mount([]);
    expect(await screen.findByTestId('overview-action-launch-planner')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();
  });

  it('resurfaces a card whose stored fingerprint no longer matches', async () => {
    localStorage.setItem(
      OVERVIEW_DISMISSED_KEY(1),
      JSON.stringify({ 'capture-idea': 'some-stale-fingerprint' }),
    );
    mount([]);
    expect(await screen.findByTestId('overview-action-capture-idea')).toBeInTheDocument();
  });

  it('dismissing EVERY card grows the toggle into the full-width "all dismissed" well', async () => {
    const user = userEvent.setup();
    mount([]);

    // The empty-new-existing hardcoded set has three cards; dismiss them all.
    for (const id of ['launch-planner', 'capture-idea', 'verify-setup']) {
      await user.click(await screen.findByTestId(`overview-action-dismiss-${id}`));
    }

    const toggle = screen.getByTestId('overview-dismissed-toggle');
    expect(toggle).toHaveTextContent('All pending actions dismissed');
    expect(toggle).toHaveTextContent('View dismissed actions (3)');
    await user.click(toggle);
    expect(screen.getByTestId('overview-dismissed-action-capture-idea')).toBeInTheDocument();
  });

  it('"View dismissed" reveals still-qualifying dismissed cards, and Restore brings one back', async () => {
    const user = userEvent.setup();
    mount([]);

    await user.click(await screen.findByTestId('overview-action-dismiss-capture-idea'));
    expect(screen.queryByTestId('overview-action-capture-idea')).not.toBeInTheDocument();

    const toggle = screen.getByTestId('overview-dismissed-toggle');
    expect(toggle).toHaveTextContent('View dismissed (1)');
    await user.click(toggle);
    expect(screen.getByTestId('overview-dismissed-action-capture-idea')).toBeInTheDocument();

    await user.click(screen.getByTestId('overview-action-restore-capture-idea'));
    expect(await screen.findByTestId('overview-action-capture-idea')).toBeInTheDocument();
    expect(screen.queryByTestId('overview-dismissed-toggle')).not.toBeInTheDocument();
    expect(
      JSON.parse(localStorage.getItem(OVERVIEW_DISMISSED_KEY(1)) ?? '{}') as Record<string, string>,
    ).not.toHaveProperty('capture-idea');
  });
});

// ---------------------------------------------------------------------------
// 2b. "Select tasks" CTA → sprint batch picker
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — Select tasks opens the batch picker', () => {
  it('clicking the launch-sprint CTA opens TaskBatchPickerModal', async () => {
    const user = userEvent.setup();
    mount([idea({ title: 'An idea' }), item({ title: 'A ready task' })]);

    expect(screen.queryByTestId('task-batch-picker-modal')).not.toBeInTheDocument();
    await user.click(await screen.findByTestId('overview-action-cta-launch-sprint'));
    expect(screen.getByTestId('task-batch-picker-modal')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 3. Store-init ownership (Codex-review regression)
// ---------------------------------------------------------------------------

describe('ProjectOverviewPage — store-init ownership', () => {
  it('never init()s the app-owned singleton stores, and disposes only its own ref-counted quick-sessions handle on unmount', () => {
    backlogStore.__set({ tasks: [], boards: [BOARD] });
    const { unmount } = render(<ProjectOverviewPage projectId={1} />);

    // App.tsx owns these three for the app's lifetime; their init() returns the
    // ONE cached global teardown, so a page-scoped call would sever app-wide
    // subscriptions on unmount.
    expect(backlogStore.getState().init).not.toHaveBeenCalled();
    expect(reviewQueueStore.getState().init).not.toHaveBeenCalled();
    expect(activeRunsStore.getState().init).not.toHaveBeenCalled();

    // The one store the page DOES own a mount/unmount pair for.
    expect(quickSessionsStore.getState().init).toHaveBeenCalledTimes(1);
    expect(quickInitDisposer).not.toHaveBeenCalled();
    unmount();
    expect(quickInitDisposer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Checkpoint navigation (Codex-review regression)
// ---------------------------------------------------------------------------

function quickRow(over: Partial<QuickSessionRow> = {}): QuickSessionRow {
  return {
    sessionId: 'sess-q1',
    name: 'release prep',
    projectId: 1,
    runId: 'run-q1',
    state: 'blocked',
    idleSince: null,
    unviewed: false,
    restedAtIso: null,
    rawStatus: 'running',
    exitCode: null,
    summary: null,
    summaryState: null,
    waitingOn: null,
    summarySupported: true,
    worktreeName: 'dusty-sparrow',
    git: null,
    ...over,
  };
}

function approval(over: Partial<Approval> = {}): Approval {
  return {
    id: 'appr-1',
    runId: 'run-q1',
    workflowName: '__quick__',
    toolName: 'Bash',
    payloadPreview: 'git push -u origin dusty-sparrow',
    rationale: 'Pushing the session branch.',
    createdAt: '2026-08-28T00:00:00.000Z',
    status: 'pending',
    sessionName: 'release prep',
    worktreeName: null,
    agentProvider: 'claude',
    awaited: true,
    ...over,
  };
}

describe('ProjectOverviewPage — checkpoint navigation', () => {
  it("a quick-session approval's Open in session routes via setActiveQuickSession, never setActiveRun", async () => {
    // A __quick__-sentinel run cannot resolve a workflow definition, so
    // setActiveRun would strand the center pane on "Loading workflow…".
    const user = userEvent.setup();
    quickSessionsStore.__set({ rows: [quickRow()] });
    reviewQueueStore.__set({ queue: [approval()] });
    mount([]);

    const card = await screen.findByTestId('overview-checkpoint-appr-1');
    await user.click(within(card).getByRole('button', { name: 'Open in session →' }));

    expect(cyboflowStore.getState().setActiveQuickSession).toHaveBeenCalledWith(
      'sess-q1',
      'run-q1',
    );
    expect(cyboflowStore.getState().setActiveRun).not.toHaveBeenCalled();
    expect(navigationStore.getState().goToSession).toHaveBeenCalled();

    quickSessionsStore.__set({ rows: [] });
    reviewQueueStore.__set({ queue: [] });
  });
});
