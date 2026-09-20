/**
 * Unit tests for runEntityOwnership — the run→entity ownership derivation.
 *
 * Covered:
 *  - listRunOwnedIdeaIds: seed-only run -> [seed].
 *  - listRunOwnedIdeaIds: run that created 2 ideas + has a seed -> union of all
 *    3, de-duped (a duplicate 'created' event for one id appears once).
 *  - listRunCreatedTaskIds: returns only the run-created tasks (not ideas, not
 *    other runs' tasks, not non-'created' kinds).
 *  - listRunDecomposedIdeaIds: retires only owned ideas with a run-created child
 *    (task or epic) carrying their originating_idea_id lineage; a childless seed
 *    idea, a NULL-lineage child, and another run's child all attribute nothing;
 *    missing epics/tasks tables fail closed to [].
 *  - Fail-soft: a DB whose workflow_runs lacks seed_idea_id, and a DB with no
 *    entity_events table, both yield [] without throwing.
 *
 * In-memory better-sqlite3 — the entity_events shape mirrors migration 015 and
 * workflow_runs carries the seed_idea_id column added by migration 017.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  listRunOwnedIdeaIds,
  listRunCreatedTaskIds,
  listRunDecomposedIdeaIds,
  listRunOwnedOrBatchIdeaIds,
  listRunBatchIdeaIds,
  resolveRunBatchIdeaId,
  listApproveIdeasBatchRows,
  hasReviewableDesignSurface,
} from '../runEntityOwnership';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test DB builders
// ---------------------------------------------------------------------------

/**
 * A DB with workflow_runs(id, seed_idea_id) + entity_events (the migration-015
 * shape, narrowed to the columns this module reads/writes).
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id           TEXT PRIMARY KEY,
      seed_idea_id TEXT
    );
    CREATE TABLE entity_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type  TEXT NOT NULL CHECK (entity_type IN ('idea', 'epic', 'task', 'review_item')),
      entity_id    TEXT NOT NULL,
      seq          INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      actor        TEXT NOT NULL,
      run_id       TEXT,
      changes_json TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

function insertRun(db: Database.Database, id: string, seedIdeaId: string | null): void {
  db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run(id, seedIdeaId);
}

/** A buildDb() variant carrying the migration-060 seed_idea_ids column. */
function buildDbWithSeedIds(): Database.Database {
  const db = buildDb();
  db.exec('ALTER TABLE workflow_runs ADD COLUMN seed_idea_ids TEXT');
  return db;
}

function setSeedIdeaIds(db: Database.Database, id: string, seedIdeaIds: string | null): void {
  db.prepare('UPDATE workflow_runs SET seed_idea_ids = ? WHERE id = ?').run(seedIdeaIds, id);
}

/**
 * A buildDbWithSeedIds() variant that additionally carries minimal epics + tasks
 * tables (id + the originating_idea_id lineage column), so lineage-aware reads
 * that JOIN entity_events to those child tables can resolve.
 */
function buildDbWithLineage(): Database.Database {
  const db = buildDbWithSeedIds();
  db.exec(`
    CREATE TABLE epics (
      id                  TEXT PRIMARY KEY,
      originating_idea_id TEXT
    );
    CREATE TABLE tasks (
      id                  TEXT PRIMARY KEY,
      originating_idea_id TEXT
    );
  `);
  return db;
}

function insertChild(
  db: Database.Database,
  table: 'epics' | 'tasks',
  id: string,
  originatingIdeaId: string | null,
): void {
  db.prepare(`INSERT INTO ${table} (id, originating_idea_id) VALUES (?, ?)`).run(id, originatingIdeaId);
}

/**
 * A sprint-batch-aware DB: workflow_runs additionally carries batch_id + task_id,
 * tasks carry parent_epic_id (so a task's idea can resolve via its epic), and a
 * sprint_batch_tasks join table (migration 022) links a batch to its tasks. This
 * is what listRunBatchIdeaIds / resolveRunBatchIdeaId read.
 */
