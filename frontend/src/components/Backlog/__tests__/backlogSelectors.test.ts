/**
 * Unit tests for the backlog selectors: archive-in-place filtering
 * (isArchived / filterTasks / countArchived), off-board filtering of decomposed
 * ideas + PENDING entities (isDecomposed / isPending), cross-project stage
 * unification (unifiedStages), position-keyed bucketing (bucketByStage), and the
 * stage helpers backing the per-card actions menu (selectableStages /
 * findStageById / friendlyStageError).
 */
import { describe, it, expect } from 'vitest';
import {
  isArchived,
  isDecomposed,
  isPending,
  isExperimentSandboxed,
  filterTasks,
  countArchived,
  unifiedStages,
  bucketByStage,
  visibleStages,
  deriveCounts,
  findStageById,
  selectableStages,
  friendlyStageError,
  isExecutionStage,
  readyForDevChildTaskIds,
} from '../backlogSelectors';
import type { BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

function stage(position: number, label: string, opts: Partial<BoardStage> = {}): BoardStage {
  return {
    id: opts.id ?? `s-${position}`,
    label,
    color_oklch: 'oklch(0.5 0.1 0)',
    hint: opts.hint ?? null,
    position,
    write_policy: opts.write_policy ?? 'asserted',
    is_terminal: opts.is_terminal ?? false,
    hidden_by_default: opts.hidden_by_default ?? false,
  };
}

/**
 * The canonical default board (matches database.ts seedDefaultBoard): the
 * four-stage model — 1 Idea, 6 Ready for development, 9 Done (terminal),
 * 10 Won't do (terminal, hidden by default). All four stages are user-assertable.
 */
function defaultBoard(over: Partial<Board> = {}): Board {
  const idPrefix = over.id ?? 'board-1';
  return {
    id: 'board-1',
    project_id: 1,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      stage(1, 'Idea', { id: `${idPrefix}-s1` }),
      stage(6, 'Ready for development', { id: `${idPrefix}-s6` }),
      stage(9, 'Done', { id: `${idPrefix}-s9`, is_terminal: true }),
      stage(10, "Won't do", { id: `${idPrefix}-s10`, is_terminal: true, hidden_by_default: true }),
    ],
    ...over,
  };
}

function item(over: Partial<BacklogTaskItem> = {}): BacklogTaskItem {
  return {
    id: 'TASK-1',
    project_id: 1,
    type: 'task',
    ref: 'TASK-1',
    title: 'A task',
    summary: null,
    body: null,
    priority: 'P1',
    repo: null,
    parent_epic_id: null,
    originating_idea_id: null,
    scope: null,
    board_id: 'board-1',
    stage_id: 'board-1-s6',
    archived_at: null,
    // Default to ON the board: not decomposed, approved (a pending fixture
    // overrides approved_at to null).
    decomposed_at: null,
    approved_at: '2026-01-01T00:00:00.000Z',
    sort_order: null,
    version: 1,
    stage_position: 6,
    inFlow: [],
    awaitingReview: false,
    isDone: false,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...over,
  };
}

describe('isArchived', () => {
  it('is true only when archived_at is stamped', () => {
    expect(isArchived(item())).toBe(false);
    expect(isArchived(item({ archived_at: '2026-06-10T00:00:00Z' }))).toBe(true);
  });
});

describe('isDecomposed', () => {
  it('is true only for an idea with decomposed_at stamped', () => {
    expect(isDecomposed(item({ type: 'idea', decomposed_at: null }))).toBe(false);
    expect(isDecomposed(item({ type: 'idea', decomposed_at: '2026-06-10T00:00:00Z' }))).toBe(true);
    // A decomposed_at stamp on a non-idea (shouldn't happen) is ignored.
    expect(isDecomposed(item({ type: 'task', decomposed_at: '2026-06-10T00:00:00Z' }))).toBe(false);
  });
});

