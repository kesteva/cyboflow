/**
 * Unit tests for resolveRunFrozenSpec (A/B testing, migration 046).
 *
 * revision present → returns the revision text; revision absent → falls back to
 * the live workflows.spec_json; missing run → null; schema-level absence
 * (no spec_hash column) → fail-soft to live spec.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolveRunFrozenSpec } from '../runFrozenSpec';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { DatabaseLike } from '../types';

function makeDb(withSpecHash = true): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflows (id TEXT PRIMARY KEY, name TEXT NOT NULL, spec_json TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL${withSpecHash ? ', spec_hash TEXT' : ''}
    );
    CREATE TABLE workflow_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, workflow_id TEXT NOT NULL, spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL, UNIQUE(workflow_id, spec_hash)
    );
  `);
  db.prepare("INSERT INTO workflows (id, name, spec_json) VALUES ('wf-1', 'planner', '{\"live\":true}')").run();
  return db;
}

describe('resolveRunFrozenSpec', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('returns the revision spec_json when a revision resolves for (workflow_id, spec_hash)', () => {
    db.prepare("INSERT INTO workflow_runs (id, workflow_id, spec_hash) VALUES ('run-1', 'wf-1', 'hashA')").run();
    db.prepare("INSERT INTO workflow_revisions (workflow_id, spec_hash, spec_json) VALUES ('wf-1', 'hashA', '{\"frozen\":true}')").run();
    const res = resolveRunFrozenSpec(dbAdapter(db), 'run-1');
    expect(res).toEqual({ workflowName: 'planner', specJson: '{"frozen":true}' });
  });

  it('falls back to the live workflows.spec_json when no revision row exists', () => {
    db.prepare("INSERT INTO workflow_runs (id, workflow_id, spec_hash) VALUES ('run-2', 'wf-1', 'missingHash')").run();
    const res = resolveRunFrozenSpec(dbAdapter(db), 'run-2');
    expect(res).toEqual({ workflowName: 'planner', specJson: '{"live":true}' });
  });

  it('falls back to the live spec when the run has no spec_hash (legacy pre-026 run)', () => {
    db.prepare("INSERT INTO workflow_runs (id, workflow_id, spec_hash) VALUES ('run-3', 'wf-1', NULL)").run();
    const res = resolveRunFrozenSpec(dbAdapter(db), 'run-3');
    expect(res).toEqual({ workflowName: 'planner', specJson: '{"live":true}' });
  });

  it('returns null when the run row is missing', () => {
    expect(resolveRunFrozenSpec(dbAdapter(db), 'nope')).toBeNull();
  });

  it('is fail-soft to the live spec when the spec_hash column is absent (schema-level)', () => {
    const legacyDb = makeDb(false);
    legacyDb.prepare("INSERT INTO workflow_runs (id, workflow_id) VALUES ('run-4', 'wf-1')").run();
    const res = resolveRunFrozenSpec(dbAdapter(legacyDb), 'run-4');
    expect(res).toEqual({ workflowName: 'planner', specJson: '{"live":true}' });
  });

  it('RETHROWS a genuine (non-schema) DB error instead of masking it as run-not-found', () => {
    // A transient / systemic error (lock, I-O, corruption) must surface — the
    // fail-soft fallback is reserved for schema ABSENCE (no such table/column).
    const throwingDb = {
      prepare: () => ({
        get: () => {
          throw new Error('SQLITE_BUSY: database is locked');
        },
      }),
    } as unknown as DatabaseLike;
    expect(() => resolveRunFrozenSpec(throwingDb, 'run-x')).toThrow(/database is locked/);
  });
});