function buildDbWithBatch(): Database.Database {
  const db = buildDbWithSeedIds();
  db.exec(`
    ALTER TABLE workflow_runs ADD COLUMN batch_id TEXT;
    ALTER TABLE workflow_runs ADD COLUMN task_id  TEXT;
    CREATE TABLE epics (
      id                  TEXT PRIMARY KEY,
      originating_idea_id TEXT
    );
    CREATE TABLE tasks (
      id                  TEXT PRIMARY KEY,
      originating_idea_id TEXT,
      parent_epic_id      TEXT
    );
    CREATE TABLE sprint_batch_tasks (
      batch_id TEXT NOT NULL,
      task_id  TEXT NOT NULL
    );
  `);
  return db;
}

function insertRunWithBatch(
  db: Database.Database,
  id: string,
  batchId: string | null,
  taskId: string | null,
): void {
  db.prepare('INSERT INTO workflow_runs (id, seed_idea_id, batch_id, task_id) VALUES (?, NULL, ?, ?)').run(
    id,
    batchId,
    taskId,
  );
}

function insertBatchTask(
  db: Database.Database,
  batchId: string,
  taskId: string,
  originatingIdeaId: string | null,
  parentEpicId: string | null = null,
): void {
  db.prepare('INSERT INTO tasks (id, originating_idea_id, parent_epic_id) VALUES (?, ?, ?)').run(
    taskId,
    originatingIdeaId,
    parentEpicId,
  );
  db.prepare('INSERT INTO sprint_batch_tasks (batch_id, task_id) VALUES (?, ?)').run(batchId, taskId);
}

let seqCounter = 0;
function insertEvent(
  db: Database.Database,
  opts: {
    entityType: 'idea' | 'epic' | 'task';
    entityId: string;
    kind: string;
    runId: string | null;
    actor?: string;
  },
): void {
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(opts.entityType, opts.entityId, (seqCounter += 1), opts.kind, opts.actor ?? 'orchestrator', opts.runId);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runEntityOwnership.listRunOwnedIdeaIds', () => {
  it('returns just the seed idea for a run with a seed and no created ideas', () => {
    const db = buildDb();
    insertRun(db, 'run-seed', 'ide_seed');

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-seed')).toEqual(['ide_seed']);
  });

  it('unions the seed with run-created ideas, de-duped', () => {
    const db = buildDb();
    insertRun(db, 'run-1', 'ide_seed');
    // Two distinct ideas created by the run.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_a', kind: 'created', runId: 'run-1' });
    insertEvent(db, { entityType: 'idea', entityId: 'ide_b', kind: 'created', runId: 'run-1' });
    // A duplicate 'created' event for ide_a must NOT produce a duplicate.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_a', kind: 'created', runId: 'run-1' });
    // Noise that must be excluded: a non-'created' kind, an idea from another run.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_a', kind: 'updated', runId: 'run-1' });
    insertEvent(db, { entityType: 'idea', entityId: 'ide_other', kind: 'created', runId: 'run-2' });

    const owned = listRunOwnedIdeaIds(dbAdapter(db), 'run-1');
    expect([...owned].sort()).toEqual(['ide_a', 'ide_b', 'ide_seed']);
    // Each id appears exactly once.
    expect(owned).toHaveLength(new Set(owned).size);
  });

  it('returns the seed-overlapping created idea exactly once when it equals the seed', () => {
    const db = buildDb();
    insertRun(db, 'run-overlap', 'ide_seed');
    insertEvent(db, { entityType: 'idea', entityId: 'ide_seed', kind: 'created', runId: 'run-overlap' });

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-overlap')).toEqual(['ide_seed']);
  });

  it('returns only run-created ideas when the seed is null', () => {
    const db = buildDb();
    insertRun(db, 'run-noseed', null);
    insertEvent(db, { entityType: 'idea', entityId: 'ide_x', kind: 'created', runId: 'run-noseed' });

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-noseed')).toEqual(['ide_x']);
  });

  it('adopts pre-existing ideas the decomposition step updated in place (actor agent:ideas)', () => {
    const db = buildDb();
    insertRun(db, 'run-adopt', null);
    // A prior run created these cards; this run's ideas step updated them.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior_a', kind: 'created', runId: 'run-old' });
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior_b', kind: 'created', runId: 'run-old' });
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior_a', kind: 'updated', runId: 'run-adopt', actor: 'agent:ideas' });
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior_b', kind: 'updated', runId: 'run-adopt', actor: 'agent:ideas' });

    expect([...listRunOwnedIdeaIds(dbAdapter(db), 'run-adopt')].sort()).toEqual([
      'ide_prior_a',
      'ide_prior_b',
    ]);
  });

  it('does NOT adopt ideas updated by other step agents or by other runs', () => {
    const db = buildDb();
    insertRun(db, 'run-adopt', null);
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior', kind: 'created', runId: 'run-old' });
    // Incidental touch by the interview agent — not a batch adoption.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_prior', kind: 'updated', runId: 'run-adopt', actor: 'agent:interview' });
    // Decomposition update belonging to a DIFFERENT run.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_other', kind: 'updated', runId: 'run-else', actor: 'agent:ideas' });

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-adopt')).toEqual([]);
  });
});

