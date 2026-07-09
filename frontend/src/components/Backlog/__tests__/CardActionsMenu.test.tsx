/**
 * Component tests for CardActionsMenu — the per-card ⋯ overflow menu.
 *
 * Covers: the menu exposes Change stage… + Archive + Delete for an active item;
 * an archived item (`archived_at` stamped — archive-in-place, no stage check)
 * swaps Archive for Unarchive; Unarchive mutates tasks.archive {archived:false}
 * directly (no dialog) and surfaces a friendly error inline on rejection;
 * Change stage / Archive / Delete are disabled while the card has an active
 * run; Archive/Delete open their confirm dialogs; the component renders nothing
 * without a board.
 *
 * The backlog store is mocked (mirrors BacklogPane.test.tsx) so the menu reads a
 * fixed board snapshot; the trpc client is mocked for Unarchive + the dialogs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

let mockBoards: Board[] = [];

vi.mock('../../../stores/backlogStore', () => {
  const useBacklogStore = (selector: (s: { boards: Board[] }) => unknown) =>
    selector({ boards: mockBoards });
  useBacklogStore.getState = () => ({ boards: mockBoards });
  return { useBacklogStore };
});

const { mockSetStage, mockArchive, mockDelete } = vi.hoisted(() => ({
  mockSetStage: vi.fn(),
  mockArchive: vi.fn(),
  mockDelete: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        setStage: { mutate: mockSetStage },
        archive: { mutate: mockArchive },
        delete: { mutate: mockDelete },
      },
    },
  },
}));

import { CardActionsMenu } from '../CardActionsMenu';

function stage(position: number, label: string, opts: Partial<BoardStage> = {}): BoardStage {
  return {
    id: opts.id ?? `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: null,
    position,
    write_policy: opts.write_policy ?? 'asserted',
    is_terminal: opts.is_terminal ?? false,
    hidden_by_default: opts.hidden_by_default ?? false,
  };
}

const BOARD: Board = {
  id: 'board-1',
  project_id: 7,
  name: 'Default',
  kind: 'default',
  is_default: true,
  stages: [stage(1, 'Idea'), stage(6, 'Ready for development')],
};

function makeTask(overrides: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'tsk_1',
    project_id: 7,
    type: 'task',
    ref: 'TASK-001',
    title: 'Wire the parser',
    summary: null,
    body: null,
    priority: 'P2',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 's-1',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 4,
    stage_position: 1,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockBoards = [BOARD];
  mockSetStage.mockReset().mockResolvedValue({ taskId: 'tsk_1' });
  mockArchive.mockReset().mockResolvedValue({ taskId: 'tsk_1' });
  mockDelete.mockReset().mockResolvedValue({ taskId: 'tsk_1' });
});

describe('CardActionsMenu', () => {
  it('renders nothing when the project has no board', () => {
    mockBoards = [];
    render(<CardActionsMenu task={makeTask()} />);
    expect(screen.queryByTestId('task-actions-trigger')).not.toBeInTheDocument();
  });

  it('exposes Change stage…, Archive and Delete (no Unarchive, no hint) for an active item', () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.queryByText('Unarchive')).not.toBeInTheDocument();
    // Enabled items carry no disabled-reason hint.
    expect(screen.queryByText('Finish or cancel the active run first.')).not.toBeInTheDocument();
  });

  it('falls back to the default board of the SAME project when board_id is not in the store', () => {
    const otherProjectBoard: Board = { ...BOARD, id: 'board-9', project_id: 9 };
    mockBoards = [otherProjectBoard, BOARD];
    render(<CardActionsMenu task={makeTask({ board_id: 'gone' })} />);
    // BOARD (project 7) is is_default, so the project-narrowed fallback resolves
    // it → the menu still renders.
    expect(screen.getByTestId('task-actions-trigger')).toBeInTheDocument();
  });

  it('swaps Archive for Unarchive once the item is archived in place', () => {
    render(<CardActionsMenu task={makeTask({ archived_at: '2026-02-01T00:00:00.000Z' })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…')).toBeInTheDocument();
    expect(screen.getByText('Unarchive')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('Unarchive mutates tasks.archive {archived:false} directly, with no dialog', async () => {
    render(<CardActionsMenu task={makeTask({ archived_at: '2026-02-01T00:00:00.000Z' })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Unarchive'));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledTimes(1));
    expect(mockArchive).toHaveBeenCalledWith({
      projectId: 7,
      taskId: 'tsk_1',
      archived: false,
      expectedVersion: 4,
    });
    expect(screen.queryByTestId('archive-confirm-dialog')).not.toBeInTheDocument();
  });

  it('surfaces a friendly inline error when Unarchive is rejected', async () => {
    mockArchive.mockRejectedValueOnce(new Error('concurrency: version mismatch'));
    render(<CardActionsMenu task={makeTask({ archived_at: '2026-02-01T00:00:00.000Z' })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Unarchive'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since you opened it/i);
  });

  it('disables Change stage, Archive and Delete (with a hint) while the card has an active run', () => {
    render(
      <CardActionsMenu task={makeTask({ inFlow: [{ agent: 'planner', runId: 'r1', stepId: null }] })} />,
    );
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…').closest('button')).toBeDisabled();
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
    expect(screen.getAllByText('Finish or cancel the active run first.').length).toBeGreaterThan(0);
  });

  it('disables actions while the card is awaiting review (non-terminal run the server would reject)', () => {
    render(<CardActionsMenu task={makeTask({ awaitingReview: true })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…').closest('button')).toBeDisabled();
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getByText('Delete').closest('button')).toBeDisabled();
  });

  it('opens the archive confirm dialog from the Archive item', () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Archive'));
    expect(screen.getByTestId('archive-confirm-dialog')).toBeInTheDocument();
  });

  it('opens the delete confirm dialog from the Delete item', () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Delete'));
    expect(screen.getByTestId('delete-confirm-dialog')).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
