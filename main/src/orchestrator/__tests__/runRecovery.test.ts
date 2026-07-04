/**
 * Integration tests for recoverActiveStateOrphans.
 *
 * Five cases per the test_strategy in the TASK-708 plan:
 *
 * A. "recovers running orphans": orphan with status='running' and no live
 *    RunQueueRegistry entry transitions to status='failed' with
 *    error_message='app_restart'.
 *
 * B. "recovers starting orphans": symmetric for status='starting'.
 *
 * C. "skips live runs": row with status='running' AND runQueues.has(runId)===true
 *    is SKIPPED (status stays 'running').
 *
 * D. "cancels pending approvals for recovered runs": pending approvals belonging
 *    to recovered runs are flipped from 'pending' to 'timed_out'.
 *
 * E. "ignores already-terminal rows": rows with status='completed' or
 *    status='failed' are left untouched.
 *
 * All tests use in-memory better-sqlite3 + dbAdapter + real RunQueueRegistry —
 * no mocks, exercises real SQL and real registry semantics.
 */
import { describe, it, expect } from 'vitest';
import {
  recoverActiveStateOrphans,
  recoverArchivedSessionRunOrphans,
  backfillTerminalOutcomes,
  stampSessionRunsOutcome,
  stampSessionRunsPrOpen,
} from '../runRecovery';
import { RunQueueRegistry } from '../RunQueueRegistry';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedApproval } from '../__test_fixtures__/orchestratorTestDb';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverActiveStateOrphans', () => {
  // -------------------------------------------------------------------------
  // Case A: "recovers running orphans"
  // -------------------------------------------------------------------------
  it('recovers running orphans', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-A1';
    seedRun(db, { id: runId, status: 'running' });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Return value: 1 running recovered, nothing else.
    expect(result).toEqual({ runningRecovered: 1, startingRecovered: 0, approvalsCanceled: 0, programmaticToResume: [] });

    // The row must be transitioned to 'failed' with error_message='app_restart'.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string };
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('app_restart');
  });

  // -------------------------------------------------------------------------
  // Case B: "recovers starting orphans"
  // -------------------------------------------------------------------------
  it('recovers starting orphans', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-B1';
    seedRun(db, { id: runId, status: 'starting' });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Return value: 1 starting recovered, nothing else.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 1, approvalsCanceled: 0, programmaticToResume: [] });

    // The row must be transitioned to 'failed' with error_message='app_restart'.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string };
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('app_restart');
  });

  // -------------------------------------------------------------------------
  // Case C: "skips live runs"
  // -------------------------------------------------------------------------
  it('skips live runs', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-C1';
    seedRun(db, { id: runId, status: 'running' });

    // Register a live entry in the registry (simulates an active executor).
    runQueues.getOrCreate(runId);
    expect(runQueues.has(runId)).toBe(true);

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing should be recovered.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0, programmaticToResume: [] });

    // The row must remain 'running' — not touched.
    const row = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string };
    expect(row.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Case D: "cancels pending approvals for recovered runs"
  // -------------------------------------------------------------------------
  it('cancels pending approvals for recovered runs', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-D1';
    seedRun(db, { id: runId, status: 'running' });

    const approvalId = 'approval-D1';
    seedApproval(db, { id: approvalId, runId });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // 1 running recovered, 1 approval canceled.
    expect(result).toEqual({ runningRecovered: 1, startingRecovered: 0, approvalsCanceled: 1, programmaticToResume: [] });

    // The approval row must be 'timed_out' with decided_at set and decided_by='system'.
    const approval = db
      .prepare('SELECT status, decided_at, decided_by FROM approvals WHERE id = ?')
      .get(approvalId) as { status: string; decided_at: string | null; decided_by: string };
    expect(approval.status).toBe('timed_out');
    expect(approval.decided_at).not.toBeNull();
    expect(approval.decided_by).toBe('system');
  });

  // -------------------------------------------------------------------------
  // Case F (Phase 4b): "paused runs survive boot recovery"
  //
  // A paused run (SDK-only Pause) is NON-terminal but must NOT be force-failed to
  // 'app_restart' on boot — it retains claude_session_id + current_step_id so
  // Resume can re-drive via --resume. recoverActiveStateOrphans only sweeps
  // 'starting'/'running', so a paused row is left untouched.
  // -------------------------------------------------------------------------
  it('does NOT recover paused runs (they survive restart)', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    const runId = 'run-F1';
    seedRun(db, { id: runId, status: 'paused' });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing recovered — paused is not in the sweep set.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0, programmaticToResume: [] });

    // The row must remain 'paused' — not force-failed.
    const row = db
      .prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string; error_message: string | null };
    expect(row.status).toBe('paused');
    expect(row.error_message).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Case E: "ignores already-terminal rows"
  // -------------------------------------------------------------------------
  it('ignores already-terminal rows', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-E1', status: 'completed' });
    seedRun(db, { id: 'run-E2', status: 'failed' });

    const result = recoverActiveStateOrphans(adapter, runQueues);

    // Nothing should be recovered.
    expect(result).toEqual({ runningRecovered: 0, startingRecovered: 0, approvalsCanceled: 0, programmaticToResume: [] });

    // Both rows must remain untouched.
    const e1 = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-E1') as { status: string };
    expect(e1.status).toBe('completed');

    const e2 = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get('run-E2') as { status: string };
    expect(e2.status).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // Crash-safe resume (Stage 3): programmatic runs are RESET to 'starting' and
  // returned for re-drive, NOT force-failed.
  // -------------------------------------------------------------------------
  const markProgrammatic = (db: ReturnType<typeof createTestDb>, id: string, stepId: string | null): void => {
    db.prepare(`UPDATE workflow_runs SET execution_model = 'programmatic', current_step_id = ? WHERE id = ?`).run(stepId, id);
  };

  it('resets a stranded programmatic running run to starting and returns it for resume', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-P1', status: 'running' });
    markProgrammatic(db, 'run-P1', 'epics');

    const result = recoverActiveStateOrphans(adapter, runQueues);

    expect(result.runningRecovered).toBe(0); // NOT force-failed
    expect(result.programmaticToResume).toEqual([{ id: 'run-P1', currentStepId: 'epics', completedStepIds: [] }]);
    const row = db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get('run-P1') as {
      status: string;
      error_message: string | null;
    };
    expect(row.status).toBe('starting'); // reset for re-drive
    expect(row.error_message).toBeNull();
  });

  it('resets a programmatic run parked at a gate (awaiting_review) for resume', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-P2', status: 'awaiting_review' });
    markProgrammatic(db, 'run-P2', 'approve-idea');

    const result = recoverActiveStateOrphans(adapter, runQueues);

    expect(result.programmaticToResume).toEqual([{ id: 'run-P2', currentStepId: 'approve-idea', completedStepIds: [] }]);
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-P2') as { status: string }).status).toBe('starting');
  });

  it('returns persisted completed step ids for a resumed programmatic run (migration 033)', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    db.exec(`CREATE TABLE IF NOT EXISTS step_results (
      run_id TEXT NOT NULL, step_id TEXT NOT NULL, phase_id TEXT,
      outcome TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, summary TEXT, error TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (run_id, step_id))`);
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-P5', status: 'running' });
    markProgrammatic(db, 'run-P5', 'tasks');
    db.prepare(`INSERT INTO step_results (run_id, step_id, outcome, attempts) VALUES ('run-P5','context','done',1)`).run();
    db.prepare(`INSERT INTO step_results (run_id, step_id, outcome, attempts) VALUES ('run-P5','research','skipped',1)`).run();
    db.prepare(`INSERT INTO step_results (run_id, step_id, outcome, attempts) VALUES ('run-P5','epics','failed',1)`).run();

    const result = recoverActiveStateOrphans(adapter, runQueues);

    expect(result.programmaticToResume).toHaveLength(1);
    expect(result.programmaticToResume[0].id).toBe('run-P5');
    expect(result.programmaticToResume[0].currentStepId).toBe('tasks');
    // only done/skipped are "completed"; the failed epics is NOT skipped on resume.
    expect(result.programmaticToResume[0].completedStepIds.sort()).toEqual(['context', 'research']);
  });

  it('leaves a NON-programmatic awaiting_review run untouched (not failed, not resumed)', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-P3', status: 'awaiting_review' }); // orchestrated (default)

    const result = recoverActiveStateOrphans(adapter, runQueues);

    expect(result.programmaticToResume).toEqual([]);
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-P3') as { status: string }).status).toBe('awaiting_review');
  });

  it('skips a live programmatic run still in the executor registry', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const runQueues = new RunQueueRegistry();

    seedRun(db, { id: 'run-P4', status: 'running' });
    markProgrammatic(db, 'run-P4', 'epics');
    runQueues.getOrCreate('run-P4'); // live → not an orphan

    const result = recoverActiveStateOrphans(adapter, runQueues);

    expect(result.programmaticToResume).toEqual([]);
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-P4') as { status: string }).status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// recoverArchivedSessionRunOrphans — runs left non-terminal under a dismissed
// (archived) session, which keep showing in the active-runs rail.
// ---------------------------------------------------------------------------

describe('recoverArchivedSessionRunOrphans', () => {
  // The orchestrator GATE_SCHEMA has no `sessions` table; the function only reads
  // sessions.id / archived / run_id, so a minimal table suffices.
  function withSessions(db: ReturnType<typeof createTestDb>): ReturnType<typeof createTestDb> {
    db.exec('CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, archived INTEGER DEFAULT 0, run_id TEXT)');
    return db;
  }

  it('cancels a non-terminal run whose session (session_id link) is archived', () => {
    const db = withSessions(createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true }));
    const { runId } = seedRun(db, { id: 'run-arch-1', status: 'stuck' });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run('sess-1', runId);
    db.prepare('INSERT INTO sessions (id, archived, run_id) VALUES (?, 1, ?)').run('sess-1', runId);

    const result = recoverArchivedSessionRunOrphans(dbAdapter(db));

    expect(result.runsCanceled).toBe(1);
    const row = db.prepare('SELECT status, outcome FROM workflow_runs WHERE id = ?').get(runId) as {
      status: string;
      outcome: string;
    };
    expect(row.status).toBe('canceled');
    expect(row.outcome).toBe('dismissed');
  });

  it('cancels a non-terminal run linked only via the legacy sessions.run_id back-link', () => {
    const db = withSessions(createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true }));
    const { runId } = seedRun(db, { id: 'run-arch-2', status: 'awaiting_review' });
    // No session_id on the run; the archived session points to it via run_id.
    db.prepare('INSERT INTO sessions (id, archived, run_id) VALUES (?, 1, ?)').run('sess-2', runId);

    const result = recoverArchivedSessionRunOrphans(dbAdapter(db));

    expect(result.runsCanceled).toBe(1);
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('canceled');
  });

  it('leaves a non-terminal run whose session is NOT archived', () => {
    const db = withSessions(createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true }));
    const { runId } = seedRun(db, { id: 'run-active-1', status: 'stuck' });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run('sess-active', runId);
    db.prepare('INSERT INTO sessions (id, archived, run_id) VALUES (?, 0, ?)').run('sess-active', runId);

    const result = recoverArchivedSessionRunOrphans(dbAdapter(db));

    expect(result.runsCanceled).toBe(0);
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('stuck');
  });

  it('leaves already-terminal runs on archived sessions untouched', () => {
    const db = withSessions(createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true }));
    const { runId } = seedRun(db, { id: 'run-term-1', status: 'failed' });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run('sess-term', runId);
    db.prepare('INSERT INTO sessions (id, archived, run_id) VALUES (?, 1, ?)').run('sess-term', runId);

    const result = recoverArchivedSessionRunOrphans(dbAdapter(db));

    expect(result.runsCanceled).toBe(0);
    const row = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string };
    expect(row.status).toBe('failed');
  });

  it('cancels pending approvals for recovered runs', () => {
    const db = withSessions(createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true }));
    const { runId } = seedRun(db, { id: 'run-arch-appr', status: 'stuck' });
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run('sess-appr', runId);
    db.prepare('INSERT INTO sessions (id, archived, run_id) VALUES (?, 1, ?)').run('sess-appr', runId);
    seedApproval(db, { runId, status: 'pending' });

    const result = recoverArchivedSessionRunOrphans(dbAdapter(db));

    expect(result.runsCanceled).toBe(1);
    expect(result.approvalsCanceled).toBe(1);
    const appr = db.prepare('SELECT status FROM approvals WHERE run_id = ?').get(runId) as { status: string };
    expect(appr.status).toBe('timed_out');
  });
});

