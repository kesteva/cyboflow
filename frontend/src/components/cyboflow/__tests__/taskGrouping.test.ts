import { describe, expect, it } from 'vitest';
import type { BacklogTaskItem } from '../../../../../shared/types/tasks';
import { flattenGroups, groupTasksByEpic } from '../taskGrouping';

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
    category: 'feature',
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

// The pickers' eligibility predicate: only approved, non-archived tasks.
const isEligible = (t: BacklogTaskItem): boolean =>
  t.type === 'task' && t.approved_at !== null && t.archived_at === null;

describe('groupTasksByEpic', () => {
  it('nests each epic’s eligible children under that epic and keeps list order', () => {
    const rows = [
      makeItem({
        id: 'EPIC-1',
        ref: 'EPIC-1',
        title: 'First epic',
        type: 'epic',
        children: [
          makeItem({ id: 'T-A', ref: 'TASK-A', parent_epic_id: 'EPIC-1' }),
          makeItem({ id: 'T-B', ref: 'TASK-B', parent_epic_id: 'EPIC-1' }),
        ],
      }),
      makeItem({
        id: 'EPIC-2',
        ref: 'EPIC-2',
        title: 'Second epic',
        type: 'epic',
        children: [makeItem({ id: 'T-C', ref: 'TASK-C', parent_epic_id: 'EPIC-2' })],
      }),
    ];

    const groups = groupTasksByEpic(rows, isEligible);

    expect(groups.map((g) => g.epic?.ref)).toEqual(['EPIC-1', 'EPIC-2']);
    expect(groups[0].epic).toEqual({ id: 'EPIC-1', ref: 'EPIC-1', title: 'First epic' });
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['T-A', 'T-B']);
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['T-C']);
  });

  it('puts orphan (no-epic) tasks in a trailing null group', () => {
    const rows = [
      makeItem({
        id: 'EPIC-1',
        ref: 'EPIC-1',
        type: 'epic',
        children: [makeItem({ id: 'T-A', ref: 'TASK-A', parent_epic_id: 'EPIC-1' })],
      }),
      makeItem({ id: 'T-ORPHAN', ref: 'TASK-ORPHAN' }),
    ];

    const groups = groupTasksByEpic(rows, isEligible);

    expect(groups).toHaveLength(2);
    expect(groups[1].epic).toBeNull();
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['T-ORPHAN']);
  });

  it('drops epics with no eligible children (no empty group)', () => {
    const rows = [
      makeItem({
        id: 'EPIC-1',
        ref: 'EPIC-1',
        type: 'epic',
        children: [
          // Both children ineligible: one archived, one unapproved.
          makeItem({ id: 'T-ARCH', ref: 'TASK-ARCH', parent_epic_id: 'EPIC-1', archived_at: 'x' }),
          makeItem({ id: 'T-PEND', ref: 'TASK-PEND', parent_epic_id: 'EPIC-1', approved_at: null }),
        ],
      }),
      makeItem({ id: 'T-ORPHAN', ref: 'TASK-ORPHAN' }),
    ];

    const groups = groupTasksByEpic(rows, isEligible);

    expect(groups).toHaveLength(1);
    expect(groups[0].epic).toBeNull();
  });

  it('drops non-task top-level rows (ideas/epics never leak into a group’s tasks)', () => {
    const rows = [
      makeItem({ id: 'IDEA-1', ref: 'IDEA-1', type: 'idea' }),
      makeItem({ id: 'EPIC-EMPTY', ref: 'EPIC-EMPTY', type: 'epic', children: [] }),
      makeItem({ id: 'T-ORPHAN', ref: 'TASK-ORPHAN' }),
    ];

    const groups = groupTasksByEpic(rows, isEligible);

    expect(groups).toHaveLength(1);
    expect(groups[0].epic).toBeNull();
    expect(groups[0].tasks.map((t) => t.id)).toEqual(['T-ORPHAN']);
  });

  it('returns no groups when nothing is eligible', () => {
    const rows = [makeItem({ id: 'T-DONE', ref: 'TASK-DONE', approved_at: null })];
    expect(groupTasksByEpic(rows, isEligible)).toEqual([]);
  });
});

describe('flattenGroups', () => {
  it('flattens grouped tasks back to a list-ordered array', () => {
    const rows = [
      makeItem({
        id: 'EPIC-1',
        ref: 'EPIC-1',
        type: 'epic',
        children: [makeItem({ id: 'T-A', ref: 'TASK-A', parent_epic_id: 'EPIC-1' })],
      }),
      makeItem({ id: 'T-ORPHAN', ref: 'TASK-ORPHAN' }),
    ];
    const flat = flattenGroups(groupTasksByEpic(rows, isEligible));
    expect(flat.map((t) => t.id)).toEqual(['T-A', 'T-ORPHAN']);
  });
});
