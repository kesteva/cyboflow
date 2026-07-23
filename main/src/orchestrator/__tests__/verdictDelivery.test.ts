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
 *  - skipped (no verdict) → NOTHING enriched, 1 NON-blocking finding (advance-with-
 *    visibility — a verification_requests row only exists because it was requested)
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
  '055_visual_verification.sql',
  '078_verification_agent_requests.sql',
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
  // ArtifactRouter.emitChange resolves the run's parent session (migration 020's
  // session_id, backfilled by 041) — layer the additive column onto this
  // pre-020 chain so the emit-path SELECT resolves.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
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

/** Seed a verification_requests row so resolveSkipReason's SELECT by id resolves. */
function seedVerificationRequest(
  db: Database.Database,
  requestId: string,
  runId: string,
  errorMessage?: string,
): void {
  db.prepare(
    `INSERT INTO verification_requests (id, run_id, project_id, status, verify_type, deliverable_json, error_message)
     VALUES (?, ?, 1, 'skipped', 'native-desktop', '{}', ?)`,
  ).run(requestId, runId, errorMessage ?? null);
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
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

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
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

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
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

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

  it('skipped (no verdict) → enriches NOTHING but raises exactly 1 NON-blocking finding', async () => {
    // Revised policy: a verification_requests row only exists because a flow agent
    // explicitly asked for verification, so a skip always means "requested but never
    // ran" (missing precondition) — it must be visible, not silent, mirroring timeout.
    seedRun(db, 'run-4');
    seedVerificationRequest(db, 'vr_4', 'run-4');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_4',
      runId: 'run-4',
      projectId: 1,
      type: 'native-desktop',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
    });

    // No verdict → nothing to enrich on the screenshots artifact.
    expect(screenshotsRows(db, 'run-4')).toHaveLength(0);

    const findings = findingRows(db, 'run-4');
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe('visual-verify');
    expect(findings[0].blocking).toBe(0);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].title).toMatch(/did not run|skipped/i);
  });

  it('skipped → finding body threads the concrete skip reason from verification_requests.error_message', async () => {
    seedRun(db, 'run-4b');
    seedVerificationRequest(db, 'vr_4b', 'run-4b', 'no healthy backend for static-render-snapshot');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_4b',
      runId: 'run-4b',
      projectId: 1,
      type: 'native-desktop',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
    });

    const findings = findingRows(db, 'run-4b');
    expect(findings).toHaveLength(1);
    const fp = db
      .prepare('SELECT body FROM review_items WHERE id = ?')
      .get(findings[0].id) as { body: string };
    expect(fp.body).toMatch(/Reason: no healthy backend for static-render-snapshot/);
  });

  it('skipped → missing verification_requests row still produces the generic fail-soft body', async () => {
    // No seedVerificationRequest call — the row the hook tries to read is absent
    // (e.g. a fixture gap or FK cascade). resolveSkipReason must fail soft: no
    // 'Reason:' line, but the finding still fires with the generic body.
    seedRun(db, 'run-4c');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_missing',
      runId: 'run-4c',
      projectId: 1,
      type: 'native-desktop',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
    });

    const findings = findingRows(db, 'run-4c');
    expect(findings).toHaveLength(1);
    const fp = db
      .prepare('SELECT body FROM review_items WHERE id = ?')
      .get(findings[0].id) as { body: string };
    expect(fp.body).not.toMatch(/Reason:/);
    expect(fp.body).toMatch(/did not run/i);
  });

  it('verdict-LESS FAIL (capture-fail / judge-throw) → enriches NOTHING but raises exactly 1 finding', async () => {
    // The scheduler delivers status='failed' with verdict=undefined on a capture
    // failure (no PNGs) OR a capture/judge exception. The hook must NOT short-circuit
    // (that would silently wedge a sprint lane parked at awaiting-verify); it enriches
    // nothing (no verdict to add to the screenshots artifact) but STILL raises a
    // finding so the failure is visible in the review inbox.
    seedRun(db, 'run-vlf', 'tsk_vlf');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

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
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

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

  it('R7: enrich carries verdict.baselineKey from the request input (round-trip key for Accept-as-baseline)', async () => {
    seedRun(db, 'run-bk', 'tsk_bk');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_bk',
      runId: 'run-bk',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png'],
      input: { intent: 'landing renders', baselineKey: 'landing-page' },
    });

    const arts = screenshotsRows(db, 'run-bk');
    expect(arts).toHaveLength(1);
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    // The hydrated key is carried INSIDE the verdict block so the tab's Accept
    // button files accepted baselines under the SAME namespace the SSIM pre-diff
    // resolves them by (not the opaque per-run artifact id).
    expect(payload.verdict?.baselineKey).toBe('landing-page');
  });

  it('R7: absent input.baselineKey → the verdict block has NO baselineKey field (not undefined-serialized)', async () => {
    seedRun(db, 'run-nobk', 'tsk_nobk');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_nobk',
      runId: 'run-nobk',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png'],
      input: { intent: 'landing renders' }, // no baselineKey
    });

    const arts = screenshotsRows(db, 'run-nobk');
    expect(arts).toHaveLength(1);
    const rawPayload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(rawPayload.verdict?.status).toBe('pass');
    // The key is OMITTED, not present-as-undefined — assert on the raw parsed object.
    expect(rawPayload.verdict && 'baselineKey' in rawPayload.verdict).toBe(false);
  });

  it('R7: no input at all → verdict enriched with no baselineKey (byte-safe)', async () => {
    seedRun(db, 'run-noinput', 'tsk_ni');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_ni',
      runId: 'run-noinput',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png'],
      // input omitted entirely
    });

    const arts = screenshotsRows(db, 'run-noinput');
    expect(arts).toHaveLength(1);
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.verdict?.status).toBe('pass');
    expect(payload.verdict && 'baselineKey' in payload.verdict).toBe(false);
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

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
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

  it('S9: captureOrigin + diagnostics reach BOTH human surfaces (finding body + screenshots payload)', async () => {
    // The end-to-end assertion the provenance sub-feature exists for: a FAIL whose
    // capture collected the file:// breadcrumb must surface it where a human reads
    // it — the review-queue finding body and the screenshots artifact payload —
    // with the untrusted framing rendered.
    seedRun(db, 'run-7', 'tsk_prov');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_7',
      runId: 'run-7',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
      captureOrigin: 'static-server',
      diagnostics: ['file:// module blocked — serve over http', 'Uncaught TypeError: x is undefined'],
    });

    const payload = JSON.parse(
      screenshotsRows(db, 'run-7')[0].payload_json ?? '{}',
    ) as ScreenshotsArtifactPayload;
    expect(payload.captureOrigin).toBe('static-server');
    expect(payload.diagnostics).toEqual([
      'file:// module blocked — serve over http',
      'Uncaught TypeError: x is undefined',
    ]);

    const findings = findingRows(db, 'run-7');
    expect(findings).toHaveLength(1);
    const bodyRow = db
      .prepare('SELECT body FROM review_items WHERE id = ?')
      .get(findings[0].id) as { body: string };
    expect(bodyRow.body).toContain('Capture origin: static-server');
    expect(bodyRow.body).toContain('UNTRUSTED page console output');
    expect(bodyRow.body).toContain('- file:// module blocked — serve over http');
    expect(bodyRow.body).toContain('- Uncaught TypeError: x is undefined');
  });

  it('S9: a delivery WITHOUT provenance leaves the finding body + payload byte-identical to pre-S9', async () => {
    seedRun(db, 'run-8', 'tsk_noprov');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });

    await deliver({
      requestId: 'vr_8',
      runId: 'run-8',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
    });

    const payload = JSON.parse(
      screenshotsRows(db, 'run-8')[0].payload_json ?? '{}',
    ) as ScreenshotsArtifactPayload;
    expect('captureOrigin' in payload).toBe(false);
    expect('diagnostics' in payload).toBe(false);

    const findings = findingRows(db, 'run-8');
    const bodyRow = db
      .prepare('SELECT body FROM review_items WHERE id = ?')
      .get(findings[0].id) as { body: string };
    expect(bodyRow.body).not.toContain('Capture origin:');
    expect(bodyRow.body).not.toContain('Capture diagnostics');
  });

  // -------------------------------------------------------------------------
  // §5.6 amended (adversarial-review fix 2026-07-23): the callback RETURNS the
  // outbox verdict — true only when every required consumer succeeded, so the
  // scheduler leaves failed deliveries 'pending' for replay.
  // -------------------------------------------------------------------------

  it('returns true when every required consumer succeeds', async () => {
    seedRun(db, 'run-ok', 'tsk_ok');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    const ok = await deliver({
      requestId: 'vr_ok',
      runId: 'run-ok',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: FAIL_VERDICT,
      fileNames: ['home.png'],
    });
    expect(ok).toBe(true);
    expect(findingRows(db, 'run-ok')).toHaveLength(1);
  });

  it('returns false when the artifact merge fails (router unavailable)', async () => {
    seedRun(db, 'run-am', 'tsk_am');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    ArtifactRouter._resetForTesting(); // getInstance() now throws inside the merge try-block
    const ok = await deliver({
      requestId: 'vr_am',
      runId: 'run-am',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: PASS_VERDICT,
      fileNames: ['home.png'],
    });
    expect(ok).toBe(false);
  });

  it('returns false when finding creation fails (router unavailable)', async () => {
    seedRun(db, 'run-ff', 'tsk_ff');
    seedVerificationRequest(db, 'vr_ff', 'run-ff', 'no backend');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    ReviewItemRouter._resetForTesting();
    // skipped with no verdict/files: the artifact merge is not attempted, so the
    // ONLY required consumer is the finding — its failure must flip the verdict.
    const ok = await deliver({
      requestId: 'vr_ff',
      runId: 'run-ff',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
    });
    expect(ok).toBe(false);
  });

  it('a PASS with nothing to merge and no finding returns true (no required consumers)', async () => {
    seedRun(db, 'run-nm', 'tsk_nm');
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    const ok = await deliver({
      requestId: 'vr_nm',
      runId: 'run-nm',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'passed',
      verdict: undefined,
      fileNames: [],
    });
    expect(ok).toBe(true);
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
  '055_visual_verification.sql',
  '078_verification_agent_requests.sql',
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
  // Same session_id layering as buildDb — see the comment there.
  db.exec('ALTER TABLE workflow_runs ADD COLUMN session_id TEXT');
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

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
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

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
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

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
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

  it('R4: TIMEOUT on a sprint lane ADVANCES it to integrated AND raises a NON-blocking finding', async () => {
    // R4: a timeout is an environment failure — advance-with-visibility. The parked
    // lane is driven OFF awaiting-verify (never wedged), and a NON-blocking finding is
    // raised so a human sees that verification did not actually run.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES ('tsk_to', 1, 'TASK-004', 'D', 'board-1-default', 'stage-board-1-default-5')`,
    ).run();
    const store = SprintLaneStore.getInstance();
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_to']);
    seedSprintRun(db, 'run-s4', batchId, 'tsk_to');
    store.updateLane({ runId: 'run-s4', batchId, taskId: 'tsk_to', status: 'running', currentStepId: 'awaiting-verify' });

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({
      requestId: 'vr_s4',
      runId: 'run-s4',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'timeout',
      verdict: undefined,
      fileNames: [],
      input: { intent: 'shows the submit button', taskRef: 'TASK-004' },
    });

    // Lane advanced to integrated (un-parked), NOT looped back / wedged.
    const lane = db
      .prepare('SELECT status, current_step_id AS step FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_to') as { status: string; step: string };
    expect(lane).toEqual({ status: 'integrated', step: 'visual-verify' });

    // Exactly one NON-blocking finding, framed as an environment failure.
    const findings = findingRows(db, 'run-s4');
    expect(findings).toHaveLength(1);
    expect(findings[0].blocking).toBe(0);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].source).toBe('visual-verify');
    expect(findings[0].title).toMatch(/did not run|timed out/i);
    // No verdict → nothing enriched.
    expect(screenshotsRows(db, 'run-s4')).toHaveLength(0);
  });

  it('R4 (revised): SKIPPED on a sprint lane ADVANCES it to integrated AND raises a NON-blocking finding', async () => {
    // Revised policy: skipped now gets the SAME advance-with-visibility treatment as
    // timeout — the lane still un-parks (never wedges the sprint), but a human sees
    // that verification was requested and never ran.
    db.prepare(
      `INSERT INTO tasks (id, project_id, ref, title, board_id, stage_id)
       VALUES ('tsk_sk', 1, 'TASK-005', 'E', 'board-1-default', 'stage-board-1-default-5')`,
    ).run();
    const store = SprintLaneStore.getInstance();
    const { batchId } = store.createForRun(1, 'sdk', ['tsk_sk']);
    seedSprintRun(db, 'run-s5', batchId, 'tsk_sk');
    store.updateLane({ runId: 'run-s5', batchId, taskId: 'tsk_sk', status: 'running', currentStepId: 'awaiting-verify' });
    seedVerificationRequest(db, 'vr_s5', 'run-s5');

    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({
      requestId: 'vr_s5',
      runId: 'run-s5',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'skipped',
      verdict: undefined,
      fileNames: [],
      input: { intent: 'shows the submit button', taskRef: 'TASK-005' },
    });

    const lane = db
      .prepare('SELECT status FROM sprint_batch_tasks WHERE batch_id = ? AND task_id = ?')
      .get(batchId, 'tsk_sk') as { status: string };
    expect(lane.status).toBe('integrated'); // un-parked

    const findings = findingRows(db, 'run-s5');
    expect(findings).toHaveLength(1);
    expect(findings[0].blocking).toBe(0); // advance-integrated is never blocking
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].source).toBe('visual-verify');
    expect(findings[0].title).toMatch(/did not run|skipped/i);
    expect(screenshotsRows(db, 'run-s5')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5.7 — report-carrying findings + correlation + supersession (slice 10b)
// ---------------------------------------------------------------------------

/** Seed a verification_requests row with the migration-078 agent columns populated. */
function seedRequestFull(
  db: Database.Database,
  opts: {
    id: string;
    runId: string;
    status: string;
    reportJson?: string | null;
    taskJson?: string | null;
    enqueueKey?: string | null;
    errorMessage?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO verification_requests
       (id, run_id, project_id, status, verify_type, deliverable_json, report_json, task_json, enqueue_key, error_message)
     VALUES (?, ?, 1, ?, 'static-render-snapshot', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    opts.runId,
    opts.status,
    JSON.stringify({ intent: 'x', taskRef: 'TASK-1' }),
    opts.reportJson ?? null,
    opts.taskJson ?? null,
    opts.enqueueKey ?? null,
    opts.errorMessage ?? null,
  );
}

/** Read every visual-verify finding for a run with its status + parsed correlation. */
function visualFindings(
  db: Database.Database,
  runId: string,
): Array<{ id: string; status: string; body: string; blocking: number; attempt: number | null; requestId: string | null }> {
  const rows = db
    .prepare(`SELECT id, status, body, blocking, payload_json AS p FROM review_items WHERE run_id = ? AND source = 'visual-verify'`)
    .all(runId) as Array<{ id: string; status: string; body: string; blocking: number; p: string | null }>;
  return rows.map((r) => {
    let attempt: number | null = null;
    let requestId: string | null = null;
    try {
      const vv = r.p ? (JSON.parse(r.p) as { visualVerify?: { attempt?: number; requestId?: string } }).visualVerify : undefined;
      if (vv) {
        attempt = typeof vv.attempt === 'number' ? vv.attempt : null;
        requestId = typeof vv.requestId === 'string' ? vv.requestId : null;
      }
    } catch { /* ignore */ }
    return { id: r.id, status: r.status, body: r.body, blocking: r.blocking, attempt, requestId };
  });
}

async function seedPriorFinding(
  runId: string,
  taskRef: string | null,
  attempt: number,
  requestId: string,
): Promise<void> {
  await ReviewItemRouter.getInstance().applyReviewItem(1, {
    op: 'create',
    actor: 'orchestrator',
    kind: 'finding',
    title: `prior visual finding a${attempt}`,
    body: 'x',
    source: 'visual-verify',
    blocking: true,
    runId,
    payload: { kind: 'finding', category: 'visual-regression', visualVerify: { runId, taskRef, attempt, requestId } },
  });
}

describe('verdictDelivery (slice 10b — report findings + supersession)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = buildDb();
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    ArtifactRouter.initialize(dbAdapter(db));
    ReviewItemRouter.initialize(dbAdapter(db));
  });

  afterEach(() => {
    ArtifactRouter._resetForTesting();
    ReviewItemRouter._resetForTesting();
    SprintLaneStore._resetForTesting();
    db.close();
  });

  it('FAIL body carries the failed behaviors (id + description + expected + observed notes) and the report feedback', async () => {
    seedRun(db, 'run-b1');
    seedRequestFull(db, {
      id: 'vr_b1',
      runId: 'run-b1',
      status: 'failed',
      enqueueKey: 'run-b1:TASK-1:2',
      taskJson: JSON.stringify({
        version: 1,
        summary: 'landing page',
        behaviors: [{ id: 'b1', description: 'header renders', expected: 'header does not overlap the hero' }],
      }),
      reportJson: JSON.stringify({
        version: 1,
        behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: ['s.png'], notes: 'header overlaps the hero text' } }],
        screenshots: [{ fileName: 's.png', caption: 'home' }],
        outcome: 'fail',
        confidence: 0.9,
        feedback: 'move the header out of the hero flow',
        issues: [],
      }),
    });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_b1', runId: 'run-b1', projectId: 1, type: 'static-render-snapshot', status: 'failed', verdict: undefined, fileNames: ['s.png'] });

    const f = visualFindings(db, 'run-b1');
    expect(f).toHaveLength(1);
    expect(f[0].attempt).toBe(2);
    expect(f[0].requestId).toBe('vr_b1');
    expect(f[0].body).toMatch(/b1 \(header renders\)/);
    expect(f[0].body).toMatch(/expected: header does not overlap the hero/);
    expect(f[0].body).toMatch(/observed: header overlaps the hero text/);
    expect(f[0].body).toMatch(/move the header out of the hero flow/);
  });

  // -------------------------------------------------------------------------
  // verifier-transcript capture — the ADVISORY transcriptFileName enrichment
  // -------------------------------------------------------------------------

  it('fileExists true → the merged screenshots report entry carries transcriptFileName', async () => {
    seedRun(db, 'run-tr1');
    seedRequestFull(db, {
      id: 'vr_tr1',
      runId: 'run-tr1',
      status: 'failed',
      enqueueKey: 'run-tr1:TASK-1:1',
      reportJson: JSON.stringify({
        version: 1,
        behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: ['s.png'], notes: 'x' } }],
        screenshots: [{ fileName: 's.png', caption: 'home' }],
        outcome: 'fail',
        confidence: 0.9,
        feedback: 'x',
        issues: [],
      }),
    });
    const deliver = createVerdictDelivery({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/art/run-tr1',
      fileExists: (absPath) => absPath === '/art/run-tr1/transcript-vr_tr1.md',
    });
    await deliver({
      requestId: 'vr_tr1',
      runId: 'run-tr1',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: undefined,
      fileNames: ['s.png'],
    });

    const arts = screenshotsRows(db, 'run-tr1');
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.reports?.[0]?.transcriptFileName).toBe('transcript-vr_tr1.md');
  });

  it('fileExists false → the merged report entry omits transcriptFileName', async () => {
    seedRun(db, 'run-tr2');
    seedRequestFull(db, {
      id: 'vr_tr2',
      runId: 'run-tr2',
      status: 'failed',
      enqueueKey: 'run-tr2:TASK-1:1',
      reportJson: JSON.stringify({
        version: 1,
        behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'x' } }],
        screenshots: [],
        outcome: 'fail',
        confidence: 0.9,
        feedback: 'x',
        issues: [],
      }),
    });
    const deliver = createVerdictDelivery({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/art/run-tr2',
      fileExists: () => false,
    });
    await deliver({
      requestId: 'vr_tr2',
      runId: 'run-tr2',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: undefined,
      fileNames: [],
    });

    const arts = screenshotsRows(db, 'run-tr2');
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.reports?.[0]?.transcriptFileName).toBeUndefined();
  });

  it('fileExists throwing → transcriptFileName absent AND the delivery still returns true (advisory, never fails)', async () => {
    seedRun(db, 'run-tr3');
    seedRequestFull(db, {
      id: 'vr_tr3',
      runId: 'run-tr3',
      status: 'failed',
      enqueueKey: 'run-tr3:TASK-1:1',
      reportJson: JSON.stringify({
        version: 1,
        behaviors: [{ id: 'b1', result: 'fail', evidence: { screenshots: [], notes: 'x' } }],
        screenshots: [],
        outcome: 'fail',
        confidence: 0.9,
        feedback: 'x',
        issues: [],
      }),
    });
    const deliver = createVerdictDelivery({
      db: dbAdapter(db),
      artifactsDirResolver: () => '/art/run-tr3',
      fileExists: () => {
        throw new Error('boom');
      },
    });
    const ok = await deliver({
      requestId: 'vr_tr3',
      runId: 'run-tr3',
      projectId: 1,
      type: 'static-render-snapshot',
      status: 'failed',
      verdict: undefined,
      fileNames: [],
    });
    expect(ok).toBe(true);

    const arts = screenshotsRows(db, 'run-tr3');
    const payload = JSON.parse(arts[0].payload_json ?? '{}') as ScreenshotsArtifactPayload;
    expect(payload.reports?.[0]?.transcriptFileName).toBeUndefined();
  });

  it('build_failed body carries the build log excerpt prominently', async () => {
    seedRun(db, 'run-b2');
    seedRequestFull(db, {
      id: 'vr_b2',
      runId: 'run-b2',
      status: 'failed',
      enqueueKey: 'run-b2:TASK-1:1',
      errorMessage: 'tsc: Cannot find module "./missing"',
      reportJson: JSON.stringify({
        version: 1,
        behaviors: [],
        screenshots: [],
        outcome: 'build_failed',
        buildLogExcerpt: 'ERROR in ./src/app.tsx\nCannot find module "./missing"',
        confidence: 0,
        feedback: 'the deliverable does not compile',
        issues: [],
      }),
    });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_b2', runId: 'run-b2', projectId: 1, type: 'static-render-snapshot', status: 'failed', verdict: undefined, fileNames: [] });

    const f = visualFindings(db, 'run-b2');
    expect(f).toHaveLength(1);
    expect(f[0].body).toMatch(/could not build the deliverable/i);
    expect(f[0].body).toMatch(/Build\/launch log excerpt/);
    expect(f[0].body).toMatch(/Cannot find module "\.\/missing"/);
  });

  it('timeout / skipped bodies carry the concrete error_message reason', async () => {
    seedRun(db, 'run-b3');
    seedRequestFull(db, { id: 'vr_to', runId: 'run-b3', status: 'timeout', errorMessage: 'request timed out' });
    seedRequestFull(db, { id: 'vr_sk', runId: 'run-b3', status: 'skipped', errorMessage: 'per-project visual-verify budget exhausted' });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_to', runId: 'run-b3', projectId: 1, type: 'static-render-snapshot', status: 'timeout', verdict: undefined, fileNames: [] });
    await deliver({ requestId: 'vr_sk', runId: 'run-b3', projectId: 1, type: 'static-render-snapshot', status: 'skipped', verdict: undefined, fileNames: [] });

    const f = visualFindings(db, 'run-b3');
    const timeout = f.find((x) => x.body.includes('timed out'));
    const skipped = f.find((x) => x.body.includes('budget exhausted'));
    expect(timeout?.body).toMatch(/Reason: request timed out/);
    expect(skipped?.body).toMatch(/Reason: per-project visual-verify budget exhausted/);
  });

  it('supersession resolves prior LOWER-attempt findings only; a same-lane higher attempt stays live', async () => {
    seedRun(db, 'run-b4');
    await seedPriorFinding('run-b4', 'TASK-1', 1, 'vr_old1');
    await seedPriorFinding('run-b4', 'TASK-1', 2, 'vr_old2');
    // A verdict at attempt 3 supersedes attempts 1 & 2, and (FAIL) raises its own.
    seedRequestFull(db, { id: 'vr_new3', runId: 'run-b4', status: 'failed', enqueueKey: 'run-b4:TASK-1:3' });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_new3', runId: 'run-b4', projectId: 1, type: 'static-render-snapshot', status: 'failed', verdict: FAIL_VERDICT, fileNames: ['home.png'], input: { intent: 'x', taskRef: 'TASK-1' } });

    const f = visualFindings(db, 'run-b4');
    const a1 = f.find((x) => x.attempt === 1);
    const a2 = f.find((x) => x.attempt === 2);
    const a3 = f.find((x) => x.attempt === 3);
    expect(a1?.status).toBe('resolved');
    expect(a2?.status).toBe('resolved');
    expect(a3?.status).toBe('pending'); // the new (highest) attempt stays live
  });

  it('a PASS resolves ALL prior findings for the lane and raises none of its own', async () => {
    seedRun(db, 'run-b5');
    await seedPriorFinding('run-b5', 'TASK-1', 1, 'vr_p1');
    await seedPriorFinding('run-b5', 'TASK-1', 2, 'vr_p2');
    seedRequestFull(db, { id: 'vr_pass3', runId: 'run-b5', status: 'passed', enqueueKey: 'run-b5:TASK-1:3' });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_pass3', runId: 'run-b5', projectId: 1, type: 'static-render-snapshot', status: 'passed', verdict: PASS_VERDICT, fileNames: ['home.png'], input: { intent: 'x', taskRef: 'TASK-1' } });

    const f = visualFindings(db, 'run-b5');
    expect(f.filter((x) => x.status === 'pending')).toHaveLength(0); // no live blockers
    expect(f.filter((x) => x.status === 'resolved')).toHaveLength(2);
  });

  it('a delivery-outbox REPLAY does not duplicate the finding (idempotent by requestId)', async () => {
    seedRun(db, 'run-b6');
    seedRequestFull(db, { id: 'vr_r', runId: 'run-b6', status: 'skipped', enqueueKey: 'run-b6:TASK-1:1', errorMessage: 'no backend' });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    const args = { requestId: 'vr_r', runId: 'run-b6', projectId: 1, type: 'static-render-snapshot' as const, status: 'skipped' as const, verdict: undefined, fileNames: [] as string[], input: { intent: 'x', taskRef: 'TASK-1' } };
    await deliver(args);
    await deliver(args); // replay
    expect(visualFindings(db, 'run-b6')).toHaveLength(1);
  });

  it('a malformed enqueue_key falls back to attempt 1 (no crash) and still correlates', async () => {
    seedRun(db, 'run-b7');
    seedRequestFull(db, { id: 'vr_bad', runId: 'run-b7', status: 'skipped', enqueueKey: 'garbage-no-colon', errorMessage: 'no backend' });
    const deliver = createVerdictDelivery({ db: dbAdapter(db), artifactsDirResolver: () => '/tmp/does-not-matter', fileExists: () => false });
    await deliver({ requestId: 'vr_bad', runId: 'run-b7', projectId: 1, type: 'static-render-snapshot', status: 'skipped', verdict: undefined, fileNames: [], input: { intent: 'x', taskRef: 'TASK-1' } });
    const f = visualFindings(db, 'run-b7');
    expect(f).toHaveLength(1);
    expect(f[0].attempt).toBe(1);
    expect(f[0].requestId).toBe('vr_bad');
  });
});
