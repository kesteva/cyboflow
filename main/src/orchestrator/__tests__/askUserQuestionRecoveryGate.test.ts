/**
 * Durable AskUserQuestion recovery gate — the fallback that keeps a human gate
 * alive when its SDK session ends before the human answers.
 *
 * Covers:
 *   - buildAskUserQuestionRecoveryGate (pure shape).
 *   - QuestionRouter.clearPendingForRun({ preserveGates }) — on SDK-session
 *     EXPIRY it mints a blocking `decision` recovery item carrying the original
 *     questions (so the run stays out of "complete" and is resumable); on a
 *     CANCEL (default) it does NOT.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { QuestionRouter } from '../questionRouter';
import {
  buildAskUserQuestionRecoveryGate,
  ASK_USER_QUESTION_RECOVERY_SOURCE,
  countPendingBlockingReviewItems,
} from '../reviewItemListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { buildReviewInboxDb, seedInboxRun } from '../__test_fixtures__/reviewInboxTestDb';
import type { QuestionPayload } from '../../../../shared/types/questions';

afterEach(() => {
  QuestionRouter._resetForTesting?.();
});

const QUESTIONS: QuestionPayload[] = [
  {
    question: 'Approve the plan?',
    header: 'Approve',
    multiSelect: false,
    options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Reject' }],
  },
];

function recoveryItems(db: ReturnType<typeof buildReviewInboxDb>, runId: string) {
  return db
    .prepare(
      `SELECT id, kind, status, blocking, title, source, payload_json AS payloadJson
         FROM review_items WHERE run_id = ? AND source = ?`,
    )
    .all(runId, ASK_USER_QUESTION_RECOVERY_SOURCE) as Array<{
    id: string;
    kind: string;
    status: string;
    blocking: number;
    title: string;
    source: string;
    payloadJson: string | null;
  }>;
}

describe('buildAskUserQuestionRecoveryGate', () => {
  it('builds a blocking-decision co-write carrying the recovered questions', () => {
    const args = buildAskUserQuestionRecoveryGate('run-1', QUESTIONS, '2026-07-07T00:00:00.000Z');
    expect(args.source).toBe(ASK_USER_QUESTION_RECOVERY_SOURCE);
    expect(args.title).toContain('Approve the plan?');
    expect(args.payload?.kind).toBe('decision');
    expect(args.payload?.gate).toBe('ask-user-question-recovery');
    expect(args.payload?.recoveredQuestions).toEqual(QUESTIONS);
  });

  it('falls back to a generic title when there are no questions', () => {
    const args = buildAskUserQuestionRecoveryGate('run-1', [], '2026-07-07T00:00:00.000Z');
    expect(args.title).toMatch(/answer to continue/i);
    expect(args.payload?.recoveredQuestions).toEqual([]);
  });
});

describe('QuestionRouter.clearPendingForRun preserveGates (SDK-session expiry)', () => {
  it('mints a durable blocking recovery gate when the session expires with a gate pending', async () => {
    const db = buildReviewInboxDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = seedInboxRun(db, 'rg-run-1', 'running');

    const p = router.requestQuestion(runId, 'tu-1', QUESTIONS, () => {});
    await router['getQuestionQueue'](runId).onIdle();

    // Simulate SDK-session expiry teardown (clean drain, NOT a cancel).
    router.clearPendingForRun(runId, { preserveGates: true });
    await p; // the awaiting hook promise resolves (empty answer) — never hangs.

    const items = recoveryItems(db, runId);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('decision');
    expect(items[0].status).toBe('pending');
    expect(items[0].blocking).toBe(1);
    // Carries the original options so the review UI can re-offer them.
    const payload = JSON.parse(items[0].payloadJson ?? '{}');
    expect(payload.recoveredQuestions).toEqual(QUESTIONS);
    // The run is now BLOCKED by the recovery gate → not end-eligible ("complete").
    expect(countPendingBlockingReviewItems(db, runId)).toBe(1);
    // The dead in-band question row is timed out (re-homed into the recovery gate).
    const q = db.prepare('SELECT status FROM questions WHERE run_id = ?').get(runId) as { status: string };
    expect(q.status).toBe('timed_out');
  });

  it('does NOT mint a recovery gate on a cancel (preserveGates default false)', async () => {
    const db = buildReviewInboxDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = seedInboxRun(db, 'rg-run-2', 'running');

    const p = router.requestQuestion(runId, 'tu-2', QUESTIONS, () => {});
    await router['getQuestionQueue'](runId).onIdle();

    router.clearPendingForRun(runId); // cancel — no preserveGates
    await p;

    expect(recoveryItems(db, runId)).toHaveLength(0);
    expect(countPendingBlockingReviewItems(db, runId)).toBe(0);
  });

  it('does NOT mint a recovery gate when no gate was pending at teardown', async () => {
    const db = buildReviewInboxDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const runId = seedInboxRun(db, 'rg-run-3', 'running');

    // No requestQuestion — nothing pending.
    router.clearPendingForRun(runId, { preserveGates: true });

    expect(recoveryItems(db, runId)).toHaveLength(0);
  });
});