describe('isPending', () => {
  it('is true for an epic/task with approved_at === null; never for an idea', () => {
    expect(isPending(item({ type: 'task', approved_at: null }))).toBe(true);
    expect(isPending(item({ type: 'epic', approved_at: null }))).toBe(true);
    expect(isPending(item({ type: 'task', approved_at: '2026-06-10T00:00:00Z' }))).toBe(false);
    expect(isPending(item({ type: 'idea', approved_at: null }))).toBe(false);
  });
});

describe('isExperimentSandboxed', () => {
  it('is true only when experiment_id is a non-null string', () => {
    expect(isExperimentSandboxed(item())).toBe(false);
    expect(isExperimentSandboxed(item({ experiment_id: null }))).toBe(false);
    expect(isExperimentSandboxed(item({ experiment_id: 'exp-1' }))).toBe(true);
  });
});

describe('filterTasks', () => {
  it('narrows to the filter project; null keeps all projects', () => {
    const tasks = [
      item({ id: 'TASK-1', project_id: 1 }),
      item({ id: 'TASK-2', project_id: 2 }),
    ];
    expect(filterTasks(tasks, 1, false).map((t) => t.id)).toEqual(['TASK-1']);
    expect(filterTasks(tasks, null, false).map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('drops archived top-level items unless showArchived', () => {
    const tasks = [
      item({ id: 'TASK-1' }),
      item({ id: 'TASK-2', archived_at: '2026-06-10T00:00:00Z' }),
    ];
    expect(filterTasks(tasks, null, false).map((t) => t.id)).toEqual(['TASK-1']);
    expect(filterTasks(tasks, null, true).map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
  });

  it('drops a decomposed idea UNCONDITIONALLY — even with showArchived on', () => {
    const live = item({ id: 'IDEA-1', type: 'idea', decomposed_at: null });
    const gone = item({ id: 'IDEA-2', type: 'idea', decomposed_at: '2026-06-10T00:00:00Z' });
    expect(filterTasks([live, gone], null, false).map((t) => t.id)).toEqual(['IDEA-1']);
    expect(filterTasks([live, gone], null, true).map((t) => t.id)).toEqual(['IDEA-1']);
  });

  it('drops a PENDING (unapproved) epic/task UNCONDITIONALLY — even with showArchived on', () => {
    const approved = item({ id: 'TASK-1', approved_at: '2026-06-10T00:00:00Z' });
    const pendingTask = item({ id: 'TASK-2', approved_at: null });
    const pendingEpic = item({ id: 'EPIC-1', type: 'epic', approved_at: null });
    expect(filterTasks([approved, pendingTask, pendingEpic], null, false).map((t) => t.id)).toEqual([
      'TASK-1',
    ]);
    expect(filterTasks([approved, pendingTask, pendingEpic], null, true).map((t) => t.id)).toEqual([
      'TASK-1',
    ]);
  });

  it('drops an experiment-sandboxed top-level item UNCONDITIONALLY — even with showArchived on', () => {
    const visible = item({ id: 'IDEA-1', type: 'idea' });
    const sandboxed = item({ id: 'IDEA-2', type: 'idea', experiment_id: 'exp-1' });
    expect(filterTasks([visible, sandboxed], null, false).map((t) => t.id)).toEqual(['IDEA-1']);
    expect(filterTasks([visible, sandboxed], null, true).map((t) => t.id)).toEqual(['IDEA-1']);
  });

  it('filters an experiment-sandboxed child out of an epic; rollups recomputed on the copy', () => {
    const children = [
      item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1' }),
      item({ id: 'TASK-c2', parent_epic_id: 'EPIC-1', experiment_id: 'exp-1' }),
    ];
    const epic = item({ id: 'EPIC-1', type: 'epic', children, childCount: 2, pendingTasks: 2 });
    const [filtered] = filterTasks([epic], null, true);
    expect(filtered).not.toBe(epic);
    expect(filtered.children?.map((c) => c.id)).toEqual(['TASK-c1']);
    expect(filtered.childCount).toBe(1);
    // store object untouched
    expect(epic.children).toHaveLength(2);
  });

  it('drops an archived epic together with its whole subtree unless showArchived', () => {
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      archived_at: '2026-06-10T00:00:00Z',
      children: [item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1' })],
      childCount: 1,
      pendingTasks: 1,
    });
    expect(filterTasks([epic], null, false)).toEqual([]);
    expect(filterTasks([epic], null, true)).toEqual([epic]);
  });

  it('shallow-copies an epic with archived children: children filtered, rollups recomputed, store object untouched', () => {
    const children = [
      item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1' }),
      item({ id: 'TASK-c2', parent_epic_id: 'EPIC-1', isDone: true }),
      item({ id: 'TASK-c3', parent_epic_id: 'EPIC-1', archived_at: '2026-06-10T00:00:00Z' }),
    ];
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      children,
      childCount: 3,
      pendingTasks: 2,
    });
    const [filtered] = filterTasks([epic], null, false);
    expect(filtered).not.toBe(epic); // shallow copy, not the store object
    expect(filtered.children?.map((c) => c.id)).toEqual(['TASK-c1', 'TASK-c2']);
    expect(filtered.childCount).toBe(2);
    expect(filtered.pendingTasks).toBe(1); // TASK-c2 is done
    // The store object was never mutated.
    expect(epic.children).toHaveLength(3);
    expect(epic.childCount).toBe(3);
    expect(epic.pendingTasks).toBe(2);
  });

  it('filters PENDING children out of an epic even with showArchived on; rollups recomputed on the copy', () => {
    const children = [
      item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', approved_at: '2026-06-10T00:00:00Z' }),
      item({ id: 'TASK-c2', parent_epic_id: 'EPIC-1', approved_at: null }), // pending → hidden
    ];
    const epic = item({ id: 'EPIC-1', type: 'epic', children, childCount: 2, pendingTasks: 2 });
    const [filtered] = filterTasks([epic], null, true);
    expect(filtered).not.toBe(epic);
    expect(filtered.children?.map((c) => c.id)).toEqual(['TASK-c1']);
    expect(filtered.childCount).toBe(1);
    expect(filtered.pendingTasks).toBe(1);
    // store object untouched
    expect(epic.children).toHaveLength(2);
  });

  it('keeps original references when nothing needs filtering (incl. showArchived on)', () => {
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      children: [
        item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', archived_at: '2026-06-10T00:00:00Z' }),
      ],
      childCount: 1,
      pendingTasks: 1,
    });
    const plain = item({ id: 'TASK-1' });
    // showArchived on: archived children stay nested, no copy made.
    expect(filterTasks([epic, plain], null, true)[0]).toBe(epic);
    // No archived children at all: no copy made either.
    expect(filterTasks([plain], null, false)[0]).toBe(plain);
  });
});

