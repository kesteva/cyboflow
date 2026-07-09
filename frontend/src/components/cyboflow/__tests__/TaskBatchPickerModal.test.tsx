/**
 * TaskBatchPickerModal tests (feat/parallel-sprint, P6 — pre-launch multi-task
 * selector for a parallel sprint batch).
 *
 * Behaviors verified:
 *   1. Filter correctness: mirrors the strict runs.start pre-check — lists only
 *      approved, non-archived tasks at a ready-or-later NON-terminal stage
 *      (stage_position >= 6, is_terminal=0). Ideas/epics, done (terminal),
 *      won't-do (terminal), Idea-column (pos 1), and pending drafts
 *      (approved_at NULL) are all excluded so no offered task can abort the
 *      launch; readyToWork===false tasks carry a 'blocked' indicator (still
 *      selectable); in-flight tasks (inFlow.length>0) render disabled.
 *   2. Multi-select accumulation: toggling several checkboxes accumulates ids;
 *      onPicked receives every selected id.
 *   3. Cap enforcement: caps at 10 for interactive and 15 for sdk, keyed by the
 *      effective substrate from substrates.resolveEffective; over-cap checkboxes
 *      disable and the launch button respects the cap.
 *   4. onPicked payload: the launch button fires onPicked with exactly the
 *      selected task ids.
 *
 * tRPC mocking follows the IdeaPickerModal.test.tsx pattern (file-local vi.mock
 * of '../../../trpc/client').
 */
import '@testing-library/jest-dom';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BacklogTaskItem, Board } from '../../../../../shared/types/tasks';
import type { CliSubstrate } from '../../../../../shared/types/substrate';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The collapsed 4-stage board (migration 042). The eligibility predicate mirrors
 * runs.start: approved + stage_position >= 6 + NON-terminal stage. Only 'Ready
 * for development' (pos 6) qualifies here; Idea (pos 1) is below 6, Done (pos 9)
 * and Won't do (pos 10) are terminal.
 */
function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    id: 'board-1',
    project_id: 1,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      { id: 'idea', label: 'Idea', color_oklch: '', hint: null, position: 1, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
      { id: 'ready', label: 'Ready for development', color_oklch: '', hint: null, position: 6, write_policy: 'asserted', is_terminal: false, hidden_by_default: false },
      { id: 'done', label: 'Done', color_oklch: '', hint: null, position: 9, write_policy: 'derived', is_terminal: true, hidden_by_default: false },
      { id: 'wontdo', label: "Won't do", color_oklch: '', hint: null, position: 10, write_policy: 'asserted', is_terminal: true, hidden_by_default: true },
    ],
    ...overrides,
  };
}