describe('runEntityOwnership.listRunOwnedIdeaIds — seed_idea_ids (migration 061)', () => {
  it('unions seed_idea_id, seed_idea_ids and run-created ideas, de-duped', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-multi', 'ide_seed');
    setSeedIdeaIds(db, 'run-multi', JSON.stringify(['ide_seed', 'ide_x', 'ide_y']));
    insertEvent(db, { entityType: 'idea', entityId: 'ide_created', kind: 'created', runId: 'run-multi' });

    const owned = listRunOwnedIdeaIds(dbAdapter(db), 'run-multi');
    expect([...owned].sort()).toEqual(['ide_created', 'ide_seed', 'ide_x', 'ide_y']);
    expect(owned).toHaveLength(new Set(owned).size);
  });

  it('collapses an id shared by all three sources to a single entry', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-overlap', 'ide_dup');
    setSeedIdeaIds(db, 'run-overlap', JSON.stringify(['ide_dup']));
    insertEvent(db, { entityType: 'idea', entityId: 'ide_dup', kind: 'created', runId: 'run-overlap' });

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-overlap')).toEqual(['ide_dup']);
  });

  it('NULL seed_idea_ids (legacy single-idea run) contributes nothing beyond seed_idea_id', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-null', 'ide_seed'); // seed_idea_ids defaults NULL

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-null')).toEqual(['ide_seed']);
  });

  it('filters non-string and empty-string members of seed_idea_ids', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-mixed', null);
    setSeedIdeaIds(db, 'run-mixed', JSON.stringify(['ide_ok', 123, '', null]));

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-mixed')).toEqual(['ide_ok']);
  });

  it('fail-soft: a pre-060 DB without the seed_idea_ids column still unions seed_idea_id + created', () => {
    const db = buildDb(); // no seed_idea_ids column
    insertRun(db, 'run-pre060', 'ide_seed');
    insertEvent(db, { entityType: 'idea', entityId: 'ide_c', kind: 'created', runId: 'run-pre060' });

    expect(() => listRunOwnedIdeaIds(dbAdapter(db), 'run-pre060')).not.toThrow();
    expect([...listRunOwnedIdeaIds(dbAdapter(db), 'run-pre060')].sort()).toEqual(['ide_c', 'ide_seed']);
  });

  it('fail-soft: corrupt seed_idea_ids JSON contributes nothing (seed_idea_id + created still union)', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-corrupt', 'ide_seed');
    setSeedIdeaIds(db, 'run-corrupt', '{not valid json');
    insertEvent(db, { entityType: 'idea', entityId: 'ide_c', kind: 'created', runId: 'run-corrupt' });

    expect(() => listRunOwnedIdeaIds(dbAdapter(db), 'run-corrupt')).not.toThrow();
    expect([...listRunOwnedIdeaIds(dbAdapter(db), 'run-corrupt')].sort()).toEqual(['ide_c', 'ide_seed']);
  });

  it('fail-soft: a non-array seed_idea_ids value contributes nothing', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-nonarray', 'ide_seed');
    setSeedIdeaIds(db, 'run-nonarray', JSON.stringify({ not: 'an array' }));

    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-nonarray')).toEqual(['ide_seed']);
  });
});

