/**
 * Unit tests for the stage helpers backing the per-card actions menu
 * (selectableStages / findArchivedStage / findStageById / friendlyStageError).
 */
import { describe, it, expect } from 'vitest';
import {
  ARCHIVED_POSITION,
  DECOMPOSED_POSITION,
  findStageById,
  findArchivedStage,
  selectableStages,
  friendlyStageError,
} from '../backlogSelectors';
import type { Board, BoardStage } from '../../../../../shared/types/tasks';

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

/** The canonical 12-stage default board (matches database.ts seedDefaultBoard). */
function defaultBoard(): Board {
  return {
    id: 'board-1',
    project_id: 1,
    name: 'Default',
    kind: 'default',
    is_default: true,
    stages: [
      stage(1, 'Idea'),
      stage(2, 'Research'),
      stage(3, 'Idea spec'),
      stage(4, 'Epics extracted'),
      stage(5, 'Tasks extracted'),
      stage(6, 'Ready for development'),
      stage(7, 'In development', { write_policy: 'derived' }),
      stage(8, 'Ready to merge', { write_policy: 'derived' }),
      stage(9, 'Done', { is_terminal: true }),
      stage(10, "Won't do", { is_terminal: true, hidden_by_default: true }),
      stage(11, 'Archived', { is_terminal: true, hidden_by_default: true }),
      stage(12, 'Decomposed', { is_terminal: true }),
    ],
  };
}

describe('findStageById', () => {
  it('returns the matching stage', () => {
    expect(findStageById(defaultBoard(), 's-6')?.label).toBe('Ready for development');
  });

  it('returns null for an unknown stage id', () => {
    expect(findStageById(defaultBoard(), 's-nope')).toBeNull();
  });
});

describe('findArchivedStage', () => {
  it('resolves the position-11 Archived stage', () => {
    const s = findArchivedStage(defaultBoard());
    expect(s?.position).toBe(ARCHIVED_POSITION);
    expect(s?.label).toBe('Archived');
  });

  it('falls back to the stage labelled "Archived" when no position 11 exists', () => {
    const board: Board = {
      ...defaultBoard(),
      stages: [stage(1, 'Idea'), stage(5, 'Archived', { id: 's-arch', is_terminal: true })],
    };
    expect(findArchivedStage(board)?.id).toBe('s-arch');
  });

  it('returns null when the board has no archived stage', () => {
    const board: Board = { ...defaultBoard(), stages: [stage(1, 'Idea'), stage(2, 'Research')] };
    expect(findArchivedStage(board)).toBeNull();
  });
});

describe('selectableStages', () => {
  it('excludes derived stages, the current stage, and Decomposed; keeps terminals; sorts by position', () => {
    const result = selectableStages(defaultBoard(), 's-6');
    const positions = result.map((s) => s.position);
    // No derived (7, 8), not the current (6), not Decomposed (12).
    expect(positions).not.toContain(7);
    expect(positions).not.toContain(8);
    expect(positions).not.toContain(6);
    expect(positions).not.toContain(DECOMPOSED_POSITION);
    // Planning + terminal planning stages remain, in ascending order.
    expect(positions).toEqual([1, 2, 3, 4, 5, 9, 10, 11]);
  });

  it('omits the current stage even for an archived item (Archive offered back via other stages)', () => {
    const result = selectableStages(defaultBoard(), 's-11');
    const positions = result.map((s) => s.position);
    expect(positions).not.toContain(11);
    expect(positions).toEqual([1, 2, 3, 4, 5, 6, 9, 10]);
  });
});

describe('friendlyStageError', () => {
  it('maps the active-run conflict', () => {
    expect(friendlyStageError(new Error('active_runs: cancel active runs first'))).toMatch(
      /active run/i,
    );
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
    expect(friendlyStageError('boom')).toMatch(/could not update/i);
    expect(friendlyStageError(new Error(''))).toMatch(/could not update/i);
  });
});
