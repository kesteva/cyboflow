/**
 * DraggableProjectTreeView — the project/folder drag-and-drop handlers, driven
 * through the component with focused mocks (the 1570-line file is not snapshotted).
 *
 * Covers:
 *   - handleProjectDrop reorder → API.projects.reorder(full order), local order
 *     flips only on {success:true}; failure → showError, order unchanged.
 *   - a folder dropped on a project header → API.folders.move(folderId, null).
 *   - handleFolderDrop A-onto-B → move(A, B.id) + auto-expands B (its child shows).
 *   - a folder dropped on itself → no move.
 *   - dragCounter: an over-highlight clears only when the enter/leave count hits 0.
 */
import '@testing-library/jest-dom';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../types/session';
import type { Folder } from '../../types/folder';

const { mockReorder, mockFoldersMove, mockShowError } = vi.hoisted(() => ({
  mockReorder: vi.fn(),
  mockFoldersMove: vi.fn(),
  mockShowError: vi.fn(),
}));

// The action layer (reorder / folders.move) lives on API.*; folder *loading*
// goes through window.electronAPI.folders.getByProject (stubbed below).
vi.mock('../../utils/api', () => ({
  API: {
    projects: {
      getAll: vi.fn(async () => ({
        success: true,
        data: [
          { id: 1, name: 'Alpha Project', path: '/alpha', active: false, build_script: null, run_script: null, created_at: '2026-01-01', updated_at: '2026-01-01', displayOrder: 0 },
          { id: 2, name: 'Beta Project', path: '/beta', active: false, build_script: null, run_script: null, created_at: '2026-01-01', updated_at: '2026-01-01', displayOrder: 1 },
        ],
      })),
      detectBranch: vi.fn(async () => ({ success: false })),
      reorder: (...a: unknown[]) => mockReorder(...a),
    },
    folders: {
      getByProject: vi.fn(async () => ({ success: true, data: [] })),
      update: vi.fn(),
      delete: vi.fn(),
      create: vi.fn(),
      reorder: vi.fn(),
      move: (...a: unknown[]) => mockFoldersMove(...a),
      moveSession: vi.fn(),
    },
    dialog: { openDirectory: vi.fn() },
  },
}));

let mockSessions: Session[] = [];
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { sessions: Session[] }) => unknown) => selector({ sessions: mockSessions }),
    { getState: () => ({ sessions: mockSessions }) },
  ),
}));

vi.mock('../../stores/cyboflowStore', () => ({
  useCyboflowStore: Object.assign((_s: unknown) => null, {
    getState: () => ({ setActiveRun: vi.fn(), setActiveQuickSession: vi.fn() }),
  }),
}));

vi.mock('../../stores/navigationStore', () => ({
  useNavigationStore: Object.assign(
    (selector: (s: { activeProjectId: number | null }) => unknown) => selector({ activeProjectId: null }),
    {
      getState: () => ({
        navigateToSessions: vi.fn(),
        navigateToProject: vi.fn(),
        setActiveProjectId: vi.fn(),
        closeHumanReview: vi.fn(),
        closeBacklog: vi.fn(),
        goToSession: vi.fn(),
        goToWizard: vi.fn(),
        goHome: vi.fn(),
      }),
    },
  ),
}));

vi.mock('../../stores/errorStore', () => ({
  useErrorStore: () => ({ showError: mockShowError }),
}));

let mockRunsByProject: Record<number, unknown[]> = {};
vi.mock('../../stores/activeRunsStore', () => {
  const state = () => ({ runsByProject: mockRunsByProject, init: () => () => {}, refresh: async () => {} });
  return {
    useActiveRunsStore: Object.assign(
      (selector: (s: ReturnType<typeof state>) => unknown) => selector(state()),
      { getState: state },
    ),
  };
});