describe('runEntityOwnership.listRunCreatedTaskIds', () => {
  it('returns only the tasks the run created (not ideas, other runs, or non-created kinds)', () => {
    const db = buildDb();
    insertRun(db, 'run-1', null);
    insertEvent(db, { entityType: 'task', entityId: 'tsk_a', kind: 'created', runId: 'run-1' });
    insertEvent(db, { entityType: 'task', entityId: 'tsk_b', kind: 'created', runId: 'run-1' });
    // Excluded: an idea, a task from another run, a non-'created' kind on this run.
    insertEvent(db, { entityType: 'idea', entityId: 'ide_a', kind: 'created', runId: 'run-1' });
    insertEvent(db, { entityType: 'task', entityId: 'tsk_other', kind: 'created', runId: 'run-2' });
    insertEvent(db, { entityType: 'task', entityId: 'tsk_a', kind: 'updated', runId: 'run-1' });

    expect([...listRunCreatedTaskIds(dbAdapter(db), 'run-1')].sort()).toEqual(['tsk_a', 'tsk_b']);
  });

  it('returns [] for a run that created no tasks', () => {
    const db = buildDb();
    insertRun(db, 'run-empty', 'ide_seed');

    expect(listRunCreatedTaskIds(dbAdapter(db), 'run-empty')).toEqual([]);
  });
});

describe('runEntityOwnership.listRunDecomposedIdeaIds', () => {
  it('retires only owned ideas with a run-created task carrying their lineage', () => {
    const db = buildDbWithLineage();
    insertRun(db, 'run-multi', 'ide_a');
    setSeedIdeaIds(db, 'run-multi', JSON.stringify(['ide_a', 'ide_b']));
    // A run-created task carrying originating_idea_id = ide_a decomposes ide_a;
    // ide_b was seeded but has no run-created child → it stays on the board.
    insertEvent(db, { entityType: 'task', entityId: 'tsk_1', kind: 'created', runId: 'run-multi' });
    insertChild(db, 'tasks', 'tsk_1', 'ide_a');

    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-multi')).toEqual(['ide_a']);
  });

  it('counts a run-created epic child lineage too', () => {
    const db = buildDbWithLineage();
    insertRun(db, 'run-epic', 'ide_c');
    insertEvent(db, { entityType: 'epic', entityId: 'epc_1', kind: 'created', runId: 'run-epic' });
    insertChild(db, 'epics', 'epc_1', 'ide_c');

    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-epic')).toEqual(['ide_c']);
  });

  it('a seed-only idea with no run-created children retires nothing', () => {
    const db = buildDbWithLineage();
    insertRun(db, 'run-childless', 'ide_d');

    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-childless')).toEqual([]);
  });

  it('fail-CLOSED: a run-created child with NULL originating_idea_id attributes to no idea', () => {
    const db = buildDbWithLineage();
    insertRun(db, 'run-nulllineage', 'ide_e');
    insertEvent(db, { entityType: 'task', entityId: 'tsk_null', kind: 'created', runId: 'run-nulllineage' });
    insertChild(db, 'tasks', 'tsk_null', null);

    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-nulllineage')).toEqual([]);
  });

  it('does not retire an idea decomposed only by ANOTHER run', () => {
    const db = buildDbWithLineage();
    insertRun(db, 'run-x', 'ide_f');
    // A child carrying ide_f lineage, but created by a DIFFERENT run.
    insertEvent(db, { entityType: 'task', entityId: 'tsk_other', kind: 'created', runId: 'run-other' });
    insertChild(db, 'tasks', 'tsk_other', 'ide_f');

    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-x')).toEqual([]);
  });

  it('fail-soft: missing epics/tasks tables yield [] (no throw) even with owned ideas', () => {
    const db = buildDbWithSeedIds(); // no epics/tasks tables
    insertRun(db, 'run-notables', 'ide_g');

    expect(() => listRunDecomposedIdeaIds(dbAdapter(db), 'run-notables')).not.toThrow();
    expect(listRunDecomposedIdeaIds(dbAdapter(db), 'run-notables')).toEqual([]);
  });
});

