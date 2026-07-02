/**
 * Migration-backed in-memory DB fixture for the B2 gate/cancel/recovery-seam
 * tests (humanStepManager.maybeResumeRun, approvalRouter.recoverStaleAwaitingReview
 * review-item reconciliation, reviewItemListing selectors, the stuckDetector
 * human-gate blind-spot pin).
 *
 * Mirrors the migration set applied by reviewItemFold.test.ts (projects + 006 +
 * 007 + 010 + 011 + 014 + 015 + 016) so review_items / approvals / questions /
 * entity_events / the stuck_* columns all exist on one connection. Distinct from
 * orchestratorTestDb's GATE_SCHEMA fixture, which deliberately does NOT carry the
 * review_items table (that is the "table absent" arm several helpers guard).
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = [
  '006_cyboflow_schema.sql',
  '007_add_stuck_reason.sql',
  '010_questions.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  // 034 adds the first-class review_items.priority (P0/P1/P2) column that
  // selectFindingForSeed projects; its ALTERs only touch review_items +
  // workflow_runs (both already present after 016), so it layers cleanly.
  '034_findings_triage.sql',
] as const;

/** Build a fresh migration-backed DB with the review_items inbox present. */
export function buildReviewInboxDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p1');

  const migDir = join(__dirname, '..', '..', 'database', 'migrations');
  for (const file of MIGRATIONS) {
    db.exec(readFileSync(join(migDir, file), 'utf-8'));
  }
  return db;
}

/** Seed a workflow + workflow_run pair. Returns the run id. */
export function seedInboxRun(
  db: Database.Database,
  runId: string,
  status = 'running',
): string {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot)
     VALUES (?, 'wf-1', 1, ?, 'default')`,
  ).run(runId, status);
  return runId;
}

/** Insert a blocking review_item row directly (bypasses the co-write helpers). */
export function seedBlockingReviewItem(
  db: Database.Database,
  args: {
    id: string;
    runId: string;
    kind: 'permission' | 'decision';
    status?: 'pending' | 'resolved' | 'dismissed';
    source?: string;
    payloadJson?: string | null;
    createdAt?: string;
  },
): string {
  const status = args.status ?? 'pending';
  const source = args.source ?? 'approval';
  const now = args.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO review_items
       (id, project_id, run_id, kind, status, blocking, title, source, payload_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(args.id, args.runId, args.kind, status, `item ${args.id}`, source, args.payloadJson ?? null, now, now);
  return args.id;
}

/** Read a run's status. */
export function runStatus(db: Database.Database, runId: string): string {
  return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
}