function makeItem(overrides: Partial<BacklogTaskItem>): BacklogTaskItem {
  return {
    id: 'TASK-1',
    project_id: 1,
    type: 'task',
    ref: 'TASK-1',
    title: 'A task',
    summary: null,
    body: null,
    priority: 'P2',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'ready',
    archived_at: null,
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    readyToWork: true,
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// tRPC mock — override the global setup.ts stub.
// ---------------------------------------------------------------------------

vi.mock('../../../trpc/client', () => ({
  trpc: {
    cyboflow: {
      tasks: {
        list: { query: vi.fn() },
        boardsForProject: { query: vi.fn() },
      },
      substrates: {
        resolveEffective: { query: vi.fn() },
      },
    },
  },
}));

// Import after mocks so vi.mock hoisting is in effect.
import { TaskBatchPickerModal } from '../TaskBatchPickerModal';
import { trpc } from '../../../trpc/client';

const mockList = vi.mocked(trpc.cyboflow.tasks.list.query);
const mockBoards = vi.mocked(trpc.cyboflow.tasks.boardsForProject.query);
const mockResolve = vi.mocked(trpc.cyboflow.substrates.resolveEffective.query);

function setSubstrate(s: CliSubstrate): void {
  mockResolve.mockResolvedValue({ substrate: s });
}

beforeEach(() => {
  vi.clearAllMocks();
  setSubstrate('sdk');
  mockBoards.mockResolvedValue([makeBoard()]);
});

async function renderOpen(
  items: BacklogTaskItem[],
  substrate: CliSubstrate = 'sdk',
  onPicked = vi.fn(),
  onClose = vi.fn(),
) {
  mockList.mockResolvedValue(structuredClone(items));
  render(
    <TaskBatchPickerModal
      isOpen
      projectId={1}
      substrate={substrate}
      onClose={onClose}
      onPicked={onPicked}
    />,
  );
  // Wait for the task list to resolve (the list renders post-load).
  await screen.findByTestId('task-batch-picker-list');
  return { onPicked, onClose };
}

// ---------------------------------------------------------------------------
// 1. Filter correctness
// ---------------------------------------------------------------------------

describe('TaskBatchPickerModal — filter correctness', () => {
  it('excludes done tasks, ideas, and epics; marks blocked + disables in-flight', async () => {
    await renderOpen([
      makeItem({ id: 'TASK-1', ref: 'TASK-1' }),
      makeItem({ id: 'TASK-DONE', ref: 'TASK-DONE', isDone: true, stage_id: 'done', stage_position: 9 }),
      makeItem({ id: 'TASK-ARCHIVED', ref: 'TASK-ARCHIVED', archived_at: '2026-06-11T20:43:34Z' }),
      makeItem({ id: 'IDEA-1', ref: 'IDEA-1', type: 'idea', stage_id: 'idea', stage_position: 1 }),
      makeItem({ id: 'EPIC-1', ref: 'EPIC-1', type: 'epic' }),
      makeItem({
        id: 'TASK-BLOCKED',
        ref: 'TASK-BLOCKED',
        readyToWork: false,
        blockedBy: [{ taskId: 'TASK-1', ref: 'TASK-1', title: 'A task' }],
      }),
      makeItem({
        id: 'TASK-INFLIGHT',
        ref: 'TASK-INFLIGHT',
        inFlow: [{ agent: 'executor', runId: 'r1', stepId: 'implement' }],
      }),
    ]);

    // Eligible + rendered: TASK-1, TASK-BLOCKED, TASK-INFLIGHT.
    expect(screen.getByTestId('task-batch-picker-item-TASK-1')).toBeInTheDocument();
    expect(screen.getByTestId('task-batch-picker-item-TASK-BLOCKED')).toBeInTheDocument();
    expect(screen.getByTestId('task-batch-picker-item-TASK-INFLIGHT')).toBeInTheDocument();

    // Excluded entirely: done task, archived-in-place task, idea, epic.
    expect(screen.queryByTestId('task-batch-picker-item-TASK-DONE')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-TASK-ARCHIVED')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-IDEA-1')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-EPIC-1')).toBeNull();

    // Blocked indicator present + carries blockedBy ref.
    const blockedBadge = screen.getByTestId('task-batch-picker-blocked-TASK-BLOCKED');
    expect(blockedBadge).toHaveTextContent('TASK-1');

    // In-flight task's checkbox is disabled; blocked task's is NOT.
    expect(screen.getByLabelText('Select TASK-INFLIGHT')).toBeDisabled();
    expect(screen.getByLabelText('Select TASK-BLOCKED')).not.toBeDisabled();
  });

  it('includes tasks nested under an epic (backlog returns epic-children NESTED, not top-level)', async () => {
    await renderOpen([
      makeItem({ id: 'TASK-TOP', ref: 'TASK-TOP' }),
      makeItem({
        id: 'EPIC-1',
        ref: 'EPIC-1',
        type: 'epic',
        children: [
          makeItem({ id: 'TASK-CHILD', ref: 'TASK-CHILD', parent_epic_id: 'EPIC-1' }),
          makeItem({
            id: 'TASK-CHILD-DONE',
            ref: 'TASK-CHILD-DONE',
            parent_epic_id: 'EPIC-1',
            isDone: true,
            stage_id: 'done',
            stage_position: 9,
          }),
        ],
      }),
    ]);

    // Epic-owned task surfaces alongside the top-level one; the epic row itself
    // and its done child stay excluded.
    expect(screen.getByTestId('task-batch-picker-item-TASK-TOP')).toBeInTheDocument();
    expect(screen.getByTestId('task-batch-picker-item-TASK-CHILD')).toBeInTheDocument();
    expect(screen.queryByTestId('task-batch-picker-item-EPIC-1')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-TASK-CHILD-DONE')).toBeNull();
    expect(screen.getByLabelText('Select TASK-CHILD')).not.toBeDisabled();
  });

  it('excludes sprint-ineligible tasks the strict runs.start pre-check would reject (F6)', async () => {
    await renderOpen([
      // Eligible: approved, ready-for-development (pos 6), non-terminal.
      makeItem({ id: 'TASK-READY', ref: 'TASK-READY', stage_id: 'ready', stage_position: 6 }),
      // Won't do — terminal stage (pos 10). isDone stays false (position-9-only),
      // so ONLY the terminal-stage check catches it.
      makeItem({ id: 'TASK-WONTDO', ref: 'TASK-WONTDO', stage_id: 'wontdo', stage_position: 10 }),
      // Hand-moved back to the Idea column (pos 1) — below the ready threshold.
      makeItem({ id: 'TASK-IDEA', ref: 'TASK-IDEA', stage_id: 'idea', stage_position: 1 }),
      // Pending draft: approved_at NULL (backend-invisible + sprint-ineligible).
      // Sits at 'ready' so ONLY the approval check excludes it.
      makeItem({ id: 'TASK-PENDING', ref: 'TASK-PENDING', approved_at: null }),
    ]);

    expect(screen.getByTestId('task-batch-picker-item-TASK-READY')).toBeInTheDocument();
    expect(screen.getByLabelText('Select TASK-READY')).not.toBeDisabled();

    expect(screen.queryByTestId('task-batch-picker-item-TASK-WONTDO')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-TASK-IDEA')).toBeNull();
    expect(screen.queryByTestId('task-batch-picker-item-TASK-PENDING')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. Multi-select accumulation + 4. onPicked payload
// ---------------------------------------------------------------------------

describe('TaskBatchPickerModal — multi-select + onPicked payload', () => {
  it('accumulates multiple selections and onPicked receives every selected id', async () => {
    const { onPicked } = await renderOpen([
      makeItem({ id: 'TASK-1', ref: 'TASK-1' }),
      makeItem({ id: 'TASK-2', ref: 'TASK-2' }),
      makeItem({ id: 'TASK-3', ref: 'TASK-3' }),
    ]);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select TASK-1'));
      fireEvent.click(screen.getByLabelText('Select TASK-3'));
    });

    expect(screen.getByLabelText('Select TASK-1')).toBeChecked();
    expect(screen.getByLabelText('Select TASK-2')).not.toBeChecked();
    expect(screen.getByLabelText('Select TASK-3')).toBeChecked();

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });

    expect(onPicked).toHaveBeenCalledOnce();
    expect(onPicked).toHaveBeenCalledWith(['TASK-1', 'TASK-3']);
  });

  it('deselecting a task removes it from the onPicked payload', async () => {
    const { onPicked } = await renderOpen([
      makeItem({ id: 'TASK-1', ref: 'TASK-1' }),
      makeItem({ id: 'TASK-2', ref: 'TASK-2' }),
    ]);

    await act(async () => {
      fireEvent.click(screen.getByLabelText('Select TASK-1'));
      fireEvent.click(screen.getByLabelText('Select TASK-2'));
      fireEvent.click(screen.getByLabelText('Select TASK-1')); // toggle off
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });

    expect(onPicked).toHaveBeenCalledWith(['TASK-2']);
  });

  it('launch is disabled with zero selection', async () => {
    await renderOpen([makeItem({ id: 'TASK-1', ref: 'TASK-1' })]);
    expect(screen.getByTestId('task-batch-picker-launch')).toBeDisabled();
  });

  it('select-all eligible selects every selectable task (and launches them)', async () => {
    const { onPicked } = await renderOpen([
      makeItem({ id: 'TASK-1', ref: 'TASK-1' }),
      makeItem({ id: 'TASK-2', ref: 'TASK-2' }),
      makeItem({
        id: 'TASK-INFLIGHT',
        ref: 'TASK-INFLIGHT',
        inFlow: [{ agent: 'executor', runId: 'r1', stepId: 'implement' }],
      }),
    ]);

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-select-all'));
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });

    // The in-flight task is NOT selected by select-all.
    expect(onPicked).toHaveBeenCalledWith(['TASK-1', 'TASK-2']);
  });
});

// ---------------------------------------------------------------------------
// 2b. Pre-selection (an epic's ready-for-dev tasks, opened from the backlog Run)
// ---------------------------------------------------------------------------

describe('TaskBatchPickerModal — pre-selection', () => {
  it('pre-checks eligible preselectedTaskIds, drops in-flight ones, and launches the survivors', async () => {
    const onPicked = vi.fn();
    mockList.mockResolvedValue(
      structuredClone([
        makeItem({ id: 'TASK-1', ref: 'TASK-1' }),
        makeItem({ id: 'TASK-2', ref: 'TASK-2' }),
        // In-flight: rendered disabled and NOT pre-checked even though preselected.
        makeItem({ id: 'TASK-3', ref: 'TASK-3', inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null }] }),
      ]),
    );
    render(
      <TaskBatchPickerModal
        isOpen
        projectId={1}
        substrate="sdk"
        preselectedTaskIds={['TASK-1', 'TASK-3']}
        onClose={vi.fn()}
        onPicked={onPicked}
      />,
    );
    await screen.findByTestId('task-batch-picker-list');

    expect(screen.getByLabelText('Select TASK-1')).toBeChecked();
    expect(screen.getByLabelText('Select TASK-2')).not.toBeChecked();
    expect(screen.getByLabelText('Select TASK-3')).not.toBeChecked();
    expect(screen.getByLabelText('Select TASK-3')).toBeDisabled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });
    expect(onPicked).toHaveBeenCalledWith(['TASK-1']);
  });
});

