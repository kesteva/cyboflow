/**
 * verdictDelivery — the verdict-delivery hook wired into the
 * VerificationScheduler's onVerdict. Tested against a real in-memory DB with the
 * REAL ArtifactRouter + ReviewItemRouter initialized (so the chokepoint logic +
 * the (runId, atype) idempotent UPSERT + the finding INSERT are exercised end to
 * end), asserting the resulting rows:
 *
 *  - FAIL           → screenshots artifact enriched WITH the verdict block + 1 finding
 *  - PASS           → screenshots artifact enriched WITH the verdict block + 0 findings
 *  - low_confidence → screenshots artifact enriched + 1 finding
 *  - skipped (no verdict) → NOTHING enriched, 0 findings
 *  - the finding soft-links to the run's task when workflow_runs.task_id is set,
 *    and omits the entity link (both null) when it is not
 *  - the enrich is idempotent — a pre-existing screenshots artifact is UPDATED
 *    (one row per (runId, atype)), not duplicated
 *  - severity is mapped from the WORST issue (high→error, medium→warning, low→info)
 *
 * P8b (visual merge-gate): for a NON-sprint run (no batch / no SprintLaneStore)
 * the finding stays NON-blocking — the merge-gate lane drive is a clean no-op. The
 * dedicated merge-gate lane-write behavior (PASS→integrated, FAIL→implement
 * loopback + BLOCKING finding, the 3× cap) is covered in
 * verify/__tests__/mergeGateLaneAdvance.test.ts; here we assert the blocking flag
 * the gate action feeds into the finding for both the non-sprint and sprint cases.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVerdictDelivery } from '../verify/verdictDelivery';
import { ArtifactRouter } from '../artifactRouter';
import { ReviewItemRouter } from '../reviewItemRouter';
import { SprintLaneStore } from '../sprintLaneStore';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import type { VerdictV1 } from '../../../../shared/types/visualVerification';
import type { ScreenshotsArtifactPayload } from '../../../../shared/types/artifacts';

const MIG_DIR = join(__dirname, '..', '..', 'database', 'migrations');
const MIGRATIONS = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '035_artifacts.sql',
];

function buildDb(): Database.Database {
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
  for (const f of MIGRATIONS) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  return db;
}

/** Seed a run; pass a taskId to set the soft task link (workflow_runs.task_id). */
function seedRun(db: Database.Database, runId: string, taskId?: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?)`,
  ).run(runId, taskId ?? null);
}

function screenshotsRows(db: Database.Database, runId: string): Array<{ id: string; payload_json: string | null }> {
  return db
    .prepare(`SELECT id, payload_json FROM artifacts WHERE run_id = ? AND atype = 'screenshots'`)
    .all(runId) as Array<{ id: string; payload_json: string | null }>;
}

function findingRows(
  db: Database.Database,
  runId: string,
): Array<{
  id: string;
  kind: string;
  severity: string | null;
  blocking: number;
  entity_type: string | null;
  entity_id: string | null;
  source: string | null;
  title: string;
}> {
  return db
    .prepare(
      `SELECT id, kind, severity, blocking, entity_type, entity_id, source, title
         FROM review_items WHERE run_id = ?`,
    )
    .all(runId) as Array<{
    id: string;
    kind: string;
    severity: string | null;
    blocking: number;
    entity_type: string | null;
    entity_id: string | null;
    source: string | null;
    title: string;
  }>;
}

const PASS_VERDICT: VerdictV1 = {
  status: 'pass',
  confidence: 0.95,
  issues: [],
  feedback: 'looks right',
  judgedFileNames: ['home.png'],
  baselineUsed: false,
  model: 'fake',
};

const FAIL_VERDICT: VerdictV1 = {
  status: 'fail',
  confidence: 0.9,
  issues: [
    { severity: 'low', description: 'tiny padding off', fileName: 'home.png' },
    { severity: 'high', description: 'header overlaps content', fileName: 'home.png' },
    { severity: 'medium', description: 'button misaligned' },
  ],
  feedback: 'the header overlaps the content area',
  judgedFileNames: ['home.png'],
  baselineUsed: false,
  model: 'fake',
};

const LOW_CONF_VERDICT: VerdictV1 = {
  status: 'low_confidence',
  confidence: 0.2,
  issues: [],
  feedback: 'could not tell if the layout is correct',
  judgedFileNames: ['home.png'],
  baselineUsed: false,
  model: 'fake',
};

describe('verdictDelivery (P8a)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    ArtifactRouter.initialize(dbAdapter(db));
    ReviewItemRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    db.close();
  });

  it('FAIL → screenshots artifact enriched WITH verdict + exactly 1 finding', async () => {
    seedRun(db, 'run-1', 'tsk_abc');
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_1',
      runId: 'run-1',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
    });

    // Artifact: exactly one screenshots row, payload carries fileNames + verdict.
    const arts = screenshotsRows(db, 'run-1');
    expect(arts).toHaveLength(1);
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.fileNames).toEqual(['home.png']);
    expect(payload.verdict?.status).toBe('fail');
    expect(payload.verdict?.feedback).toBe('the header overlaps the content area');

    // Finding: exactly one, severity from WORST issue (high→error), source
    // 'visual-verify', soft-linked to the run's task. This is a NON-sprint run
    // (no batch / SprintLaneStore not initialized) so the merge-gate lane drive
    // no-ops and the finding stays NON-blocking.
    const findings = findingRows(db, 'run-1');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('finding');
    expect(findings[0].severity).toBe('error'); // worst issue is 'high'
    expect(findings[0].blocking).toBe(0);
    expect(findings[0].source).toBe('visual-verify');
    expect(findings[0].entity_type).toBe('task');
    expect(findings[0].entity_id).toBe('tsk_abc');
    expect(findings[0].title).toMatch(/failed/i);

    // The finding payload category is 'visual-regression'.
    const fp = db
      .prepare('SELECT payload_json FROM review_items WHERE id = ?')
      .get(findings[0].id) as { payload_json: string };
    expect(JSON.parse(fp.payload_json).category).toBe('visual-regression');
  });

  it('PASS → screenshots artifact enriched WITH verdict + 0 findings', async () => {
    seedRun(db, 'run-2', 'tsk_pass');
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_2',
      runId: 'run-2',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png', 'detail.png'],
    });

    const arts = screenshotsRows(db, 'run-2');
    expect(arts).toHaveLength(1);
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.fileNames).toEqual(['home.png', 'detail.png']);
    expect(payload.verdict?.status).toBe('pass');

    // PASS raises NO finding.
    expect(findingRows(db, 'run-2')).toHaveLength(0);
  });

  it('low_confidence → screenshots artifact enriched + exactly 1 finding', async () => {
    seedRun(db, 'run-3', 'tsk_lc');
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_3',
      runId: 'run-3',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'low_confidence',
      verdict: LOW_CONF_VERDICT,
      fileNames: ['home.png'],
    });

    const arts = screenshotsRows(db, 'run-3');
    expect(arts).toHaveLength(1);
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.verdict?.status).toBe('low_confidence');

    const findings = findingRows(db, 'run-3');
    expect(findings).toHaveLength(1);
    // No issues on a bare low_confidence verdict → severity defaults to 'warning'.
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].title).toMatch(/human review/i);
  });

  it('skipped (no verdict) → enriches NOTHING and raises 0 findings', async () => {
    seedRun(db, 'run-4');
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_4',
      runId: 'run-4',
      projectId: 1,
      type: 'native-desktop',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
    });

    expect(screenshotsRows(db, 'run-4')).toHaveLength(0);
    expect(findingRows(db, 'run-4')).toHaveLength(0);
  });

  it('verdict-LESS FAIL (capture-fail / judge-throw) → enriches NOTHING but raises exactly 1 finding', async () => {
    // The scheduler delivers status='failed' with verdict=undefined on a capture
    // failure (no PNGs) OR a capture/judge exception. The hook must NOT short-circuit
    // (that would silently wedge a sprint lane parked at awaiting-verify); it enriches
    // nothing (no verdict to add to the screenshots artifact) but STILL raises a
    // finding so the failure is visible in the review inbox.
    seedRun(db, 'run-vlf', 'tsk_vlf');
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_vlf',
      runId: 'run-vlf',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: undefined,
      fileNames: [],
    });

    // Nothing to enrich without a verdict — no screenshots artifact created here.
    expect(screenshotsRows(db, 'run-vlf')).toHaveLength(0);

    // But a finding IS raised so the lane/failure is not silently dropped.
    const findings = findingRows(db, 'run-vlf');
    expect(findings).toHaveLength(1);
    expect(findings[0].kind).toBe('finding');
    expect(findings[0].source).toBe('visual-verify');
    expect(findings[0].title).toMatch(/failed/i);
    // No issues to rank → severity defaults to 'warning'.
    expect(findings[0].severity).toBe('warning');
    // Non-sprint run (no SprintLaneStore) → finding stays NON-blocking.
    expect(findings[0].blocking).toBe(0);
    // The body carries an actionable reason for the verdict-less failure.
    const fp = db
      .prepare('SELECT body FROM review_items WHERE id = ?')
      .get(findings[0].id) as { body: string };
    expect(fp.body).toMatch(/no screenshots were captured or judged/i);
  });

  it('omits the entity link when the run has no task (both fields null)', async () => {
    seedRun(db, 'run-5'); // no task_id
    const deliver = createVerdictDelivery({ db: dbAdapter(db) });

    await deliver({
      requestId: 'vr_5',
      runId: 'run-5',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
    });

    const findings = findingRows(db, 'run-5');
    expect(findings).toHaveLength(1);
    expect(findings[0].entity_type).toBeNull();
    expect(findings[0].entity_id).toBeNull();
  });

  it('enrich is idempotent — a pre-existing screenshots artifact is UPDATED, not duplicated', async () => {
    seedRun(db, 'run-6', 'tsk_idem');
    // Producer already minted the screenshots artifact with just fileNames.
    await ArtifactRouter.getInstance().apply(1, {
      op: 'create',
      runId: 'run-6',
      atype: 'screenshots',
      label: '1 screenshot',
      payloadJson: JSON.stringify({ fileNames: ['home.png'] }),
      actor: 'orchestrator',
    });
    const before = screenshotsRows(db, 'run-6');
    expect(before).toHaveLength(1);
    const originalId = before[0].id;

    const deliver = createVerdictDelivery({ db: dbAdapter(db) });
    await deliver({
      requestId: 'vr_6',
      runId: 'run-6',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
    });

    const after = screenshotsRows(db, 'run-6');
    expect(after).toHaveLength(1); // still ONE row (UPSERT by (runId, atype))
    expect(after[0].id).toBe(originalId); // same row id
    const payload = JSON.parse(after[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.verdict?.status).toBe('fail'); // now carries the verdict
  });
});

// ---------------------------------------------------------------------------
// P8b — visual MERGE-GATE: for a SPRINT run the verdict drives the lane AND the
// FAIL finding is BLOCKING. Built on the sprint migration chain so workflow_runs
// has batch_id (022) + the lane tables exist, with the real SprintLaneStore.
// ---------------------------------------------------------------------------

const SPRINT_MIGRATIONS = [
  '006_cyboflow_schema.sql',
  '011_workflow_step_tracking.sql',
  '014_native_tasks.sql',
  '015_entity_model_rebuild.sql',
  '016_review_items.sql',
  '022_sprint_batches.sql',
  '023_sprint_lane_step.sql',
  '025_sprint_lane_attempts.sql',
  '035_artifacts.sql',
];

function buildSprintDb(): Database.Database {
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
  for (const f of SPRINT_MIGRATIONS) db.exec(readFileSync(join(MIG_DIR, f), 'utf-8'));
  return db;
}

function seedSprintRun(db: Database.Database, runId: string, batchId: string, taskId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-1', 1, 'sprint', '{}')`,
  ).run();
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, status, permission_mode_snapshot, task_id, batch_id)
     VALUES (?, 'wf-1', 1, 'running', 'default', ?, ?)`,
  ).run(runId, taskId, batchId);
}

describe('verdictDelivery (P8b — merge-gate)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildSprintDb();
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    ArtifactRouter.initialize(dbAdapter(db));
    ReviewItemRouter.initialize(dbAdapter(db));
    SprintLaneStore.initialize(dbAdapter(db));
  });

  afterEach(() => {
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    db.close();
  });

  it('FAIL on a sprint lane loops it back to implement AND raises a BLOCKING finding', async () => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES ('tsk_a', 1, 'TASK-001', 'A', 'board-1-default', 'stage-board-1-default-5')`,
    ).run();
    const store = SprintLaneStore.getInstance();
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_a']);
    seedSprintRun(db, 'run-s1', batchId, 'tsk_a');
    store.updateLane({ runId: 'run-s1', batchId, taskId: 'tsk_a', status: 'running', currentStepId: 'awaiting-verify' });

    const deliver = createVerdictDelivery({ db: dbAdapter(db) });
    await deliver({
      requestId: 'vr_s1',
      runId: 'run-s1',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
      input: { intent: 'shows the submit button', taskRef: 'TASK-001' },
    });

    // Lane looped back to implement at attempt 2.
    const lane = db
      .prepare('SELECT status, current_step_id AS step, attempts FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_a') as { status: string; step: string; attempts: number };
    expect(lane).toEqual({ status: 'running', step: 'implement', attempts: 2 });

    // The finding is BLOCKING (merge-gate holds the lane's integration).
    const findings = findingRows(db, 'run-s1');
    expect(findings).toHaveLength(1);
    expect(findings[0].blocking).toBe(1);
  });

  it('verdict-LESS FAIL on a sprint lane STILL loops it back to implement AND raises a BLOCKING finding (no silent wedge)', async () => {
    // Regression: a transient capture failure / judge throw delivers status='failed'
    // with verdict=undefined. Before the fix the hook early-returned on !verdict and
    // the lane wedged at awaiting-verify with no loopback and no finding. It must now
    // drive the merge-gate (loopback) AND raise the BLOCKING finding exactly like a
    // judged FAIL.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES ('tsk_c', 1, 'TASK-003', 'C', 'board-1-default', 'stage-board-1-default-5')`,
    ).run();
    const store = SprintLaneStore.getInstance();
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_c']);
    seedSprintRun(db, 'run-s3', batchId, 'tsk_c');
    store.updateLane({ runId: 'run-s3', batchId, taskId: 'tsk_c', status: 'running', currentStepId: 'awaiting-verify' });

    const deliver = createVerdictDelivery({ db: dbAdapter(db) });
    await deliver({
      requestId: 'vr_s3',
      runId: 'run-s3',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: undefined, // capture-fail / judge-throw — no verdict
      fileNames: [],
      input: { intent: 'shows the submit button', taskRef: 'TASK-003' },
    });

    // Lane looped back to implement at attempt 2 — NOT wedged at awaiting-verify.
    const lane = db
      .prepare('SELECT status, current_step_id AS step, attempts FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_c') as { status: string; step: string; attempts: number };
    expect(lane).toEqual({ status: 'running', step: 'implement', attempts: 2 });

    // A BLOCKING finding is raised (merge-gate holds the lane's integration), with no
    // verdict the body carries the generic actionable reason.
    const findings = findingRows(db, 'run-s3');
    expect(findings).toHaveLength(1);
    expect(findings[0].blocking).toBe(1);
    expect(findings[0].title).toMatch(/failed/i);

    // No screenshots artifact enriched (no verdict to add).
    expect(screenshotsRows(db, 'run-s3')).toHaveLength(0);
  });

  it('PASS on a sprint lane advances it to integrated with NO finding', async () => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES ('tsk_b', 1, 'TASK-002', 'B', 'board-1-default', 'stage-board-1-default-5')`,
    ).run();
    const store = SprintLaneStore.getInstance();
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_b']);
    seedSprintRun(db, 'run-s2', batchId, 'tsk_b');
    store.updateLane({ runId: 'run-s2', batchId, taskId: 'tsk_b', status: 'running', currentStepId: 'awaiting-verify' });

    const deliver = createVerdictDelivery({ db: dbAdapter(db) });
    await deliver({
      requestId: 'vr_s2',
      runId: 'run-s2',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png'],
      input: { intent: 'shows the submit button', taskRef: 'TASK-002' },
    });

    const lane = db
      .prepare('SELECT status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_b') as { status: string };
    expect(lane.status).toBe('integrated');
    expect(findingRows(db, 'run-s2')).toHaveLength(0);
  });
});
