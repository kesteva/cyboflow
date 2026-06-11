/**
 * Unit tests for the backlog selectors: archive-in-place filtering
 * (isArchived / filterTasks / countArchived), cross-project stage unification
 * (unifiedStages), position-keyed bucketing (bucketByStage), and the stage
 * helpers backing the per-card actions menu (selectableStages / findStageById /
 * friendlyStageError).
 */
import { describe, it, expect } from 'vitest';
import {
  DECOMPOSED_POSITION,
  isArchived,
  filterTasks,
  countArchived,
  unifiedStages,
  bucketByStage,
  visibleStages,
  deriveCounts,
  findStageById,
  selectableStages,
  friendlyStageError,
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
 * The canonical default board after migration 024 (matches database.ts
 * seedDefaultBoard): positions 1–10 + 12 — the terminal "Archived" stage
 * (position 11) no longer exists.
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
      stage(2, 'Research', { id: `${idPrefix}-s2` }),
      stage(3, 'Idea spec', { id: `${idPrefix}-s3` }),
      stage(4, 'Epics extracted', { id: `${idPrefix}-s4` }),
      stage(5, 'Tasks extracted', { id: `${idPrefix}-s5` }),
      stage(6, 'Ready for development', { id: `${idPrefix}-s6` }),
      stage(7, 'In development', { id: `${idPrefix}-s7`, write_policy: 'derived' }),
      stage(8, 'Ready to merge', { id: `${idPrefix}-s8`, write_policy: 'derived' }),
      stage(9, 'Done', { id: `${idPrefix}-s9`, is_terminal: true }),
      stage(10, "Won't do", { id: `${idPrefix}-s10`, is_terminal: true, hidden_by_default: true }),
      stage(12, 'Decomposed', { id: `${idPrefix}-s12`, is_terminal: true }),
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
    stage_id: 'board-1-s5',
    archived_at: null,
    version: 1,
    stage_position: 5,
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
    // Project 2 renamed a stage — the first board's label must front the column.
    b.stages[0] = { ...b.stages[0], label: 'Captured (custom)' };
    const stages = unifiedStages([a, b], null, false);
    expect(stages.map((s) => s.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 12]);
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
    expect(visibleStages(board, false).map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 12,
    ]);
    expect(visibleStages(board, true).map((s) => s.position)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12,
    ]);
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
      item({ id: 'TASK-1', project_id: 1, stage_id: 'board-1-s5', stage_position: 5 }),
      item({ id: 'TASK-2', project_id: 2, stage_id: 'board-2-s5', stage_position: 5 }),
      item({ id: 'IDEA-1', project_id: 2, type: 'idea', stage_id: 'board-2-s1', stage_position: 1 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    const at = (pos: number) => buckets.find((b) => b.stage.position === pos);
    // Both projects' position-5 items share one column despite different stage_ids.
    expect(at(5)?.tasks.map((t) => t.id)).toEqual(['TASK-1', 'TASK-2']);
    expect(at(1)?.tasks.map((t) => t.id)).toEqual(['IDEA-1']);
  });

  it('drops items whose stage position is not in the visible set; ignores epic children', () => {
    const stages = unifiedStages([defaultBoard()], null, false);
    const tasks = [
      // Won't-do (position 10) is hidden while showArchived is off.
      item({ id: 'TASK-1', stage_id: 'board-1-s10', stage_position: 10 }),
      item({ id: 'TASK-c1', parent_epic_id: 'EPIC-1', stage_position: 5 }),
    ];
    const buckets = bucketByStage(tasks, stages);
    expect(buckets.flatMap((b) => b.tasks)).toEqual([]);
  });

  it('preserves the StageBucket shape with one bucket per stage in order', () => {
    const stages = unifiedStages([defaultBoard()], null, true);
    const buckets = bucketByStage([], stages);
    expect(buckets.map((b) => b.stage.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12]);
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
  it('excludes derived stages, the current stage, and Decomposed; keeps terminals; sorts by position', () => {
    const result = selectableStages(defaultBoard(), 'board-1-s6');
    const positions = result.map((s) => s.position);
    // No derived (7, 8), not the current (6), not Decomposed (12).
    expect(positions).not.toContain(7);
    expect(positions).not.toContain(8);
    expect(positions).not.toContain(6);
    expect(positions).not.toContain(DECOMPOSED_POSITION);
    // Planning + terminal planning stages (Done / Won't do) remain, ascending.
    expect(positions).toEqual([1, 2, 3, 4, 5, 9, 10]);
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
