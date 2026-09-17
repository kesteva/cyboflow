/**
 * Unit tests for the backlog selectors: archive-in-place filtering
 * (isArchived / filterTasks / countArchived), off-board filtering of decomposed
 * ideas + PENDING entities (isDecomposed / isPending), cross-project stage
 * unification (unifiedStages), position-keyed bucketing (bucketByStage), the
 * stage helpers backing the per-card actions menu (selectableStages /
 * findStageById / friendlyStageError), and the same-column reorder rank math
 * (dropRank / seedPlan / planReorder / compareBacklogOrder).
 */
import { describe, it, expect } from 'vitest';
import {
  isArchived,
  hasRunningFlow,
  isDecomposed,
  isPending,
  isExperimentSandboxed,
  filterTasks,
  countArchived,
  countActiveBacklogItems,
  unifiedStages,
  bucketByStage,
  effectiveBoardPosition,
  visibleStages,
  deriveCounts,
  findStageById,
  selectableStages,
  friendlyStageError,
  isExecutionStage,
  readyForDevChildTaskIds,
  ideaReadyTaskIds,
  RANK_GAP,
  dropRank,
  movedOrder,
  seedPlan,
  planReorder,
  compareBacklogOrder,
  deriveMembershipOptions,
  applySearchAndMembership,
  comparePriority,
  compareUpdated,
  compareTitle,
  compareForSortMode,
  type FilteredBacklogTaskItem,
} from '../backlogSelectors';
import type { BacklogMembership, BacklogTaskItem, Board, BoardStage } from '../../../../../shared/types/tasks';

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
    category: 'feature',
    executor: 'agent',
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
    memberships: [],
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

