/**
 * KanbanView drag-and-drop tests — driven directly against the view with a
 * stubbed BoardCard (the card body's store/trpc wiring is covered by
 * BacklogPane.test.tsx / TaskCard-adjacent suites; here only the DnD contract
 * matters):
 *   - card slots render `draggable`;
 *   - same-column dragover/dragenter preventDefault (valid drop target) and
 *     show the insertion indicator; a drop calls onReorder with the card's
 *     POST-DROP index;
 *   - the column body accepts end-of-column drops (targetIndex = last);
 *   - cross-column dragover does NOT preventDefault and a cross-column drop is
 *     a no-op;
 *   - dragend clears the drag state (indicator gone, later drop inert).
 */
import '@testing-library/jest-dom';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, BoardStage } from '../../../../../shared/types/tasks';
import type { StageBucket } from '../backlogSelectors';

// Stub the card body — KanbanView owns the drag wrapper, not the card.
vi.mock('../TaskCard', () => ({
  BoardCard: ({ task }: { task: BacklogTaskItem }) => (
    <div data-testid="board-card">{task.title}</div>
  ),
}));

import { KanbanView } from '../KanbanView';

function stage(position: number, label: string): BoardStage {
  return {
    id: `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: null,
    position,
    write_policy: 'asserted',
    is_terminal: false,
    hidden_by_default: false,
  };
}

function item(id: string, stagePosition: number): BacklogTaskItem {
  return {
    id,
    project_id: 1,
    type: 'task',
    ref: id,
    title: `Title ${id}`,
    summary: null,
    body: null,
    priority: 'P1',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: `s-${stagePosition}`,
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: stagePosition,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
  };
}

// Two columns: Idea (1) with three cards, Ready (6) with one card.
const IDEA_TASKS = [item('t1', 1), item('t2', 1), item('t3', 1)];
const READY_TASKS = [item('r1', 6)];
const BUCKETS: StageBucket[] = [
  { stage: stage(1, 'Idea'), tasks: IDEA_TASKS },
  { stage: stage(6, 'Ready for development'), tasks: READY_TASKS },
];

const onReorder = vi.fn();
const onRun = vi.fn();

/** A minimal dataTransfer stub — dragStart writes effectAllowed + setData. */
function dataTransfer() {
  return { effectAllowed: '', setData: vi.fn(), getData: vi.fn() };
}

function renderView() {
  return render(
    <KanbanView buckets={BUCKETS} onRun={onRun} onReorder={onReorder} launchingTaskId={null} now={Date.now()} />,
  );
}

/** The drag wrapper slot for a task id. */
function slotOf(taskId: string): HTMLElement {
  const slot = screen
    .getAllByTestId('kanban-card-slot')
    .find((el) => el.getAttribute('data-task-id') === taskId);
  if (!slot) throw new Error(`no card slot for ${taskId}`);
  return slot;
}

beforeEach(() => {
  onReorder.mockClear();
  onRun.mockClear();
});

describe('KanbanView drag-and-drop', () => {
  it('renders every card slot draggable', () => {
    renderView();
    const slots = screen.getAllByTestId('kanban-card-slot');
    expect(slots).toHaveLength(4);
    for (const slot of slots) expect(slot).toHaveAttribute('draggable', 'true');
  });

  it('same-column drop before a later card calls onReorder with the POST-DROP index', () => {
    renderView();
    fireEvent.dragStart(slotOf('t1'), { dataTransfer: dataTransfer() });
    // preventDefault in BOTH dragenter and dragover — fireEvent returns false
    // when the default was prevented (= valid drop target).
    expect(fireEvent.dragEnter(slotOf('t3'), { dataTransfer: dataTransfer() })).toBe(false);
    expect(fireEvent.dragOver(slotOf('t3'), { dataTransfer: dataTransfer() })).toBe(false);
    // The insertion indicator marks the hovered slot.
    expect(screen.getByTestId('drop-indicator')).toBeInTheDocument();
    fireEvent.drop(slotOf('t3'), { dataTransfer: dataTransfer() });
    // Insert-before t3 (index 2) with t1 removed from index 0 → final index 1.
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(IDEA_TASKS[0], 1);
    // The indicator clears on drop.
    expect(screen.queryByTestId('drop-indicator')).not.toBeInTheDocument();
  });

  it('drop on an earlier card targets that card\'s index', () => {
    renderView();
    fireEvent.dragStart(slotOf('t3'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(slotOf('t1'), { dataTransfer: dataTransfer() });
    fireEvent.drop(slotOf('t1'), { dataTransfer: dataTransfer() });
    expect(onReorder).toHaveBeenCalledWith(IDEA_TASKS[2], 0);
  });

  it('drop on the column body (below the cards) targets the end of the column', () => {
    renderView();
    fireEvent.dragStart(slotOf('t1'), { dataTransfer: dataTransfer() });
    const column = screen
      .getAllByTestId('kanban-column')
      .find((el) => el.getAttribute('data-stage-id') === 's-1');
    if (!column) throw new Error('no Idea column');
    // The cards container is the slot's parent — dropping there = end of column.
    const body = within(column).getAllByTestId('kanban-card-slot')[0].parentElement;
    if (!body) throw new Error('no column body');
    expect(fireEvent.dragOver(body, { dataTransfer: dataTransfer() })).toBe(false);
    fireEvent.drop(body, { dataTransfer: dataTransfer() });
    // Insert at slot 3 (after last) with t1 removed from index 0 → final index 2.
    expect(onReorder).toHaveBeenCalledWith(IDEA_TASKS[0], 2);
  });

  it('cross-column dragover is not a valid target and a cross-column drop is a no-op', () => {
    renderView();
    fireEvent.dragStart(slotOf('t1'), { dataTransfer: dataTransfer() });
    // Another column's card: preventDefault NOT called (fireEvent returns true).
    expect(fireEvent.dragEnter(slotOf('r1'), { dataTransfer: dataTransfer() })).toBe(true);
    expect(fireEvent.dragOver(slotOf('r1'), { dataTransfer: dataTransfer() })).toBe(true);
    expect(screen.queryByTestId('drop-indicator')).not.toBeInTheDocument();
    fireEvent.drop(slotOf('r1'), { dataTransfer: dataTransfer() });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('dragend clears the drag state — indicator gone, a later drop is inert', () => {
    renderView();
    fireEvent.dragStart(slotOf('t1'), { dataTransfer: dataTransfer() });
    fireEvent.dragOver(slotOf('t3'), { dataTransfer: dataTransfer() });
    expect(screen.getByTestId('drop-indicator')).toBeInTheDocument();
    // dragend fires even on a cancelled drag (Escape / dropped outside).
    fireEvent.dragEnd(slotOf('t1'), { dataTransfer: dataTransfer() });
    expect(screen.queryByTestId('drop-indicator')).not.toBeInTheDocument();
    fireEvent.drop(slotOf('t3'), { dataTransfer: dataTransfer() });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('dropping a card onto its own position is a no-op', () => {
    renderView();
    fireEvent.dragStart(slotOf('t2'), { dataTransfer: dataTransfer() });
    // Insert-before its own slot → same final index → no callback.
    fireEvent.drop(slotOf('t2'), { dataTransfer: dataTransfer() });
    expect(onReorder).not.toHaveBeenCalled();
  });
});
