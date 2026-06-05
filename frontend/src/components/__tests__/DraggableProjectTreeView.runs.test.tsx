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
 *   (e) status indicator dot class differs across session statuses
 *   (f) empty session list renders the per-project "Start new session" CTA
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
