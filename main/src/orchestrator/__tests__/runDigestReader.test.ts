/**
 * Unit tests for runDigestReader — what a run PRODUCED, folded into the
 * supervisor's prompts (CR-6).
 *
 * Covered:
 *  - the artifact ALLOW-LIST: only the payload-carrying atypes are read, and a
 *    templated deliverable (no `markdown` payload) contributes nothing;
 *  - entities: the run's owned ideas + created epics + created tasks, in that
 *    read order, with ref/title/body;
 *  - the PER-ITEM cap + its truncation marker;
 *  - the TOTAL cap: once spent, later items are dropped whole rather than folded
 *    in as empty shells;
 *  - fail-soft: a DB with no artifacts / entities tables yields an empty digest
 *    rather than a throw.
 *
 * In-memory better-sqlite3 mirroring the migration shapes the reader touches.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  RUN_DIGEST_ITEM_MAX_CHARS,
  RUN_DIGEST_TOTAL_MAX_CHARS,
  RUN_DIGEST_TRUNCATION_MARKER,
  readRunDigest,
} from '../runDigestReader';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

// ---------------------------------------------------------------------------
// Test DB
// ---------------------------------------------------------------------------

/**
 * workflow_runs + entity_events (the ownership projection's source) + the three
 * backlog tables + artifacts, narrowed to the columns this reader selects.
 */
function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE workflow_runs (
      id           TEXT PRIMARY KEY,
      seed_idea_id TEXT
    );
    CREATE TABLE entity_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id   TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      kind        TEXT NOT NULL,
      actor       TEXT NOT NULL,
      run_id      TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ideas (
      id TEXT PRIMARY KEY, ref TEXT, title TEXT, body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE epics (
      id TEXT PRIMARY KEY, ref TEXT, title TEXT, body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, ref TEXT, title TEXT, body TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE artifacts (
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL,
      atype        TEXT NOT NULL,
      label        TEXT NOT NULL,
      payload_json TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, NULL)').run('run-1');
  return db;
}

function addArtifact(
  db: Database.Database,
  id: string,
  atype: string,
  label: string,
  payload: unknown,
  runId = 'run-1',
): void {
  db.prepare('INSERT INTO artifacts (id, run_id, atype, label, payload_json) VALUES (?, ?, ?, ?, ?)').run(
    id,
    runId,
    atype,
    label,
    payload === undefined ? null : JSON.stringify(payload),
  );
}

/** Create an entity row AND the run-created event the ownership projection reads. */
function addEntity(
  db: Database.Database,
  table: 'ideas' | 'epics' | 'tasks',
  id: string,
  ref: string,
  title: string,
  body: string,
  runId = 'run-1',
): void {
  db.prepare(`INSERT INTO ${table} (id, ref, title, body) VALUES (?, ?, ?, ?)`).run(id, ref, title, body);
  const entityType = table === 'ideas' ? 'idea' : table === 'epics' ? 'epic' : 'task';
  db.prepare(
    `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id)
     VALUES (?, ?, 1, 'created', 'orchestrator', ?)`,
  ).run(entityType, id, runId);
}

describe('readRunDigest — artifacts', () => {
  it('reads only the payload-carrying allow-listed atypes', () => {
    const db = buildDb();
    addArtifact(db, 'a1', 'adversarial-review', 'Adversarial review', { markdown: '## Blocking\n\nAR-1' });
    addArtifact(db, 'a2', 'project-brief', 'Brief', { markdown: 'THOROUGHNESS: balanced' });
    // Not on the list: a templated tab and a canvas artifact.
    addArtifact(db, 'a3', 'idea-spec', 'Idea spec', { markdown: 'should not appear' });
    addArtifact(db, 'a4', 'generic', 'Canvas', { url: 'http://localhost:8081' });

    const digest = readRunDigest(dbAdapter(db), 'run-1');

    expect(digest.artifacts.map((a) => a.atype)).toEqual(['adversarial-review', 'project-brief']);
    expect(digest.artifacts[0]).toEqual({
      atype: 'adversarial-review',
      label: 'Adversarial review',
      markdown: '## Blocking\n\nAR-1',
    });
  });

  it('skips an allow-listed artifact whose payload carries no markdown string', () => {
    const db = buildDb();
    addArtifact(db, 'a1', 'adversarial-review', 'Review', { fileName: 'x.md' });
    addArtifact(db, 'a2', 'project-brief', 'Brief', undefined);
    addArtifact(db, 'a3', 'verify-runbook', 'Runbook', 'not json at all');

    expect(readRunDigest(dbAdapter(db), 'run-1').artifacts).toEqual([]);
  });

  it('ignores another run’s artifacts', () => {
    const db = buildDb();
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, NULL)').run('run-2');
    addArtifact(db, 'a1', 'project-brief', 'Theirs', { markdown: 'other run' }, 'run-2');

    expect(readRunDigest(dbAdapter(db), 'run-1').artifacts).toEqual([]);
  });
});

