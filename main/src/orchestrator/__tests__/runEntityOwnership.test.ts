/**
 * Unit tests for runEntityOwnership — the run→entity ownership derivation.
 *
 * Covered:
 *  - listRunOwnedIdeaIds: seed-only run -> [seed].
 *  - listRunOwnedIdeaIds: run that created 2 ideas + has a seed -> union of all
 *    3, de-duped (a duplicate 'created' event for one id appears once).
 *  - listRunCreatedTaskIds: returns only the run-created tasks (not ideas, not
 *    other runs' tasks, not non-'created' kinds).
 *  - Fail-soft: a DB whose workflow_runs lacks seed_idea_id, and a DB with no
 *    entity_events table, both yield [] without throwing.
 *
 * In-memory better-sqlite3 — the entity_events shape mirrors migration 015 and
 * workflow_runs carries the seed_idea_id column added by migration 017.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { listRunOwnedIdeaIds, listRunCreatedTaskIds } from '../runEntityOwnership';
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

let seqCounter = 0;
function insertEvent(
  db: Database.Database,
  opts: { entityType: 'idea' | 'epic' | 'task'; entityId: string; kind: string; runId: string | null },
): void {
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES (?, ?, ?, ?, 'orchestrator', ?)`,
  ).run(opts.entityType, opts.entityId, (seqCounter += 1), opts.kind, opts.runId);
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
