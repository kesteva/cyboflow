/**
 * Component tests for StageChangeDialog — the manual "Change stage…" picker.
 *
 * Covers: the warning is always shown; the four-stage board picker excludes the
 * current stage and keeps the terminal "Won't do" as a manual target; confirming
 * forwards the full setStage payload (incl. expectedVersion) and closes; a
 * rejecting move surfaces the friendly error and keeps the dialog open.
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

import { StageChangeDialog } from '../StageChangeDialog';

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

function board(): Board {
  return {
    id: 'board-1',
    project_id: 7,
    name: 'Default',
    kind: 'default',
    is_default: true,
    // Four-stage board (migration 036): Idea, Ready for development, Done,
    // Won't do (terminal, hidden_by_default). All four are asserted.
    stages: [
      stage(1, 'Idea'),
      stage(6, 'Ready for development'),
      stage(9, 'Done', { is_terminal: true }),
      stage(10, "Won't do", { is_terminal: true, hidden_by_default: true }),
    ],
  };
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
    archived_at: null,
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
  mockSetStage.mockClear();
  mockSetStage.mockResolvedValue({ taskId: 'tsk_1' });
});

describe('StageChangeDialog', () => {
  it('renders nothing when closed', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('stage-change-dialog')).not.toBeInTheDocument();
  });

  it('always shows the manual-move warning and the current stage', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    expect(screen.getByTestId('stage-change-warning')).toBeInTheDocument();
    // The task sits at Idea (s-1); the dialog names its current stage.
    expect(screen.getByText('Idea')).toBeInTheDocument();
  });

  it('reflects the selected target stage in the warning', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    // No stage chosen yet → the warning does not name a target.
    expect(screen.getByTestId('stage-change-warning')).not.toHaveTextContent('Ready for development');
    fireEvent.change(screen.getByTestId('stage-change-select'), { target: { value: 's-6' } });
    expect(screen.getByTestId('stage-change-warning')).toHaveTextContent('Ready for development');
  });

  it('offers user-settable stages, excludes the current stage, keeps terminal Won\'t do', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    const select = screen.getByTestId('stage-change-select') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('Ready for development');
    expect(optionLabels).toContain('Done');
    // The terminal "Won't do" stays a valid manual target.
    expect(optionLabels).toContain("Won't do");
    // The item's current stage (Idea) is excluded — moving to it is a no-op.
    expect(optionLabels).not.toContain('Idea');
  });

  it('forwards the setStage payload with expectedVersion and closes on success', async () => {
    const onClose = vi.fn();
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByTestId('stage-change-select'), { target: { value: 's-6' } });
    fireEvent.click(screen.getByTestId('stage-change-confirm'));
    await waitFor(() => expect(mockSetStage).toHaveBeenCalledTimes(1));
    expect(mockSetStage).toHaveBeenCalledWith({
      projectId: 7,
      taskId: 'tsk_1',
      stageId: 's-6',
      expectedVersion: 4,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('keeps the dialog open and shows the friendly error when the move is rejected', async () => {
    mockSetStage.mockRejectedValueOnce(new Error('active_runs: cancel active runs first'));
    const onClose = vi.fn();
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={onClose} />);
    fireEvent.change(screen.getByTestId('stage-change-select'), { target: { value: 's-6' } });
    fireEvent.click(screen.getByTestId('stage-change-confirm'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/active run/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('disables the confirm button until a stage is chosen', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    expect(screen.getByTestId('stage-change-confirm')).toBeDisabled();
  });
});
