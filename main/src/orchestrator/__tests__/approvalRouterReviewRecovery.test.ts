/**
 * B2 — ApprovalRouter.recoverStaleAwaitingReview review_items reconciliation.
 *
 * approvalRouter.test.ts exercises recoverStaleAwaitingReview on the GATE_SCHEMA
 * DB (no review_items table), so the migration-016 fold-reconciliation branch —
 * resolving the orphaned pending permission review_items whose socket is gone —
 * is untested there. This file pins that branch on a migration-backed DB carrying
 * the inbox, and DOCUMENTS the current no-emit behavior of boot recovery.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ApprovalRouter } from '../approvalRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import {
  buildReviewInboxDb,
  seedInboxRun,
  seedBlockingReviewItem,
} from '../__test_fixtures__/reviewInboxTestDb';

afterEach(() => {
  ApprovalRouter._resetForTesting();
});

/** Insert a pending approvals row for a run. */
function seedApproval(db: ReturnType<typeof buildReviewInboxDb>, id: string, runId: string): void {
  db.prepare(
    `INSERT INTO approvals (id, run_id, tool_name, tool_input_json, tool_use_id, status, created_at)
     VALUES (?, ?, 'Bash', '{}', ?, 'pending', ?)`,
  ).run(id, runId, id, new Date().toISOString());
}

describe('ApprovalRouter.recoverStaleAwaitingReview — review_items reconciliation', () => {
  it('resolves the folded pending permission review_item to system/app_restart alongside the run+approval', () => {
    const db = buildReviewInboxDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));

    seedInboxRun(db, 'run-G1', 'awaiting_review');
    seedApproval(db, 'approval-G1', 'run-G1');
    // The blocking permission review_item folded when the approval was opened,
    // linked to the approval via payload.approvalId.
    seedBlockingReviewItem(db, {
      id: 'rvw_perm',
      runId: 'run-G1',
      kind: 'permission',
      payloadJson: JSON.stringify({ kind: 'permission', toolName: 'Bash', approvalId: 'approval-G1' }),
    });

    const count = router.recoverStaleAwaitingReview();
    expect(count).toBe(1);

    // Run + approval reconciled.
    expect(
      (db.prepare('SELECT status, error_message FROM workflow_runs WHERE id = ?').get('run-G1') as {
        status: string;
        error_message: string | null;
      }),
    ).toMatchObject({ status: 'failed', error_message: 'app_restart' });
    expect(
      (db.prepare('SELECT status FROM approvals WHERE id = ?').get('approval-G1') as { status: string }).status,
    ).toBe('timed_out');

    // The orphaned permission review_item is resolved by 'system' with resolution
    // 'app_restart' so it no longer lingers as a blocking item.
    const item = db
      .prepare('SELECT status, resolved_by, resolution FROM review_items WHERE id = ?')
      .get('rvw_perm') as { status: string; resolved_by: string | null; resolution: string | null };
    expect(item.status).toBe('resolved');
    expect(item.resolved_by).toBe('system');
    expect(item.resolution).toBe('app_restart');
  });

  it('DOCUMENTS CURRENT BEHAVIOR: boot recovery emits NO review-item entity_events delta for the reconciled item', () => {
    // The recovery branch resolves review_items with a bare UPDATE inside its
    // transaction — it does NOT append a 'resolved' entity_events row and does
    // NOT emit a renderer delta (unlike the normal resolve path). This is the
    // current behavior; a queue chip resolved only by boot recovery relies on a
    // full re-sync rather than an incremental delta. Pinned as a regression guard.
    const db = buildReviewInboxDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));

    seedInboxRun(db, 'run-G1', 'awaiting_review');
    seedApproval(db, 'approval-G1', 'run-G1');
    seedBlockingReviewItem(db, {
      id: 'rvw_perm',
      runId: 'run-G1',
      kind: 'permission',
      payloadJson: JSON.stringify({ kind: 'permission', toolName: 'Bash', approvalId: 'approval-G1' }),
    });

    router.recoverStaleAwaitingReview();

    const resolvedEvents = db
      .prepare(
        `SELECT COUNT(*) AS n FROM entity_events
          WHERE entity_type = 'review_item' AND entity_id = 'rvw_perm' AND kind = 'resolved'`,
      )
      .get() as { n: number };
    // No 'resolved' delta is written by boot recovery (documented no-emit gap).
    expect(resolvedEvents.n).toBe(0);
  });

  it('leaves an unrelated pending review_item on a clean-rest run untouched', () => {
    const db = buildReviewInboxDb();
    const router = ApprovalRouter.initialize(dbAdapter(db));

    // Clean-rest run: awaiting_review, NO pending approval → not recovered.
    seedInboxRun(db, 'run-G2', 'awaiting_review');
    seedBlockingReviewItem(db, { id: 'rvw_clean', runId: 'run-G2', kind: 'decision' });

    const count = router.recoverStaleAwaitingReview();
    expect(count).toBe(0);

    expect(
      (db.prepare('SELECT status FROM review_items WHERE id = ?').get('rvw_clean') as { status: string }).status,
    ).toBe('pending');
    expect(
      (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-G2') as { status: string }).status,
    ).toBe('awaiting_review');
  });
});
