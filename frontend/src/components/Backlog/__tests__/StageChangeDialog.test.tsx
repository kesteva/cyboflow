/**
 * Component tests for StageChangeDialog — the manual "Change stage…" picker.
 *
 * Covers: the warning is always shown; the picker excludes the current / derived
 * / Decomposed stages; confirming forwards the full setStage payload (incl.
 * expectedVersion) and closes; a rejecting move surfaces the friendly error and
 * keeps the dialog open.
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
    stages: [
      stage(1, 'Idea'),
      stage(5, 'Tasks extracted'),
      stage(6, 'Ready for development'),
      stage(7, 'In development', { write_policy: 'derived' }),
      stage(11, 'Archived', { is_terminal: true, hidden_by_default: true }),
      stage(12, 'Decomposed', { is_terminal: true }),
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
    stage_id: 's-5',
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

describe('StageChangeDialog', () => {
  it('renders nothing when closed', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('stage-change-dialog')).not.toBeInTheDocument();
  });

  it('always shows the manual-move warning and the current stage', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    expect(screen.getByTestId('stage-change-warning')).toBeInTheDocument();
    expect(screen.getByText('Tasks extracted')).toBeInTheDocument();
  });

  it('offers only user-settable stages (no current / derived / Decomposed)', () => {
    render(<StageChangeDialog task={makeTask()} board={board()} isOpen onClose={vi.fn()} />);
    const select = screen.getByTestId('stage-change-select') as HTMLSelectElement;
    const optionLabels = Array.from(select.options).map((o) => o.textContent);
    expect(optionLabels).toContain('Idea');
    expect(optionLabels).toContain('Ready for development');
    expect(optionLabels).toContain('Archived');
    // current (Tasks extracted), derived (In development), Decomposed excluded
    expect(optionLabels).not.toContain('Tasks extracted');
    expect(optionLabels).not.toContain('In development');
    expect(optionLabels).not.toContain('Decomposed');
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