describe('runEntityOwnership.listRunOwnedOrBatchIdeaIds', () => {
  it('returns the FULL owned-idea set when the run owns any (seed + created, de-duped)', () => {
    const db = buildDbWithSeedIds();
    insertRun(db, 'run-owned', 'ide_seed');
    setSeedIdeaIds(db, 'run-owned', JSON.stringify(['ide_seed', 'ide_x']));
    insertEvent(db, { entityType: 'idea', entityId: 'ide_y', kind: 'created', runId: 'run-owned' });

    const ids = listRunOwnedOrBatchIdeaIds(dbAdapter(db), 'run-owned');
    expect([...ids].sort()).toEqual(['ide_seed', 'ide_x', 'ide_y']);
  });

  it('falls back to [] when the run owns no idea and no sprint-batch tables exist (fail-soft)', () => {
    const db = buildDb(); // no sprint_batch_tasks / batch_id — resolveRunBatchIdeaId degrades to null
    insertRun(db, 'run-none', null);

    expect(() => listRunOwnedOrBatchIdeaIds(dbAdapter(db), 'run-none')).not.toThrow();
    expect(listRunOwnedOrBatchIdeaIds(dbAdapter(db), 'run-none')).toEqual([]);
  });

  it('falls back to ALL of the sprint batch ideas (not just the dominant one) when the run owns none', () => {
    const db = buildDbWithBatch();
    insertRunWithBatch(db, 'run-batch', 'batch-1', null);
    // ide_a dominates (2 tasks), ide_b has 1 — a standalone sprint owns no ideas
    // so this must surface BOTH, dominant-first.
    insertBatchTask(db, 'batch-1', 'tsk_1', 'ide_a');
    insertBatchTask(db, 'batch-1', 'tsk_2', 'ide_a');
    insertBatchTask(db, 'batch-1', 'tsk_3', 'ide_b');

    expect(listRunOwnedOrBatchIdeaIds(dbAdapter(db), 'run-batch')).toEqual(['ide_a', 'ide_b']);
  });
});

