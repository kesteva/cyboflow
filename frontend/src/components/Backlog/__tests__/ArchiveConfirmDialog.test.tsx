/**
 * Component tests for ArchiveConfirmDialog — the per-card "Archive" confirm.
 *
 * Covers: confirming archives via setStage to the board's Archived stage (with
 * expectedVersion) and closes; a rejecting archive surfaces the friendly error;
 * a board with no Archived stage disables the action.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

const { mockSetStage } = vi.hoisted(() => ({
  mockSetStage: vi.fn().mockResolvedValue({ taskId: 'tsk_1' }),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { setStage: { mutate: mockSetStage } } } },
}));

import { ArchiveConfirmDialog } from '../ArchiveConfirmDialog';

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

function board(stages: BoardStage[]): Board {
  return { id: 'board-1', project_id: 7, name: 'Default', kind: 'default', is_default: true, stages };
}

function boardWithArchive(): Board {
  return board([
    stage(1, 'Idea'),
    stage(11, 'Archived', { id: 's-arch', is_terminal: true, hidden_by_default: true }),
  ]);
}

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
    version: 4,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  mockSetStage.mockClear();
  mockSetStage.mockResolvedValue({ taskId: 'tsk_1' });
});

describe('ArchiveConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ArchiveConfirmDialog task={makeTask()} board={boardWithArchive()} isOpen={false} onClose={vi.fn()} />,
    );
    expect(screen.queryByTestId('archive-confirm-dialog')).not.toBeInTheDocument();
  });

  it('archives via setStage to the Archived stage and closes on success', async () => {
    const onClose = vi.fn();
    render(<ArchiveConfirmDialog task={makeTask()} board={boardWithArchive()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('archive-confirm-button'));
    await waitFor(() => expect(mockSetStage).toHaveBeenCalledTimes(1));
    expect(mockSetStage).toHaveBeenCalledWith({
      projectId: 7,
      taskId: 'tsk_1',
      stageId: 's-arch',
      expectedVersion: 4,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('shows the friendly error and stays open when archiving is rejected', async () => {
    mockSetStage.mockRejectedValueOnce(new Error('active_runs: cancel active runs first'));
    const onClose = vi.fn();
    render(<ArchiveConfirmDialog task={makeTask()} board={boardWithArchive()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('archive-confirm-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/active run/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the action and never calls setStage when the board has no Archived stage', () => {
    render(
      <ArchiveConfirmDialog task={makeTask()} board={board([stage(1, 'Idea')])} isOpen onClose={vi.fn()} />,
    );
    const btn = screen.getByTestId('archive-confirm-button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(mockSetStage).not.toHaveBeenCalled();
  });
});