describe('countArchived', () => {
  it('counts archived items at any depth, narrowed by project', () => {
    const tasks = [
      item({ id: 'TASK-1', project_id: 1, archived_at: '2026-06-10T00:00:00Z' }),
      item({
        id: 'EPIC-1',
        project_id: 1,
        type: 'epic',
        children: [
          item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', archived_at: '2026-06-10T00:00:00Z' }),
          item({ id: 'TASK-c2', parent_epic_id: 'EPIC-1' }),
        ],
      }),
      item({ id: 'TASK-2', project_id: 2, archived_at: '2026-06-10T00:00:00Z' }),
    ];
    expect(countArchived(tasks, null)).toBe(3);
    expect(countArchived(tasks, 1)).toBe(2);
    expect(countArchived(tasks, 2)).toBe(1);
  });
});

describe('unifiedStages', () => {
  it('collapses two boards with identical positions into one column set, first board representative', () => {
    const a = defaultBoard({ id: 'board-1', project_id: 1 });
    const b = defaultBoard({ id: 'board-2', project_id: 2 });
    // Project 2 renamed its Idea stage — the first board's label must front the column.
    b.stages[0] = { ...b.stages[0], label: 'Idea (custom)' };
    const stages = unifiedStages([a, b], null, false);
    expect(stages.map((s) => s.position)).toEqual([1, 6, 9]);
    expect(stages[0].label).toBe('Idea');
    expect(stages[0].id).toBe('board-1-s1'); // representative comes from board-1
  });

  it('narrows to the filter project', () => {
    const a = defaultBoard({ id: 'board-1', project_id: 1 });
    const b = defaultBoard({ id: 'board-2', project_id: 2 });
    const stages = unifiedStages([a, b], 2, false);
    expect(stages.every((s) => s.id.startsWith('board-2'))).toBe(true);
  });

  it('excludes hidden-by-default stages unless showArchived', () => {
    const a = defaultBoard();
    expect(unifiedStages([a], null, false).map((s) => s.position)).not.toContain(10);
    expect(unifiedStages([a], null, true).map((s) => s.position)).toContain(10);
  });

  it('returns an empty set for no boards', () => {
    expect(unifiedStages([], null, true)).toEqual([]);
  });
});

