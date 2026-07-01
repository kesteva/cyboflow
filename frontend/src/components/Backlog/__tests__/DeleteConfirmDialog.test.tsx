/**
 * Component tests for DeleteConfirmDialog — the per-card danger "Delete" confirm.
 *
 * Covers: confirming calls tasks.delete and closes; the cascade note is shown
 * for epics with children (using childCount) and for ideas (generic clause) but
 * not for solo tasks; an active_runs / concurrency rejection surfaces the
 * friendly error and keeps the dialog open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

const { mockDelete } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { delete: { mutate: mockDelete } } } },
}));

import { DeleteConfirmDialog } from '../DeleteConfirmDialog';

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
  mockDelete.mockReset().mockResolvedValue({ taskId: 'tsk_1' });
});

describe('DeleteConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<DeleteConfirmDialog task={makeTask()} isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument();
  });

  it('deletes via tasks.delete and closes on success', async () => {
    const onClose = vi.fn();
    render(<DeleteConfirmDialog task={makeTask()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('delete-confirm-button'));
    await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
    expect(mockDelete).toHaveBeenCalledWith({ projectId: 7, taskId: 'tsk_1' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('states permanence and shows NO cascade note for a solo task', () => {
    render(<DeleteConfirmDialog task={makeTask()} isOpen onClose={vi.fn()} />);
    expect(screen.getByTestId('delete-confirm-dialog')).toHaveTextContent(/cannot be undone/i);
    expect(screen.queryByTestId('delete-cascade-note')).not.toBeInTheDocument();
  });

  it('shows the child-count cascade note for an epic with children', () => {
    render(
      <DeleteConfirmDialog
        task={makeTask({ id: 'epc_1', type: 'epic', ref: 'EPIC-001', childCount: 3 })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-cascade-note')).toHaveTextContent(
      'Its 3 child tasks will be deleted too.',
    );
  });

  it('uses singular phrasing for an epic with one child', () => {
    render(
      <DeleteConfirmDialog
        task={makeTask({ id: 'epc_1', type: 'epic', ref: 'EPIC-001', childCount: 1 })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-cascade-note')).toHaveTextContent(
      'Its 1 child task will be deleted too.',
    );
  });

  it('shows the generic cascade clause for an idea', () => {
    render(
      <DeleteConfirmDialog
        task={makeTask({ id: 'idea_1', type: 'idea', ref: 'IDEA-001' })}
        isOpen
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('delete-cascade-note')).toHaveTextContent(
      'Any epics and tasks created from this idea will be deleted too.',
    );
  });

  it('shows the friendly error and stays open when the delete is blocked by active runs', async () => {
    mockDelete.mockRejectedValueOnce(new Error('active_runs: cancel active runs first'));
    const onClose = vi.fn();
    render(<DeleteConfirmDialog task={makeTask()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('delete-confirm-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/active run/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('maps a concurrency rejection to the retry message', async () => {
    mockDelete.mockRejectedValueOnce(new Error('concurrency: version mismatch'));
    render(<DeleteConfirmDialog task={makeTask()} isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId('delete-confirm-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/changed since you opened it/i);
  });
});
