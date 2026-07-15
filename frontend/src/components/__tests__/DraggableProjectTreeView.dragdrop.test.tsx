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
import { render, screen, waitFor, act, fireEvent, createEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Session } from '../../types/session';
import type { Folder } from '../../types/folder';
import type { ExperimentRow } from '../../../../shared/types/experiments';
import type { RailExperimentData } from '../../hooks/useRailExperiments';

const { mockReorder, mockSessionsReorder, mockFoldersMove, mockShowError, mockSetSessions } = vi.hoisted(() => ({
  mockReorder: vi.fn(),
  mockSessionsReorder: vi.fn(),
  mockFoldersMove: vi.fn(),
  mockShowError: vi.fn(),
  mockSetSessions: vi.fn(),
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
    sessions: {
      reorder: (...a: unknown[]) => mockSessionsReorder(...a),
    },
    dialog: { openDirectory: vi.fn() },
  },
}));

let mockSessions: Session[] = [];
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: Object.assign(
    (selector: (s: { sessions: Session[]; setSessions: (sessions: Session[]) => void }) => unknown) =>
      selector({ sessions: mockSessions, setSessions: mockSetSessions }),
    { getState: () => ({ sessions: mockSessions, setSessions: mockSetSessions }) },
  ),
}));

let mockRailByProject: Record<number, RailExperimentData> = {};
vi.mock('../../hooks/useRailExperiments', () => ({
  useRailExperiments: () => ({ byProject: mockRailByProject, refetch: vi.fn() }),
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
  mockSessionsReorder.mockReset().mockResolvedValue({ success: true });
  mockFoldersMove.mockReset().mockResolvedValue({ success: true });
  mockShowError.mockReset();
  mockSetSessions.mockReset().mockImplementation((sessions: Session[]) => {
    mockSessions = sessions;
  });
  mockSessions = [];
  mockRailByProject = {};
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

function session(id: string, name: string, projectId: number, displayOrder: number): Session {
  return {
    id,
    name,
    projectId,
    displayOrder,
    worktreePath: `/tmp/${id}`,
    prompt: '',
    status: 'ready',
    createdAt: '2026-01-01',
    output: [],
    jsonMessages: [],
  };
}

function experiment(overrides: Partial<ExperimentRow> = {}): ExperimentRow {
  return {
    id: 'exp-1',
    project_id: 1,
    workflow_id: 'sprint',
    kind: 'side_by_side',
    base_branch: 'main',
    base_sha: 'abc123',
    variant_a_id: 'variant-a',
    variant_b_id: 'variant-b',
    run_a_id: null,
    run_b_id: null,
    session_a_id: 'arm-a',
    session_b_id: 'arm-b',
    seed_idea_id: null,
    seed_idea_clone_a_id: null,
    seed_idea_clone_b_id: null,
    status: 'running',
    winner_run_id: null,
    winner_arm: null,
    merge_sha: null,
    decided_at: null,
    rerun_of_experiment_id: null,
    promoted_variant_id: null,
    promoted_arm: null,
    promoted_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...overrides,
  };
}

function setRowRect(row: HTMLElement): void {
  vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    height: 40,
    bottom: 40,
    left: 0,
    right: 200,
    width: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
}

function dragOverAt(row: HTMLElement, clientY: number, transfer: ReturnType<typeof dataTransfer>): Event {
  const event = createEvent.dragOver(row, { dataTransfer: transfer });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(row, event);
  return event;
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

describe('DraggableProjectTreeView — session reorder', () => {
  it('sets the drag-transfer contract, prevents dragover default, and uses the row midpoint for an after-drop', async () => {
    mockSessions = [
      session('one', 'Session One', 1, 0),
      session('two', 'Session Two', 1, 1),
      session('three', 'Session Three', 1, 2),
    ];
    await renderTree();

    const source = draggableOf('Session Three');
    const target = draggableOf('Session One');
    setRowRect(target);
    const transfer = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });

    expect(transfer.effectAllowed).toBe('move');
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'three');

    // The row midpoint is y=20; y=35 must choose the "after" insertion point.
    const dragOverEvent = dragOverAt(target, 35, transfer);
    expect(dragOverEvent.defaultPrevented).toBe(true);
    await act(async () => {
      fireEvent.drop(target, { clientY: 35, dataTransfer: transfer });
    });

    await waitFor(() => expect(mockSessionsReorder).toHaveBeenCalledWith([
      { id: 'one', displayOrder: 0 },
      { id: 'three', displayOrder: 1 },
      { id: 'two', displayOrder: 2 },
    ]));
  });

  it('persists the draggable rows by session id while excluding an interleaved experiment group', async () => {
    mockSessions = [
      session('one', 'Session One', 1, 0),
      session('arm-a', 'Arm A session', 1, 1),
      session('two', 'Session Two', 1, 2),
      session('arm-b', 'Arm B session', 1, 3),
      session('three', 'Session Three', 1, 4),
    ];
    mockRailByProject = {
      1: { experiments: [experiment()], summariesById: {} },
    };
    await renderTree();

    const source = draggableOf('Session Three');
    const target = draggableOf('Session One');
    setRowRect(target);
    const transfer = dataTransfer();
    fireEvent.dragStart(source, { dataTransfer: transfer });
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'three');
    dragOverAt(target, 5, transfer);
    await act(async () => {
      fireEvent.drop(target, { clientY: 5, dataTransfer: transfer });
    });

    await waitFor(() => expect(mockSessionsReorder).toHaveBeenCalledTimes(1));
    expect(mockSessionsReorder).toHaveBeenCalledWith([
      { id: 'three', displayOrder: 0 },
      { id: 'one', displayOrder: 1 },
      { id: 'two', displayOrder: 2 },
    ]);
    expect(mockSessionsReorder.mock.calls[0][0]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'arm-a' }), expect.objectContaining({ id: 'arm-b' })]),
    );
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text.indexOf('Session Three')).toBeLessThan(text.indexOf('Session One'));
    });
  });

  it('surfaces a reorder failure and leaves the rendered order unchanged', async () => {
    mockSessionsReorder.mockResolvedValue({ success: false, error: 'db locked' });
    mockSessions = [
      session('one', 'Session One', 1, 0),
      session('two', 'Session Two', 1, 1),
      session('three', 'Session Three', 1, 2),
    ];
    await renderTree();

    const source = draggableOf('Session Three');
    const target = draggableOf('Session One');
    setRowRect(target);
    fireEvent.dragStart(source, { dataTransfer: dataTransfer() });
    dragOverAt(target, 5, dataTransfer());
    await act(async () => {
      fireEvent.drop(target, { clientY: 5, dataTransfer: dataTransfer() });
    });

    await waitFor(() => expect(mockShowError).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Failed to reorder sessions', error: 'db locked' }),
    ));
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Session One')).toBeLessThan(text.indexOf('Session Three'));
    expect(mockSetSessions).not.toHaveBeenCalled();
  });

  it('treats cross-project and experiment-group anchored drops as no-ops', async () => {
    mockSessions = [
      session('one', 'Session One', 1, 0),
      session('arm-a', 'Arm A session', 1, 1),
      session('arm-b', 'Arm B session', 1, 2),
      session('other-project', 'Other Project Session', 2, 0),
    ];
    mockRailByProject = {
      1: { experiments: [experiment()], summariesById: {} },
    };
    await renderTree();

    const source = draggableOf('Session One');
    const crossProjectTarget = draggableOf('Other Project Session');
    setRowRect(crossProjectTarget);
    fireEvent.dragStart(source, { dataTransfer: dataTransfer() });
    dragOverAt(crossProjectTarget, 5, dataTransfer());
    fireEvent.drop(crossProjectTarget, { clientY: 5, dataTransfer: dataTransfer() });

    fireEvent.dragStart(source, { dataTransfer: dataTransfer() });
    const groupRow = screen.getByTitle('Experiment running').closest('[role="button"]');
    expect(groupRow).not.toBeNull();
    fireEvent.drop(groupRow as HTMLElement, { dataTransfer: dataTransfer() });
    await act(async () => { await Promise.resolve(); });

    expect(mockSessionsReorder).not.toHaveBeenCalled();
  });

  it('renders a newly added highest-display-order session at the bottom', async () => {
    mockSessions = [
      session('one', 'Session One', 1, 0),
      session('two', 'Session Two', 1, 1),
    ];
    const result = render(<DraggableProjectTreeView />);
    await waitFor(() => expect(screen.getByText('Session Two')).toBeInTheDocument());

    // Model the event-time array shape defensively: even if a caller supplied the
    // new row first, display_order remains the rail's source of truth.
    mockSessions = [
      session('new', 'New Session', 1, 2),
      session('one', 'Session One', 1, 0),
      session('two', 'Session Two', 1, 1),
    ];
    result.rerender(<DraggableProjectTreeView />);

    await waitFor(() => expect(screen.getByText('New Session')).toBeInTheDocument());
    const text = document.body.textContent ?? '';
    expect(text.indexOf('Session Two')).toBeLessThan(text.indexOf('New Session'));
  });
});