describe('runEntityOwnership.listRunBatchIdeaIds', () => {
  it('returns EVERY distinct batch idea, dominant-first (task count DESC, id tiebreak)', () => {
    const db = buildDbWithBatch();
    insertRunWithBatch(db, 'run-multi', 'batch-1', null);
    insertBatchTask(db, 'batch-1', 'tsk_1', 'ide_b'); // ide_b: 1 task
    insertBatchTask(db, 'batch-1', 'tsk_2', 'ide_a'); // ide_a: 2 tasks (dominant)
    insertBatchTask(db, 'batch-1', 'tsk_3', 'ide_a');
    insertBatchTask(db, 'batch-1', 'tsk_4', 'ide_c'); // ide_c: 1 task — tie with ide_b

    // ide_a (2) first; ide_b/ide_c tie at 1, broken by id ASC.
    expect(listRunBatchIdeaIds(dbAdapter(db), 'run-multi')).toEqual(['ide_a', 'ide_b', 'ide_c']);
  });

  it('resolves a batch task idea via its parent epic when the task carries no direct lineage', () => {
    const db = buildDbWithBatch();
    insertRunWithBatch(db, 'run-epic', 'batch-2', null);
    db.prepare('INSERT INTO epics (id, originating_idea_id) VALUES (?, ?)').run('epc_1', 'ide_via_epic');
    insertBatchTask(db, 'batch-2', 'tsk_1', null, 'epc_1'); // NULL direct lineage → via epic

    expect(listRunBatchIdeaIds(dbAdapter(db), 'run-epic')).toEqual(['ide_via_epic']);
  });

  it('falls back (rung 2) to the run task_id idea when there is no sprint batch', () => {
    const db = buildDbWithBatch();
    insertRunWithBatch(db, 'run-single', null, 'tsk_solo');
    db.prepare('INSERT INTO tasks (id, originating_idea_id, parent_epic_id) VALUES (?, ?, NULL)').run(
      'tsk_solo',
      'ide_solo',
    );

    expect(listRunBatchIdeaIds(dbAdapter(db), 'run-single')).toEqual(['ide_solo']);
  });

  it('returns [] (no throw) when no sprint-batch tables exist (fail-soft)', () => {
    const db = buildDb();
    insertRun(db, 'run-none', null);

    expect(() => listRunBatchIdeaIds(dbAdapter(db), 'run-none')).not.toThrow();
    expect(listRunBatchIdeaIds(dbAdapter(db), 'run-none')).toEqual([]);
  });

  it('resolveRunBatchIdeaId returns the head (dominant idea) of the full batch list', () => {
    const db = buildDbWithBatch();
    insertRunWithBatch(db, 'run-dom', 'batch-3', null);
    insertBatchTask(db, 'batch-3', 'tsk_1', 'ide_minor');
    insertBatchTask(db, 'batch-3', 'tsk_2', 'ide_major');
    insertBatchTask(db, 'batch-3', 'tsk_3', 'ide_major');

    expect(resolveRunBatchIdeaId(dbAdapter(db), 'run-dom')).toBe('ide_major');
  });
});