// ---------------------------------------------------------------------------
// backfillTerminalOutcomes — boot-time backfill that makes outcome trustworthy
// for success-rate stats. Stamps the unambiguous status→outcome cases (failed /
// canceled), DELIBERATELY leaving completed+NULL ("awaiting close-out decision")
// and any pre-existing outcome untouched.
// ---------------------------------------------------------------------------

describe('backfillTerminalOutcomes', () => {
  function readOutcome(db: ReturnType<typeof createTestDb>, runId: string): string | null {
    const row = db.prepare('SELECT outcome FROM workflow_runs WHERE id = ?').get(runId) as {
      outcome: string | null;
    };
    return row.outcome;
  }

  it("stamps outcome='failed' on status='failed' rows with NULL outcome", () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    seedRun(db, { id: 'run-bf-failed', status: 'failed' });

    const result = backfillTerminalOutcomes(dbAdapter(db));

    expect(result).toEqual({ failedBackfilled: 1, canceledBackfilled: 0 });
    expect(readOutcome(db, 'run-bf-failed')).toBe('failed');
  });

  it("stamps outcome='canceled' on status='canceled' rows with NULL outcome", () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    seedRun(db, { id: 'run-bf-canceled', status: 'canceled' });

    const result = backfillTerminalOutcomes(dbAdapter(db));

    expect(result).toEqual({ failedBackfilled: 0, canceledBackfilled: 1 });
    expect(readOutcome(db, 'run-bf-canceled')).toBe('canceled');
  });

  it("leaves status='completed' rows with NULL outcome UNTOUCHED (awaiting close-out)", () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    seedRun(db, { id: 'run-bf-completed', status: 'completed' });

    const result = backfillTerminalOutcomes(dbAdapter(db));

    // Completed+NULL legitimately means "awaiting close-out decision" — not stamped.
    expect(result).toEqual({ failedBackfilled: 0, canceledBackfilled: 0 });
    expect(readOutcome(db, 'run-bf-completed')).toBeNull();
  });

  it('never clobbers a pre-existing outcome on a terminal row', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    // A run that failed AFTER it was already dismissed — the dismiss decision stands.
    seedRun(db, { id: 'run-bf-preexisting', status: 'failed' });
    db.prepare("UPDATE workflow_runs SET outcome = 'dismissed' WHERE id = ?").run('run-bf-preexisting');

    const result = backfillTerminalOutcomes(dbAdapter(db));

    expect(result).toEqual({ failedBackfilled: 0, canceledBackfilled: 0 });
    expect(readOutcome(db, 'run-bf-preexisting')).toBe('dismissed');
  });

  it('backfills a mixed batch in one pass', () => {
    const db = createTestDb({ includeWorkflowRunTaskColumns: true });
    seedRun(db, { id: 'run-mix-f1', status: 'failed' });
    seedRun(db, { id: 'run-mix-f2', status: 'failed' });
    seedRun(db, { id: 'run-mix-c1', status: 'canceled' });
    seedRun(db, { id: 'run-mix-done', status: 'completed' });
    // Already-stamped failed row — must not be counted or re-written.
    seedRun(db, { id: 'run-mix-stamped', status: 'canceled' });
    db.prepare("UPDATE workflow_runs SET outcome = 'merged' WHERE id = ?").run('run-mix-stamped');

    const result = backfillTerminalOutcomes(dbAdapter(db));

    expect(result).toEqual({ failedBackfilled: 2, canceledBackfilled: 1 });
    expect(readOutcome(db, 'run-mix-f1')).toBe('failed');
    expect(readOutcome(db, 'run-mix-f2')).toBe('failed');
    expect(readOutcome(db, 'run-mix-c1')).toBe('canceled');
    expect(readOutcome(db, 'run-mix-done')).toBeNull();
    expect(readOutcome(db, 'run-mix-stamped')).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// stampSessionRunsOutcome — the shared pure helper used by the session-level
// Merge (ipc/git.ts) and Dismiss (ipc/session.ts) close-out paths. Runs link to
// the session via workflow_runs.session_id; the guard never clobbers an existing
// outcome.
// ---------------------------------------------------------------------------

describe('stampSessionRunsOutcome', () => {
  // session_id needs includeSubstrate; outcome needs includeWorkflowRunTaskColumns.
  function makeDb() {
    return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
  }

  function setSession(db: ReturnType<typeof createTestDb>, runId: string, sessionId: string): void {
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
  }

  function readOutcome(db: ReturnType<typeof createTestDb>, runId: string): string | null {
    const row = db.prepare('SELECT outcome FROM workflow_runs WHERE id = ?').get(runId) as {
      outcome: string | null;
    };
    return row.outcome;
  }

  it("stamps outcome='merged' on all NULL-outcome runs of a session", () => {
    const db = makeDb();
    seedRun(db, { id: 'run-s1-a', status: 'completed' });
    seedRun(db, { id: 'run-s1-b', status: 'completed' });
    setSession(db, 'run-s1-a', 'sess-1');
    setSession(db, 'run-s1-b', 'sess-1');

    const stamped = stampSessionRunsOutcome(dbAdapter(db), 'sess-1', 'merged');

    expect(stamped).toBe(2);
    expect(readOutcome(db, 'run-s1-a')).toBe('merged');
    expect(readOutcome(db, 'run-s1-b')).toBe('merged');
  });

  it("stamps outcome='dismissed' on a session's runs", () => {
    const db = makeDb();
    seedRun(db, { id: 'run-s2-a', status: 'completed' });
    setSession(db, 'run-s2-a', 'sess-2');

    const stamped = stampSessionRunsOutcome(dbAdapter(db), 'sess-2', 'dismissed');

    expect(stamped).toBe(1);
    expect(readOutcome(db, 'run-s2-a')).toBe('dismissed');
  });

  it('never clobbers a run that already recorded its own outcome', () => {
    const db = makeDb();
    seedRun(db, { id: 'run-s3-pr', status: 'completed' });
    seedRun(db, { id: 'run-s3-null', status: 'completed' });
    setSession(db, 'run-s3-pr', 'sess-3');
    setSession(db, 'run-s3-null', 'sess-3');
    // One run already opened a PR — its outcome must survive the session-level stamp.
    db.prepare("UPDATE workflow_runs SET outcome = 'pr_open' WHERE id = ?").run('run-s3-pr');

    const stamped = stampSessionRunsOutcome(dbAdapter(db), 'sess-3', 'merged');

    // Only the NULL-outcome run is stamped.
    expect(stamped).toBe(1);
    expect(readOutcome(db, 'run-s3-pr')).toBe('pr_open');
    expect(readOutcome(db, 'run-s3-null')).toBe('merged');
  });

  it('does not touch runs belonging to a different session', () => {
    const db = makeDb();
    seedRun(db, { id: 'run-mine', status: 'completed' });
    seedRun(db, { id: 'run-other', status: 'completed' });
    setSession(db, 'run-mine', 'sess-mine');
    setSession(db, 'run-other', 'sess-other');

    const stamped = stampSessionRunsOutcome(dbAdapter(db), 'sess-mine', 'merged');

    expect(stamped).toBe(1);
    expect(readOutcome(db, 'run-mine')).toBe('merged');
    expect(readOutcome(db, 'run-other')).toBeNull();
  });

  // A/B post-merge attribution (migration 047): the mergeSha param stamps
  // workflow_runs.merge_sha ONLY for a 'merged' outcome.
  it('stamps merge_sha on a merged outcome; leaves it NULL for dismissed', () => {
    const db = makeDb();
    seedRun(db, { id: 'run-merge', status: 'completed' });
    seedRun(db, { id: 'run-dismiss', status: 'completed' });
    setSession(db, 'run-merge', 'sess-m');
    setSession(db, 'run-dismiss', 'sess-d');

    stampSessionRunsOutcome(dbAdapter(db), 'sess-m', 'merged', 'sha-abc123');
    stampSessionRunsOutcome(dbAdapter(db), 'sess-d', 'dismissed', 'sha-ignored');

    const readSha = (id: string) =>
      (db.prepare('SELECT merge_sha AS v FROM workflow_runs WHERE id = ?').get(id) as { v: unknown }).v;
    expect(readSha('run-merge')).toBe('sha-abc123');
    // dismissed never records a merge_sha, even when one is (wrongly) supplied.
    expect(readSha('run-dismiss')).toBeNull();
  });

  it('merged with no mergeSha leaves merge_sha NULL (fail-soft)', () => {
    const db = makeDb();
    seedRun(db, { id: 'run-nosha', status: 'completed' });
    setSession(db, 'run-nosha', 'sess-n');
    stampSessionRunsOutcome(dbAdapter(db), 'sess-n', 'merged');
    expect(readOutcome(db, 'run-nosha')).toBe('merged');
    const sha = (db.prepare('SELECT merge_sha AS v FROM workflow_runs WHERE id = ?').get('run-nosha') as { v: unknown }).v;
    expect(sha).toBeNull();
  });

  it('returns 0 when a session has no runs', () => {
    const db = makeDb();
    const stamped = stampSessionRunsOutcome(dbAdapter(db), 'sess-empty', 'dismissed');
    expect(stamped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stampSessionRunsPrOpen — the session-scoped Create-PR close-out. Marks a
// session's NON-terminal runs TERMINAL as completed/pr_open so the dismiss that
// the Create-PR dialog issues next no-ops instead of re-stamping them canceled.
// ---------------------------------------------------------------------------

describe('stampSessionRunsPrOpen', () => {
  function makeDb() {
    return createTestDb({ includeSubstrate: true, includeWorkflowRunTaskColumns: true });
  }

  function setSession(db: ReturnType<typeof createTestDb>, runId: string, sessionId: string): void {
    db.prepare('UPDATE workflow_runs SET session_id = ? WHERE id = ?').run(sessionId, runId);
  }

  function readRow(db: ReturnType<typeof createTestDb>, runId: string): { status: string; outcome: string | null } {
    return db.prepare('SELECT status, outcome FROM workflow_runs WHERE id = ?').get(runId) as {
      status: string;
      outcome: string | null;
    };
  }

  it("completes a session's non-terminal runs as completed/pr_open", () => {
    const db = makeDb();
    seedRun(db, { id: 'run-pr-a', status: 'running' });
    seedRun(db, { id: 'run-pr-b', status: 'awaiting_review' });
    setSession(db, 'run-pr-a', 'sess-pr');
    setSession(db, 'run-pr-b', 'sess-pr');

    const closed = stampSessionRunsPrOpen(dbAdapter(db), 'sess-pr');

    expect(closed).toBe(2);
    expect(readRow(db, 'run-pr-a')).toMatchObject({ status: 'completed', outcome: 'pr_open' });
    expect(readRow(db, 'run-pr-b')).toMatchObject({ status: 'completed', outcome: 'pr_open' });
  });

  it('leaves already-terminal runs untouched (the later dismiss-cancel is a no-op)', () => {
    const db = makeDb();
    // A run already canceled must NOT be revived to completed.
    seedRun(db, { id: 'run-pr-term', status: 'canceled' });
    db.prepare("UPDATE workflow_runs SET outcome = 'canceled' WHERE id = ?").run('run-pr-term');
    setSession(db, 'run-pr-term', 'sess-pr-term');

    const closed = stampSessionRunsPrOpen(dbAdapter(db), 'sess-pr-term');

    expect(closed).toBe(0);
    expect(readRow(db, 'run-pr-term')).toMatchObject({ status: 'canceled', outcome: 'canceled' });
  });

  it('does not touch runs belonging to a different session', () => {
    const db = makeDb();
    seedRun(db, { id: 'run-pr-mine', status: 'running' });
    seedRun(db, { id: 'run-pr-other', status: 'running' });
    setSession(db, 'run-pr-mine', 'sess-pr-mine');
    setSession(db, 'run-pr-other', 'sess-pr-other');

    const closed = stampSessionRunsPrOpen(dbAdapter(db), 'sess-pr-mine');

    expect(closed).toBe(1);
    expect(readRow(db, 'run-pr-mine')).toMatchObject({ status: 'completed', outcome: 'pr_open' });
    expect(readRow(db, 'run-pr-other')).toMatchObject({ status: 'running', outcome: null });
  });

  it('returns 0 when a session has no runs', () => {
    const db = makeDb();
    expect(stampSessionRunsPrOpen(dbAdapter(db), 'sess-pr-empty')).toBe(0);
  });
});