describe('readRunDigest — entities', () => {
  it('reads the run’s owned ideas and created epics + tasks, in that order', () => {
    const db = buildDb();
    addEntity(db, 'ideas', 'i1', 'IDEA-001', 'The idea', 'idea body');
    addEntity(db, 'epics', 'e1', 'EPIC-001', 'The epic', 'epic body');
    addEntity(db, 'tasks', 't1', 'TASK-001', 'The task', 'task body');

    const digest = readRunDigest(dbAdapter(db), 'run-1');

    expect(digest.entities).toEqual([
      { kind: 'idea', ref: 'IDEA-001', title: 'The idea', body: 'idea body' },
      { kind: 'epic', ref: 'EPIC-001', title: 'The epic', body: 'epic body' },
      { kind: 'task', ref: 'TASK-001', title: 'The task', body: 'task body' },
    ]);
  });

  it('ignores entities another run created', () => {
    const db = buildDb();
    db.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, NULL)').run('run-2');
    addEntity(db, 'tasks', 't9', 'TASK-009', 'Theirs', 'body', 'run-2');

    expect(readRunDigest(dbAdapter(db), 'run-1').entities).toEqual([]);
  });
});

describe('readRunDigest — caps', () => {
  it('truncates a single over-long item and marks the cut', () => {
    const db = buildDb();
    const huge = 'x'.repeat(RUN_DIGEST_ITEM_MAX_CHARS + 500);
    addArtifact(db, 'a1', 'adversarial-review', 'Review', { markdown: huge });

    const [artifact] = readRunDigest(dbAdapter(db), 'run-1').artifacts;

    expect(artifact.markdown.startsWith('x'.repeat(100))).toBe(true);
    expect(artifact.markdown.endsWith(RUN_DIGEST_TRUNCATION_MARKER)).toBe(true);
    expect(artifact.markdown.length).toBeLessThanOrEqual(
      RUN_DIGEST_ITEM_MAX_CHARS + RUN_DIGEST_TRUNCATION_MARKER.length + 1,
    );
  });

  it('drops later items whole once the TOTAL budget is spent', () => {
    const db = buildDb();
    // Five maximal artifacts exceed the 60k total after five (5 × 12k = 60k).
    for (let i = 0; i < 6; i++) {
      addArtifact(db, `a${i}`, 'adversarial-review', `Review ${i}`, {
        markdown: 'y'.repeat(RUN_DIGEST_ITEM_MAX_CHARS),
      });
    }
    // One entity, which must be dropped rather than folded in empty.
    addEntity(db, 'tasks', 't1', 'TASK-001', 'Later', 'task body');

    const digest = readRunDigest(dbAdapter(db), 'run-1');
    const total =
      digest.artifacts.reduce((n, a) => n + a.markdown.length, 0) +
      digest.entities.reduce((n, e) => n + e.body.length, 0);

    expect(digest.artifacts.length).toBeLessThan(6);
    expect(total).toBeLessThanOrEqual(RUN_DIGEST_TOTAL_MAX_CHARS);
    expect(digest.entities).toEqual([]);
  });
});

describe('readRunDigest — fail-soft', () => {
  it('yields an empty digest (never throws) when the tables are absent', () => {
    const bare = new Database(':memory:');
    bare.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, seed_idea_id TEXT)');
    bare.prepare('INSERT INTO workflow_runs (id, seed_idea_id) VALUES (?, NULL)').run('run-1');

    expect(() => readRunDigest(dbAdapter(bare), 'run-1')).not.toThrow();
    expect(readRunDigest(dbAdapter(bare), 'run-1')).toEqual({ artifacts: [], entities: [] });
  });

  it('yields an empty digest for a run that produced nothing', () => {
    expect(readRunDigest(dbAdapter(buildDb()), 'run-1')).toEqual({ artifacts: [], entities: [] });
  });
});
