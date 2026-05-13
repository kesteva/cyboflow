/**
 * Unit tests for the atomic awaiting_review transition helpers.
 *
 * Schema DDL is inlined here rather than loaded from
 * main/src/database/migrations/006_cyboflow_schema.sql because TASK-153
 * runs in a parallel worktree that does not yet have TASK-152's migration
 * file. The inlined DDL is byte-for-byte identical to what TASK-152 will
 * deliver — keeping these tests self-contained and post-merge green.
 *
 * See TASK-153 plan "Lowest Confidence Area" for why concurrent-transaction
 * races cannot be truly reproduced in a single-threaded vitest run.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  transitionToAwaitingReview,
  transitionFromAwaitingReview,
  TransitionRejectedError,
} from '../transitions';

// ---------------------------------------------------------------------------
// Inline schema DDL (mirrors 006_cyboflow_schema.sql from TASK-152)
// ---------------------------------------------------------------------------

const SCHEMA_DDL = `
-- Migration 006: Cyboflow orchestrator schema (5 net-new tables)
-- Strictly disjoint from Crystal's sessions/tool_panels — no cross-FK.

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  spec_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  project_id INTEGER NOT NULL,
  worktree_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'starting', 'running', 'awaiting_review', 'stuck', 'completed', 'failed', 'canceled')),
  policy_json TEXT NOT NULL,
  stuck_at DATETIME,
  stuck_reason TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME,
  ended_at DATETIME,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS raw_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content_json TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input_json TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  decided_at DATETIME,
  decided_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_raw_events_run_id ON raw_events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_raw_events_type_run ON raw_events(event_type, run_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status_created ON workflow_runs(status, created_at);
`;

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const WORKFLOW_ID = 'wf-test-001';
const RUN_ID = 'run-test-001';
const APPROVAL_ID = 'appr-test-001';

function seedWorkflow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO workflows (id, project_id, name, spec_json)
     VALUES (?, 1, 'Test Workflow', '{}')`,
  ).run(WORKFLOW_ID);
}

function seedRun(db: Database.Database, status: string): void {
  db.prepare(
    `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json)
     VALUES (?, ?, 1, '/tmp/wt', ?, '{}')`,
  ).run(RUN_ID, WORKFLOW_ID, status);
}

function seedApproval(db: Database.Database, status: string): void {
  db.prepare(
    `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status)
     VALUES (?, ?, 'bash', '{}', 'tu-001', ?)`,
  ).run(APPROVAL_ID, RUN_ID, status);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('transitions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_DDL);
    seedWorkflow(db);
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Case (a): Happy-path forward transition
  // -------------------------------------------------------------------------

  describe('transitionToAwaitingReview', () => {
    it('(a) happy-path: updates run to awaiting_review and inserts pending approval', () => {
      seedRun(db, 'running');

      transitionToAwaitingReview(db, {
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        toolName: 'bash',
        toolInputJson: '{"cmd":"ls"}',
        toolUseId: 'tu-happy-001',
        rationale: 'Needs review',
      });

      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('awaiting_review');

      const approval = db
        .prepare('SELECT status FROM approvals WHERE id = ?')
        .get(APPROVAL_ID) as { status: string };
      expect(approval.status).toBe('pending');
    });

    // -----------------------------------------------------------------------
    // Case (b): Stale-status rejection
    // -----------------------------------------------------------------------

    it('(b) stale-status: throws TransitionRejectedError and does NOT insert approval when run is canceled', () => {
      seedRun(db, 'canceled');

      expect(() =>
        transitionToAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          toolName: 'bash',
          toolInputJson: '{"cmd":"ls"}',
          toolUseId: 'tu-stale-001',
          rationale: null,
        }),
      ).toThrow(TransitionRejectedError);

      // Run must still be in 'canceled' — the UPDATE rolled back
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('canceled');

      // No approval row must have been inserted (INSERT was rolled back)
      const count = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM approvals WHERE id = ?')
          .get(APPROVAL_ID) as { cnt: number }
      ).cnt;
      expect(count).toBe(0);
    });

    it('(b) stale-status error has correct code and entity discriminators', () => {
      seedRun(db, 'canceled');

      let caught: unknown;
      try {
        transitionToAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          toolName: 'bash',
          toolInputJson: '{}',
          toolUseId: 'tu-disc-001',
          rationale: null,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransitionRejectedError);
      const e = caught as TransitionRejectedError;
      expect(e.code).toBe('TRANSITION_REJECTED');
      expect(e.details.entity).toBe('workflow_run');
      expect(e.details.expectedStatus).toBe('running');
      expect(e.details.runId).toBe(RUN_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Case (c): Happy-path reverse transition
  // -------------------------------------------------------------------------

  describe('transitionFromAwaitingReview', () => {
    it('(c) reverse happy-path: updates run to running and sets approval to approved', () => {
      seedRun(db, 'awaiting_review');
      seedApproval(db, 'pending');

      transitionFromAwaitingReview(db, {
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        decision: 'approved',
        decidedBy: 'user',
      });

      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('running');

      const approval = db
        .prepare('SELECT status, decided_at, decided_by FROM approvals WHERE id = ?')
        .get(APPROVAL_ID) as { status: string; decided_at: string | null; decided_by: string | null };
      expect(approval.status).toBe('approved');
      expect(approval.decided_at).not.toBeNull();
      expect(approval.decided_by).toBe('user');
    });

    // -----------------------------------------------------------------------
    // Case (d): Reverse stale-status rejection
    // -----------------------------------------------------------------------

    it('(d) reverse stale-status: throws TransitionRejectedError when run is in failed state', () => {
      seedRun(db, 'failed');
      seedApproval(db, 'pending');

      expect(() =>
        transitionFromAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'approved',
          decidedBy: 'user',
        }),
      ).toThrow(TransitionRejectedError);

      // Approval must still be pending — the UPDATE approval was rolled back
      const approval = db
        .prepare('SELECT status, decided_at FROM approvals WHERE id = ?')
        .get(APPROVAL_ID) as { status: string; decided_at: string | null };
      expect(approval.status).toBe('pending');
      expect(approval.decided_at).toBeNull();
    });

    it('(d) reverse stale-status error has correct code and entity discriminators', () => {
      seedRun(db, 'failed');
      seedApproval(db, 'pending');

      let caught: unknown;
      try {
        transitionFromAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'rejected',
          decidedBy: 'user',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransitionRejectedError);
      const e = caught as TransitionRejectedError;
      expect(e.code).toBe('TRANSITION_REJECTED');
      expect(e.details.entity).toBe('workflow_run');
      expect(e.details.expectedStatus).toBe('awaiting_review');
    });

    // -----------------------------------------------------------------------
    // Case (e): Approval row deleted between transitions
    //
    // The run is in 'awaiting_review' (run UPDATE succeeds), but the
    // approvals row was deleted before the transaction body runs (or was
    // never inserted). The approval UPDATE returns changes===0, which must
    // throw TransitionRejectedError with entity='approval' AND roll back the
    // run UPDATE — leaving the run still in 'awaiting_review'.
    // -----------------------------------------------------------------------

    it('(e) missing approval row: throws with entity=approval and rolls back the run status update', () => {
      seedRun(db, 'awaiting_review');
      // Deliberately omit seedApproval — no row exists for APPROVAL_ID

      let caught: unknown;
      try {
        transitionFromAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'approved',
          decidedBy: 'user',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransitionRejectedError);
      const e = caught as TransitionRejectedError;
      expect(e.code).toBe('TRANSITION_REJECTED');
      expect(e.details.entity).toBe('approval');
      expect(e.details.expectedStatus).toBe('pending');

      // The run UPDATE must have been rolled back — run is still awaiting_review
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('awaiting_review');
    });

    // -----------------------------------------------------------------------
    // Case (f): Approval already decided (non-pending status)
    //
    // Same code path as case (e) — approval UPDATE finds 0 rows — but the
    // row *exists* with status='timed_out' rather than being absent entirely.
    // Verifies the WHERE status='pending' guard, not just the row-existence
    // guard. Rollback of the run UPDATE is again the key invariant.
    // -----------------------------------------------------------------------

    it('(f) already-decided approval: throws with entity=approval and rolls back the run status update', () => {
      seedRun(db, 'awaiting_review');
      seedApproval(db, 'timed_out'); // approval already decided; status guard rejects it

      let caught: unknown;
      try {
        transitionFromAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'approved',
          decidedBy: 'user',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(TransitionRejectedError);
      const e = caught as TransitionRejectedError;
      expect(e.code).toBe('TRANSITION_REJECTED');
      expect(e.details.entity).toBe('approval');
      expect(e.details.expectedStatus).toBe('pending');

      // Run UPDATE rolled back — run stays awaiting_review
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('awaiting_review');

      // Approval status must be unchanged (still timed_out, not approved)
      const approval = db
        .prepare('SELECT status, decided_by FROM approvals WHERE id = ?')
        .get(APPROVAL_ID) as { status: string; decided_by: string | null };
      expect(approval.status).toBe('timed_out');
      expect(approval.decided_by).toBeNull();
    });
  });
});
