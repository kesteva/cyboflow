/**
 * Migration 138: widen agent_proposals.kind to admit 'create-workflow' (the
 * global assistant's new-flow-plus-agents proposal).
 *
 * Same full-recreate recipe as 125, with one new hazard to pin: migration 133
 * added widget_action_log, which FKs INTO agent_proposals with ON DELETE
 * CASCADE. A rebuild that ran with foreign keys ON would cascade-delete every
 * widget-action audit row the moment it DROPped the old table — so beyond the
 * 125 guards (column shape + row survival + the agent_threads cascade) this
 * file asserts the side table's rows survive the rebuild and its FK still
 * resolves afterwards.
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', 'migrations');
const MIGRATION_074 = readFileSync(join(MIGRATIONS, '074_agent_threads.sql'), 'utf-8');
const MIGRATION_125 = readFileSync(join(MIGRATIONS, '125_agent_proposal_create_backlog_kind.sql'), 'utf-8');
const MIGRATION_133 = readFileSync(join(MIGRATIONS, '133_custom_views.sql'), 'utf-8');
const MIGRATION_138 = readFileSync(join(MIGRATIONS, '138_agent_proposal_create_workflow_kind.sql'), 'utf-8');

const COLUMNS_074 = [
  'id',
  'thread_id',
  'kind',
  'payload_json',
  'preconditions_json',
  'status',
  'result_json',
  'idempotency_key',
  'created_at',
  'decided_at',
];

const PRIOR_KINDS = ['launch-run', 'reprioritize-backlog', 'edit-workflow', 'open-session', 'create-backlog-items'];

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION_074);
  db.exec(MIGRATION_125);
  db.exec(MIGRATION_133);
  db.prepare('INSERT INTO agent_threads (id) VALUES (?)').run('t1');
  return db;
}

function insertProposal(db: Database.Database, id: string, kind: string): void {
  db.prepare(
    "INSERT INTO agent_proposals (id, thread_id, kind, payload_json, status) VALUES (?, 't1', ?, '{}', 'proposed')",
  ).run(id, kind);
}

describe("Migration 138: agent_proposals.kind admits 'create-workflow'", () => {
  it('rejects the new kind BEFORE the migration and accepts it after', () => {
    const db = buildDb();
    expect(() => insertProposal(db, 'p-before', 'create-workflow')).toThrow(/CHECK constraint failed/);

    db.exec(MIGRATION_138);
    insertProposal(db, 'p-after', 'create-workflow');
    expect(db.prepare('SELECT kind FROM agent_proposals WHERE id = ?').get('p-after')).toEqual({
      kind: 'create-workflow',
    });
  });

  it('keeps the five pre-existing kinds valid and still rejects an unknown one', () => {
    const db = buildDb();
    db.exec(MIGRATION_138);
    for (const kind of PRIOR_KINDS) insertProposal(db, `p-${kind}`, kind);
    expect(() => insertProposal(db, 'p-bogus', 'delete-everything')).toThrow(/CHECK constraint failed/);
  });

  it("preserves 074's exact column shape and every existing row through the rebuild", () => {
    const db = buildDb();
    insertProposal(db, 'p-existing', 'edit-workflow');
    db.prepare("UPDATE agent_proposals SET result_json = '{\"kind\":\"edit-workflow\"}', status = 'executed' WHERE id = ?").run(
      'p-existing',
    );

    db.exec(MIGRATION_138);

    const columns = (db.prepare('PRAGMA table_info(agent_proposals)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
    expect(columns).toEqual(COLUMNS_074);
    expect(db.prepare('SELECT id, kind, status, result_json FROM agent_proposals').all()).toEqual([
      { id: 'p-existing', kind: 'edit-workflow', status: 'executed', result_json: '{"kind":"edit-workflow"}' },
    ]);
  });

  it("keeps 133's widget_action_log rows through the rebuild (the FK into agent_proposals must not cascade)", () => {
    const db = buildDb();
    insertProposal(db, 'p-widget', 'launch-run');
    db.prepare(
      `INSERT INTO widget_action_log (proposal_id, operation_id, view_id, view_revision, instance_id, action_id)
       VALUES ('p-widget', 'op-1', 'view-1', 1, 'inst-1', 'act-1')`,
    ).run();

    db.exec(MIGRATION_138);

    expect(db.prepare('SELECT proposal_id, operation_id FROM widget_action_log').all()).toEqual([
      { proposal_id: 'p-widget', operation_id: 'op-1' },
    ]);
    // The FK resolves against the RENAMED table: deleting the proposal cascades
    // into the side table again, and a dangling proposal_id is refused.
    db.pragma('foreign_keys = ON');
    expect(() =>
      db
        .prepare(
          `INSERT INTO widget_action_log (proposal_id, operation_id, view_id, view_revision, instance_id, action_id)
           VALUES ('p-missing', 'op-2', 'view-1', 1, 'inst-1', 'act-1')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    db.prepare('DELETE FROM agent_proposals WHERE id = ?').run('p-widget');
    expect(db.prepare('SELECT COUNT(*) AS n FROM widget_action_log').get()).toEqual({ n: 0 });
  });

  it('keeps the ON DELETE CASCADE to agent_threads after the rebuild', () => {
    const db = buildDb();
    db.exec(MIGRATION_138);
    db.pragma('foreign_keys = ON');
    insertProposal(db, 'p-cascade', 'create-workflow');
    db.prepare('DELETE FROM agent_threads WHERE id = ?').run('t1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_proposals').get()).toEqual({ n: 0 });
  });
});