describe('hasRunningFlow', () => {
  it('is false with no inFlow entries', () => {
    expect(hasRunningFlow(item({ inFlow: [] }))).toBe(false);
  });

  it('is false when every inFlow entry is live but NOT running (e.g. queued/awaiting_review)', () => {
    const task = item({
      inFlow: [
        { agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'queued', sessionId: null, sessionName: null },
        { agent: 'sprint', runId: 'r2', stepId: null, runStatus: 'awaiting_review', sessionId: null, sessionName: null },
      ],
    });
    expect(hasRunningFlow(task)).toBe(false);
  });

  it('is true when ANY inFlow entry has runStatus === running', () => {
    const task = item({
      inFlow: [
        { agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'queued', sessionId: null, sessionName: null },
        { agent: 'sprint', runId: 'r2', stepId: null, runStatus: 'running', sessionId: 'sess-1', sessionName: 'quick-1' },
      ],
    });
    expect(hasRunningFlow(task)).toBe(true);
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
    expect(bucketByStage([], stages).map((b) => b.stage.position)).toEqual([1, 6, 9, 10]);
  });

  it('buckets a live experiment seed under In development (7) despite its DB stage_position 6', () => {
    // The real board carries the derived In-development stage (migration 066);
    // build one here so the position-7 bucket exists.
    const board: Board = {
      ...defaultBoard(),
      stages: [
        stage(1, 'Idea', { id: 'board-1-s1' }),
        stage(6, 'Ready for development', { id: 'board-1-s6' }),
        stage(7, 'In development', { id: 'board-1-s7', write_policy: 'derived' }),
        stage(9, 'Done', { id: 'board-1-s9', is_terminal: true }),
      ],
    };
    const stages = unifiedStages([board], null, false);
    const tasks = [
      item({ id: 'SEED-1', stage_position: 6, experimentSeed: true }),
      item({ id: 'NORMAL-1', stage_position: 6 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    const at = (pos: number) => buckets.find((b) => b.stage.position === pos);
    // The live seed is placed in In-development on read; the normal task stays in Ready.
    expect(at(7)?.tasks.map((t) => t.id)).toEqual(['SEED-1']);
    expect(at(6)?.tasks.map((t) => t.id)).toEqual(['NORMAL-1']);
  });
});

describe('effectiveBoardPosition', () => {
  it('returns the In-development position (7) for a live experiment seed, else the DB stage_position', () => {
    expect(effectiveBoardPosition(item({ stage_position: 6, experimentSeed: true }))).toBe(7);
    expect(effectiveBoardPosition(item({ stage_position: 6 }))).toBe(6);
    expect(effectiveBoardPosition(item({ stage_position: 9, experimentSeed: false }))).toBe(9);
  });
});

describe('dropRank', () => {
  it('returns the fractional midpoint between two ranked neighbours', () => {
    expect(dropRank(1024, 2048)).toBe(1536);
    expect(dropRank(0, 1024)).toBe(512);
  });

  it('handles the open-ended boundaries: top, bottom, and an empty column', () => {
    expect(dropRank(null, 1024)).toBe(1024 - RANK_GAP); // drop at top → before `next`
    expect(dropRank(1024, null)).toBe(1024 + RANK_GAP); // drop at bottom → after `prev`
    expect(dropRank(null, null)).toBe(0); // alone in the column
  });

  it('detects exhaustion with <=/>= — equal neighbours and adjacent doubles', () => {
    // Equal neighbours: mid === prev === next → exhausted (needs <=, not <).
    expect(dropRank(7, 7)).toBe('exhausted');
    // Adjacent doubles: the midpoint rounds onto one of the neighbours.
    expect(dropRank(1, 1 + Number.EPSILON)).toBe('exhausted');
  });
});

describe('movedOrder', () => {
  it('moves a card to its post-drop index without mutating the input', () => {
    const tasks = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    expect(movedOrder(tasks, 2, 0).map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(movedOrder(tasks, 0, 2).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']); // untouched
  });
});

describe('seedPlan', () => {
  it('assigns spaced ranks (index × RANK_GAP) in the given order', () => {
    const ordered = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })];
    expect(seedPlan(ordered)).toEqual([
      { task: ordered[0], sortOrder: 0 },
      { task: ordered[1], sortOrder: 1024 },
      { task: ordered[2], sortOrder: 2048 },
    ]);
  });
});

describe('planReorder', () => {
  it('plans a single fractional write when both post-drop neighbours are ranked', () => {
    const tasks = [
      item({ id: 'a', sort_order: 1024 }),
      item({ id: 'b', sort_order: 2048 }),
      item({ id: 'c', sort_order: 3072 }),
    ];
    // Move a between b and c → midpoint of 2048/3072.
    expect(planReorder(tasks, 0, 1)).toEqual([{ task: tasks[0], sortOrder: 2560 }]);
  });

  it('plans open-ended writes for a drop at the top or bottom of a ranked column', () => {
    const tasks = [
      item({ id: 'a', sort_order: 1024 }),
      item({ id: 'b', sort_order: 2048 }),
      item({ id: 'c', sort_order: 3072 }),
    ];
    expect(planReorder(tasks, 2, 0)).toEqual([{ task: tasks[2], sortOrder: 1024 - RANK_GAP }]);
    expect(planReorder(tasks, 0, 2)).toEqual([{ task: tasks[0], sortOrder: 3072 + RANK_GAP }]);
  });

  it('seeds the whole column in post-drop order on the first drag in an all-NULL column', () => {
    const tasks = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]; // sort_order all null
    const plan = planReorder(tasks, 2, 0);
    expect(plan.map((p) => [p.task.id, p.sortOrder])).toEqual([
      ['c', 0],
      ['a', 1024],
      ['b', 2048],
    ]);
  });

  it('renumbers the whole column when the fractional midpoint is exhausted', () => {
    const tasks = [
      item({ id: 'a', sort_order: 1 }),
      item({ id: 'b', sort_order: 1 + Number.EPSILON }),
      item({ id: 'c', sort_order: 5000 }),
    ];
    // Move c between a and b → adjacent doubles → full re-seed in post-drop order.
    const plan = planReorder(tasks, 2, 1);
    expect(plan.map((p) => [p.task.id, p.sortOrder])).toEqual([
      ['a', 0],
      ['c', 1024],
      ['b', 2048],
    ]);
  });
});

describe('compareBacklogOrder', () => {
  it('sorts ranked items before unranked ones ((sort_order IS NULL) ASC)', () => {
    const ranked = item({ id: 'r', sort_order: 9999 });
    const unranked = item({ id: 'u', sort_order: null });
    expect([unranked, ranked].sort(compareBacklogOrder).map((t) => t.id)).toEqual(['r', 'u']);
  });

  it('sorts ranked items by sort_order ascending', () => {
    const a = item({ id: 'a', sort_order: 2048 });
    const b = item({ id: 'b', sort_order: 512 });
    expect([a, b].sort(compareBacklogOrder).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('falls back to created_at then ref — identical to the server ORDER BY', () => {
    // Both unranked: created_at decides…
    const older = item({ id: 'o', created_at: '2026-06-01T00:00:00Z' });
    const newer = item({ id: 'n', created_at: '2026-06-02T00:00:00Z' });
    expect([newer, older].sort(compareBacklogOrder).map((t) => t.id)).toEqual(['o', 'n']);
    // …then ref for identical created_at (ranked ties fall through the same way).
    const refA = item({ id: 'x', ref: 'TASK-001', sort_order: 100 });
    const refB = item({ id: 'y', ref: 'TASK-002', sort_order: 100 });
    expect([refB, refA].sort(compareBacklogOrder).map((t) => t.id)).toEqual(['x', 'y']);
  });

  it('bucketByStage renders each bucket in compareBacklogOrder order', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [
      item({ id: 'unranked', sort_order: null }),
      item({ id: 'late', sort_order: 2048 }),
      item({ id: 'early', sort_order: 512 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    expect(buckets.find((b) => b.stage.position === 6)?.tasks.map((t) => t.id)).toEqual([
      'early',
      'late',
      'unranked',
    ]);
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
        inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
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

describe('countActiveBacklogItems', () => {
  it('counts non-done visible top-level items (matches the board columns)', () => {
    const tasks = [
      item({ id: 'IDEA-1', type: 'idea', stage_position: 1 }),
      item({ id: 'EPIC-1', type: 'epic', stage_position: 6 }),
      item({ id: 'TASK-1', stage_position: 7 }),
      item({ id: 'TASK-2', isDone: true, stage_position: 9 }),
    ];
    expect(countActiveBacklogItems(tasks)).toBe(3);
  });

  it('excludes decomposed ideas — retired via decomposed_at, they are !isDone yet off the board (the 43-vs-26 badge drift)', () => {
    const tasks = [
      item({ id: 'IDEA-1', type: 'idea', stage_position: 1 }),
      item({ id: 'IDEA-2', type: 'idea', stage_position: 1, decomposed_at: '2026-07-01T00:00:00Z' }),
    ];
    expect(countActiveBacklogItems(tasks)).toBe(1);
  });

  it('excludes PENDING (unapproved) epics/tasks, archived and experiment-sandboxed items, like the board', () => {
    const tasks = [
      item({ id: 'TASK-1' }),
      item({ id: 'TASK-2', approved_at: null }),
      item({ id: 'TASK-3', archived_at: '2026-07-01T00:00:00Z' }),
      item({ id: 'TASK-4', experiment_id: 'exp-1' }),
    ];
    expect(countActiveBacklogItems(tasks)).toBe(1);
  });

  it("excludes Won't-do items (terminal position 10, !isDone but retired) and nested epic children", () => {
    const child = item({ id: 'TASK-C', parent_epic_id: 'EPIC-1' });
    const tasks = [
      item({ id: 'EPIC-1', type: 'epic', children: [child], childCount: 1, pendingTasks: 1 }),
      item({ id: 'TASK-W', stage_position: 10 }),
      child, // defensive: even if a child leaked to the top-level list it must not count
    ];
    expect(countActiveBacklogItems(tasks)).toBe(1);
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
  it("offers the four asserted board positions minus the current one; Won't do (10) stays a manual target", () => {
    // From Done (9): may move to Idea (1), Ready for development (6), or Won't do (10).
    expect(selectableStages(defaultBoard(), 'board-1-s9').map((s) => s.position)).toEqual([1, 6, 10]);
    // From Ready for development (6): the current stage is excluded.
    expect(selectableStages(defaultBoard(), 'board-1-s6').map((s) => s.position)).toEqual([1, 9, 10]);
  });

  it("excludes the DERIVED 'In development' stage (position 7, migration 066) as a manual target — the client-side half of preventing a hand move onto it", () => {
    const board = defaultBoard({
      stages: [
        ...defaultBoard().stages,
        stage(7, 'In development', { id: 'board-1-s7', write_policy: 'derived' }),
      ],
    });
    // From Ready for development (6): position 7 never appears, even though
    // it's a real board column now — only 'asserted' stages are offered.
    expect(selectableStages(board, 'board-1-s6').map((s) => s.position)).toEqual([1, 9, 10]);
    // The derived stage is excluded even when IT is the item's current stage.
    expect(selectableStages(board, 'board-1-s7').map((s) => s.position)).toEqual([1, 6, 9, 10]);
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
        item({
          id: 'TASK-f',
          stage_position: 6,
          inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
        }), // ✗ in flight
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

// ---------------------------------------------------------------------------
// Search + membership filtering (IDEA-053, TASK-203)
// ---------------------------------------------------------------------------

function sprintMembership(id: string, label: string): BacklogMembership {
  return { kind: 'sprint', id, label, status: 'running' };
}

function experimentMembership(id: string, label: string): BacklogMembership {
  return { kind: 'experiment', id, label, status: 'running' };
}

describe('deriveMembershipOptions', () => {
  it('dedupes by (kind, id), sorted by case-folded label, then raw label, then id', () => {
    const tasks = [
      item({ id: 'T1', memberships: [sprintMembership('s2', 'zulu'), experimentMembership('e1', 'Alpha')] }),
      item({ id: 'T2', memberships: [sprintMembership('s2', 'zulu')] }), // duplicate (kind, id)
      item({ id: 'T3', memberships: [sprintMembership('s1', 'Alpha')] }), // same label as e1, different kind/id
    ];
    const options = deriveMembershipOptions(tasks);
    expect(options).toEqual([
      { kind: 'experiment', id: 'e1', label: 'Alpha' },
      { kind: 'sprint', id: 's1', label: 'Alpha' },
      { kind: 'sprint', id: 's2', label: 'zulu' },
    ]);
  });

  it('sorts case-folded first, then raw label breaks a case-fold tie', () => {
    const tasks = [
      item({ id: 'T1', memberships: [sprintMembership('s1', 'bravo')] }),
      item({ id: 'T2', memberships: [sprintMembership('s2', 'Bravo')] }),
    ];
    // Case-folded labels tie ('bravo'); raw string comparison breaks it ('Bravo' < 'bravo').
    expect(deriveMembershipOptions(tasks).map((o) => o.id)).toEqual(['s2', 's1']);
  });

  it('breaks a same-label tie by raw id when case-folded AND raw label are identical', () => {
    const tasks = [
      item({ id: 'T1', memberships: [sprintMembership('s2', 'same')] }),
      item({ id: 'T2', memberships: [sprintMembership('s1', 'same')] }),
    ];
    expect(deriveMembershipOptions(tasks).map((o) => o.id)).toEqual(['s1', 's2']);
  });

  it('walks epic children — memberships are only ever populated on task rows', () => {
    const child = item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', memberships: [sprintMembership('s1', 'Sprint 1')] });
    const epic = item({ id: 'EPIC-1', type: 'epic', children: [child], childCount: 1, pendingTasks: 1 });
    expect(deriveMembershipOptions([epic])).toEqual([{ kind: 'sprint', id: 's1', label: 'Sprint 1' }]);
  });

  it('returns [] when nothing carries any membership', () => {
    expect(deriveMembershipOptions([item({ id: 'T1' })])).toEqual([]);
  });
});

describe('applySearchAndMembership', () => {
  it('empty query and no membership selection is an IDENTITY pass-through', () => {
    const tasks = [item({ id: 'T1' }), item({ id: 'T2' })];
    expect(applySearchAndMembership(tasks, '', [], [])).toBe(tasks);
    expect(applySearchAndMembership(tasks, '   ', [], [])).toBe(tasks);
  });

  it('matches ref, title, and summary — trimmed and case-folded', () => {
    const tasks = [
      item({ id: 'T1', ref: 'TASK-042', title: 'Wire the parser', summary: null }),
      item({ id: 'T2', ref: 'TASK-999', title: 'Unrelated', summary: 'mentions the Parser somewhere' }),
      item({ id: 'T3', ref: 'TASK-999', title: 'Nothing matches', summary: null }),
    ];
    const byRef = applySearchAndMembership(tasks, '  task-042  ', [], []);
    expect(byRef.map((t) => t.id)).toEqual(['T1']);

    const byTitle = applySearchAndMembership(tasks, 'PARSER', [], []);
    expect(byTitle.map((t) => t.id).sort()).toEqual(['T1', 'T2']);

    const bySummary = applySearchAndMembership(tasks, 'parser', [], []);
    expect(bySummary.map((t) => t.id).sort()).toEqual(['T1', 'T2']);
  });

  it('a task with summary === null never matches on summary (no crash on null)', () => {
    const tasks = [item({ id: 'T1', summary: null })];
    expect(applySearchAndMembership(tasks, 'anything', [], [])).toEqual([]);
  });

  it('a leaf (no children) that matches neither search nor membership is dropped entirely', () => {
    const tasks = [item({ id: 'T1', title: 'no match here' })];
    expect(applySearchAndMembership(tasks, 'zzz', [], [])).toEqual([]);
  });

  it('recursive: a CHILD-ONLY match retains the parent, narrows children, recomputes rollups, and never mutates the source', () => {
    const matchingChild = item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', ref: 'TASK-014', title: 'Add retry guard' });
    const otherChild = item({ id: 'TASK-c2', parent_epic_id: 'EPIC-1', ref: 'TASK-015', title: 'Unrelated', isDone: true });
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      title: 'Parent epic (no match itself)',
      children: [matchingChild, otherChild],
      childCount: 2,
      pendingTasks: 1,
    });
    const [result] = applySearchAndMembership([epic], 'retry', [], []) as FilteredBacklogTaskItem[];
    expect(result.id).toBe('EPIC-1');
    expect(result).not.toBe(epic); // shallow copy, source untouched
    expect(result.children?.map((c) => c.id)).toEqual(['TASK-c1']);
    expect(result.childCount).toBe(1);
    expect(result.pendingTasks).toBe(1);
    // Accessible child evidence for both Kanban and List (rendered from this field).
    expect(result.matchedChildRefs).toEqual([{ ref: 'TASK-014', title: 'Add retry guard' }]);
    // Source object is untouched.
    expect(epic.children).toHaveLength(2);
    expect(epic.childCount).toBe(2);
    expect(epic.pendingTasks).toBe(1);
  });

  it('a node that matches SELF never carries matchedChildRefs, even with matching children too', () => {
    const child = item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', ref: 'TASK-014', title: 'retry guard' });
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      title: 'retry epic', // self matches "retry" too
      children: [child],
      childCount: 1,
      pendingTasks: 1,
    });
    const [result] = applySearchAndMembership([epic], 'retry', [], []) as FilteredBacklogTaskItem[];
    expect(result.matchedChildRefs).toBeUndefined();
    // Self-matched epics keep ALL children as given (filter only narrows a
    // child-only-match ancestor, per visitTask — every child that itself
    // matched-or-bubbled is retained).
    expect(result.children?.map((c) => c.id)).toEqual(['TASK-c1']);
  });

  it('a SELF-matched parent keeps its full children and rollups even when NO child matches', () => {
    // Regression: narrowing a self-matched node zeroed childCount/pendingTasks,
    // which hides TaskCard's expand affordance (gated on childCount > 0) and
    // makes the epic's real children unreachable while the search is active.
    const childA = item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', ref: 'TASK-014', title: 'Fix login bug' });
    const childB = item({
      id: 'TASK-c2',
      parent_epic_id: 'EPIC-1',
      ref: 'TASK-015',
      title: 'Update session token',
      isDone: true,
    });
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      title: 'Auth revamp', // only the EPIC matches "auth"; neither child does
      children: [childA, childB],
      childCount: 2,
      pendingTasks: 1,
    });
    const [result] = applySearchAndMembership([epic], 'auth', [], []) as FilteredBacklogTaskItem[];
    expect(result.children?.map((c) => c.id)).toEqual(['TASK-c1', 'TASK-c2']);
    expect(result.childCount).toBe(2);
    expect(result.pendingTasks).toBe(1);
    expect(result.matchedChildRefs).toBeUndefined();
  });

  it('a SELF-matched parent under an active MEMBERSHIP filter also keeps its full children', () => {
    const child = item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', ref: 'TASK-014', title: 'child', memberships: [] });
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      title: 'epic',
      memberships: [sprintMembership('s1', 'Sprint 1')],
      children: [child],
      childCount: 1,
      pendingTasks: 1,
    });
    const [result] = applySearchAndMembership([epic], '', ['s1'], []) as FilteredBacklogTaskItem[];
    expect(result.children?.map((c) => c.id)).toEqual(['TASK-c1']);
    expect(result.childCount).toBe(1);
    expect(result.pendingTasks).toBe(1);
  });

  it('search AND membership apply to the SAME node — a search-only self-match fails when membership is also active', () => {
    const tasks = [
      // Matches search, but not a member of the selected sprint.
      item({ id: 'T1', title: 'wire the parser', memberships: [] }),
    ];
    expect(applySearchAndMembership(tasks, 'parser', ['sprint-1'], [])).toEqual([]);
  });

  it('a descendant match must satisfy BOTH the search text and the membership selection on itself', () => {
    // The epic self fails both; one child matches search but not membership,
    // another matches membership but not search — neither is a valid
    // self-match under both predicates, so the whole subtree is dropped.
    const searchOnlyChild = item({
      id: 'C1',
      parent_epic_id: 'EPIC-1',
      title: 'wire the parser',
      memberships: [],
    });
    const membershipOnlyChild = item({
      id: 'C2',
      parent_epic_id: 'EPIC-1',
      title: 'unrelated title',
      memberships: [sprintMembership('sprint-1', 'Sprint 1')],
    });
    const epic = item({
      id: 'EPIC-1',
      type: 'epic',
      title: 'epic',
      children: [searchOnlyChild, membershipOnlyChild],
      childCount: 2,
      pendingTasks: 2,
    });
    expect(applySearchAndMembership([epic], 'parser', ['sprint-1'], [])).toEqual([]);

    // A child that satisfies BOTH on itself keeps the whole tree.
    const bothChild = item({
      id: 'C3',
      parent_epic_id: 'EPIC-1',
      ref: 'TASK-020',
      title: 'wire the parser',
      memberships: [sprintMembership('sprint-1', 'Sprint 1')],
    });
    const epic2 = item({
      id: 'EPIC-2',
      type: 'epic',
      title: 'epic',
      children: [searchOnlyChild, bothChild],
      childCount: 2,
      pendingTasks: 2,
    });
    const [result] = applySearchAndMembership([epic2], 'parser', ['sprint-1'], []) as FilteredBacklogTaskItem[];
    expect(result.children?.map((c) => c.id)).toEqual(['C3']);
    expect(result.matchedChildRefs).toEqual([{ ref: 'TASK-020', title: 'wire the parser' }]);
  });

  it('OR semantics within a kind: any selected sprint id matches', () => {
    const tasks = [
      item({ id: 'T1', memberships: [sprintMembership('s1', 'Sprint 1')] }),
      item({ id: 'T2', memberships: [sprintMembership('s2', 'Sprint 2')] }),
      item({ id: 'T3', memberships: [sprintMembership('s3', 'Sprint 3')] }),
    ];
    expect(applySearchAndMembership(tasks, '', ['s1', 's2'], []).map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('OR semantics across kinds: a sprint OR an experiment selection both pass', () => {
    const tasks = [
      item({ id: 'T1', memberships: [sprintMembership('s1', 'Sprint 1')] }),
      item({ id: 'T2', memberships: [experimentMembership('e1', 'Experiment 1')] }),
      item({ id: 'T3', memberships: [] }),
    ];
    expect(applySearchAndMembership(tasks, '', ['s1'], ['e1']).map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('no selection in either kind is NOT a constraint — every item passes membership', () => {
    const tasks = [item({ id: 'T1', memberships: [] }), item({ id: 'T2', memberships: [sprintMembership('s1', 'S1')] })];
    expect(applySearchAndMembership(tasks, '', [], []).map((t) => t.id)).toEqual(['T1', 'T2']);
  });

  it('a STALE selected id (no longer in memberships) fails to match — no fallback to inFlow/experimentSeed', () => {
    const tasks = [
      item({
        id: 'T1',
        memberships: [], // membership went terminal and fell out
        inFlow: [{ agent: 'sprint', runId: 'r1', stepId: null, runStatus: 'running', sessionId: null, sessionName: null }],
        experimentSeed: true,
      }),
    ];
    expect(applySearchAndMembership(tasks, '', ['stale-sprint-id'], [])).toEqual([]);
  });
});

describe('comparePriority', () => {
  it('orders P0 (highest) before P6 (lowest)', () => {
    const p6 = item({ id: 'a', priority: 'P6' });
    const p0 = item({ id: 'b', priority: 'P0' });
    const p3 = item({ id: 'c', priority: 'P3' });
    expect([p6, p0, p3].sort(comparePriority).map((t) => t.id)).toEqual(['b', 'c', 'a']);
  });

  it('ties fall through to the full compareBacklogOrder chain (sort_order first)', () => {
    const a = item({ id: 'a', priority: 'P1', sort_order: 2048 });
    const b = item({ id: 'b', priority: 'P1', sort_order: 1024 });
    expect([a, b].sort(comparePriority).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('compareUpdated', () => {
  it('orders raw ISO updated_at DESCENDING (most recent first)', () => {
    const older = item({ id: 'a', updated_at: '2026-06-01T00:00:00Z' });
    const newer = item({ id: 'b', updated_at: '2026-06-05T00:00:00Z' });
    expect([older, newer].sort(compareUpdated).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('ties fall through to the full compareBacklogOrder chain', () => {
    const a = item({ id: 'a', updated_at: '2026-06-01T00:00:00Z', sort_order: 2048 });
    const b = item({ id: 'b', updated_at: '2026-06-01T00:00:00Z', sort_order: 1024 });
    expect([a, b].sort(compareUpdated).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('compareTitle', () => {
  it('orders case-folded ascending', () => {
    const zulu = item({ id: 'a', title: 'zulu' });
    const alpha = item({ id: 'b', title: 'Alpha' });
    expect([zulu, alpha].sort(compareTitle).map((t) => t.id)).toEqual(['b', 'a']);
  });

  it('breaks a case-fold tie via the raw title', () => {
    const upper = item({ id: 'a', title: 'Bravo' });
    const lower = item({ id: 'b', title: 'bravo' });
    // Same case-folded value ('bravo'); raw string comparison: 'Bravo' < 'bravo'.
    expect([lower, upper].sort(compareTitle).map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('falls through to the full compareBacklogOrder chain once title AND case-fold tie', () => {
    const a = item({ id: 'a', title: 'same', sort_order: 2048 });
    const b = item({ id: 'b', title: 'same', sort_order: 1024 });
    expect([a, b].sort(compareTitle).map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('compareForSortMode', () => {
  it('returns the matching comparator for each mode', () => {
    expect(compareForSortMode('manual')).toBe(compareBacklogOrder);
    expect(compareForSortMode('priority')).toBe(comparePriority);
    expect(compareForSortMode('updated')).toBe(compareUpdated);
    expect(compareForSortMode('title')).toBe(compareTitle);
  });
});

describe('bucketByStage — sortMode', () => {
  it('sorts each stage bucket independently by the active sort mode, never moving items between stages', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [
      item({ id: 'ready-p2', stage_position: 6, priority: 'P2', title: 'B' }),
      item({ id: 'ready-p0', stage_position: 6, priority: 'P0', title: 'A' }),
      item({ id: 'idea-p1', type: 'idea', stage_position: 1, priority: 'P1' }),
    ];
    const buckets = bucketByStage(tasks, stages, 'priority');
    expect(buckets.find((b) => b.stage.position === 6)?.tasks.map((t) => t.id)).toEqual([
      'ready-p0',
      'ready-p2',
    ]);
    // The idea stays in its own stage (1), unaffected by the position-6 sort.
    expect(buckets.find((b) => b.stage.position === 1)?.tasks.map((t) => t.id)).toEqual(['idea-p1']);
  });

  it('defaults to manual (compareBacklogOrder) when sortMode is omitted', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [
      item({ id: 'late', stage_position: 6, sort_order: 2048 }),
      item({ id: 'early', stage_position: 6, sort_order: 512 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    expect(buckets.find((b) => b.stage.position === 6)?.tasks.map((t) => t.id)).toEqual(['early', 'late']);
  });

  it('title sort mode orders each column case-foldedly, independent of manual sort_order', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [
      item({ id: 'z', stage_position: 6, title: 'zulu', sort_order: 0 }),
      item({ id: 'a', stage_position: 6, title: 'alpha', sort_order: 100 }),
    ];
    const buckets = bucketByStage(tasks, stages, 'title');
    expect(buckets.find((b) => b.stage.position === 6)?.tasks.map((t) => t.id)).toEqual(['a', 'z']);
  });
});

describe('ideaReadyTaskIds', () => {
  it('collects ready tasks from BOTH decomposition shapes: epic-less direct task + tasks under the idea\'s epics', () => {
    const rows = [
      // The single epic-less task directly under the idea (top-level row).
      item({ id: 'TASK-direct', stage_position: 6, originating_idea_id: 'idea-1' }),
      // An epic of the idea with a ready child, an unready child, and a done child.
      item({
        id: 'EPIC-mine',
        type: 'epic',
        originating_idea_id: 'idea-1',
        children: [
          item({ id: 'TASK-under-epic', stage_position: 6 }),
          item({ id: 'TASK-planning', stage_position: 1 }),
          item({ id: 'TASK-done', stage_position: 6, isDone: true }),
        ],
      }),
      // Another idea's ready work must never leak in.
      item({ id: 'TASK-foreign', stage_position: 6, originating_idea_id: 'idea-2' }),
      item({
        id: 'EPIC-foreign',
        type: 'epic',
        originating_idea_id: 'idea-2',
        children: [item({ id: 'TASK-foreign-child', stage_position: 6 })],
      }),
    ];
    expect(ideaReadyTaskIds(rows, 'idea-1')).toEqual(['TASK-direct', 'TASK-under-epic']);
  });

  it('returns [] when the idea has no decomposition or nothing ready', () => {
    expect(ideaReadyTaskIds([], 'idea-1')).toEqual([]);
    expect(
      ideaReadyTaskIds(
        [item({ id: 'TASK-a', stage_position: 7, originating_idea_id: 'idea-1' })],
        'idea-1',
      ),
    ).toEqual([]);
  });
});
