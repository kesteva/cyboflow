/**
 * DraggableProjectTreeView — active-session tree renderer tests.
 *
 * The rail lists active open sessions (reactive to the session store), not a
 * historic log of workflow runs. Covers:
 *   (a) session rows render under an expanded project (by name)
 *   (b) main-repo sessions are excluded
 *   (c) clicking a quick session (no runId) → setActiveQuickSession(id, undefined) + setActiveProjectId
 *   (d) clicking a runId-backed session → setActiveQuickSession(id, runId) + setActiveProjectId
 *       (panel surface, NOT setActiveRun — avoids the __quick__ workflow-pane bug)
 *   (d2) clicking a session that HOSTS an active workflow run → setActiveRun (run pane,
 *        not the resting QuickSessionCanvas)
 *   (e) status indicator dot class differs across session statuses
 *   (f) empty session list renders the per-project "Start new session" CTA
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { Session } from '../../types/session';

// ---------------------------------------------------------------------------
// Shared mutable state for mocks
// ---------------------------------------------------------------------------

let mockSessions: Session[] = [];
const mockSetActiveRun = vi.fn();
const mockSetActiveQuickSession = vi.fn();
const mockNavigateToSessions = vi.fn();
const mockSetActiveProjectId = vi.fn();
const mockCloseHumanReview = vi.fn();

// ---------------------------------------------------------------------------
// Mock API.projects.getAll
// ---------------------------------------------------------------------------

vi.mock('../../utils/api', () => ({
  API: {
    projects: {
      getAll: vi.fn(async () => ({
        success: true,
        data: [
          {
            id: 1,
            name: 'Alpha Project',
            path: '/alpha',
            active: false,
            build_script: null,
            run_script: null,
            created_at: '2026-01-01',
            updated_at: '2026-01-01',
            displayOrder: 0,
          },
        ],
      })),
      detectBranch: vi.fn(async () => ({ success: false })),
      reorder: vi.fn(async () => ({ success: true })),
    },
    folders: {
      getByProject: vi.fn(async () => ({ success: true, data: [] })),
      update: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      reorder: vi.fn(),
      move: vi.fn(),
      moveSession: vi.fn(),
    },
    dialog: {
      openDirectory: vi.fn(),
    },
  },
}));

// ---------------------------------------------------------------------------
// Mock sessionStore — supplies the rail's session rows
// ---------------------------------------------------------------------------

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { sessions: Session[] }) => unknown) => selector({ sessions: mockSessions }),
    {
      getState: () => ({ sessions: mockSessions }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock cyboflowStore — selectors return null (no active highlight); getState
// exposes the lifecycle navigation actions used by handleSessionClick.
// ---------------------------------------------------------------------------

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: Object.assign(
    (_selector: unknown) => null,
    {
      getState: () => ({
        setActiveRun: mockSetActiveRun,
        setActiveQuickSession: mockSetActiveQuickSession,
      }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock navigationStore
// ---------------------------------------------------------------------------

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    (selector: (s: { activeProjectId: number | null }) => unknown) =>
      selector({ activeProjectId: null }),
    {
      getState: () => ({
        navigateToSessions: mockNavigateToSessions,
        navigateToProject: vi.fn(),
        setActiveProjectId: mockSetActiveProjectId,
        closeHumanReview: mockCloseHumanReview,
        closeBacklog: vi.fn(),
        goToSession: vi.fn(),
        goToWizard: vi.fn(),
        goHome: vi.fn(),
      }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock heavy sub-components and stores
// ---------------------------------------------------------------------------

vi.mock('../SessionListItem', () => ({ SessionListItem: () => null }));
vi.mock('../ProjectSettings', () => ({ default: () => null }));
vi.mock('../EmptyState', () => ({
  EmptyState: ({ title, description }: { title: string; description: string }) => (
    <div>
      <div>{title}</div>
      <div>{description}</div>
    </div>
  ),
}));
vi.mock('../LoadingSpinner', () => ({ LoadingSpinner: () => <div>Loading...</div> }));
vi.mock('../ui/Modal', () => ({
  Modal: ({ children, isOpen }: { children: React.ReactNode; isOpen: boolean }) =>
    isOpen ? <div>{children}</div> : null,
  ModalHeader: ({ title }: { title?: string }) => (title ? <div>{title}</div> : null),
  ModalBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModalFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../ui/Button', () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));
vi.mock('../ui/EnhancedInput', () => ({
  EnhancedInput: ({ onChange, value, placeholder }: {
    onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
    value?: string;
    placeholder?: string;
  }) => <input onChange={onChange} value={value} placeholder={placeholder} />,
}));
vi.mock('../ui/FieldWithTooltip', () => ({
  FieldWithTooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../ui/Card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../../stores/errorStore', () => ({
  useErrorStore: () => ({ showError: vi.fn() }),
}));
vi.mock('../../contexts/ContextMenuContext', () => ({
  useContextMenu: () => ({
    menuState: { type: null, payload: null, position: null },
    openMenu: vi.fn(),
    closeMenu: vi.fn(),
    isMenuOpen: () => false,
  }),
}));
vi.mock('../../utils/debounce', () => ({
  debounce: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('../../utils/performanceUtils', () => ({
  throttle: (fn: (...args: unknown[]) => unknown) => fn,
}));

// Mock the activeRunsStore — the rail lists active workflow runs from here. We
// drive its rows directly per-test so we can assert the workflow-run status dot
// classes (e.g. the static amber 'paused' dot, Phase 4b) without standing up the
// real tRPC subscriptions. `init` is a no-op; `refresh` resolves; selectors read
// the seeded `runsByProject`.
let mockRunsByProject: Record<number, unknown[]> = {};
vi.mock('../../stores/activeRunsStore', () => {
  // Full mocked store state — both the reactive selector path (runsByProject,
  // refresh) and the getState path (init) read from here so every call site in
  // the component resolves to a real value.
  const state = () => ({
    runsByProject: mockRunsByProject,
    init: () => () => {},
    refresh: async () => {},
  });
  return {
    useActiveRunsStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state },
    ),
  };
});

// ---------------------------------------------------------------------------
// window.electronAPI stub factory
// ---------------------------------------------------------------------------

function makeElectronAPI(expandedProjects: number[] = []) {
  return {
    uiState: {
      getExpanded: vi.fn().mockResolvedValue(
        expandedProjects.length > 0
          ? {
              success: true,
              data: {
                expandedProjects,
                expandedFolders: [],
              },
            }
          : { success: false },
      ),
      saveExpanded: vi.fn().mockResolvedValue({ success: true }),
    },
    projects: {
      getRunningScript: vi.fn().mockResolvedValue({ success: false }),
      stopScript: vi.fn(),
      runScript: vi.fn(),
    },
    git: {
      cancelStatusForProject: vi.fn().mockResolvedValue({ success: true }),
    },
    folders: {
      getByProject: vi.fn().mockResolvedValue({ success: true, data: [] }),
    },
    events: null,
    invoke: vi.fn().mockResolvedValue({ success: false }),
  };
}

beforeEach(() => {
  mockSetActiveRun.mockReset();
  mockSetActiveQuickSession.mockReset();
  mockNavigateToSessions.mockReset();
  mockSetActiveProjectId.mockReset();
  mockCloseHumanReview.mockReset();
  mockRunsByProject = {};
  // Default: project 1 pre-expanded
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: makeElectronAPI([1]),
  });
});

// ---------------------------------------------------------------------------
// Import the component AFTER all mocks are configured
// ---------------------------------------------------------------------------

import { DraggableProjectTreeView } from '../DraggableProjectTreeView';

// ---------------------------------------------------------------------------
// Test data factory
// ---------------------------------------------------------------------------

let sessionCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
  sessionCounter += 1;
  return {
    id: `sess-${sessionCounter}`,
    name: `session-${sessionCounter}`,
    worktreePath: '/tmp/wt',
    prompt: '',
    status: 'stopped',
    createdAt: '2026-01-01 12:00:00',
    output: [],
    jsonMessages: [],
    projectId: 1,
    isMainRepo: false,
    runId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: render with pre-expanded project 1
// ---------------------------------------------------------------------------

async function renderExpanded() {
  let container: HTMLElement;
  await act(async () => {
    const result = render(<DraggableProjectTreeView />);
    container = result.container;
  });
  await waitFor(() => {
    expect(screen.getByText('Alpha Project')).toBeInTheDocument();
  });
  return container!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DraggableProjectTreeView — active-session tree', () => {
  it('(a) renders session rows under an expanded project', async () => {
    mockSessions = [
      makeSession({ name: 'quick-aaa' }),
      makeSession({ name: 'quick-bbb' }),
      makeSession({ name: 'quick-ccc' }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('quick-aaa')).toBeInTheDocument();
      expect(screen.getByText('quick-bbb')).toBeInTheDocument();
      expect(screen.getByText('quick-ccc')).toBeInTheDocument();
    });
  });

  it('(b) excludes main-repo sessions from the rail', async () => {
    mockSessions = [
      makeSession({ name: 'real-session' }),
      makeSession({ name: 'main-repo-session', isMainRepo: true }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('real-session')).toBeInTheDocument();
    });
    expect(screen.queryByText('main-repo-session')).not.toBeInTheDocument();
  });

  it('(b2) excludes archived sessions from the rail', async () => {
    // The store is hydrated from getAllSessions() (which includes archived rows),
    // so the rail must filter them — otherwise a dismissed (archived) session lingers.
    mockSessions = [
      makeSession({ name: 'active-session' }),
      makeSession({ name: 'archived-session', archived: true }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('active-session')).toBeInTheDocument();
    });
    expect(screen.queryByText('archived-session')).not.toBeInTheDocument();
  });

  it('(c) clicking a quick session (no runId) triggers setActiveQuickSession + setActiveProjectId', async () => {
    mockSessions = [makeSession({ id: 'sess-quick', name: 'quick-CLICK', projectId: 1, runId: null })];

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('quick-CLICK')).toBeInTheDocument());

    const row = screen.getByText('quick-CLICK').closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-quick', undefined);
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockSetActiveRun).not.toHaveBeenCalled();
    // Picking a session must dismiss the human-review pane (else the center
    // stays pinned to the review queue — the reported navigation bug).
    expect(mockCloseHumanReview).toHaveBeenCalled();
  });

  it('(d) clicking a runId-backed session opens the panel surface via setActiveQuickSession(id, runId)', async () => {
    mockSessions = [makeSession({ id: 'sess-wf', name: 'wf-CLICK', projectId: 1, runId: 'run-xyz' })];

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('wf-CLICK')).toBeInTheDocument());

    const row = screen.getByText('wf-CLICK').closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    // Quick sessions get a backfilled runId (TASK-788); reopening must NOT route
    // through setActiveRun (workflow-run pane) — that throws on the __quick__
    // sentinel in getPhaseState. Pass runId so the approval subscription starts.
    expect(mockSetActiveQuickSession).toHaveBeenCalledWith('sess-wf', 'run-xyz');
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockSetActiveRun).not.toHaveBeenCalled();
    expect(mockCloseHumanReview).toHaveBeenCalled();
  });

  it('(d2) clicking a session that HOSTS an active workflow run opens the run pane via setActiveRun', async () => {
    // Regression: a session co-hosting a live (non-terminal) workflow run must open
    // the RUN pane, not the resting "No active run" QuickSessionCanvas — the
    // mismatch where clicking the run vs. its session gave two different views.
    // The run is matched by workflow_runs.session_id in runsByProject (which is
    // already terminal-filtered and excludes the __quick__ sentinel).
    mockSessions = [makeSession({ id: 'sess-host', name: 'host-CLICK', projectId: 1, runId: null })];
    mockRunsByProject = {
      1: [makeRun({ id: 'run-live-1', session_id: 'sess-host', status: 'running' })],
    };

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('host-CLICK')).toBeInTheDocument());

    const row = screen.getByText('host-CLICK').closest('[role="button"]');
    expect(row).not.toBeNull();
    fireEvent.click(row!);

    expect(mockSetActiveRun).toHaveBeenCalledWith('run-live-1', 'sess-host');
    expect(mockSetActiveQuickSession).not.toHaveBeenCalled();
    expect(mockSetActiveProjectId).toHaveBeenCalledWith(1);
    expect(mockCloseHumanReview).toHaveBeenCalled();
  });

  it('(e) status indicator dot class differs across session statuses', async () => {
    mockSessions = [
      makeSession({ name: 'sess-running', status: 'running' }),
      makeSession({ name: 'sess-error', status: 'error' }),
      makeSession({ name: 'sess-ready', status: 'ready' }),
    ];

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('sess-running')).toBeInTheDocument());

    const runningDot = document.querySelector('span[title="running"]');
    const errorDot = document.querySelector('span[title="error"]');
    const readyDot = document.querySelector('span[title="ready"]');

    expect(runningDot).not.toBeNull();
    expect(errorDot).not.toBeNull();
    expect(readyDot).not.toBeNull();

    expect(runningDot!.className).toContain('bg-status-success');
    expect(errorDot!.className).toContain('bg-status-error');
    expect(readyDot!.className).toContain('bg-status-neutral');

    expect(runningDot!.className).not.toEqual(errorDot!.className);
    expect(runningDot!.className).not.toEqual(readyDot!.className);
  });

  it('(f) empty session list renders the "Start new session" CTA', async () => {
    mockSessions = [];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('Start new session')).toBeInTheDocument();
    });
    expect(
      screen.queryByText('No open sessions. Start one with Quick Session.'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Workflow-run status dot (Phase 4b paused visuals)
// ---------------------------------------------------------------------------

let runCounter = 0;
function makeRun(overrides: Record<string, unknown> = {}) {
  runCounter += 1;
  return {
    id: `run-${runCounter}-aaaaaaaa`,
    workflow_id: 'wf-1',
    project_id: 1,
    status: 'running',
    substrate: 'sdk',
    worktree_path: '/tmp/wt',
    branch_name: `branch-${runCounter}`,
    session_id: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    started_at: null,
    ended_at: null,
    stuck_reason: null,
    workflowName: 'planner',
    ...overrides,
  };
}

describe('DraggableProjectTreeView — workflow-run status dots', () => {
  beforeEach(() => {
    mockSessions = [];
  });

  it('renders a STATIC (non-pulsing) amber dot for a paused run', async () => {
    mockRunsByProject = { 1: [makeRun({ status: 'paused' })] };

    await renderExpanded();

    const pausedDot = await waitFor(() => {
      const dot = document.querySelector('span[title="paused"]');
      expect(dot).not.toBeNull();
      return dot!;
    });

    // Amber/warning hue, and NOT animate-pulse (a paused run is at rest, distinct
    // from the pulsing awaiting_review attention state).
    expect(pausedDot.className).toContain('bg-status-warning');
    expect(pausedDot.className).not.toContain('animate-pulse');
  });

  it('renders a PULSING amber dot for awaiting_review (distinct from paused)', async () => {
    mockRunsByProject = { 1: [makeRun({ status: 'awaiting_review' })] };

    await renderExpanded();

    const reviewDot = await waitFor(() => {
      const dot = document.querySelector('span[title="awaiting_review"]');
      expect(dot).not.toBeNull();
      return dot!;
    });

    expect(reviewDot.className).toContain('bg-status-warning');
    expect(reviewDot.className).toContain('animate-pulse');
  });

  it('renders a pulsing amber dot for awaiting_input (consistency)', async () => {
    mockRunsByProject = { 1: [makeRun({ status: 'awaiting_input' })] };

    await renderExpanded();

    const inputDot = await waitFor(() => {
      const dot = document.querySelector('span[title="awaiting_input"]');
      expect(dot).not.toBeNull();
      return dot!;
    });

    expect(inputDot.className).toContain('bg-status-warning');
    expect(inputDot.className).toContain('animate-pulse');
  });
});

// ---------------------------------------------------------------------------
// Run nesting under the parent session (workflow_runs.session_id)
// ---------------------------------------------------------------------------

describe('DraggableProjectTreeView — runs nest under their session', () => {
  it('nests a run with a matching session_id under its session row (label drops the redundant session suffix)', async () => {
    mockSessions = [makeSession({ id: 'sess-A', name: 'quick-A', projectId: 1 })];
    mockRunsByProject = {
      1: [makeRun({ session_id: 'sess-A', workflowName: 'sprint', branch_name: 'quick-A' })],
    };

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('quick-A')).toBeInTheDocument());

    // The run is rendered INSIDE the session's wrapper (the marginLeft:16px div
    // that holds the session row), not as a top-level sibling.
    const sessionRow = screen.getByText('quick-A').closest('[role="button"]');
    expect(sessionRow).not.toBeNull();
    const sessionWrapper = sessionRow!.parentElement;
    expect(sessionWrapper).not.toBeNull();

    // Nested label is JUST the workflow name (no "· quick-A" suffix), and it lives
    // within the session wrapper.
    const nestedRun = within(sessionWrapper as HTMLElement).getByText('sprint');
    expect(nestedRun).toBeInTheDocument();
    expect(screen.queryByText('sprint · quick-A')).toBeNull();
  });

  it('renders a run whose parent session is absent as a top-level row with the branch suffix', async () => {
    // session_id points at a session not in the active list → treated as parentless.
    mockSessions = [];
    mockRunsByProject = {
      1: [makeRun({ session_id: 'sess-gone', workflowName: 'planner', branch_name: 'orphan-br' })],
    };

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('planner · orphan-br')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// A/B variant chip (migration 048) — denormalized workflow_runs.variant_label
// ---------------------------------------------------------------------------

describe('DraggableProjectTreeView — A/B variant chip', () => {
  it('renders the variant chip on a nested (session-hosted) run carrying variant_label', async () => {
    mockSessions = [makeSession({ id: 'sess-A', name: 'quick-A', projectId: 1 })];
    mockRunsByProject = {
      1: [makeRun({ session_id: 'sess-A', workflowName: 'sprint', branch_name: 'quick-A', variant_label: 'Variant B' })],
    };

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('Variant B')).toBeInTheDocument());
  });

  it('renders the variant chip on a parentless run carrying variant_label', async () => {
    mockSessions = [];
    mockRunsByProject = {
      1: [makeRun({ session_id: 'sess-gone', workflowName: 'planner', branch_name: 'orphan-br', variant_label: 'Variant A' })],
    };

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('Variant A')).toBeInTheDocument());
  });

  it('omits the chip for a baseline run (no variant_label)', async () => {
    mockSessions = [];
    mockRunsByProject = {
      1: [makeRun({ session_id: 'sess-gone', workflowName: 'planner', branch_name: 'orphan-br' })],
    };

    await renderExpanded();
    await waitFor(() => expect(screen.getByText('planner · orphan-br')).toBeInTheDocument());
    expect(screen.queryByTitle(/^Variant:/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Empty saved expansion must not lock projects collapsed (collapse regression)
// ---------------------------------------------------------------------------

/**
 * getExpanded resolves success:true with EMPTY arrays — the exact persisted
 * state (`treeView.expandedProjects = []`) that locked every project collapsed.
 * Note this is distinct from `makeElectronAPI([])`, which resolves success:false
 * ("never saved"); the original guard treated the two the same only by accident,
 * and the empty-but-present case is what shipped the bug.
 */
