/**
 * Component tests for ArchiveConfirmDialog — the per-card "Archive" confirm.
 *
 * Covers: confirming archives IN PLACE via tasks.archive {archived:true}
 * (with expectedVersion) and closes; a rejecting archive surfaces the friendly
 * error and keeps the dialog open; the copy explains the in-place semantics
 * (keeps its column, hidden behind the Archived toggle, reversible via
 * Unarchive).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';

const { mockArchive } = vi.hoisted(() => ({
  mockArchive: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { archive: { mutate: mockArchive } } } },
}));

import { ArchiveConfirmDialog } from '../ArchiveConfirmDialog';

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
  mockArchive.mockReset().mockResolvedValue({ taskId: 'tsk_1' });
});

describe('ArchiveConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(<ArchiveConfirmDialog task={makeTask()} isOpen={false} onClose={vi.fn()} />);
    expect(screen.queryByTestId('archive-confirm-dialog')).not.toBeInTheDocument();
  });

  it('archives in place via tasks.archive (with expectedVersion) and closes on success', async () => {
    const onClose = vi.fn();
    render(<ArchiveConfirmDialog task={makeTask()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('archive-confirm-button'));
    await waitFor(() => expect(mockArchive).toHaveBeenCalledTimes(1));
    expect(mockArchive).toHaveBeenCalledWith({
      projectId: 7,
      taskId: 'tsk_1',
      archived: true,
      expectedVersion: 4,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('explains the in-place semantics: keeps its column, Archived toggle, Unarchive', () => {
    render(<ArchiveConfirmDialog task={makeTask()} isOpen onClose={vi.fn()} />);
    const body = screen.getByTestId('archive-confirm-dialog');
    expect(body).toHaveTextContent(/keeps its current column/i);
    expect(body).toHaveTextContent(/toggle Archived in the header/i);
    expect(body).toHaveTextContent(/Unarchive/);
  });

  it('shows the friendly error and stays open when archiving is rejected', async () => {
    mockArchive.mockRejectedValueOnce(new Error('active_runs: cancel active runs first'));
    const onClose = vi.fn();
    render(<ArchiveConfirmDialog task={makeTask()} isOpen onClose={onClose} />);
    fireEvent.click(screen.getByTestId('archive-confirm-button'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/active run/i);
    expect(onClose).not.toHaveBeenCalled();
  });
});
