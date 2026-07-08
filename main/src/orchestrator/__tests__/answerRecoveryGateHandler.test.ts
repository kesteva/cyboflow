/**
 * answerRecoveryGateHandler — resume-first / resolve-only-on-delivered ordering.
 *
 * Adversarial-review regression (2026-07-08): a refused resume must NOT resolve
 * the gate, or the human's answer is lost with no gate to retry. These tests pin
 * that the gate is resolved ONLY on `delivered`, and left pending on every
 * nudge no-op (no_session / not_idle / race / execute_failed / blocked).
 */
import { describe, it, expect, vi } from 'vitest';
import { answerRecoveryGateHandler } from '../answerRecoveryGateHandler';
import { ASK_USER_QUESTION_RECOVERY_SOURCE } from '../reviewItemListing';
import type { NudgeRunResult } from '../nudgeRunHandler';
import { buildReviewInboxDb, seedInboxRun, seedBlockingReviewItem } from '../__test_fixtures__/reviewInboxTestDb';

function setup(opts: { source?: string; status?: 'pending' | 'resolved'; runId?: string | null } = {}) {
  const db = buildReviewInboxDb();
  const runId = seedInboxRun(db, 'arg-run-1', 'awaiting_review');
  const reviewItemId = seedBlockingReviewItem(db, {
    id: 'rvw_rec',
    runId: opts.runId === null ? (null as unknown as string) : runId,
    kind: 'decision',
    status: opts.status ?? 'pending',
    source: opts.source ?? ASK_USER_QUESTION_RECOVERY_SOURCE,
  });
  return { db, runId, reviewItemId };
}

const resolveReviewItem = vi.fn().mockResolvedValue(undefined);

function makeDeps(db: ReturnType<typeof buildReviewInboxDb>, nudge: (r: string, t: string, o: { ignoreBlockingReviewItemId: string }) => Promise<NudgeRunResult>) {
  return { db, nudge: vi.fn(nudge), resolveReviewItem };
}

describe('answerRecoveryGateHandler', () => {
  it('resumes FIRST (ignoring this gate) and resolves ONLY on delivered', async () => {
    resolveReviewItem.mockClear();
    const { db, reviewItemId } = setup();
    const deps = makeDeps(db, async () => ({ delivered: true }));

    const res = await answerRecoveryGateHandler(1, reviewItemId, 'Approve', deps);

    expect(res.resolved).toBe(true);
    // Nudge was asked to ignore THIS gate's own blocking row.
    expect(deps.nudge).toHaveBeenCalledWith('arg-run-1', 'Approve', { ignoreBlockingReviewItemId: reviewItemId });
    expect(resolveReviewItem).toHaveBeenCalledWith(1, reviewItemId, 'Approve');
  });

  it.each(['no_session', 'not_idle', 'race', 'execute_failed', 'blocked'] as const)(
    'does NOT resolve the gate when the resume no-ops with %s (answer preserved)',
    async (reason) => {
      resolveReviewItem.mockClear();
      const { db, reviewItemId } = setup();
      const deps = makeDeps(db, async () => ({ noOp: true, reason }));

      const res = await answerRecoveryGateHandler(1, reviewItemId, 'Approve', deps);

      expect(res.resolved).toBe(false);
      expect(res.nudge).toEqual({ noOp: true, reason });
      // The gate is NOT cleared — it stays pending for retry.
      expect(resolveReviewItem).not.toHaveBeenCalled();
      const row = db.prepare('SELECT status FROM review_items WHERE id = ?').get(reviewItemId) as { status: string };
      expect(row.status).toBe('pending');
    },
  );

  it('no-ops without touching the run for a non-recovery item', async () => {
    resolveReviewItem.mockClear();
    const { db, reviewItemId } = setup({ source: 'question' });
    const deps = makeDeps(db, async () => ({ delivered: true }));

    const res = await answerRecoveryGateHandler(1, reviewItemId, 'Approve', deps);

    expect(res).toEqual({ resolved: false, nudge: { noOp: true, reason: 'not_found' } });
    expect(deps.nudge).not.toHaveBeenCalled();
    expect(resolveReviewItem).not.toHaveBeenCalled();
  });

  it('no-ops for an already-resolved gate (idempotent double-answer)', async () => {
    resolveReviewItem.mockClear();
    const { db, reviewItemId } = setup({ status: 'resolved' });
    const deps = makeDeps(db, async () => ({ delivered: true }));

    const res = await answerRecoveryGateHandler(1, reviewItemId, 'Approve', deps);

    expect(res.resolved).toBe(false);
    expect(deps.nudge).not.toHaveBeenCalled();
  });
});
