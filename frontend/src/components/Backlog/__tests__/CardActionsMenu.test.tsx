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
 * The tracker-sync local-removal ruling: Archive/Delete first ask
 * tracker.linksForEntity (EVERY live link, not just one), an item with an EMPTY
 * link array goes straight to its confirm dialog, a LINKED one gets
 * TrackerUnlinkDialog first — passed the whole link array so it can name every
 * provider — (and only reaches the confirm dialog once a ruling was STAGED —
 * never unlinkEntity, so backing out of the confirm mutates nothing), a
 * cascading idea/epic delete also asks tracker.hasLinkedDescendants for the
 * dialog's copy, and neither lookup failing can block the delete. Backing out
 * of the CONFIRM additionally CLEARS the staged ruling (it is keyed by entity
 * alone, so an abandoned one would stay consumable by an unrelated later
 * removal); a COMMITTED confirm does not, since its own entity write already
 * spent it.
 *
 * Reorder items (WCAG 2.5.7): Move up / Move down / Move to top appear only
 * when `onReorder` is wired, fire it with the right direction, and disable per
 * first/last-card position (canMoveUp / canMoveDown).
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

const {
  mockSetStage,
  mockArchive,
  mockDelete,
  mockLinksForEntity,
  mockHasLinkedDescendants,
  mockStageUnlinkRuling,
  mockClearUnlinkRuling,
  mockUnlinkEntity,
} = vi.hoisted(() => ({
  mockSetStage: vi.fn(),
  mockArchive: vi.fn(),
  mockDelete: vi.fn(),
  mockLinksForEntity: vi.fn(),
  mockHasLinkedDescendants: vi.fn(),
  mockStageUnlinkRuling: vi.fn(),
  mockClearUnlinkRuling: vi.fn(),
  mockUnlinkEntity: vi.fn(),
}));

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        setStage: { mutate: mockSetStage },
        archive: { mutate: mockArchive },
        delete: { mutate: mockDelete },
      },
      tracker: {
        linksForEntity: { query: mockLinksForEntity },
        hasLinkedDescendants: { query: mockHasLinkedDescendants },
        stageUnlinkRuling: { mutate: mockStageUnlinkRuling },
        clearUnlinkRuling: { mutate: mockClearUnlinkRuling },
        // Present but never expected to fire from this path any more.
        unlinkEntity: { mutate: mockUnlinkEntity },
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
    category: 'feature',
    executor: 'agent',
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
    memberships: [],
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
  // The overwhelmingly common case: nothing on this board is tracker-synced.
  mockLinksForEntity.mockReset().mockResolvedValue([]);
  mockHasLinkedDescendants.mockReset().mockResolvedValue(false);
  mockStageUnlinkRuling.mockReset().mockResolvedValue({ ok: true });
  mockClearUnlinkRuling.mockReset().mockResolvedValue({ ok: true });
  mockUnlinkEntity.mockReset().mockResolvedValue({ unlinked: true });
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
      <CardActionsMenu task={makeTask({ inFlow: [{ agent: 'planner', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }] })} />,
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

  it('opens the archive confirm dialog from the Archive item', async () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Archive'));
    expect(await screen.findByTestId('archive-confirm-dialog')).toBeInTheDocument();
  });

  it('opens the delete confirm dialog from the Delete item', async () => {
    render(<CardActionsMenu task={makeTask()} />);
    fireEvent.click(screen.getByTestId('task-actions-trigger'));
    fireEvent.click(screen.getByText('Delete'));
    expect(await screen.findByTestId('delete-confirm-dialog')).toBeInTheDocument();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  describe('tracker local-removal ruling', () => {
    const LINK = {
      provider: 'linear' as const,
      externalIdentifier: 'CORE-142',
      externalUrl: 'https://linear.app/acme/issue/CORE-142',
      removalAction: 'archive' as const,
    };
    const DART_LINK = {
      provider: 'dart' as const,
      externalIdentifier: 'DART-7',
      externalUrl: 'https://app.itsdart.com/t/DART-7',
      removalAction: 'archive' as const,
    };

    it('asks for the link on the CLICK, and an unlinked item deletes with no extra dialog', async () => {
      render(<CardActionsMenu task={makeTask()} />);
      // Nothing is asked while the card just sits there.
      expect(mockLinksForEntity).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      expect(await screen.findByTestId('delete-confirm-dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument();
      expect(mockLinksForEntity).toHaveBeenCalledTimes(1);
      expect(mockLinksForEntity).toHaveBeenCalledWith({ entityType: 'task', entityId: 'tsk_1' });
      expect(mockStageUnlinkRuling).not.toHaveBeenCalled();
      expect(mockUnlinkEntity).not.toHaveBeenCalled();
    });

    it('a LINKED item gets the ruling first; "Keep" STAGES and then opens the delete confirm', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();
      // The destructive confirm is NOT open yet — the ruling comes first.
      expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('tracker-unlink-keep'));
      await waitFor(() => expect(mockStageUnlinkRuling).toHaveBeenCalledTimes(1));
      expect(mockStageUnlinkRuling).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'tsk_1',
        cancelRemote: false,
      });
      // NOTHING was mutated to get here: the ruling is recorded, not applied.
      expect(mockUnlinkEntity).not.toHaveBeenCalled();
      expect(await screen.findByTestId('delete-confirm-dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument();
    });

    it('an entity linked to TWO providers discloses both in the ruling dialog', async () => {
      // The regression this route rename fixed: linkForEntity used to return
      // only the FIRST provider's link, so the dialog said "Archive in Linear"
      // while handleLocalRemoval/unlinkEntity would ALSO trash the Dart task,
      // undisclosed. linksForEntity returns every live link, and the dialog now
      // gets the whole array.
      mockLinksForEntity.mockResolvedValue([LINK, DART_LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      const dialog = await screen.findByTestId('tracker-unlink-dialog');
      expect(dialog).toHaveTextContent('CORE-142');
      expect(dialog).toHaveTextContent('DART-7');
      expect(screen.getByTestId('tracker-unlink-keep')).toHaveTextContent('Keep in Linear and Dart');
      expect(screen.getByTestId('tracker-unlink-cancel-remote')).toHaveTextContent(
        'Archive in Linear and Dart',
      );
    });

    it('"Archive in <provider>" stages cancelRemote and then opens the archive confirm', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask({ type: 'idea', id: 'ide_9' })} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Archive'));

      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();
      expect(mockLinksForEntity).toHaveBeenCalledWith({ entityType: 'idea', entityId: 'ide_9' });
      // An archive cascades into nothing, so the children question is not asked.
      expect(mockHasLinkedDescendants).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId('tracker-unlink-cancel-remote'));
      await waitFor(() => expect(mockStageUnlinkRuling).toHaveBeenCalledTimes(1));
      expect(mockStageUnlinkRuling).toHaveBeenCalledWith({
        entityType: 'idea',
        entityId: 'ide_9',
        cancelRemote: true,
      });
      expect(mockUnlinkEntity).not.toHaveBeenCalled();
      expect(await screen.findByTestId('archive-confirm-dialog')).toBeInTheDocument();
    });

    it('backing out of the CONFIRM behind the ruling clears it and deletes nothing', async () => {
      // The regression: the staged ruling is keyed by entity alone and stays
      // consumable for its whole TTL, so an answer the user backed out of here
      // could be spent by an unrelated later archive/delete of the same entity
      // — cancelling a tracker issue they explicitly declined to cancel.
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));
      fireEvent.click(await screen.findByTestId('tracker-unlink-cancel-remote'));

      // The ruling dialog is gone by now, so this is the CONFIRM's own Cancel.
      await screen.findByTestId('delete-confirm-dialog');
      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() =>
        expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument(),
      );
      await waitFor(() => expect(mockClearUnlinkRuling).toHaveBeenCalledTimes(1));
      expect(mockClearUnlinkRuling).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: 'tsk_1',
      });
      // Nothing else was mutated: the staging, then the discard, and no delete.
      expect(mockStageUnlinkRuling).toHaveBeenCalledTimes(1);
      expect(mockUnlinkEntity).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('COMPLETING the delete does NOT clear — its own entity write spent the ruling', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));
      fireEvent.click(await screen.findByTestId('tracker-unlink-cancel-remote'));

      await screen.findByTestId('delete-confirm-dialog');
      fireEvent.click(screen.getByTestId('delete-confirm-button'));

      await waitFor(() => expect(mockDelete).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument(),
      );
      // Clearing here would be a no-op on the main side, but it would also mean
      // the renderer cannot tell a committed confirm from an abandoned one.
      expect(mockClearUnlinkRuling).not.toHaveBeenCalled();
    });

    it('a FAILED confirm keeps the ruling until the user actually backs out', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      mockArchive.mockRejectedValueOnce(new Error('active_runs: cancel the run first'));
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Archive'));
      fireEvent.click(await screen.findByTestId('tracker-unlink-keep'));

      await screen.findByTestId('archive-confirm-dialog');
      fireEvent.click(screen.getByTestId('archive-confirm-button'));
      await waitFor(() => expect(mockArchive).toHaveBeenCalledTimes(1));

      // The write never landed, so nothing consumed the ruling and the dialog
      // is still open — no clear yet.
      expect(screen.getByTestId('archive-confirm-dialog')).toBeInTheDocument();
      expect(mockClearUnlinkRuling).not.toHaveBeenCalled();

      fireEvent.click(screen.getByText('Cancel'));
      await waitFor(() => expect(mockClearUnlinkRuling).toHaveBeenCalledTimes(1));
    });

    it('an UNLINKED item that backs out of the confirm clears nothing (no ruling was staged)', async () => {
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      await screen.findByTestId('delete-confirm-dialog');
      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() =>
        expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument(),
      );
      expect(mockClearUnlinkRuling).not.toHaveBeenCalled();
    });

    it('asks about synced children for a cascading idea/epic DELETE only', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      mockHasLinkedDescendants.mockResolvedValue(true);
      render(<CardActionsMenu task={makeTask({ type: 'idea', id: 'ide_9' })} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();
      expect(mockHasLinkedDescendants).toHaveBeenCalledWith({
        entityType: 'idea',
        entityId: 'ide_9',
      });
      expect(await screen.findByTestId('tracker-unlink-children-note')).toBeInTheDocument();
    });

    it('never asks about children for a TASK — nothing cascades under one', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();
      expect(mockHasLinkedDescendants).not.toHaveBeenCalled();
    });

    it('dismissing the ruling abandons the delete entirely', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));
      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();

      fireEvent.click(screen.getByText('Cancel'));

      await waitFor(() =>
        expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument(),
      );
      expect(screen.queryByTestId('delete-confirm-dialog')).not.toBeInTheDocument();
      expect(mockStageUnlinkRuling).not.toHaveBeenCalled();
      expect(mockUnlinkEntity).not.toHaveBeenCalled();
      expect(mockDelete).not.toHaveBeenCalled();
    });

    it('a failing link lookup never blocks the delete', async () => {
      mockLinksForEntity.mockRejectedValue(new Error('PRECONDITION_FAILED'));
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      expect(await screen.findByTestId('delete-confirm-dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('tracker-unlink-dialog')).not.toBeInTheDocument();
    });

    it('a failing children lookup never blocks the delete either', async () => {
      mockLinksForEntity.mockResolvedValue([LINK]);
      mockHasLinkedDescendants.mockRejectedValue(new Error('PRECONDITION_FAILED'));
      render(<CardActionsMenu task={makeTask({ type: 'idea', id: 'ide_9' })} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Delete'));

      // The ruling dialog still opens, just without the children sentence.
      expect(await screen.findByTestId('tracker-unlink-dialog')).toBeInTheDocument();
      expect(screen.queryByTestId('tracker-unlink-children-note')).not.toBeInTheDocument();
    });
  });

  describe('reorder items (WCAG 2.5.7 alternative to drag)', () => {
    it('hides Move up / Move down / Move to top when onReorder is not wired', () => {
      render(<CardActionsMenu task={makeTask()} />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.queryByText('Move up')).not.toBeInTheDocument();
      expect(screen.queryByText('Move down')).not.toBeInTheDocument();
      expect(screen.queryByText('Move to top')).not.toBeInTheDocument();
      // The rest of the menu is unchanged.
      expect(screen.getByText('Change stage…')).toBeInTheDocument();
    });

    it('shows the Move items when onReorder is provided', () => {
      render(
        <CardActionsMenu task={makeTask()} onReorder={vi.fn()} canMoveUp canMoveDown />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.getByText('Move up')).toBeInTheDocument();
      expect(screen.getByText('Move down')).toBeInTheDocument();
      expect(screen.getByText('Move to top')).toBeInTheDocument();
    });

    it('fires onReorder with the task and the clicked direction', () => {
      const onReorder = vi.fn();
      const task = makeTask();
      render(<CardActionsMenu task={task} onReorder={onReorder} canMoveUp canMoveDown />);
      // The menu closes on select — reopen before each click.
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Move up'));
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Move down'));
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Move to top'));
      expect(onReorder.mock.calls).toEqual([
        [task, 'up'],
        [task, 'down'],
        [task, 'top'],
      ]);
    });

    it('disables Move up and Move to top on the first card (canMoveUp=false)', () => {
      const onReorder = vi.fn();
      render(
        <CardActionsMenu task={makeTask()} onReorder={onReorder} canMoveUp={false} canMoveDown />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.getByText('Move up').closest('button')).toBeDisabled();
      expect(screen.getByText('Move to top').closest('button')).toBeDisabled();
      expect(screen.getByText('Move down').closest('button')).toBeEnabled();
      // A click on a disabled item never fires the callback.
      fireEvent.click(screen.getByText('Move up'));
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('disables Move down on the last card (canMoveDown=false)', () => {
      const onReorder = vi.fn();
      render(
        <CardActionsMenu task={makeTask()} onReorder={onReorder} canMoveUp canMoveDown={false} />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.getByText('Move down').closest('button')).toBeDisabled();
      expect(screen.getByText('Move up').closest('button')).toBeEnabled();
      expect(screen.getByText('Move to top').closest('button')).toBeEnabled();
      fireEvent.click(screen.getByText('Move down'));
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('keeps the Move items enabled while the card has an active run (rank-only write)', () => {
      render(
        <CardActionsMenu
          task={makeTask({ inFlow: [{ agent: 'planner', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }] })}
          onReorder={vi.fn()}
          canMoveUp
          canMoveDown
        />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.getByText('Move up').closest('button')).toBeEnabled();
      expect(screen.getByText('Move down').closest('button')).toBeEnabled();
      expect(screen.getByText('Move to top').closest('button')).toBeEnabled();
    });

    // -- Manual-sort-only gating (IDEA-053, TASK-203) ------------------------

    it('reorderEnabled=false disables ALL THREE Move items regardless of canMoveUp/canMoveDown, with the accessible hint', () => {
      const onReorder = vi.fn();
      render(
        <CardActionsMenu
          task={makeTask()}
          onReorder={onReorder}
          canMoveUp
          canMoveDown
          reorderEnabled={false}
        />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.getByText('Move up').closest('button')).toBeDisabled();
      expect(screen.getByText('Move down').closest('button')).toBeDisabled();
      expect(screen.getByText('Move to top').closest('button')).toBeDisabled();
      // The equivalent-of-required accessible explanation, once per item.
      expect(screen.getAllByText('Reordering is available only in Manual sort with no search or membership filter')).toHaveLength(3);
    });

    it('reorderEnabled=false guards onClick too — a stray activation can never invoke onReorder', () => {
      const onReorder = vi.fn();
      render(
        <CardActionsMenu
          task={makeTask()}
          onReorder={onReorder}
          canMoveUp
          canMoveDown
          reorderEnabled={false}
        />,
      );
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      fireEvent.click(screen.getByText('Move up'));
      fireEvent.click(screen.getByText('Move down'));
      fireEvent.click(screen.getByText('Move to top'));
      expect(onReorder).not.toHaveBeenCalled();
    });

    it('reorderEnabled defaults to true — no hint, and first/last-card disabling behaves as before', () => {
      const onReorder = vi.fn();
      render(<CardActionsMenu task={makeTask()} onReorder={onReorder} canMoveUp canMoveDown />);
      fireEvent.click(screen.getByTestId('task-actions-trigger'));
      expect(screen.queryByText('Reordering is available only in Manual sort with no search or membership filter')).not.toBeInTheDocument();
      expect(screen.getByText('Move up').closest('button')).toBeEnabled();
    });
  });
});
