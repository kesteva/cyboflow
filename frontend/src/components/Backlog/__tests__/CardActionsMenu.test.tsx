/**
 * Component tests for CardActionsMenu — the per-card ⋯ overflow menu.
 *
 * Covers: the menu exposes Change stage… + Archive; Archive is hidden once the
 * item already sits in the Archived stage; both items are disabled while the
 * card has an active run; the component renders nothing without a board.
 *
 * The backlog store is mocked (mirrors BacklogPane.test.tsx) so the menu reads a
 * fixed board snapshot; the trpc client is mocked because the (closed) dialogs
 * import it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

let mockBoards: Board[] = [];

vi.mock('../../../stores/backlogStore', () => {
  const useBacklogStore = (selector: (s: { boards: Board[] }) => unknown) =>
    selector({ boards: mockBoards });
  useBacklogStore.getState = () => ({ boards: mockBoards });
  return { useBacklogStore };
});

vi.mock('../../../trpc/client', () => ({
  trpc: { cyboflow: { tasks: { setStage: { mutate: vi.fn() } } } },
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
  stages: [
    stage(1, 'Idea'),
    stage(6, 'Ready for development'),
    stage(11, 'Archived', { id: 's-arch', is_terminal: true, hidden_by_default: true }),
  ],
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
  mockBoards = [BOARD];
});

describe('CardActionsMenu', () => {
  it('renders nothing when the project has no board', () => {
    mockBoards = [];
    render(<CardActionsMenu task={makeTask()} />);
    expect(screen.queryByTestId('task-actions-trigger')).not.toBeInTheDocument();
  });

  it('exposes Change stage… and Archive (with no active-run hint) for a normal item', () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…')).toBeInTheDocument();
    expect(screen.getByText('Archive')).toBeInTheDocument();
    // Enabled items carry no disabled-reason hint.
    expect(screen.queryByText('Finish or cancel the active run first.')).not.toBeInTheDocument();
  });

  it('falls back to the default board when the task board_id is not in the store', () => {
    render(<CardActionsMenu task={makeTask({ board_id: 'gone' })} />);
    // BOARD is is_default, so pickDefaultBoard resolves it → the menu still renders.
    expect(screen.getByTestId('task-actions-trigger')).toBeInTheDocument();
  });

  it('hides Archive when the item already sits in the Archived stage', () => {
    render(<CardActionsMenu task={makeTask({ stage_id: 's-arch' })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…')).toBeInTheDocument();
    expect(screen.queryByText('Archive')).not.toBeInTheDocument();
  });

  it('disables both actions (with a hint) while the card has an active run', () => {
    render(
      <CardActionsMenu task={makeTask({ inFlow: [{ agent: 'planner', runId: 'r1', stepId: null }] })} />,
    );
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…').closest('button')).toBeDisabled();
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
    expect(screen.getAllByText('Finish or cancel the active run first.').length).toBeGreaterThan(0);
  });

  it('disables actions while the card is awaiting review (non-terminal run the server would reject)', () => {
    render(<CardActionsMenu task={makeTask({ awaitingReview: true })} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    expect(screen.getByText('Change stage…').closest('button')).toBeDisabled();
    expect(screen.getByText('Archive').closest('button')).toBeDisabled();
  });
});
