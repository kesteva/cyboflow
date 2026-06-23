/**
 * Unit tests for QuestionRouter.
 *
 * Six cases per the test_strategy in the TASK-758 plan:
 *
 * 1. requestQuestion inserts a questions row (status='pending') and sets
 *    workflow_runs.status='awaiting_input' atomically in a single transaction
 *    (guarded by status='running').
 *
 * 2. respond writes answer_json + answered_at, transitions workflow_runs.status
 *    back to 'running' under the awaiting_input guard, and resolves the pending
 *    promise with the user's QuestionAnswer payload.
 *
 * 3. Two concurrent requestQuestion calls for the same runId are serialized by
 *    the per-run questionQueues (no overlapping transactions; serial ordering).
 *
 * 4. clearPendingForRun resolves pending entries with empty-answers payload and
 *    updates DB rows to status='timed_out'.
 *
 * 5. respond after run is canceled does NOT revive the run and still resolves
 *    the awaiting caller with a synthetic empty payload.
 *
 * All tests use an in-memory better-sqlite3 instance with migration 010 applied
 * (via includeQuestionsTable: true) and a real PQueue per runId so transaction
 * semantics and queue serialization are exercised end-to-end without spinning
 * up Electron or the MCP bridge.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuestionRouter, RunNotRunningError, type QuestionAnswer } from '../questionRouter';
import { TaskChangeRouter, taskChangeEvents } from '../taskChangeRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import type { QuestionPayload } from '../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QuestionRouter', () => {
  // Reset the singleton between tests so each test gets a clean instance.
  afterEach(() => {
    QuestionRouter._resetForTesting();
  });

  // -------------------------------------------------------------------------
  // Case 1: requestQuestion inserts questions row + updates workflow_runs
  //         inside a single transaction
  // -------------------------------------------------------------------------
  it('requestQuestion inserts questions (pending) and sets workflow_runs to awaiting_input', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const noopSocketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-001';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Which library should we use?',
        header: 'Library',
        multiSelect: false,
        options: [
          { label: 'Library A', description: 'Fast' },
          { label: 'Library B', description: 'Stable' },
        ],
      },
    ];

    // Fire requestQuestion — do NOT await the full answer; we just want the
    // transaction to have committed so we can inspect DB state.
    const questionPromise = router.requestQuestion(runId, 'tool-use-id-001', questions, noopSocketReply);

    // Wait for the per-run queue to drain.
    // QuestionRouter maintains its own questionQueues; we wait on the internal queue.
    // We can observe it via the returned promise not yet resolving + a short yield.
    await router['getQuestionQueue'](runId).onIdle();

    // --- Assert: workflow_runs updated ---
    const run = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(run.status).toBe('awaiting_input');

    // --- Assert: questions row created ---
    const question = db
      .prepare("SELECT tool_use_id, status FROM questions WHERE run_id = ?")
      .get(runId) as { tool_use_id: string; status: string } | undefined;
    expect(question).toBeDefined();
    expect(question?.tool_use_id).toBe('tool-use-id-001');
    expect(question?.status).toBe('pending');

    // Resolve the pending answer so the test can clean up.
    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    await router.respond(questionId, { answers: { 'Which library should we use?': 'Library A' } });
    await questionPromise;
  });

  // -------------------------------------------------------------------------
  // Case 2: respond writes answer_json + answered_at and transitions
  //         workflow_runs back to running — full happy path
  // -------------------------------------------------------------------------
  it('respond writes answer_json + answered_at and transitions workflow_runs back to running', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-002';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'TDD', description: 'Test-driven' },
          { label: 'BDD', description: 'Behavior-driven' },
        ],
      },
    ];
    const userAnswer: QuestionAnswer = { answers: { 'Which approach?': 'TDD' } };

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-002', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // Confirm intermediate state.
    const runMid = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runMid.status).toBe('awaiting_input');

    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // Respond with the user's answer.
    await router.respond(questionId, userAnswer);
    const resolvedAnswer = await questionPromise;

    // The returned answer must match.
    expect(resolvedAnswer.answers).toEqual({ 'Which approach?': 'TDD' });

    // socketReply must have been called exactly once with the user's answer.
    expect(socketReply).toHaveBeenCalledOnce();
    expect(socketReply.mock.calls[0][0].answers).toEqual({ 'Which approach?': 'TDD' });

    // questions row must be 'answered' with answer_json set.
    const questionRow = db
      .prepare("SELECT status, answer_json, answered_at FROM questions WHERE id = ?")
      .get(questionId) as { status: string; answer_json: string; answered_at: string | null };
    expect(questionRow.status).toBe('answered');
    expect(JSON.parse(questionRow.answer_json)).toEqual(userAnswer);
    expect(questionRow.answered_at).not.toBeNull();

    // workflow_runs must be back to 'running'.
    const runAfter = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfter.status).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Case 2b: respond with attachments folds the file paths into the answer text
  //          (<attachments> block) the agent receives, and drops the raw
  //          `attachments` field from the resolved payload.
  // -------------------------------------------------------------------------
  it('respond embeds attachment file paths into the answer text via <attachments>', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-002b';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Which approach?',
        header: 'Approach',
        multiSelect: false,
        options: [{ label: 'TDD' }, { label: 'BDD' }],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-002b', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    await router.respond(questionId, {
      answers: { 'Which approach?': 'TDD' },
      attachments: ['/abs/artifacts/qrun-002b/shot.png', '/abs/artifacts/qrun-002b/two.png'],
    });
    const resolved = await questionPromise;

    // The first answer value carries the <attachments> block with both paths.
    const answerText = resolved.answers['Which approach?'];
    expect(answerText).toContain('TDD');
    expect(answerText).toContain('<attachments>');
    expect(answerText).toContain('/abs/artifacts/qrun-002b/shot.png');
    expect(answerText).toContain('/abs/artifacts/qrun-002b/two.png');
    // The raw attachments field is not part of the resolved payload.
    expect(resolved.attachments).toBeUndefined();

    // socketReply received the same embedded answer.
    expect(socketReply.mock.calls[0][0].answers['Which approach?']).toContain('<attachments>');

    // answer_json persisted with the embedded block, no raw attachments key.
    const questionRow = db
      .prepare("SELECT answer_json FROM questions WHERE id = ?")
      .get(questionId) as { answer_json: string };
    const persisted = JSON.parse(questionRow.answer_json) as QuestionAnswer;
    expect(persisted.answers['Which approach?']).toContain('<attachments>');
    expect(persisted.attachments).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Case 3: Two concurrent requestQuestion calls for the same runId are
  //         serialized by the per-run questionQueues — ordering preserved
  // -------------------------------------------------------------------------
  it('two concurrent requestQuestion calls for the same runId are serialized by the per-run queue', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-003';
    seedRun(db, { id: runId, status: 'running' });

    const q1 = [
      {
        question: 'First question?',
        header: 'First',
        multiSelect: false,
        options: [
          { label: 'Option A', description: 'A' },
          { label: 'Option B', description: 'B' },
        ],
      },
    ];
    const q2 = [
      {
        question: 'Second question?',
        header: 'Second',
        multiSelect: false,
        options: [
          { label: 'Option C', description: 'C' },
          { label: 'Option D', description: 'D' },
        ],
      },
    ];

    // Fire both requestQuestion calls concurrently (don't await).
    // The first call transitions run to 'awaiting_input'.
    // The second call should fail with RunNotRunningError (since the first already
    // moved it out of 'running') — this is the correct serialized behavior.
    const promise1 = router.requestQuestion(runId, 'tool-use-id-003a', q1, vi.fn());
    const promise2 = router.requestQuestion(runId, 'tool-use-id-003b', q2, vi.fn());

    // Wait for both queue tasks to drain.
    await router['getQuestionQueue'](runId).onIdle();

    // Only one questions row should have been inserted (the second was blocked).
    const questionRows = db
      .prepare("SELECT id, tool_use_id FROM questions WHERE run_id = ?")
      .all(runId) as { id: string; tool_use_id: string }[];

    expect(questionRows).toHaveLength(1);
    expect(questionRows[0].tool_use_id).toBe('tool-use-id-003a');

    // Resolve the first question.
    await router.respond(questionRows[0].id, { answers: { 'First question?': 'Option A' } });
    await promise1;

    // promise2 should have rejected with RunNotRunningError.
    await expect(promise2).rejects.toBeInstanceOf(RunNotRunningError);
  });

  // -------------------------------------------------------------------------
  // Case 4: clearPendingForRun resolves pending entries with empty-answers
  //         payload and updates DB rows to status='timed_out'
  // -------------------------------------------------------------------------
  it('clearPendingForRun resolves pending entries with empty-answers payload and updates DB rows to status=timed_out', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-004';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Clear test?',
        header: 'Clear',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'yes' },
          { label: 'No', description: 'no' },
        ],
      },
    ];

    // Start a question request — do not await the answer yet.
    const questionPromise = router.requestQuestion(runId, 'tool-use-id-004', questions, socketReply);

    // Wait for the transaction to commit so the entry is in this.pending.
    await router['getQuestionQueue'](runId).onIdle();

    // Confirm the entry is in-flight.
    expect(router.getPending()).toHaveLength(1);

    // Simulate run termination.
    router.clearPendingForRun(runId);

    // The awaiting promise must resolve (not hang) with an empty-answers payload.
    const answer = await questionPromise;
    expect(answer.answers).toEqual({});

    // socketReply must NOT have been called.
    expect(socketReply.mock.calls).toHaveLength(0);

    // getPending() must be empty.
    expect(router.getPending()).toHaveLength(0);

    // DB row must be 'timed_out'.
    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    const questionRow = db
      .prepare("SELECT status FROM questions WHERE id = ?")
      .get(questionId) as { status: string };
    expect(questionRow.status).toBe('timed_out');
  });

  // -------------------------------------------------------------------------
  // Case 4b: clearPendingForRun settles a run still wedged at 'awaiting_input'
  //          to 'awaiting_review' (nudge-resumable) instead of leaving it stuck.
  // -------------------------------------------------------------------------
  it('clearPendingForRun flips a still-awaiting_input run to awaiting_review (not left wedged)', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();
    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-004b';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Approve and retire?',
        header: 'Done',
        multiSelect: false,
        options: [
          { label: 'Approve', description: 'approve' },
          { label: 'Reject', description: 'reject' },
        ],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-004b', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // requestQuestion opened the gate → run parked at 'awaiting_input'.
    const before = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string };
    expect(before.status).toBe('awaiting_input');

    // Tear the run down while the gate is open (the SDK query finally / shutdown).
    router.clearPendingForRun(runId);
    await questionPromise; // must not hang

    // The run rests in 'awaiting_review' (review queue + nudge-resumable), NOT
    // wedged at 'awaiting_input'.
    const after = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string };
    expect(after.status).toBe('awaiting_review');
  });

  // -------------------------------------------------------------------------
  // Case 4c: the awaiting_review settle is GUARDED — a run already moved to a
  //          terminal status (e.g. a concurrent cancel) is never resurrected.
  // -------------------------------------------------------------------------
  it('clearPendingForRun does NOT flip a run that already reached a terminal status', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();
    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-004c';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Approve?',
        header: 'Q',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'y' },
          { label: 'No', description: 'n' },
        ],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-004c', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // Simulate a concurrent cancel stamping the run terminal before teardown.
    db.prepare("UPDATE workflow_runs SET status = 'canceled' WHERE id = ?").run(runId);

    router.clearPendingForRun(runId);
    await questionPromise;

    const after = db
      .prepare('SELECT status FROM workflow_runs WHERE id = ?')
      .get(runId) as { status: string };
    expect(after.status).toBe('canceled');
  });

  // -------------------------------------------------------------------------
  // Case 5: respond after run is canceled does NOT revive the run and still
  //         resolves the awaiting caller with empty-answers payload
  // -------------------------------------------------------------------------
  it('respond after run is canceled does NOT revive the run and resolves awaiting caller with empty-answers payload', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-005';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Cancel test?',
        header: 'Cancel',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'yes' },
          { label: 'No', description: 'no' },
        ],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-005', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // Simulate a concurrent cancel OUTSIDE the queue.
    db.prepare(
      `UPDATE workflow_runs SET status = 'canceled', updated_at = datetime('now')
       WHERE id = ?`,
    ).run(runId);

    // Verify cancel took effect.
    const runAfterCancel = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfterCancel.status).toBe('canceled');

    // Retrieve the questionId from DB.
    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;

    // Respond — the status guard should detect changes=0 and NOT revive the run.
    await router.respond(questionId, { answers: { 'Cancel test?': 'Yes' } });

    // The promise should resolve with a synthetic empty-answers payload (not hang).
    const finalAnswer = await questionPromise;
    expect(finalAnswer.answers).toEqual({});

    // socketReply MUST NOT have been called.
    expect(socketReply.mock.calls).toHaveLength(0);

    // The run status must remain 'canceled' (NOT revived to 'running').
    const runAfterRespond = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get(runId) as { status: string };
    expect(runAfterRespond.status).toBe('canceled');

    // The questions row should be marked 'timed_out'.
    const questionRow = db
      .prepare("SELECT status FROM questions WHERE id = ?")
      .get(questionId) as { status: string };
    expect(questionRow.status).toBe('timed_out');
  });

  // -------------------------------------------------------------------------
  // Case 6: 'questionCreated' event is emitted after the transaction commits
  // -------------------------------------------------------------------------
  it("emits 'questionCreated' event after requestQuestion transaction commits", async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-006';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Event test?',
        header: 'Event',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'yes' },
          { label: 'No', description: 'no' },
        ],
      },
    ];

    const emittedRequests: unknown[] = [];
    router.on('questionCreated', (req) => { emittedRequests.push(req); });

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-006', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // One event should have fired after the transaction committed.
    expect(emittedRequests).toHaveLength(1);
    const emitted = emittedRequests[0] as { runId: string; toolUseId: string };
    expect(emitted.runId).toBe(runId);
    expect(emitted.toolUseId).toBe('tool-use-id-006');

    // Clean up.
    const questionId = (db
      .prepare("SELECT id FROM questions WHERE run_id = ?")
      .get(runId) as { id: string }).id;
    await router.respond(questionId, { answers: { 'Event test?': 'Yes' } });
    await questionPromise;
  });

  // -------------------------------------------------------------------------
  // Case 7: getPending() reflects in-flight questions and clears after respond
  // -------------------------------------------------------------------------
  it('getPending returns in-flight questions and is empty after respond', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();

    const router = QuestionRouter.initialize(adapter);

    const runId = 'qrun-007';
    seedRun(db, { id: runId, status: 'running' });

    // Before any request, pending list is empty.
    expect(router.getPending()).toHaveLength(0);

    const questions = [
      {
        question: 'Pending test?',
        header: 'Pending',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'yes' },
          { label: 'No', description: 'no' },
        ],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-007', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    // After transaction commits, one entry should be visible.
    const pending = router.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].runId).toBe(runId);
    expect(pending[0].toolUseId).toBe('tool-use-id-007');

    // After respond, the entry must be removed.
    await router.respond(pending[0].id, { answers: {} });
    await questionPromise;

    expect(router.getPending()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Case 8: clearPendingForRun swallows a DB error and still resolves the
  //         pending promise with empty-answers payload
  // -------------------------------------------------------------------------
  it('clearPendingForRun swallows a DB error and still resolves the pending promise with empty-answers payload', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const socketReply = vi.fn<(answer: QuestionAnswer) => void>();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Inject a DB adapter whose prepare() throws for UPDATE questions statements
    // but delegates everything else to the real DB so requestQuestion can seed
    // the entry normally.
    const faultyAdapter = {
      prepare(sql: string) {
        // Throw only on the guarded UPDATE issued by clearPendingForRun.
        if (
          sql.includes("SET status = 'timed_out'") &&
          sql.includes("AND status = 'pending'")
        ) {
          throw new Error('simulated DB failure in clearPendingForRun');
        }
        return db.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
    };

    const router = QuestionRouter.initialize(faultyAdapter);

    const runId = 'qrun-008';
    seedRun(db, { id: runId, status: 'running' });

    const questions = [
      {
        question: 'Error test?',
        header: 'Error',
        multiSelect: false,
        options: [
          { label: 'Yes', description: 'yes' },
          { label: 'No', description: 'no' },
        ],
      },
    ];

    const questionPromise = router.requestQuestion(runId, 'tool-use-id-008', questions, socketReply);
    await router['getQuestionQueue'](runId).onIdle();

    expect(router.getPending()).toHaveLength(1);

    // clearPendingForRun must not throw even though the DB call throws.
    expect(() => router.clearPendingForRun(runId)).not.toThrow();

    // The question promise must still resolve with empty-answers (not hang, not reject).
    const answer = await questionPromise;
    expect(answer.answers).toEqual({});

    // The entry must have been removed from pending despite the DB error.
    expect(router.getPending()).toHaveLength(0);

    // socketReply must NOT have been called.
    expect(socketReply.mock.calls).toHaveLength(0);

    // console.warn must have been called (DB error swallowed).
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 9: recoverStaleAwaitingInput rests resumable runs in awaiting_review
  //         (reopenable) and fails ONLY sessionless ones.
  // -------------------------------------------------------------------------
  it('recoverStaleAwaitingInput rests resumable runs in awaiting_review and fails only sessionless ones', () => {
    // includeWorkflowRunTaskColumns adds claude_session_id (migration 018) — the
    // resumability signal the recovery now keys on.
    const db = createTestDb({ includeQuestionsTable: true, includeWorkflowRunTaskColumns: true });
    const adapter = dbAdapter(db);
    const router = QuestionRouter.initialize(adapter);

    seedRun(db, { id: 'qrun-R1', status: 'awaiting_input' }); // resumable (captured a session)
    seedRun(db, { id: 'qrun-R2', status: 'awaiting_input' }); // sessionless
    seedRun(db, { id: 'qrun-R3', status: 'running' });        // untouched
    // R1 was mid-gate when the app quit but captured an SDK conversation id, so
    // it can be re-opened via --resume.
    db.prepare("UPDATE workflow_runs SET claude_session_id = 'sess-abc' WHERE id = ?").run('qrun-R1');

    const count = router.recoverStaleAwaitingInput();

    // Both awaiting_input rows were recovered (the running one was not).
    expect(count).toBe(2);

    // R1 is reopenable: rests in awaiting_review (NOT failed), session preserved.
    const r1 = db
      .prepare("SELECT status, error_message, claude_session_id FROM workflow_runs WHERE id = ?")
      .get('qrun-R1') as { status: string; error_message: string | null; claude_session_id: string | null };
    expect(r1.status).toBe('awaiting_review');
    expect(r1.error_message).toBeNull();
    expect(r1.claude_session_id).toBe('sess-abc');

    // R2 had no captured session → genuinely unresumable → failed.
    const r2 = db
      .prepare("SELECT status, error_message FROM workflow_runs WHERE id = ?")
      .get('qrun-R2') as { status: string; error_message: string };
    expect(r2.status).toBe('failed');
    expect(r2.error_message).toBe('app_restart');

    // The running row is unchanged.
    const r3 = db
      .prepare("SELECT status FROM workflow_runs WHERE id = ?")
      .get('qrun-R3') as { status: string };
    expect(r3.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// FIX-STAGE-MODEL (D): answering the approve-plan gate with Approve flips the
// tasks the run CREATED (entity_events kind='created', run_id=<run>) to Ready
// for development (position 6). Ownership is derived from the created-event
// projection (listRunCreatedTaskIds), NOT seed_idea_id / originating_idea_id —
// the agent never stamps those. Backend-deterministic + idempotent; Revise/
// Reject is a no-op.
// ---------------------------------------------------------------------------

describe('QuestionRouter approve-plan promotes tasks to Ready for development (FIX-STAGE-MODEL D)', () => {
  // Full migration chain (006/007/010/011/014/015/016/017) so QuestionRouter can
  // reach awaiting_input AND the entity tables + seed_idea_id exist.
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
    const migDir = join(__dirname, '..', '..', 'database', 'migrations');
    db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '007_add_stuck_reason.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '010_questions.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
    return db;
  }

  function stageId(position: number): string {
    return `stage-board-1-default-${position}`;
  }

  function seedPlannerRun(
    db: Database.Database,
    opts: { runId: string; currentStepId: string; seedIdeaId: string | null },
  ): void {
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-p', 1, 'planner', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, seed_idea_id)
       VALUES (?, 'wf-p', 1, 'running', ?, ?)`,
    ).run(opts.runId, opts.currentStepId, opts.seedIdeaId);
  }

  const PLAN_QUESTIONS: QuestionPayload[] = [
    {
      question: 'Approve the plan?',
      header: 'Approve plan',
      multiSelect: false,
      options: [{ label: 'Approve' }, { label: 'Revise' }],
    },
  ];

  afterEach(() => {
    QuestionRouter._resetForTesting();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  /**
   * Append a run-attributed `created` entity_event for an entity so the
   * created-event projection (listRunCreatedTaskIds / listRunOwnedIdeaIds) links
   * it to `runId`. The chokepoint already wrote a seq-1 `created` row with
   * run_id=NULL; this adds a second `created` row (next seq) carrying the run id,
   * mirroring how the agent would attribute creates during a real run.
   */
  function markCreatedByRun(
    db: Database.Database,
    entityType: 'idea' | 'task',
    entityId: string,
    runId: string,
  ): void {
    const maxRow = db
      .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    db.prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
       VALUES (?, ?, ?, 'created', 'agent:planner', ?, '[]', ?)`,
    ).run(entityType, entityId, seq, runId, new Date().toISOString());
  }

  /**
   * Seed an idea + N tasks originating from it through the chokepoint, then
   * settle the auto-decompose follow-on. When `runId` is provided, every created
   * entity is attributed to that run via a `created` entity_event so the
   * created-event ownership projection resolves them. Returns the idea id + task ids.
   */
  async function seedIdeaWithTasks(
    db: Database.Database,
    taskRouter: TaskChangeRouter,
    count: number,
    runId?: string,
  ): Promise<{ ideaId: string; taskIds: string[] }> {
    const idea = await taskRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Seed idea' });
    const taskIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = await taskRouter.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: `Task ${i}`,
        originatingIdeaId: idea.taskId,
      });
      taskIds.push(t.taskId);
    }
    await taskRouter._queueForProject(1).onIdle();
    if (runId) {
      markCreatedByRun(db, 'idea', idea.taskId, runId);
      for (const id of taskIds) markCreatedByRun(db, 'task', id, runId);
    }
    return { ideaId: idea.taskId, taskIds };
  }

  async function answerPlanGate(
    db: Database.Database,
    router: QuestionRouter,
    runId: string,
    chosen: string,
  ): Promise<void> {
    const questionPromise = router.requestQuestion(runId, `tu-${runId}-${Math.random().toString(36).slice(2)}`, PLAN_QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();
    // Select the NEWEST pending question (a re-answer leaves the prior, already
    // 'answered' row behind, so a bare WHERE run_id could pick the stale one).
    const questionId = (
      db
        .prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(runId) as { id: string }
    ).id;
    await router.respond(questionId, { answers: { 'Approve the plan?': chosen } });
    await questionPromise;
    // Settle the TaskChangeRouter follow-on promotions.
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();
  }

  it('Approve on approve-plan moves all originating tasks to Ready for development (position 6)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // Seed the run FIRST so the run-attributed `created` entity_events satisfy
    // the entity_events.run_id FK (foreign_keys=ON).
    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { taskIds } = await seedIdeaWithTasks(db, taskRouter, 2, 'run-p');
    // Tasks created at Tasks extracted (position 5).
    for (const id of taskIds) {
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(5),
      );
    }

    await answerPlanGate(db, router, 'run-p', 'Approve');

    for (const id of taskIds) {
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    }
    // The promotion is orchestrator-attributed.
    const ev = db
      .prepare("SELECT actor, kind FROM entity_events WHERE entity_type = 'task' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(taskIds[0]) as { actor: string; kind: string };
    expect(ev.actor).toBe('orchestrator');
    expect(ev.kind).toBe('plan-approved');
  });

  it('Revise on approve-plan does NOT promote the tasks', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { taskIds } = await seedIdeaWithTasks(db, taskRouter, 2, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Revise');

    for (const id of taskIds) {
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(5),
      );
    }
  });

  it('Approve on a NON-approve-plan step does NOT promote the tasks', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // current_step_id is the EARLIER approve-idea gate, not approve-plan.
    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-idea', seedIdeaId: null });
    const { taskIds } = await seedIdeaWithTasks(db, taskRouter, 1, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Approve');

    expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskIds[0]) as { stage_id: string }).stage_id).toBe(
      stageId(5),
    );
  });

  it('is idempotent: a re-answer at approve-plan does not double-bump already-promoted tasks', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { taskIds } = await seedIdeaWithTasks(db, taskRouter, 1, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Approve');

    const versionAfterFirst = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskIds[0]) as { version: number })
      .version;

    // The run is back to 'running'; answer a second approve-plan gate. The task is
    // already at position 6, so the chokepoint no-op delta leaves version unchanged.
    await answerPlanGate(db, router, 'run-p', 'Approve');
    const versionAfterSecond = (db.prepare('SELECT version FROM tasks WHERE id = ?').get(taskIds[0]) as { version: number })
      .version;
    expect(versionAfterSecond).toBe(versionAfterFirst);
    expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(taskIds[0]) as { stage_id: string }).stage_id).toBe(
      stageId(6),
    );
  });
});

// ---------------------------------------------------------------------------
// FIX-STAGE-MODEL (decompose): the planner's separate FINAL gate. Answering at
// the `decompose` step COMPLETES the run; choosing Archive first retires the
// run's owned ideas to the terminal Decomposed stage (position 12). The
// completion is held back while a blocking review_item is still pending.
// ---------------------------------------------------------------------------

describe('QuestionRouter decompose gate finalizes the planner run (FIX-STAGE-MODEL decompose)', () => {
  // Same migration chain as the approve-plan block so the entity tables +
  // seed_idea_id + review_items all exist.
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
    const migDir = join(__dirname, '..', '..', 'database', 'migrations');
    db.exec(readFileSync(join(migDir, '006_cyboflow_schema.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '007_add_stuck_reason.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '010_questions.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '011_workflow_step_tracking.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '014_native_tasks.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '015_entity_model_rebuild.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '016_review_items.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '017_run_seed_idea.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '024_archive_in_place.sql'), 'utf-8'));
    db.exec(readFileSync(join(migDir, '028_idea_attachments.sql'), 'utf-8'));
    return db;
  }

  function stageId(position: number): string {
    return `stage-board-1-default-${position}`;
  }

  function seedPlannerRun(
    db: Database.Database,
    opts: { runId: string; currentStepId: string },
  ): void {
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-p', 1, 'planner', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id)
       VALUES (?, 'wf-p', 1, 'running', ?)`,
    ).run(opts.runId, opts.currentStepId);
  }

  /**
   * Append a run-attributed `created` entity_event so the created-event
   * ownership projection (listRunOwnedIdeaIds) links the idea to `runId`.
   */
  function markCreatedByRun(
    db: Database.Database,
    entityType: 'idea' | 'task',
    entityId: string,
    runId: string,
  ): void {
    const maxRow = db
      .prepare('SELECT MAX(seq) AS maxSeq FROM entity_events WHERE entity_type = ? AND entity_id = ?')
      .get(entityType, entityId) as { maxSeq: number | null };
    const seq = (maxRow.maxSeq ?? 0) + 1;
    db.prepare(
      `INSERT INTO entity_events (entity_type, entity_id, seq, kind, actor, run_id, changes_json, created_at)
       VALUES (?, ?, ?, 'created', 'agent:planner', ?, '[]', ?)`,
    ).run(entityType, entityId, seq, runId, new Date().toISOString());
  }

  /** Seed a pending blocking finding review_item for the run. */
  function seedBlockingFinding(db: Database.Database, runId: string): void {
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
          title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
       VALUES (?, 1, ?, NULL, NULL, 'finding', 'pending', 1, 'Blocking finding', NULL, 'warning', 'test', NULL,
               CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)`,
    ).run(`rvw_block_${Math.random().toString(36).slice(2)}`, runId);
  }

  const DECOMPOSE_QUESTIONS: QuestionPayload[] = [
    {
      question: 'Finish the planner run?',
      header: 'Finish',
      multiSelect: false,
      options: [{ label: 'Archive & finish' }, { label: 'Keep ideas & finish' }],
    },
  ];

  afterEach(() => {
    QuestionRouter._resetForTesting();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  /** Seed an idea via the chokepoint and attribute it to the run. Returns the idea id. */
  async function seedOwnedIdea(
    db: Database.Database,
    taskRouter: TaskChangeRouter,
    runId: string,
  ): Promise<string> {
    const idea = await taskRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Owned idea' });
    await taskRouter._queueForProject(1).onIdle();
    markCreatedByRun(db, 'idea', idea.taskId, runId);
    return idea.taskId;
  }

  async function answerDecomposeGate(
    db: Database.Database,
    router: QuestionRouter,
    runId: string,
    chosen: string,
  ): Promise<void> {
    const questionPromise = router.requestQuestion(
      runId,
      `tu-${runId}-${Math.random().toString(36).slice(2)}`,
      DECOMPOSE_QUESTIONS,
      vi.fn(),
    );
    await router['getQuestionQueue'](runId).onIdle();
    const questionId = (
      db
        .prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(runId) as { id: string }
    ).id;
    await router.respond(questionId, { answers: { 'Finish the planner run?': chosen } });
    await questionPromise;
    // Settle any TaskChangeRouter follow-on (idea moves).
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();
  }

  it('Archive on decompose retires owned ideas to Decomposed (position 12) and completes the run', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-d', currentStepId: 'decompose' });
    const ideaA = await seedOwnedIdea(db, taskRouter, 'run-d');
    const ideaB = await seedOwnedIdea(db, taskRouter, 'run-d');
    // Ideas start at Idea (position 1).
    for (const id of [ideaA, ideaB]) {
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(1),
      );
    }

    await answerDecomposeGate(db, router, 'run-d', 'Archive & finish');

    for (const id of [ideaA, ideaB]) {
      expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(12),
      );
    }
    // The idea retirement is orchestrator-attributed.
    const ev = db
      .prepare("SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(ideaA) as { actor: string; kind: string };
    expect(ev.actor).toBe('orchestrator');
    expect(ev.kind).toBe('decomposed');

    // The run is completed.
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-d') as { status: string }).status).toBe(
      'completed',
    );
  });

  it('Keep on decompose completes the run WITHOUT moving the ideas', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-d', currentStepId: 'decompose' });
    const ideaA = await seedOwnedIdea(db, taskRouter, 'run-d');

    await answerDecomposeGate(db, router, 'run-d', 'Keep ideas & finish');

    // The idea stays where it was (position 1) — NOT retired.
    expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaA) as { stage_id: string }).stage_id).toBe(
      stageId(1),
    );
    // The run still completes.
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-d') as { status: string }).status).toBe(
      'completed',
    );
  });

  it('answering on a NON-decompose step does NOT complete the run', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // current_step_id is an earlier gate, not decompose.
    seedPlannerRun(db, { runId: 'run-d', currentStepId: 'approve-idea' });
    const ideaA = await seedOwnedIdea(db, taskRouter, 'run-d');

    await answerDecomposeGate(db, router, 'run-d', 'Archive & finish');

    // Not completed — respond() flipped it back to 'running' and finalize is a no-op.
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-d') as { status: string }).status).toBe(
      'running',
    );
    // The idea is untouched.
    expect((db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaA) as { stage_id: string }).stage_id).toBe(
      stageId(1),
    );
  });

  it('does NOT complete the run while a blocking review_item is still pending', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-d', currentStepId: 'decompose' });
    await seedOwnedIdea(db, taskRouter, 'run-d');
    // A separate blocking finding stays pending even after the decision gate resolves.
    seedBlockingFinding(db, 'run-d');

    await answerDecomposeGate(db, router, 'run-d', 'Keep ideas & finish');

    // The aggregate-unblock gate holds the run open (back at 'running' after respond()).
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get('run-d') as { status: string }).status).toBe(
      'running',
    );
  });
});
