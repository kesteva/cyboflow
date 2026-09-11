/**
 * Unit tests for composePartialSprintGateBody (Item 2) — the enriched terminal
 * human-gate body for a sprint/ship run that settled with failed lanes.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { composePartialSprintGateBody } from '../partialSprintGateSummary';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, ref TEXT, title TEXT);
    CREATE TABLE sprint_batch_tasks (
      batch_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      current_step_id TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE task_dependencies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      depends_on_task_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'blocking'
    );
  `);
  return db;
}

function seedRun(db: Database.Database, runId: string, batchId: string | null): void {
  db.prepare('INSERT INTO workflow_runs (id, batch_id) VALUES (?, ?)').run(runId, batchId);
}
function seedTask(db: Database.Database, id: string, ref: string | null, title: string | null): void {
  db.prepare('INSERT INTO tasks (id, ref, title) VALUES (?, ?, ?)').run(id, ref, title);
}
function seedLane(
  db: Database.Database,
  batchId: string,
  taskId: string,
  status: string,
  currentStepId: string | null,
  attempts: number,
): void {
  db.prepare(
    'INSERT INTO sprint_batch_tasks (batch_id, task_id, status, current_step_id, attempts) VALUES (?, ?, ?, ?, ?)',
  ).run(batchId, taskId, status, currentStepId, attempts);
}

function seedDependency(
  db: Database.Database,
  taskId: string,
  dependsOn: string,
  kind = 'blocking',
): void {
  db.prepare(
    'INSERT INTO task_dependencies (task_id, depends_on_task_id, kind) VALUES (?, ?, ?)',
  ).run(taskId, dependsOn, kind);
}

describe('composePartialSprintGateBody', () => {
  it('returns null for a run with no batch (a non-sprint gate keeps its generic body)', () => {
    const db = buildDb();
    seedRun(db, 'run-1', null);
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
  });

  it('returns null when every lane integrated (a clean sprint keeps its generic body)', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-001', 'Do a thing');
    seedLane(db, 'batch-1', 't1', 'integrated', 'visual-verify', 1);
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
  });

  it('enumerates each failed lane with ref/title, failing step, and attempt count', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-107', 'Add chat panel');
    seedTask(db, 't2', 'TASK-108', 'Wire the store');
    seedTask(db, 't3', 'TASK-109', 'Integrated one');
    // Two failed lanes (one exhausted 3×, one failed on its first pass), one integrated.
    seedLane(db, 'batch-1', 't1', 'failed', 'code-review', 3);
    seedLane(db, 'batch-1', 't2', 'failed', 'implement', 0);
    seedLane(db, 'batch-1', 't3', 'integrated', 'visual-verify', 1);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).not.toBeNull();
    expect(body).toContain('**2 failed lanes**');
    expect(body).toContain('Human review');
    expect(body).toContain('`TASK-107` — Add chat panel — failed at `code-review` after 3 attempts');
    // attempts=0 (first-pass failure) renders as "1 attempt".
    expect(body).toContain('`TASK-108` — Wire the store — failed at `implement` after 1 attempt');
    // The integrated lane is not listed.
    expect(body).not.toContain('TASK-109');
    // Singular/plural + backlog guidance present.
    expect(body).toContain('returns to the backlog');
  });

  it('falls back to the opaque task id + "an early step" when ref/current_step are null', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', null, null); // task row present but unref'd
    seedLane(db, 'batch-1', 't1', 'failed', null, 0);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).toContain('**1 failed lane**');
    expect(body).toContain('`t1`');
    expect(body).toContain('an early step');
  });

  it('lists never-started lanes separately, naming the prerequisite that stranded them', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-012', 'Device driver');
    seedTask(db, 't2', 'TASK-013', 'Device validation');
    seedTask(db, 't3', 'TASK-014', 'Shipped one');
    seedLane(db, 'batch-1', 't1', 'failed', 'code-review', 3);
    seedLane(db, 'batch-1', 't2', 'blocked', null, 0);
    seedLane(db, 'batch-1', 't3', 'integrated', 'visual-verify', 1);
    seedDependency(db, 't2', 't1');

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).not.toBeNull();
    // The two kinds are counted separately — one real defect, one lane stranded.
    expect(body).toContain('**1 failed lane** and **1 never started**');
    expect(body).toContain('**Failed lanes**');
    expect(body).toContain('`TASK-012` — Device driver — failed at `code-review` after 3 attempts');
    expect(body).toContain('**Never started**');
    expect(body).toContain('`TASK-013` — Device validation — never started, waiting on `TASK-012`');
    // A never-started lane is never described as having failed at a step.
    expect(body).not.toContain('TASK-013` — Device validation — failed');
    expect(body).not.toContain('TASK-014');
  });

  it('renders a blocked-only sprint without a Failed lanes section', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-020', 'One');
    seedTask(db, 't2', 'TASK-021', 'Two');
    seedLane(db, 'batch-1', 't1', 'blocked', null, 0);
    seedLane(db, 'batch-1', 't2', 'blocked', null, 0);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).toContain('**2 never-started lanes**');
    expect(body).not.toContain('**Failed lanes**');
    expect(body).toContain('**Never started**');
    // No dependency rows seeded ⇒ the generic wording, never a null body.
    expect(body).toContain('waiting on a prerequisite that did not finish');
  });

  it('names every prerequisite when a lane waits on more than one', () => {
    const db = buildDb();
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-030', 'A');
    seedTask(db, 't2', 'TASK-031', 'B');
    seedTask(db, 't3', 'TASK-032', 'C');
    seedLane(db, 'batch-1', 't1', 'failed', 'implement', 0);
    seedLane(db, 'batch-1', 't2', 'blocked', null, 0);
    seedLane(db, 'batch-1', 't3', 'blocked', null, 0);
    seedDependency(db, 't3', 't1');
    seedDependency(db, 't3', 't2');
    // A non-blocking edge is advisory metadata and must not be reported.
    seedDependency(db, 't3', 't1', 'related');

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).toContain('`TASK-032` — C — never started, waiting on `TASK-030`, `TASK-031`');
  });

  it('still renders when the task_dependencies table is absent (no refs, never a null body)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, ref TEXT, title TEXT);
      CREATE TABLE sprint_batch_tasks (
        batch_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        current_step_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
    seedRun(db, 'run-1', 'batch-1');
    seedTask(db, 't1', 'TASK-040', 'Stranded');
    seedLane(db, 'batch-1', 't1', 'blocked', null, 0);

    const body = composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review');
    expect(body).not.toBeNull();
    expect(body).toContain('`TASK-040` — Stranded — never started, waiting on a prerequisite');
    db.close();
  });

  it('returns null fail-soft when the sprint_batch_tasks table is absent', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE workflow_runs (id TEXT PRIMARY KEY, batch_id TEXT)');
    seedRun(db, 'run-1', 'batch-1');
    expect(composePartialSprintGateBody(dbAdapter(db), 'run-1', 'Human review')).toBeNull();
    db.close();
  });
});
