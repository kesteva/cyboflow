/**
 * DraggableProjectTreeView — collapsed-project running-agents badge (TASK-223).
 *
 * A collapsed project header shows a pulsing running-count badge whenever it
 * hides at least one running thing (flow run active-status rows, or a quick
 * session whose own status is 'running'), so a running agent is never fully
 * hidden just because its project got collapsed post-boot. The badge:
 *   - only renders while the project is COLLAPSED (expanded rows already carry
 *     the state themselves);
 *   - counts via the SAME active/blocked/terminal split the landing page's
 *     Working section uses (`classifyRun`, homeClassify.ts) — terminal runs
 *     never count;
 *   - a session already spoken for by its own non-terminal run is not
 *     double-counted off its raw session.status;
 *   - clicking the badge expands the project (same action as the chevron).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { Session } from '../../types/session';

// ---------------------------------------------------------------------------
// Shared mutable state for mocks (mirrors DraggableProjectTreeView.runs.test.tsx)
// ---------------------------------------------------------------------------

let mockSessions: Session[] = [];
let mockRailByProject: Record<number, import('../../hooks/useRailExperiments').RailExperimentData> = {};
const mockSetActiveRun = vi.fn();
const mockSetActiveQuickSession = vi.fn();
const mockNavigateToSessions = vi.fn();
const mockSetActiveProjectId = vi.fn();
const mockNavigateToProject = vi.fn();
const mockCloseHumanReview = vi.fn();

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

vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { sessions: Session[] }) => unknown) => selector({ sessions: mockSessions }),
    {
      getState: () => ({ sessions: mockSessions }),
    },
  ),
}));

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

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    (selector: (s: { activeProjectId: number | null }) => unknown) =>
      selector({ activeProjectId: null }),
    {
      getState: () => ({
        activeProjectId: null,
        navigateToSessions: mockNavigateToSessions,
        navigateToProject: mockNavigateToProject,
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

// Mock the activeRunsStore, same shape/semantics as
// DraggableProjectTreeView.runs.test.tsx — `isTerminalRunStatus` mirrors the
// real helper (terminal = completed/failed/canceled); everything else,
// including 'awaiting_review'/'stuck'/'paused', is non-terminal.
let mockRunsByProject: Record<number, unknown[]> = {};
vi.mock('../../stores/activeRunsStore', () => {
  const state = () => ({
    runsByProject: mockRunsByProject,
    init: () => () => {},
    refresh: async () => {},
  });
  return {
    isTerminalRunStatus: (status: string) =>
      status === 'completed' || status === 'failed' || status === 'canceled',
    useActiveRunsStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state },
    ),
  };
});

vi.mock('../../hooks/useRailExperiments', () => ({
  useRailExperiments: () => ({ byProject: mockRailByProject, refetch: vi.fn() }),
}));

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
  mockNavigateToProject.mockReset();
  mockCloseHumanReview.mockReset();
  mockRunsByProject = {};
  mockRailByProject = {};
  mockSessions = [];
});

function setExpanded(expandedProjects: number[]): void {
  Object.defineProperty(window, 'electronAPI', {
    writable: true,
    value: makeElectronAPI(expandedProjects),
  });
}

/**
 * Project 1 explicitly COLLAPSED. An EMPTY saved-expansion set reads as "no
 * layout yet" and triggers the boot fallback that auto-expands EVERY project
 * (see loadProjectsWithRuns) — so collapsing project 1 for a test means giving
 * it a non-empty saved layout that simply omits project 1 (mirrors the "respects
 * a non-empty saved layout" case in DraggableProjectTreeView.runs.test.tsx).
 */
function setCollapsed(): void {
  setExpanded([999]);
}

import { DraggableProjectTreeView } from '../DraggableProjectTreeView';

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

describe('DraggableProjectTreeView — collapsed running-agents badge (TASK-223)', () => {
  it('shows the running badge on a collapsed project with an active flow run', async () => {
    setCollapsed();
    mockRunsByProject = { 1: [makeRun({ status: 'running' })] };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    const badge = await waitFor(() => screen.getByTitle('1 agent running — click to expand'));
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('1');
  });

  it('omits the badge once the project is expanded (rows carry the state instead)', async () => {
    setExpanded([1]); // project 1 pre-expanded
    mockRunsByProject = { 1: [makeRun({ status: 'running' })] };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());
    // The nested run row itself is visible while expanded.
    await waitFor(() => expect(screen.getByText(/planner/)).toBeInTheDocument());

    expect(screen.queryByTitle(/agent(s)? running/)).not.toBeInTheDocument();
  });

  it('shows nothing on a collapsed idle project (count is 0)', async () => {
    setCollapsed();
    mockSessions = [makeSession({ name: 'idle-session', status: 'ready' })];

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    expect(screen.queryByTitle(/agent(s)? running/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/awaiting you/)).not.toBeInTheDocument();
  });

  it('counts a mix of an active flow run + a running quick session, excluding a terminal run', async () => {
    setCollapsed();
    mockSessions = [
      makeSession({ id: 'sess-quick', name: 'quick-running', status: 'running' }),
      makeSession({ id: 'sess-host', name: 'host-session', status: 'ready' }),
    ];
    mockRunsByProject = {
      1: [
        // Active run hosted by sess-host — counted.
        makeRun({ id: 'run-active', session_id: 'sess-host', status: 'running' }),
        // Terminal run (own unrelated session) — excluded from the count.
        makeRun({ id: 'run-done', session_id: null, status: 'completed' }),
      ],
    };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    // 1 active run + 1 running quick session (sess-quick has no run of its own) = 2.
    const badge = await waitFor(() => screen.getByTitle('2 agents running — click to expand'));
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('2');
  });

  it('does not double-count a session already represented by its own non-terminal run', async () => {
    setCollapsed();
    mockSessions = [makeSession({ id: 'sess-host', name: 'host-session', status: 'running' })];
    mockRunsByProject = {
      1: [makeRun({ id: 'run-active', session_id: 'sess-host', status: 'running' })],
    };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    // Only the run counts once, not the run PLUS the session's own 'running' status.
    const badge = await waitFor(() => screen.getByTitle('1 agent running — click to expand'));
    expect(badge).toBeInTheDocument();
  });

  it('shows the amber blocked badge alongside the running badge when both are non-zero', async () => {
    setCollapsed();
    mockRunsByProject = {
      1: [
        makeRun({ id: 'run-active', status: 'running' }),
        makeRun({ id: 'run-blocked', status: 'awaiting_review' }),
      ],
    };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    expect(await waitFor(() => screen.getByTitle('1 agent running — click to expand'))).toBeInTheDocument();
    expect(screen.getByTitle('1 awaiting you — click to expand')).toBeInTheDocument();
  });

  it('clicking the running badge expands the project', async () => {
    setCollapsed();
    mockRunsByProject = { 1: [makeRun({ status: 'running' })] };

    await act(async () => {
      render(<DraggableProjectTreeView />);
    });
    await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());

    const badge = await waitFor(() => screen.getByTitle('1 agent running — click to expand'));
    fireEvent.click(badge);

    // Expanding surfaces the nested run row and drops the badge (no double display).
    await waitFor(() => expect(screen.getByText(/planner/)).toBeInTheDocument());
    expect(screen.queryByTitle(/agent(s)? running/)).not.toBeInTheDocument();
  });
});
