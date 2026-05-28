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
import { QuestionRouter, RunNotRunningError, type QuestionAnswer } from '../questionRouter';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';

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
  // Case 9: recoverStaleAwaitingInput transitions awaiting_input rows to failed
  // -------------------------------------------------------------------------
  it('recoverStaleAwaitingInput transitions awaiting_input rows to failed', () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const router = QuestionRouter.initialize(adapter);

    seedRun(db, { id: 'qrun-R1', status: 'awaiting_input' });
    seedRun(db, { id: 'qrun-R2', status: 'awaiting_input' });
    seedRun(db, { id: 'qrun-R3', status: 'running' });

    const count = router.recoverStaleAwaitingInput();

    // Return value must be 2.
    expect(count).toBe(2);

    // The two awaiting_input rows are now 'failed' with error_message='app_restart'.
    const r1 = db
      .prepare("SELECT status, error_message FROM workflow_runs WHERE id = ?")
      .get('qrun-R1') as { status: string; error_message: string };
    expect(r1.status).toBe('failed');
    expect(r1.error_message).toBe('app_restart');

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
