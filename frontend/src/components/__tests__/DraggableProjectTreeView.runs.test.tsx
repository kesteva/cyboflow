/**
 * DraggableProjectTreeView — run-centric tree renderer tests (TASK-687).
 *
 * Covers:
 *   (a) 3 mocked runs render under an expanded project
 *   (b) ordering is newest-first by created_at (server returns DESC order)
 *   (c) each row shows the last-6 characters of the workflow_id
 *   (d) status indicator CSS class differs across statuses
 *   (e) clicking a row triggers useCyboflowStore.setActiveRun
 *   (f) empty listRuns response renders "No runs yet. Use Start Run."
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import type { WorkflowRunListRow } from '../../utils/cyboflowApi';

// ---------------------------------------------------------------------------
// Shared mutable state for mocks
// ---------------------------------------------------------------------------

let mockRuns: WorkflowRunListRow[] = [];
const mockSetActiveRun = vi.fn();
const mockNavigateToSessions = vi.fn();

// ---------------------------------------------------------------------------
// Mock cyboflowApi.listRuns
// ---------------------------------------------------------------------------

vi.mock('../../utils/cyboflowApi', () => ({
  listRuns: vi.fn(async () => mockRuns),
  subscribeToStreamEvents: vi.fn(() => () => {}),
  startRun: vi.fn(),
  approveRun: vi.fn(),
  listWorkflows: vi.fn(async () => []),
}));

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
// Mock cyboflowStore
// ---------------------------------------------------------------------------

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: Object.assign(
    (_selector: unknown) => null,
    {
      getState: () => ({ setActiveRun: mockSetActiveRun }),
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
      }),
    },
  ),
}));

// ---------------------------------------------------------------------------
// Mock heavy sub-components and stores
// ---------------------------------------------------------------------------

vi.mock('../CreateSessionDialog', () => ({ CreateSessionDialog: () => null }));
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
                sessionSortAscending: false,
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
  mockNavigateToSessions.mockReset();
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

let runCounter = 0;
function makeRun(overrides: Partial<WorkflowRunListRow> = {}): WorkflowRunListRow {
  runCounter += 1;
  return {
    id: `run-${runCounter}`,
    workflow_id: `wf-${runCounter}-aabbccddee`,
    project_id: 1,
    status: 'running',
    worktree_path: '/tmp/worktree',
    branch_name: 'cyboflow/test',
    created_at: '2026-01-01 12:00:00',
    updated_at: '2026-01-01 12:00:00',
    started_at: '2026-01-01 12:00:00',
    ended_at: null,
    stuck_reason: null,
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
  // Wait for async data loads to settle
  await waitFor(() => {
    expect(screen.getByText('Alpha Project')).toBeInTheDocument();
  });
  return container!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DraggableProjectTreeView — run-centric tree', () => {
  it('(a) renders 3 run rows under an expanded project', async () => {
    mockRuns = [
      makeRun({ workflow_id: 'wf-aaaaaa111111', created_at: '2026-01-03 12:00:00' }),
      makeRun({ workflow_id: 'wf-aaaaaa222222', created_at: '2026-01-02 12:00:00' }),
      makeRun({ workflow_id: 'wf-aaaaaa333333', created_at: '2026-01-01 12:00:00' }),
    ];

    await renderExpanded();

    // Each run row renders the last-6 of its workflow_id
    await waitFor(() => {
      expect(screen.getByText('111111')).toBeInTheDocument();
      expect(screen.getByText('222222')).toBeInTheDocument();
      expect(screen.getByText('333333')).toBeInTheDocument();
    });
  });

  it('(b) run rows appear newest-first (server returns DESC order)', async () => {
    // Supply runs in newest-first order as the server would return them
    mockRuns = [
      makeRun({ workflow_id: 'wf-newest-aabbcc', created_at: '2026-01-03 12:00:00' }),
      makeRun({ workflow_id: 'wf-middle-ddeeff', created_at: '2026-01-02 12:00:00' }),
      makeRun({ workflow_id: 'wf-oldest-112233', created_at: '2026-01-01 12:00:00' }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('aabbcc')).toBeInTheDocument();
      expect(screen.getByText('112233')).toBeInTheDocument();
    });

    // Verify DOM order: newest should appear before oldest in the markup
    const allText = document.body.innerHTML;
    const newestPos = allText.indexOf('aabbcc');
    const oldestPos = allText.indexOf('112233');
    expect(newestPos).toBeGreaterThan(-1);
    expect(oldestPos).toBeGreaterThan(-1);
    expect(newestPos).toBeLessThan(oldestPos);
  });

  it('(c) each run row shows the last-6 characters of workflow_id', async () => {
    mockRuns = [
      makeRun({ workflow_id: 'wf-abcdef-LAST12', created_at: '2026-01-02 12:00:00' }),
      makeRun({ workflow_id: 'wf-ghijkl-XYZUVW', created_at: '2026-01-01 12:00:00' }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('LAST12')).toBeInTheDocument();
      expect(screen.getByText('XYZUVW')).toBeInTheDocument();
    });
  });

  it('(d) status indicator dot class differs across statuses', async () => {
    mockRuns = [
      makeRun({ workflow_id: 'wf-running-rrrrr1', status: 'running', created_at: '2026-01-03 12:00:00' }),
      makeRun({ workflow_id: 'wf-failed-ffffff', status: 'failed', created_at: '2026-01-02 12:00:00' }),
      makeRun({ workflow_id: 'wf-completed-ccccc', status: 'completed', created_at: '2026-01-01 12:00:00' }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('rrrrr1')).toBeInTheDocument();
    });

    // Find status dots by their title attribute (we set title={run.status} on the dot)
    const runningDot = document.querySelector('span[title="running"]');
    const failedDot = document.querySelector('span[title="failed"]');
    const completedDot = document.querySelector('span[title="completed"]');

    expect(runningDot).not.toBeNull();
    expect(failedDot).not.toBeNull();
    expect(completedDot).not.toBeNull();

    expect(runningDot!.className).toContain('bg-status-success');
    expect(failedDot!.className).toContain('bg-status-error');
    expect(completedDot!.className).toContain('bg-status-neutral');

    // Statuses should have different CSS classes
    expect(runningDot!.className).not.toEqual(failedDot!.className);
    expect(runningDot!.className).not.toEqual(completedDot!.className);
  });

  it('(e) clicking a run row triggers setActiveRun on the cyboflow store', async () => {
    const runId = 'run-clickme-unique';
    mockRuns = [
      makeRun({ id: runId, workflow_id: 'wf-click-CLICK6', created_at: '2026-01-01 12:00:00' }),
    ];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('CLICK6')).toBeInTheDocument();
    });

    // Find the run row via role="button"
    const runRow = screen.getByText('CLICK6').closest('[role="button"]');
    expect(runRow).not.toBeNull();

    fireEvent.click(runRow!);

    expect(mockSetActiveRun).toHaveBeenCalledWith(runId);
  });

  it('(f) empty listRuns renders "No runs yet. Use Start Run."', async () => {
    mockRuns = [];

    await renderExpanded();

    await waitFor(() => {
      expect(screen.getByText('No runs yet. Use Start Run.')).toBeInTheDocument();
    });
  });
});
