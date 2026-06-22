import { describe, it, expect } from 'vitest';
import { buildSeedTasksBlock } from '../seedTasksBlock';
import type { IdeaBodyReaderLike, SprintLaneTaskIdsLike } from '../runExecutor';

type TaskRow = NonNullable<ReturnType<IdeaBodyReaderLike['read']>>;

function task(p: Partial<TaskRow> & { title: string }): TaskRow {
  return {
    type: 'task',
    title: p.title,
    summary: p.summary ?? null,
    body: p.body ?? null,
    scope: p.scope ?? null,
    ...(p.ref !== undefined ? { ref: p.ref } : {}),
  };
}

/** A reader backed by an id→row map; unknown ids resolve to null. */
function reader(map: Record<string, TaskRow | null>): IdeaBodyReaderLike {
  return { read: (id) => (id in map ? map[id] : null) };
}

function lanes(ids: string[]): SprintLaneTaskIdsLike {
  return { listLaneTaskIds: () => ids };
}

describe('buildSeedTasksBlock', () => {
  it('returns null when the batch has no lane task ids', () => {
    expect(buildSeedTasksBlock('b', lanes([]), reader({}))).toBeNull();
  });

  it('returns null (fail-soft) when lane listing throws', () => {
    const throwing: SprintLaneTaskIdsLike = {
      listLaneTaskIds: () => {
        throw new Error('boom');
      },
    };
    expect(buildSeedTasksBlock('b', throwing, reader({}))).toBeNull();
  });

  it('renders one section per resolved task with the intro line', () => {
    const out = buildSeedTasksBlock(
      'b',
      lanes(['t1', 't2']),
      reader({
        t1: task({ title: 'Init Vite', ref: 'TASK-001', summary: 'Scaffold', body: 'Run create-vite.' }),
        t2: task({ title: 'Add Tailwind', ref: 'TASK-002', body: 'Depends on the scaffold.' }),
      }),
    );
    expect(out).toContain('This sprint covers 2 tasks. Execute ALL of them.');
    expect(out).toContain('## TASK-001: Init Vite');
    expect(out).toContain('Scaffold');
    expect(out).toContain('Run create-vite.');
    expect(out).toContain('## TASK-002: Add Tailwind');
    expect(out).toContain('Depends on the scaffold.');
  });

  it('uses the singular "task" for a one-task sprint', () => {
    const out = buildSeedTasksBlock('b', lanes(['t1']), reader({ t1: task({ title: 'Only', ref: 'TASK-9' }) }));
    expect(out).toContain('This sprint covers 1 task. Execute ALL of them.');
  });

  it('falls back to the raw id as the heading when no ref is present', () => {
    const out = buildSeedTasksBlock('b', lanes(['tsk_abc']), reader({ tsk_abc: task({ title: 'No ref' }) }));
    expect(out).toContain('## tsk_abc: No ref');
  });

  it('skips tasks that resolve to null or all-empty content', () => {
    const out = buildSeedTasksBlock(
      'b',
      lanes(['gone', 'empty', 'good']),
      reader({
        gone: null,
        empty: task({ title: '   ', summary: '  ', body: '' }),
        good: task({ title: 'Real', ref: 'TASK-1' }),
      }),
    );
    expect(out).toContain('This sprint covers 1 task. Execute ALL of them.');
    expect(out).toContain('## TASK-1: Real');
    expect(out).not.toContain('empty');
  });

  it('returns null when no task resolves to usable content', () => {
    const out = buildSeedTasksBlock('b', lanes(['a', 'b']), reader({ a: null, b: null }));
    expect(out).toBeNull();
  });
});
