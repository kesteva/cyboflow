/**
 * The synced projection (projection.ts) over a fully migrated DB: which fields
 * sync per type, stage keys (derived stages never sync), depends_on, and the
 * experiment-sandbox exclusion. Fast and offline: part of the per-PR gate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseService } from '../../../database/database';
import { TaskChangeRouter } from '../../../orchestrator/taskChangeRouter';
import { dbAdapter } from '../../../orchestrator/__test_fixtures__/dbAdapter';
import {
  SYNCED_FIELDS,
  normalizeDependsOn,
  projectStageKey,
  readEntityProjection,
  readProjection,
  stageIdForKey,
} from '../projection';

let dir: string;
let svc: DatabaseService;
let db: Database.Database;
let router: TaskChangeRouter;
let projectId: number;
const stage = (pos: number): string => `stage-board-${projectId}-default-${pos}`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cyboflow-projection-'));
  svc = new DatabaseService(join(dir, 'test.db'));
  svc.initialize();
  db = svc.getDb();
  projectId = svc.createProject('P', join(dir, 'proj')).id;
  router = new TaskChangeRouter(dbAdapter(db));
});

afterEach(() => {
  svc.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('projectStageKey', () => {
  it('maps positions to keys, epics at 6/9 to rollup, an in-development task to its entry stage', () => {
    expect(projectStageKey('idea', 1, null)).toBe('1');
    expect(projectStageKey('epic', 6, null)).toBe('rollup');
    expect(projectStageKey('epic', 9, null)).toBe('rollup');
    expect(projectStageKey('epic', 10, null)).toBe('10');
    expect(projectStageKey('task', 7, 1)).toBe('1');
    expect(projectStageKey('task', 7, null)).toBe('6');
    expect(projectStageKey('task', 9, null)).toBe('9');
  });
});

describe('readProjection', () => {
  it('projects exactly the synced fields per type, with depends_on sorted', async () => {
    const { taskId: idea } = await router.applyChange(projectId, { actor: 'user', entityType: 'idea', title: 'I', scope: 'small' });
    const { taskId: epic } = await router.applyChange(projectId, { actor: 'user', entityType: 'epic', title: 'E', originatingIdeaId: idea });
    const { taskId: b } = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'B', parentEpicId: epic });
    const { taskId: a } = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'A', parentEpicId: epic });
    const { taskId: c } = await router.applyChange(projectId, { actor: 'user', entityType: 'task', title: 'C', parentEpicId: epic });
    await router.applyChange(projectId, { actor: 'user', taskId: a, dependsOnTaskId: c });
    await router.applyChange(projectId, { actor: 'user', taskId: a, dependsOnTaskId: b, dependencyKind: 'related' });

    const p = readProjection(dbAdapter(db), projectId);
    for (const e of p.values()) expect(Object.keys(e.fields)).toEqual([...SYNCED_FIELDS[e.entityType]]);
    expect(p.get(idea)?.fields).toMatchObject({ title: 'I', scope: 'small', stage: '1', decomposed_at: null });
    expect(p.get(epic)?.fields).toMatchObject({ stage: 'rollup', originating_idea_id: idea });
    const expected = [
      { id: b, kind: 'related' },
      { id: c, kind: 'blocking' },
    ].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(p.get(a)?.fields.depends_on).toEqual(expected);
    expect(readEntityProjection(dbAdapter(db), projectId, 'task', a)?.fields).toEqual(p.get(a)?.fields);
  });

  it('never projects an experiment-sandbox row', async () => {
    await router.applyChange(projectId, { actor: 'orchestrator', entityType: 'task', title: 'sandboxed', experimentId: 'exp', experimentArm: 'A' });
    expect(readProjection(dbAdapter(db), projectId).size).toBe(0);
  });

  it('maps stage keys back to this project board', () => {
    expect(stageIdForKey(dbAdapter(db), projectId, '9')).toBe(stage(9));
    expect(stageIdForKey(dbAdapter(db), projectId, '42')).toBeNull();
    expect(stageIdForKey(dbAdapter(db), projectId, 'rollup')).toBeNull();
  });
});

describe('normalizeDependsOn', () => {
  it('sorts, dedupes and rejects malformed entries', () => {
    expect(normalizeDependsOn([{ id: 'b', kind: 'blocking' }, { id: 'a', kind: 'related' }, { id: 'b', kind: 'blocking' }])).toEqual([
      { id: 'a', kind: 'related' },
      { id: 'b', kind: 'blocking' },
    ]);
    expect(normalizeDependsOn([{ id: 'a', kind: 'weird' }])).toBeNull();
    expect(normalizeDependsOn('nope')).toBeNull();
  });
});