function makeElectronAPISavedEmpty() {
  return {
    ...makeElectronAPI([]),
    uiState: {
      getExpanded: vi.fn().mockResolvedValue({
        success: true,
        data: { expandedProjects: [], expandedFolders: [] },
      }),
      saveExpanded: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

describe('DraggableProjectTreeView — empty saved expansion', () => {
  it('auto-expands a project with sessions even when the saved expansion exists but is empty', async () => {
    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      value: makeElectronAPISavedEmpty(),
    });
    mockSessions = [makeSession({ name: 'visible-on-boot', projectId: 1 })];

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());
    // Empty arrays are truthy: the old guard restored the empty set, collapsing
    // every project and hiding this row. The fixed guard falls through to
    // auto-expand, so the session renders.
    await waitFor(() => expect(screen.getByText('visible-on-boot')).toBeInTheDocument());
  });

  it('auto-expands once the session store hydrates after the initial load (race fix)', async () => {
    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      value: makeElectronAPISavedEmpty(),
    });
    // No sessions at first load → the load-time auto-expand opens nothing.
    mockSessions = [];

    let utils: ReturnType<typeof render>;
    await act(async () => {
      utils = render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());
    expect(screen.queryByText('late-session')).toBeNull();

    // Sessions hydrate after the initial load; the reactive effect must expand
    // the project so the late-arriving session becomes visible without a reload.
    mockSessions = [makeSession({ name: 'late-session', projectId: 1 })];
    await act(async () => {
      utils!.rerender(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('late-session')).toBeInTheDocument());
  });

  it('respects a non-empty saved layout and does not force-expand a project the user left collapsed', async () => {
    // Saved layout is non-empty but does NOT include project 1. Even though
    // project 1 has a session, the reactive auto-expand must stay out of the way
    // (the user's explicit layout is authoritative), so the row stays hidden.
    Object.defineProperty(window, 'electronAPI', {
      writable: true,
      value: makeElectronAPI([999]),
    });
    mockSessions = [makeSession({ name: 'collapsed-session', projectId: 1 })];

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());
    // restoredSavedExpansionRef is true → reactive auto-expand is skipped →
    // project 1 (absent from the saved set) stays collapsed → its session is not
    // rendered.
    expect(screen.queryByText('collapsed-session')).toBeNull();
  });
});
