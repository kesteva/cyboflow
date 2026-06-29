/**
 * Unit tests for the atomic awaiting_review transition helpers.
 *
 * DDL now comes from GATE_SCHEMA in
 * main/src/database/__test_fixtures__/registrySchema.ts rather than being
 * inlined here. That fixture is the single source of truth for schema used
 * across test files.
 *
 * See TASK-153 plan "Lowest Confidence Area" for why concurrent-transaction
 * races cannot be truly reproduced in a single-threaded vitest run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  transitionToAwaitingReview,
  transitionFromAwaitingReview,
  transitionToRunning,
  transitionRunningToAwaitingReview,
  transitionToCompleted,
  transitionToPaused,
  transitionPausedToRunning,
  reviveQuickRunToRunning,
  TransitionRejectedError,
} from '../transitions';
import { IllegalTransitionError } from '../stateMachine';
import { GATE_SCHEMA } from '../../../database/__test_fixtures__/registrySchema';
import { seedApproval } from '../../../orchestrator/__test_fixtures__/orchestratorTestDb';

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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('transitions', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(GATE_SCHEMA);
    // GATE_SCHEMA mirrors the 006/007 columns only. transitionToPaused must
    // preserve the resume-critical columns added later (migration 011's
    // current_step_id, migration 018's claude_session_id); layer them on so the
    // preservation assertion has real columns to read back. Additive ALTERs —
    // GATE_SCHEMA itself is untouched (its column-set parity test is unaffected).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN current_step_id TEXT');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
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

    // -----------------------------------------------------------------------
    // Case (g): In-process guard rejects transitionToAwaitingReview
    //
    // The assertTransitionAllowed guard is forced to throw IllegalTransitionError
    // via a spy. This verifies the guard fires BEFORE the SQL UPDATE — the DB
    // row remains unchanged and no approval row is inserted, confirming the
    // SQL never ran.
    // -----------------------------------------------------------------------

    it('(g) in-process guard: throws IllegalTransitionError before SQL UPDATE when assertTransitionAllowed rejects', async () => {
      const stateMachine = await import('../stateMachine');
      const guardSpy = vi.spyOn(stateMachine, 'assertTransitionAllowed').mockImplementationOnce(
        (from, to, runId) => {
          throw new IllegalTransitionError(from, to, runId);
        },
      );

      seedRun(db, 'running');

      expect(() =>
        transitionToAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          toolName: 'bash',
          toolInputJson: '{"cmd":"ls"}',
          toolUseId: 'tu-guard-to-001',
          rationale: null,
        }),
      ).toThrow(IllegalTransitionError);

      // Guard must have been called with the correct static args
      expect(guardSpy).toHaveBeenCalledWith('running', 'awaiting_review', RUN_ID);

      // Row must still be 'running' — the SQL UPDATE was never reached
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('running');

      // No approval row was inserted
      const count = (
        db
          .prepare('SELECT COUNT(*) as cnt FROM approvals WHERE id = ?')
          .get(APPROVAL_ID) as { cnt: number }
      ).cnt;
      expect(count).toBe(0);

      guardSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Case (c): Happy-path reverse transition
  // -------------------------------------------------------------------------

  describe('transitionFromAwaitingReview', () => {
    it('(c) reverse happy-path: updates run to running and sets approval to approved', () => {
      seedRun(db, 'awaiting_review');
      seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'pending' });

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
      seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'pending' });

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
      seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'pending' });

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
      seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'timed_out' }); // approval already decided; status guard rejects it

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

    // -----------------------------------------------------------------------
    // Case (h): In-process guard rejects transitionFromAwaitingReview
    //
    // The assertTransitionAllowed guard is forced to throw IllegalTransitionError
    // via a spy. This verifies the guard fires BEFORE the SQL UPDATE — the DB
    // row remains unchanged and the approval row is untouched, confirming the
    // SQL never ran.
    // -----------------------------------------------------------------------

    it('(h) in-process guard: throws IllegalTransitionError before SQL UPDATE when assertTransitionAllowed rejects', async () => {
      const stateMachine = await import('../stateMachine');
      const guardSpy = vi.spyOn(stateMachine, 'assertTransitionAllowed').mockImplementationOnce(
        (from, to, runId) => {
          throw new IllegalTransitionError(from, to, runId);
        },
      );

      seedRun(db, 'awaiting_review');
      seedApproval(db, { id: APPROVAL_ID, runId: RUN_ID, toolUseId: 'tu-001', status: 'pending' });

      expect(() =>
        transitionFromAwaitingReview(db, {
          runId: RUN_ID,
          approvalId: APPROVAL_ID,
          decision: 'approved',
          decidedBy: 'user',
        }),
      ).toThrow(IllegalTransitionError);

      // Guard must have been called with the correct static args
      expect(guardSpy).toHaveBeenCalledWith('awaiting_review', 'running', RUN_ID);

      // Row must still be 'awaiting_review' — the SQL UPDATE was never reached
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('awaiting_review');

      // Approval row must be unchanged (still pending)
      const approval = db
        .prepare('SELECT status, decided_at FROM approvals WHERE id = ?')
        .get(APPROVAL_ID) as { status: string; decided_at: string | null };
      expect(approval.status).toBe('pending');
      expect(approval.decided_at).toBeNull();

      guardSpy.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Cases (i) and (j): transitionToRunning COALESCE semantics
  // -------------------------------------------------------------------------

  describe('transitionToRunning', () => {
    it('(i) transitionToRunning sets started_at when previously NULL', () => {
      // seedRun inserts with default DEFAULT values; started_at is unset → NULL
      seedRun(db, 'starting');

      const beforeStartedAt = db
        .prepare('SELECT started_at FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { started_at: string | null };
      expect(beforeStartedAt.started_at).toBeNull();

      transitionToRunning(db, { runId: RUN_ID });

      const after = db
        .prepare('SELECT status, started_at FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string; started_at: string | null };
      expect(after.status).toBe('running');
      expect(after.started_at).not.toBeNull();
    });

    it('(j) transitionToRunning preserves existing started_at (COALESCE)', () => {
      seedRun(db, 'starting');
      const FIXED_TS = '2026-01-01 00:00:00';
      db.prepare('UPDATE workflow_runs SET started_at = ? WHERE id = ?')
        .run(FIXED_TS, RUN_ID);

      transitionToRunning(db, { runId: RUN_ID });

      const after = db
        .prepare('SELECT status, started_at FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string; started_at: string };
      expect(after.status).toBe('running');
      expect(after.started_at).toBe(FIXED_TS);
    });
  });

  // -------------------------------------------------------------------------
  // transitionRunningToAwaitingReview — the REST transition (no approval row)
  // -------------------------------------------------------------------------
  describe('transitionRunningToAwaitingReview', () => {
    it('rests a running run in awaiting_review WITHOUT inserting an approval row', () => {
      seedRun(db, 'running');

      transitionRunningToAwaitingReview(db, { runId: RUN_ID });

      const after = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(after.status).toBe('awaiting_review');

      // Distinguishing signal: a REST awaiting_review has NO pending approval row
      // (unlike the tool-approval gate via transitionToAwaitingReview).
      const approvals = db
        .prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id = ?')
        .get(RUN_ID) as { n: number };
      expect(approvals.n).toBe(0);
    });

    it('rejects when the run is not in running state', () => {
      seedRun(db, 'awaiting_review');
      expect(() => transitionRunningToAwaitingReview(db, { runId: RUN_ID })).toThrow(
        TransitionRejectedError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // transitionToCompleted — user accept (Merge / Create-PR), now valid from
  // running / awaiting_review / stuck.
  // -------------------------------------------------------------------------
  describe('transitionToCompleted', () => {
    it('completes from awaiting_review (the rest state)', () => {
      seedRun(db, 'awaiting_review');

      transitionToCompleted(db, { runId: RUN_ID, fromStatus: 'awaiting_review' });

      const after = db
        .prepare('SELECT status, ended_at FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string; ended_at: string | null };
      expect(after.status).toBe('completed');
      expect(after.ended_at).not.toBeNull();
    });

    it('completes from stuck', () => {
      seedRun(db, 'stuck');
      transitionToCompleted(db, { runId: RUN_ID, fromStatus: 'stuck' });
      const after = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(RUN_ID) as { status: string };
      expect(after.status).toBe('completed');
    });

    it('completes from running', () => {
      seedRun(db, 'running');
      transitionToCompleted(db, { runId: RUN_ID, fromStatus: 'running' });
      const after = db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(RUN_ID) as { status: string };
      expect(after.status).toBe('completed');
    });

    it('rejects when the row is not in the expected fromStatus', () => {
      seedRun(db, 'running');
      expect(() => transitionToCompleted(db, { runId: RUN_ID, fromStatus: 'awaiting_review' })).toThrow(
        TransitionRejectedError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // transitionToPaused — Phase 4b SDK-only Pause. Valid from running OR
  // awaiting_review; preserves claude_session_id + current_step_id; no ended_at.
  // -------------------------------------------------------------------------
  describe('transitionToPaused', () => {
    it('(happy) pauses a running run and preserves resume state (no ended_at)', () => {
      seedRun(db, 'running');
      // Stamp the resume-critical columns Pause must NOT touch.
      db.prepare(
        'UPDATE workflow_runs SET claude_session_id = ?, current_step_id = ? WHERE id = ?',
      ).run('claude-sess-1', 'implement', RUN_ID);

      transitionToPaused(db, { runId: RUN_ID });

      const after = db
        .prepare(
          'SELECT status, ended_at, claude_session_id, current_step_id FROM workflow_runs WHERE id = ?',
        )
        .get(RUN_ID) as {
        status: string;
        ended_at: string | null;
        claude_session_id: string | null;
        current_step_id: string | null;
      };
      expect(after.status).toBe('paused');
      // paused is non-terminal — ended_at must remain NULL.
      expect(after.ended_at).toBeNull();
      // Resume state preserved.
      expect(after.claude_session_id).toBe('claude-sess-1');
      expect(after.current_step_id).toBe('implement');
    });

    it('(happy) pauses an awaiting_review (idle-rested) run', () => {
      seedRun(db, 'awaiting_review');

      transitionToPaused(db, { runId: RUN_ID });

      const after = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(after.status).toBe('paused');
    });

    it('(stale) rejects when the run is not pausable (e.g. already completed)', () => {
      seedRun(db, 'completed');
      expect(() => transitionToPaused(db, { runId: RUN_ID })).toThrow(TransitionRejectedError);

      // Row must be unchanged — still completed.
      const after = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(after.status).toBe('completed');
    });

    it('(stale) reject carries workflow_run entity discriminator', () => {
      seedRun(db, 'queued'); // not running / awaiting_review
      let caught: unknown;
      try {
        transitionToPaused(db, { runId: RUN_ID });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(TransitionRejectedError);
      const e = caught as TransitionRejectedError;
      expect(e.code).toBe('TRANSITION_REJECTED');
      expect(e.details.entity).toBe('workflow_run');
    });
  });

  // -------------------------------------------------------------------------
  // transitionPausedToRunning — Phase 4b SDK-only Resume.
  // -------------------------------------------------------------------------
  describe('transitionPausedToRunning', () => {
    it('(happy) resumes a paused run back to running', () => {
      seedRun(db, 'paused');

      transitionPausedToRunning(db, { runId: RUN_ID });

      const after = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(after.status).toBe('running');
    });

    it('(reject) throws when the run is not in paused state', () => {
      seedRun(db, 'running');
      expect(() => transitionPausedToRunning(db, { runId: RUN_ID })).toThrow(
        TransitionRejectedError,
      );

      // Row must be unchanged — still running.
      const after = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(after.status).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // reviveQuickRunToRunning — quick-session sentinel per-turn approval-gate fix
  // -------------------------------------------------------------------------

  describe('reviveQuickRunToRunning', () => {
    const QUICK_WF_ID = 'wf-quick-001';
    const QUICK_RUN_ID = 'run-quick-001';

    function seedQuickWorkflow(): void {
      db.prepare(
        `INSERT INTO workflows (id, project_id, name, spec_json)
         VALUES (?, 1, '__quick__', '{}')`,
      ).run(QUICK_WF_ID);
    }

    function seedQuickRun(status: string, opts: { error?: string; ended?: string } = {}): void {
      db.prepare(
        `INSERT INTO workflow_runs (id, workflow_id, project_id, worktree_path, status, policy_json, error_message, ended_at)
         VALUES (?, ?, 1, '/tmp/wt', ?, '{}', ?, ?)`,
      ).run(QUICK_RUN_ID, QUICK_WF_ID, status, opts.error ?? null, opts.ended ?? null);
    }

    function readRun(): { status: string; error_message: string | null; ended_at: string | null } {
      return db
        .prepare('SELECT status, error_message, ended_at FROM workflow_runs WHERE id = ?')
        .get(QUICK_RUN_ID) as { status: string; error_message: string | null; ended_at: string | null };
    }

    it("revives a force-failed sentinel run to 'running' and clears the failure stamp", () => {
      seedQuickWorkflow();
      seedQuickRun('failed', { error: 'app_restart', ended: '2026-06-29 00:00:00' });

      const result = reviveQuickRunToRunning(db, QUICK_RUN_ID);

      expect(result).toEqual({ revived: true, fromStatus: 'failed' });
      const run = readRun();
      expect(run.status).toBe('running');
      expect(run.error_message).toBeNull();
      expect(run.ended_at).toBeNull();
    });

    it.each(['completed', 'canceled', 'awaiting_review'])(
      "revives a sentinel run parked in '%s' back to 'running'",
      (parked) => {
        seedQuickWorkflow();
        seedQuickRun(parked, { ended: '2026-06-29 00:00:00' });

        const result = reviveQuickRunToRunning(db, QUICK_RUN_ID);

        expect(result).toEqual({ revived: true, fromStatus: parked });
        expect(readRun().status).toBe('running');
      },
    );

    it("is a no-op when the sentinel run is already 'running'", () => {
      seedQuickWorkflow();
      seedQuickRun('running');

      const result = reviveQuickRunToRunning(db, QUICK_RUN_ID);

      expect(result).toEqual({ revived: false, fromStatus: 'running' });
      expect(readRun().status).toBe('running');
    });

    it('NEVER touches a real (non-__quick__) workflow run — the JOIN gate excludes it', () => {
      // seedWorkflow() in beforeEach created WORKFLOW_ID with name 'Test Workflow'.
      seedRun(db, 'failed'); // RUN_ID belongs to the non-quick workflow

      const result = reviveQuickRunToRunning(db, RUN_ID);

      expect(result).toEqual({ revived: false, fromStatus: null });
      const run = db
        .prepare('SELECT status FROM workflow_runs WHERE id = ?')
        .get(RUN_ID) as { status: string };
      expect(run.status).toBe('failed'); // untouched
    });

    it('is a no-op for a missing run id', () => {
      const result = reviveQuickRunToRunning(db, 'no-such-run');
      expect(result).toEqual({ revived: false, fromStatus: null });
    });
  });
});