describe('visibleStages', () => {
  it("hides the won't-do stage unless showArchived; sorts by position", () => {
    const board = defaultBoard();
    expect(visibleStages(board, false).map((s) => s.position)).toEqual([1, 6, 9]);
    expect(visibleStages(board, true).map((s) => s.position)).toEqual([1, 6, 9, 10]);
  });
});

describe('bucketByStage', () => {
  it('buckets cross-project items by stage POSITION, not stage_id', () => {
    const stages = unifiedStages(
      [defaultBoard({ id: 'board-1', project_id: 1 }), defaultBoard({ id: 'board-2', project_id: 2 })],
      null,
      false,
    );
    const tasks = [
      item({ id: 'TASK-1', project_id: 1, stage_id: 'board-1-s6', stage_position: 6 }),
      item({ id: 'TASK-2', project_id: 2, stage_id: 'board-2-s6', stage_position: 6 }),
      item({ id: 'IDEA-1', project_id: 2, type: 'idea', stage_id: 'board-2-s1', stage_position: 1 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    const at = (pos: number) => buckets.find((b) => b.stage.position === pos);
    // Both projects' position-6 items share one column despite different stage_ids.
    expect(at(6)?.tasks.map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
    expect(at(1)?.tasks.map((t) => t.id)).toEqual(['IDEA-1']);
  });

  it("a Won't-do (position 10) item lands on the board only when showArchived reveals stage 10", () => {
    const wontDo = item({ id: 'TASK-1', stage_id: 'board-1-s10', stage_position: 10 });
    // showArchived off → stage 10 not in the visible set → item dropped.
    const hidden = bucketByStage([wontDo], unifiedStages([defaultBoard()], null, false));
    expect(hidden.flatMap((b) => b.tasks)).toEqual([]);
    // showArchived on → stage 10 present → item bucketed there.
    const shown = bucketByStage([wontDo], unifiedStages([defaultBoard()], null, true));
    expect(shown.find((b) => b.stage.position === 10)?.tasks.map((t) => t.id)).toEqual(['TASK-1']);
  });

  it('ignores epic children (only top-level items are bucketed)', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', stage_position: 6 })];
    const buckets = bucketByStage(tasks, stages);
    expect(buckets.flatMap((b) => b.tasks)).toEqual([]);
  });

  it('preserves the StageBucket shape with one bucket per stage in order', () => {
    const stages = unifiedStages([defaultBoard()], null, true);
    const buckets = bucketByStage([], stages);
    expect(buckets.map((b) => b.stage.position)).toEqual([1, 6, 9, 10]);
    expect(buckets.every((b) => Array.isArray(b.tasks))).toBe(true);
  });
});

describe('deriveCounts', () => {
  it('splits top-level types and tallies overlays from the (filtered) list it is given', () => {
    const tasks = [
      item({ id: 'IDEA-1', type: 'idea' }),
      item({ id: 'EPIC-1', type: 'epic' }),
      item({ id: 'TASK-1', isDone: true }),
      item({
        id: 'TASK-2',
        awaitingReview: true,
        inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null }],
      }),
    ];
    expect(deriveCounts(tasks)).toEqual({
      items: 4,
      epics: 1,
      solo: 2,
      ideas: 1,
      done: 1,
      inFlow: 1,
      awaitingReview: 1,
    });
  });
});

describe('findStageById', () => {
  it('returns the matching stage', () => {
    expect(findStageById(defaultBoard(), 'board-1-s6')?.label).toBe('Ready for development');
  });

  it('returns null for an unknown stage id', () => {
    expect(findStageById(defaultBoard(), 's-nope')).toBeNull();
  });
});

describe('selectableStages', () => {
  it("offers the four board positions minus the current one; Won't do (10) stays a manual target", () => {
    // From Done (9): may move to Idea (1), Ready for development (6), or Won't do (10).
    expect(selectableStages(defaultBoard(), 'board-1-s9').map((s) => s.position)).toEqual([1, 6, 10]);
    // From Ready for development (6): the current stage is excluded.
    expect(selectableStages(defaultBoard(), 'board-1-s6').map((s) => s.position)).toEqual([1, 9, 10]);
  });
});

describe('friendlyStageError', () => {
  it('maps the active-run conflict with operation-neutral phrasing (stage move / archive / delete)', () => {
    const msg = friendlyStageError(new Error('active_runs: cancel active runs first'));
    expect(msg).toMatch(/active run/i);
    expect(msg).not.toMatch(/stage/i); // neutral: also shown by the delete dialog
  });

  it('maps the concurrency conflict', () => {
    expect(friendlyStageError(new Error('concurrency: stale version'))).toMatch(/changed since/i);
  });

  it('maps the forbidden (derived) stage', () => {
    expect(
      friendlyStageError(new Error('forbidden_stage: execution stage is orchestrator-derived')),
    ).toMatch(/automatically/i);
  });

  it('maps the not-found code', () => {
    expect(friendlyStageError(new Error('not_found: task gone'))).toMatch(/no longer exists/i);
  });

  it('falls back to a generic message for a non-Error / empty message', () => {
    expect(friendlyStageError('boom')).toMatch(/could not complete/i);
    expect(friendlyStageError(new Error(''))).toMatch(/could not complete/i);
  });
});

describe('isExecutionStage', () => {
  it('is true only for position 6 (Ready for development)', () => {
    // Planning (1): false.
    expect(isExecutionStage(1)).toBe(false);
    // Execution boundary (6): true.
    expect(isExecutionStage(6)).toBe(true);
    // Everything past the boundary + terminals (7, 9, 10): false.
    for (const p of [7, 9, 10]) expect(isExecutionStage(p)).toBe(false);
  });
});

describe('readyForDevChildTaskIds', () => {
  it('returns the epic\'s child tasks AT Ready-for-development, excluding done/archived/in-flight/non-task/other-stage', () => {
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      stage_position: 6,
      children: [
        item({ id: 'TASK-a', stage_position: 6 }), // ✓ ready
        item({ id: 'TASK-b', stage_position: 6 }), // ✓ ready
        item({ id: 'TASK-c', stage_position: 1 }), // ✗ still in planning
        item({ id: 'TASK-d', stage_position: 6, isDone: true }), // ✗ done
        item({ id: 'TASK-e', stage_position: 6, archived_at: '2026-06-10T00:00:00Z' }), // ✗ archived
        item({ id: 'TASK-f', stage_position: 6, inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null }] }), // ✗ in flight
      ],
    });
    expect(readyForDevChildTaskIds(epic)).toEqual(['TASK-a', 'TASK-b']);
  });

  it('returns [] for an epic with no children or no ready children', () => {
    expect(readyForDevChildTaskIds(item({ id: 'EPIC-2', type: 'epic' }))).toEqual([]);
    expect(
      readyForDevChildTaskIds(
        item({ id: 'EPIC-3', type: 'epic', children: [item({ id: 'TASK-x', stage_position: 1 })] }),
      ),
    ).toEqual([]);
  });
});