vi.mock('../SessionListItem', () => ({ SessionListItem: () => null }));
vi.mock('../ProjectSettings', () => ({ default: () => null }));
vi.mock('../CreateProjectDialog', () => ({ CreateProjectDialog: () => null }));
vi.mock('../EmptyState', () => ({ EmptyState: () => null }));
vi.mock('../LoadingSpinner', () => ({ LoadingSpinner: () => <div>Loading...</div> }));
vi.mock('../../contexts/ContextMenuContext', () => ({
  useContextMenu: () => ({ menuState: { type: null, payload: null, position: null }, openMenu: vi.fn(), closeMenu: vi.fn(), isMenuOpen: () => false }),
}));
vi.mock('../../utils/debounce', () => ({ debounce: (fn: (...a: unknown[]) => unknown) => fn }));
vi.mock('../../utils/performanceUtils', () => ({ throttle: (fn: (...a: unknown[]) => unknown) => fn }));

// Folder catalogue per project — Alpha has two root folders (B carries a child C
// that stays hidden until B expands); Beta has none.
let mockFoldersByProject: Record<number, Folder[]> = {};
function folder(id: string, name: string, projectId: number, parentFolderId: string | null = null): Folder {
  return { id, name, projectId, parentFolderId, displayOrder: 0, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
}

function makeElectronAPI() {
  return {
    uiState: {
      // success:false → no saved layout → auto-expand ALL projects (folders render).
      getExpanded: vi.fn().mockResolvedValue({ success: false }),
      saveExpanded: vi.fn().mockResolvedValue({ success: true }),
    },
    projects: { getRunningScript: vi.fn().mockResolvedValue({ success: false }), stopScript: vi.fn(), runScript: vi.fn() },
    git: { cancelStatusForProject: vi.fn().mockResolvedValue({ success: true }) },
    folders: {
      getByProject: vi.fn(async (pid: number) => ({ success: true, data: mockFoldersByProject[pid] ?? [] })),
    },
    events: null,
    invoke: vi.fn().mockResolvedValue({ success: false }),
  };
}

beforeEach(() => {
  mockReorder.mockReset().mockResolvedValue({ success: true });
  mockFoldersMove.mockReset().mockResolvedValue({ success: true });
  mockShowError.mockReset();
  mockSessions = [];
  mockRunsByProject = {};
  mockFoldersByProject = {
    1: [folder('f-a', 'Folder A', 1), folder('f-b', 'Folder B', 1), folder('f-c', 'Folder C', 1, 'f-b')],
    2: [],
  };
  Object.defineProperty(window, 'electronAPI', { writable: true, value: makeElectronAPI() });
});

import { DraggableProjectTreeView } from '../DraggableProjectTreeView';

/** A dataTransfer stub — dragStart writes effectAllowed + setData. */
function dataTransfer() {
  return { effectAllowed: '', setData: vi.fn(), getData: vi.fn(() => ''), files: [] as File[] };
}

function draggableOf(text: string): HTMLElement {
  const el = screen.getByText(text).closest('[draggable="true"]');
  expect(el).not.toBeNull();
  return el as HTMLElement;
}

async function renderTree() {
  await act(async () => {
    render(<DraggableProjectTreeView />);
  });
  await waitFor(() => expect(screen.getByText('Alpha Project')).toBeInTheDocument());
  // Folders load in a follow-on effect — wait for a root folder to appear.
  await waitFor(() => expect(screen.getByText('Folder A')).toBeInTheDocument());
}

describe('DraggableProjectTreeView — project reorder drop', () => {
  it('reorders via API.projects.reorder(full order) and flips the local order on success', async () => {
    await renderTree();
    // Drag Beta (source) onto Alpha (target).
    fireEvent.dragStart(draggableOf('Beta Project'), { dataTransfer: dataTransfer() });
    await act(async () => {
      fireEvent.drop(draggableOf('Alpha Project'), { dataTransfer: dataTransfer() });
    });
    await waitFor(() => expect(mockReorder).toHaveBeenCalledTimes(1));
    // Full order payload, Beta hoisted to index 0.
    expect(mockReorder).toHaveBeenCalledWith([
      { id: 2, displayOrder: 0 },
      { id: 1, displayOrder: 1 },
    ]);
    // Local state applied the new order → Beta now renders before Alpha.
    await waitFor(() => {
      const names = screen.getAllByText(/Project$/).map((n) => n.textContent);
      expect(names.indexOf('Beta Project')).toBeLessThan(names.indexOf('Alpha Project'));
    });
  });

  it('surfaces showError and does NOT reorder locally when reorder fails', async () => {
    mockReorder.mockResolvedValue({ success: false, error: 'db locked' });
    await renderTree();
    fireEvent.dragStart(draggableOf('Beta Project'), { dataTransfer: dataTransfer() });
    await act(async () => {
      fireEvent.drop(draggableOf('Alpha Project'), { dataTransfer: dataTransfer() });
    });
    await waitFor(() => expect(mockShowError).toHaveBeenCalled());
    expect(mockShowError.mock.calls[0][0]).toMatchObject({ title: 'Failed to reorder projects' });
    // Order unchanged (Alpha still first).
    const names = screen.getAllByText(/Project$/).map((n) => n.textContent);
    expect(names.indexOf('Alpha Project')).toBeLessThan(names.indexOf('Beta Project'));
  });
});

describe('DraggableProjectTreeView — folder drops', () => {
  it('a folder dropped on a project header moves it to the project root (parent=null)', async () => {
    await renderTree();
    fireEvent.dragStart(draggableOf('Folder A'), { dataTransfer: dataTransfer() });
    await act(async () => {
      fireEvent.drop(draggableOf('Beta Project'), { dataTransfer: dataTransfer() });
    });
    await waitFor(() => expect(mockFoldersMove).toHaveBeenCalledWith('f-a', null));
  });

  it('folder-onto-folder moves under the target and auto-expands it (child appears)', async () => {
    await renderTree();
    // Folder C is a child of B, hidden while B is collapsed.
    expect(screen.queryByText('Folder C')).toBeNull();
    fireEvent.dragStart(draggableOf('Folder A'), { dataTransfer: dataTransfer() });
    await act(async () => {
      fireEvent.drop(draggableOf('Folder B'), { dataTransfer: dataTransfer() });
    });
    await waitFor(() => expect(mockFoldersMove).toHaveBeenCalledWith('f-a', 'f-b'));
    // B auto-expanded on success → its child C is now visible.
    await waitFor(() => expect(screen.getByText('Folder C')).toBeInTheDocument());
  });

  it('a folder dropped on itself is a no-op (no move)', async () => {
    await renderTree();
    fireEvent.dragStart(draggableOf('Folder A'), { dataTransfer: dataTransfer() });
    await act(async () => {
      fireEvent.drop(draggableOf('Folder A'), { dataTransfer: dataTransfer() });
    });
    // Give any async handler a tick.
    await act(async () => { await Promise.resolve(); });
    expect(mockFoldersMove).not.toHaveBeenCalled();
  });
});

describe('DraggableProjectTreeView — dragCounter highlight', () => {
  it('clears the over-highlight only when enter/leave balance reaches 0', async () => {
    await renderTree();
    const beta = draggableOf('Beta Project');
    const alpha = draggableOf('Alpha Project');

    fireEvent.dragStart(beta, { dataTransfer: dataTransfer() });
    // Two enters raise the counter to 2.
    fireEvent.dragEnter(alpha);
    fireEvent.dragEnter(alpha);
    // dragOver sets the over-target → Alpha row highlights.
    fireEvent.dragOver(alpha);
    await waitFor(() => expect(draggableOf('Alpha Project').className).toContain('bg-interactive/20'));

    // One leave (counter → 1): highlight persists.
    fireEvent.dragLeave(alpha);
    expect(draggableOf('Alpha Project').className).toContain('bg-interactive/20');

    // Second leave (counter → 0): highlight cleared.
    fireEvent.dragLeave(alpha);
    await waitFor(() => expect(draggableOf('Alpha Project').className).not.toContain('bg-interactive/20'));
  });
});