// ---------------------------------------------------------------------------
// 3. Cap enforcement by substrate (10 interactive vs 15 sdk)
// ---------------------------------------------------------------------------

describe('TaskBatchPickerModal — cap enforcement', () => {
  function manyTasks(n: number): BacklogTaskItem[] {
    return Array.from({ length: n }, (_, i) =>
      makeItem({ id: `TASK-${i}`, ref: `TASK-${i}` }),
    );
  }

  it('caps selection at 10 for the interactive substrate', async () => {
    setSubstrate('interactive');
    await renderOpen(manyTasks(12), 'interactive');

    // The cap line reflects 10.
    expect(screen.getByTestId('task-batch-picker-cap')).toHaveTextContent('10');

    // Select all eligible takes only the first 10.
    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-select-all'));
    });

    // Exactly 10 checked.
    const checked = screen
      .getAllByRole('checkbox')
      .filter((c) => (c as HTMLInputElement).checked);
    expect(checked).toHaveLength(10);

    // The 11th + 12th checkboxes are disabled (at cap, not selected).
    expect(screen.getByLabelText('Select TASK-10')).toBeDisabled();
    expect(screen.getByLabelText('Select TASK-11')).toBeDisabled();
  });

  it('caps selection at 15 for the sdk substrate', async () => {
    setSubstrate('sdk');
    await renderOpen(manyTasks(18), 'sdk');

    expect(screen.getByTestId('task-batch-picker-cap')).toHaveTextContent('15');

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-select-all'));
    });

    const checked = screen
      .getAllByRole('checkbox')
      .filter((c) => (c as HTMLInputElement).checked);
    expect(checked).toHaveLength(15);

    // The 16th checkbox is disabled once at the 15-cap.
    expect(screen.getByLabelText('Select TASK-15')).toBeDisabled();
  });

  it('manual checks past the cap are ignored (cannot exceed N)', async () => {
    setSubstrate('interactive');
    const { onPicked } = await renderOpen(manyTasks(11), 'interactive');

    // Click the first 11 checkboxes one-by-one; the cap is 10.
    await act(async () => {
      for (let i = 0; i < 11; i++) {
        fireEvent.click(screen.getByLabelText(`Select TASK-${i}`));
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('task-batch-picker-launch'));
    });

    expect(onPicked).toHaveBeenCalledOnce();
    const ids = onPicked.mock.calls[0][0] as string[];
    expect(ids).toHaveLength(10);
  });
});