describe('runEntityOwnership fail-soft contract', () => {
  it('returns [] (no throw) when workflow_runs lacks the seed_idea_id column', () => {
    const db = new Database(':memory:');
    // Pre-migration-017 shape: no seed_idea_id column.
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY);
      CREATE TABLE entity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        run_id TEXT
      );
    `);
    db.prepare('INSERT INTO workflow_runs (id) VALUES (?)').run('run-old');

    expect(() => listRunOwnedIdeaIds(dbAdapter(db), 'run-old')).not.toThrow();
    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-old')).toEqual([]);
  });

  it('returns [] (no throw) when the entity_events table does not exist', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, seed_idea_id TEXT);');
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, ?)').run('run-noevents', 'ide_seed');

    // The seed still resolves; the missing entity_events table degrades to "no
    // created ideas" rather than throwing.
    expect(() => listRunOwnedIdeaIds(dbAdapter(db), 'run-noevents')).not.toThrow();
    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-noevents')).toEqual(['ide_seed']);

    expect(() => listRunCreatedTaskIds(dbAdapter(db), 'run-noevents')).not.toThrow();
    expect(listRunCreatedTaskIds(dbAdapter(db), 'run-noevents')).toEqual([]);
  });

  it('returns [] for an unknown runId without throwing', () => {
    const db = buildDb();
    expect(listRunOwnedIdeaIds(dbAdapter(db), 'run-missing')).toEqual([]);
    expect(listRunCreatedTaskIds(dbAdapter(db), 'run-missing')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listApproveIdeasBatchRows — the SHARED approve-ideas batch-row derivation
// (artifact tab rows AND the programmatic human-step gate's ideaRefs)
// ---------------------------------------------------------------------------

describe('runEntityOwnership.listApproveIdeasBatchRows', () => {
  /** buildDb() plus a minimal ideas table (the columns the helper SELECTs). */
  function buildDbWithIdeas(): Database.Database {
    const db = buildDb();
    db.exec(`
      CREATE TABLE ideas (
        id      TEXT PRIMARY KEY,
        ref     TEXT NOT NULL,
        title   TEXT NOT NULL,
        summary TEXT,
        body    TEXT,
        scope   TEXT
      );
    `);
    return db;
  }

  function insertIdea(
    db: Database.Database,
    id: string,
    ref: string,
    opts: { title?: string; summary?: string | null; body?: string | null; scope?: string | null } = {},
  ): void {
    db.prepare('INSERT INTO ideas (id, ref, title, summary, body, scope) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      ref,
      opts.title ?? `Idea ${ref}`,
      opts.summary ?? null,
      opts.body ?? null,
      opts.scope ?? null,
    );
  }

  function insertCreatedEvent(db: Database.Database, runId: string, ideaId: string, seq: number): void {
    db.prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
       VALUES ('idea', ?, ?, 'created', 'orchestrator', ?)`,
    ).run(ideaId, seq, runId);
  }

  it('returns one row per run-owned idea with a ref and content, keyed by display ref', () => {
    const db = buildDbWithIdeas();
    insertRun(db, 'run-b', null);
    insertIdea(db, 'ide_1', 'IDEA-001', { body: 'Spec body', scope: 'large' });
    insertIdea(db, 'ide_2', 'IDEA-002', { summary: 'One-liner', title: 'Second' });
    insertCreatedEvent(db, 'run-b', 'ide_1', 1);
    insertCreatedEvent(db, 'run-b', 'ide_2', 1);

    expect(listApproveIdeasBatchRows(dbAdapter(db), 'run-b')).toEqual([
      { ref: 'IDEA-001', title: 'Idea IDEA-001', scope: 'large', summary: null },
      { ref: 'IDEA-002', title: 'Second', scope: null, summary: 'One-liner' },
    ]);
  });

  it('skips ideas with no content (empty body AND summary) and ideas with an empty ref', () => {
    const db = buildDbWithIdeas();
    insertRun(db, 'run-b', null);
    insertIdea(db, 'ide_ok', 'IDEA-001', { body: 'has content' });
    insertIdea(db, 'ide_stub', 'IDEA-002'); // no body, no summary — not renderable yet
    insertIdea(db, 'ide_noref', '', { body: 'content but no ref' }); // no verdict-map key
    insertCreatedEvent(db, 'run-b', 'ide_ok', 1);
    insertCreatedEvent(db, 'run-b', 'ide_stub', 1);
    insertCreatedEvent(db, 'run-b', 'ide_noref', 1);

    expect(listApproveIdeasBatchRows(dbAdapter(db), 'run-b').map((r) => r.ref)).toEqual(['IDEA-001']);
  });

  it('is fail-soft: no ideas table, and an unknown run, both yield []', () => {
    // buildDb() has NO ideas table — the per-idea read throws → [].
    const noIdeas = buildDb();
    insertRun(noIdeas, 'run-b', 'ide_seed');
    expect(() => listApproveIdeasBatchRows(dbAdapter(noIdeas), 'run-b')).not.toThrow();
    expect(listApproveIdeasBatchRows(dbAdapter(noIdeas), 'run-b')).toEqual([]);

    const db = buildDbWithIdeas();
    expect(listApproveIdeasBatchRows(dbAdapter(db), 'run-missing')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hasReviewableDesignSurface — the approve-design gate's precondition
// ---------------------------------------------------------------------------

describe('runEntityOwnership.hasReviewableDesignSurface', () => {
  /** buildDb() plus minimal ideas + artifacts tables (the columns read here). */
  function buildDesignDb(): Database.Database {
    const db = buildDb();
    db.exec(`
      CREATE TABLE ideas (
        id   TEXT PRIMARY KEY,
        ref  TEXT NOT NULL,
        body TEXT
      );
      CREATE TABLE artifacts (
        id           TEXT PRIMARY KEY,
        run_id       TEXT,
        atype        TEXT NOT NULL,
        payload_json TEXT
      );
    `);
    return db;
  }

  it('true when the run has a prototype or arch-design artifact', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-a', null);
    db.prepare("INSERT INTO artifacts (id, run_id, atype) VALUES ('art_1', 'run-a', 'ui-prototype')").run();
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-a')).toBe(true);
  });

  it('true when an owned idea body carries an Architecture design section', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-b', 'ide_arch');
    db.prepare("INSERT INTO ideas (id, ref, body) VALUES ('ide_arch', 'IDEA-1', ?)").run(
      'Spec…\n\n## Architecture design\n\nStack: …',
    );
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-b')).toBe(true);
  });

  it('true only when the project-brief artifact carries an Architecture design section (launch, pre-ideas)', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-brief', null);
    const insert = db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)');
    // A plain brief (no architecture section) is NOT a design surface.
    insert.run('art_plain', 'run-brief', 'project-brief', JSON.stringify({ markdown: '## Project brief\n…' }));
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-brief')).toBe(false);
    // The architecture step appended its section → reviewable.
    insertRun(db, 'run-brief-arch', null);
    insert.run(
      'art_arch',
      'run-brief-arch',
      'project-brief',
      JSON.stringify({ markdown: '## Project brief\n…\n\n## Architecture design\n\nStack: …' }),
    );
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-brief-arch')).toBe(true);
  });

  it('false when the run has neither (empty design surface)', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-c', 'ide_plain');
    db.prepare("INSERT INTO ideas (id, ref, body) VALUES ('ide_plain', 'IDEA-1', 'just a spec')").run();
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-c')).toBe(false);
  });

  it('FAIL-OPEN: a missing artifacts table yields true (the gate opens)', () => {
    const db = buildDb(); // no artifacts, no ideas tables
    insertRun(db, 'run-d', null);
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-d')).toBe(true);
  });

  /** Writes an `adversarial-review` artifact with the given markdown payload. */
  function insertReview(db: Database.Database, runId: string, markdown: string): void {
    db.prepare('INSERT INTO artifacts (id, run_id, atype, payload_json) VALUES (?, ?, ?, ?)').run(
      `art_rev_${runId}`,
      runId,
      'adversarial-review',
      JSON.stringify({ markdown }),
    );
  }

  it('true when a POPULATED adversarial-review artifact exists with no prototype or architecture', () => {
    // The reviewer raised a blocking defect against something that left no other
    // surface behind — the critique itself is what the human has to see.
    const db = buildDesignDb();
    insertRun(db, 'run-rev', null);
    insertReview(
      db,
      'run-rev',
      ['## Blocking', '', '#### AR-1 — no way back from Spend', '**What:** no Home affordance.', '', '## Findings', '', 'None.'].join('\n'),
    );
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev')).toBe(true);
  });

  it('true when only the non-blocking Findings section is populated', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-rev-f', null);
    insertReview(db, 'run-rev-f', '## Blocking\n\nNone.\n\n## Findings\n\n#### AR-2 — nit\n**What:** copy.');
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-f')).toBe(true);
  });

  it('false when the review artifact is EMPTY (both sections `None.`, or no entries at all)', () => {
    const db = buildDesignDb();
    insertRun(db, 'run-rev-empty', null);
    insertReview(db, 'run-rev-empty', '## Blocking\n\nNone.\n\n## Findings\n\nNone.\n');
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-empty')).toBe(false);

    insertRun(db, 'run-rev-bare', null);
    insertReview(db, 'run-rev-bare', 'Reported the adversarial review.\n');
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-bare')).toBe(false);
  });

  it('a run with NO review artifact keeps its existing result', () => {
    const db = buildDesignDb();
    // Nothing at all → still false (today's behaviour).
    insertRun(db, 'run-rev-none', null);
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-none')).toBe(false);
    // Another run's populated review is not this run's surface.
    insertReview(db, 'run-other', '## Blocking\n\n#### AR-1 — x\n**What:** y.');
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-none')).toBe(false);
    // A prototype still short-circuits to true without consulting the review.
    insertRun(db, 'run-rev-proto', null);
    db.prepare("INSERT INTO artifacts (id, run_id, atype) VALUES ('art_p', 'run-rev-proto', 'ui-prototype')").run();
    expect(hasReviewableDesignSurface(dbAdapter(db), 'run-rev-proto')).toBe(true);
  });
});
