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
import { TaskChangeRouter, taskChangeEvents, taskProjectChannel } from '../taskChangeRouter';
import type { TaskChangedEvent } from '../../../../shared/types/tasks';
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
  //         serialized by the per-run questionQueues — the first opens the gate
  //         and the second SUPERSEDES it (supersede-and-reopen), rather than
  //         throwing. (Before the self-heal fix the second threw
  //         RunNotRunningError because the run had already left 'running'; that
  //         is the exact wedge the fix removes — see the self-heal describe block.)
  // -------------------------------------------------------------------------
  it('two concurrent requestQuestion calls for the same runId are serialized, second supersedes the first', async () => {
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
    // Serialized by the per-run queue: the first transitions the run to
    // 'awaiting_input'; the second runs after it commits, finds the run already
    // awaiting_input, and self-heals — superseding the first gate and opening its own.
    const socket1 = vi.fn<(a: QuestionAnswer) => void>();
    const promise1 = router.requestQuestion(runId, 'tool-use-id-003a', q1, socket1);
    const promise2 = router.requestQuestion(runId, 'tool-use-id-003b', q2, vi.fn());

    // Wait for both queue tasks to drain.
    await router['getQuestionQueue'](runId).onIdle();

    // The first gate's awaiting caller is resolved with a synthetic empty answer
    // (never its socketReply), and its question row is superseded (timed_out).
    const answer1 = await promise1;
    expect(answer1.answers).toEqual({});
    expect(socket1).not.toHaveBeenCalled();

    const rowsByTool = new Map(
      (db.prepare('SELECT id, tool_use_id, status FROM questions WHERE run_id = ?').all(runId) as {
        id: string;
        tool_use_id: string;
        status: string;
      }[]).map((r) => [r.tool_use_id, r]),
    );
    expect(rowsByTool.get('tool-use-id-003a')?.status).toBe('timed_out');
    expect(rowsByTool.get('tool-use-id-003b')?.status).toBe('pending');

    // The run is still parked at awaiting_input under the live (second) gate.
    expect((db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status).toBe(
      'awaiting_input',
    );

    // Answering the second (live) gate resolves it and returns the run to running.
    const secondId = rowsByTool.get('tool-use-id-003b')!.id;
    await router.respond(secondId, { answers: { 'Second question?': 'Option C' } });
    const answer2 = await promise2;
    expect(answer2.answers).toEqual({ 'Second question?': 'Option C' });
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

    seedRun(db, { id: 'qrun-R1', status: 'awaiting_input' }); // resumable + fresh
    seedRun(db, { id: 'qrun-R2', status: 'awaiting_input' }); // sessionless
    seedRun(db, { id: 'qrun-R3', status: 'running' });        // untouched
    seedRun(db, { id: 'qrun-R4', status: 'awaiting_input' }); // resumable but STALE
    // R1 was mid-gate when the app quit but captured an SDK conversation id, so
    // it can be re-opened via --resume.
    db.prepare("UPDATE workflow_runs SET claude_session_id = 'sess-abc' WHERE id = ?").run('qrun-R1');
    // R4 also has a session but was last touched long ago → past the age cap.
    db.prepare("UPDATE workflow_runs SET claude_session_id = 'sess-old', updated_at = datetime('now','-30 days') WHERE id = ?").run('qrun-R4');

    const count = router.recoverStaleAwaitingInput();

    // All three awaiting_input rows were recovered (the running one was not).
    expect(count).toBe(3);

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

    // R4 has a session but is past the age cap → failed (review queue stays lean).
    const r4 = db
      .prepare("SELECT status, error_message FROM workflow_runs WHERE id = ?")
      .get('qrun-R4') as { status: string; error_message: string };
    expect(r4.status).toBe('failed');
    expect(r4.error_message).toBe('app_restart');
  });
});

// ---------------------------------------------------------------------------
// Boot recovery re-homes an unanswered gate into a durable recovery item
// (adversarial-review regression): a crash / force-quit / update-restart while a
// human question is open must NOT drop the answerable card. The in-memory pending
// map is gone after a restart, so recoverStaleAwaitingInput reads the persisted
// questions_json and mints an ask-user-question-recovery gate for RESUMABLE runs.
// ---------------------------------------------------------------------------

describe('QuestionRouter boot recovery mints durable recovery gates', () => {
  // Full chain THROUGH migration 016 (review_items) so coWriteDecisionReviewItem
  // can mint the gate; + claude_session_id (migration 018) for the resumability key.
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
    db.exec('ALTER TABLE workflow_runs ADD COLUMN claude_session_id TEXT');
    return db;
  }

  function seedParkedRun(
    db: Database.Database,
    opts: { runId: string; sessionId: string | null; questionsJson: string },
  ): void {
    db.prepare(`INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-b', 1, 'ship', '{}')`).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, claude_session_id, updated_at)
       VALUES (?, 'wf-b', 1, 'awaiting_input', ?, CURRENT_TIMESTAMP)`,
    ).run(opts.runId, opts.sessionId);
    db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    ).run(`q-${opts.runId}`, opts.runId, `tu-${opts.runId}`, opts.questionsJson);
  }

  afterEach(() => QuestionRouter._resetForTesting());

  it('re-homes a RESUMABLE run\'s open question into a blocking recovery gate carrying its options', () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    const questions = [
      { question: 'Ship it?', header: 'Ship', multiSelect: false, options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Reject' }] },
    ];
    seedParkedRun(db, { runId: 'brun-1', sessionId: 'sess-live', questionsJson: JSON.stringify(questions) });

    router.recoverStaleAwaitingInput();

    // The run rests resumable, and the dead in-session question is timed out.
    const run = db.prepare("SELECT status FROM workflow_runs WHERE id = 'brun-1'").get() as { status: string };
    expect(run.status).toBe('awaiting_review');
    const q = db.prepare("SELECT status FROM questions WHERE id = 'q-brun-1'").get() as { status: string };
    expect(q.status).toBe('timed_out');
    // A NEW durable blocking recovery gate carries the ORIGINAL options so the
    // answerable card survives the restart.
    const gate = db
      .prepare(
        "SELECT kind, blocking, status, payload_json AS payloadJson FROM review_items WHERE run_id = 'brun-1' AND source = 'gate:ask-user-question-recovery'",
      )
      .get() as { kind: string; blocking: number; status: string; payloadJson: string } | undefined;
    expect(gate).toBeDefined();
    expect(gate?.kind).toBe('decision');
    expect(gate?.blocking).toBe(1);
    expect(gate?.status).toBe('pending');
    const payload = JSON.parse(gate!.payloadJson) as { gate: string; recoveredQuestions: QuestionPayload[] };
    expect(payload.gate).toBe('ask-user-question-recovery');
    expect(payload.recoveredQuestions[0].options.map((o) => o.label)).toEqual(['Approve', 'Revise', 'Reject']);
  });

  it('does NOT mint a recovery gate for a sessionless (failed) run', () => {
    const db = buildDb();
    const router = QuestionRouter.initialize(dbAdapter(db));
    seedParkedRun(db, { runId: 'brun-2', sessionId: null, questionsJson: '[]' });

    router.recoverStaleAwaitingInput();

    const run = db.prepare("SELECT status FROM workflow_runs WHERE id = 'brun-2'").get() as { status: string };
    expect(run.status).toBe('failed');
    const gate = db
      .prepare("SELECT id FROM review_items WHERE run_id = 'brun-2' AND source = 'gate:ask-user-question-recovery'")
      .get();
    expect(gate).toBeUndefined();
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
    // Migration 042 adds the decompose/approval stamps (the columns the router
    // now reads) AND collapses the board. The board collapse (stage deletes) is
    // exercised in migration036.test.ts; here we only add the columns so the
    // 12-stage board's positions stay available for these stage assertions.
    db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
    db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
    // migration 046/047: experiment tag on runs + entity tables (reveal suppression).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
    for (const t of ['ideas', 'epics', 'tasks']) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
      db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
    }
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
   * Seed an idea + one epic + N tasks UNDER the plan-gated run (every create
   * carries `runId`). Two effects matter for the Q1 reveal:
   *  - the chokepoint stamps run_id onto each `created` entity_event, so the
   *    ownership projection (listRunCreatedTaskIds / listRunCreatedEpicIds)
   *    resolves them, and
   *  - the create-side Q1 guard mints the epic + tasks PENDING (approved_at NULL)
   *    because the planner run's plan is not yet approved — exactly the state the
   *    approve-plan gate must reveal.
   * Returns the idea/epic/task ids.
   */
  async function seedRunEntities(
    taskRouter: TaskChangeRouter,
    count: number,
    runId: string,
  ): Promise<{ ideaId: string; epicId: string; taskIds: string[] }> {
    const idea = await taskRouter.applyChange(1, {
      actor: 'user',
      entityType: 'idea',
      title: 'Seed idea',
      runId,
    });
    const epic = await taskRouter.applyChange(1, {
      actor: 'user',
      entityType: 'epic',
      title: 'Seed epic',
      originatingIdeaId: idea.taskId,
      runId,
    });
    const taskIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const t = await taskRouter.applyChange(1, {
        actor: 'user',
        entityType: 'task',
        title: `Task ${i}`,
        originatingIdeaId: idea.taskId,
        runId,
      });
      taskIds.push(t.taskId);
    }
    await taskRouter._queueForProject(1).onIdle();
    return { ideaId: idea.taskId, epicId: epic.taskId, taskIds };
  }

  function taskApprovedAt(db: Database.Database, taskId: string): string | null {
    return (db.prepare('SELECT approved_at FROM tasks WHERE id = ?').get(taskId) as { approved_at: string | null })
      .approved_at;
  }
  function epicApprovedAt(db: Database.Database, epicId: string): string | null {
    return (db.prepare('SELECT approved_at FROM epics WHERE id = ?').get(epicId) as { approved_at: string | null })
      .approved_at;
  }
  function planApprovedAt(db: Database.Database, runId: string): string | null {
    return (
      db.prepare('SELECT plan_approved_at FROM workflow_runs WHERE id = ?').get(runId) as {
        plan_approved_at: string | null;
      }
    ).plan_approved_at;
  }
  function rowCount(db: Database.Database, table: string, id: string): number {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(id) as { n: number }).n;
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

  it('Approve on approve-plan stamps plan_approved_at + reveals the run-created epic and tasks (approved_at), keeping tasks at Ready for development', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // Seed the run FIRST so the run-attributed `created` entity_events satisfy
    // the entity_events.run_id FK (foreign_keys=ON).
    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    // Pre-approval: the plan-gated run minted its epic + tasks PENDING
    // (approved_at NULL) and the run is not yet plan-approved.
    for (const id of taskIds) expect(taskApprovedAt(db, id)).toBeNull();
    expect(epicApprovedAt(db, epicId)).toBeNull();
    expect(planApprovedAt(db, 'run-p')).toBeNull();

    // The reveal must be OBSERVABLE on a mounted board: each approved_at flip
    // routes through the chokepoint and broadcasts a TaskChangedEvent (the tasks
    // are already at position 6, so the reveal event is the ONLY live signal).
    const revealEvents: TaskChangedEvent[] = [];
    taskChangeEvents.on(taskProjectChannel(1), (e: TaskChangedEvent) => revealEvents.push(e));

    await answerPlanGate(db, router, 'run-p', 'Approve');

    // The run is plan-approved and every run-created task + epic is revealed.
    expect(planApprovedAt(db, 'run-p')).not.toBeNull();
    for (const id of taskIds) expect(taskApprovedAt(db, id)).not.toBeNull();
    expect(epicApprovedAt(db, epicId)).not.toBeNull();

    // One reveal broadcast per revealed entity, snapshot carrying the stamp.
    const revealedIds = revealEvents
      .filter((e) => e.task.approved_at !== null && e.task.approved_at !== undefined)
      .map((e) => e.taskId);
    expect(revealedIds).toEqual(expect.arrayContaining([epicId, ...taskIds]));

    // The tasks sit at Ready for development (position 6).
    for (const id of taskIds) {
      expect((db.prepare('SELECT stage_id FROM tasks WHERE id = ?').get(id) as { stage_id: string }).stage_id).toBe(
        stageId(6),
      );
    }
  });

  it('Revise on approve-plan KEEPS the run-created drafts (negotiation round — agent adjusts in place)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { ideaId, epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    await answerPlanGate(db, router, 'run-p', 'Revise');

    // REJECT-ONLY deletion: a Revise (or cap-trim / free-text) answer keeps the
    // drafts — ship retains their ids across revise rounds and adjusts them via
    // update; deleting here bricked the eventual Approve → materialize.
    expect(rowCount(db, 'epics', epicId)).toBe(1);
    for (const id of taskIds) expect(rowCount(db, 'tasks', id)).toBe(1);
    expect(rowCount(db, 'ideas', ideaId)).toBe(1);
    // Still pending — invisible + sprint-ineligible until the eventual Approve.
    expect(epicApprovedAt(db, epicId)).toBeNull();
    expect(planApprovedAt(db, 'run-p')).toBeNull();
  });

  it('Reject on approve-plan DELETES the run-created epic + tasks but keeps the seed idea (run stays un-approved)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { ideaId, epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    await answerPlanGate(db, router, 'run-p', 'Reject');

    // Q1 GUARD (reject = no tasks): the run's PENDING draft entities are gone...
    expect(rowCount(db, 'epics', epicId)).toBe(0);
    for (const id of taskIds) expect(rowCount(db, 'tasks', id)).toBe(0);
    // ...but the seed idea survives (reachable for the replan)...
    expect(rowCount(db, 'ideas', ideaId)).toBe(1);
    // ...and the run is NOT plan-approved.
    expect(planApprovedAt(db, 'run-p')).toBeNull();
  });

  it('Approve on a NON-approve-plan step does NOT reveal the entities', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // current_step_id is the EARLIER approve-idea gate, not approve-plan.
    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-idea', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 1, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Approve');

    expect(taskApprovedAt(db, taskIds[0])).toBeNull();
    expect(epicApprovedAt(db, epicId)).toBeNull();
    expect(planApprovedAt(db, 'run-p')).toBeNull();
  });

  it('is idempotent: a re-answer at approve-plan does not re-stamp approved_at / plan_approved_at', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 1, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Approve');

    const taskFirst = taskApprovedAt(db, taskIds[0]);
    const epicFirst = epicApprovedAt(db, epicId);
    const planFirst = planApprovedAt(db, 'run-p');
    expect(taskFirst).not.toBeNull();
    expect(epicFirst).not.toBeNull();
    expect(planFirst).not.toBeNull();

    // The run is back to 'running'; answer a second approve-plan gate. The guarded
    // `IS NULL` stamps are no-ops, so every timestamp is unchanged.
    await answerPlanGate(db, router, 'run-p', 'Approve');
    expect(taskApprovedAt(db, taskIds[0])).toBe(taskFirst);
    expect(epicApprovedAt(db, epicId)).toBe(epicFirst);
    expect(planApprovedAt(db, 'run-p')).toBe(planFirst);
  });

  // -------------------------------------------------------------------------
  // F1: a decline (draft teardown) fires ONLY when the user SELECTED an explicit
  // reject OPTION — an exact match on a presented option label that starts with
  // 'reject', never a prefix match on free text. A draft-preserving negotiation
  // reply that merely starts with 'reject' must keep the drafts.
  // -------------------------------------------------------------------------
  const REJECTABLE_QUESTIONS: QuestionPayload[] = [
    {
      question: 'Approve the plan?',
      header: 'Approve plan',
      multiSelect: false,
      options: [{ label: 'Approve' }, { label: 'Revise' }, { label: 'Reject plan' }],
    },
  ];

  async function answerWith(
    db: Database.Database,
    router: QuestionRouter,
    runId: string,
    questions: QuestionPayload[],
    answerValue: string,
  ): Promise<void> {
    const questionPromise = router.requestQuestion(
      runId,
      `tu-${runId}-${Math.random().toString(36).slice(2)}`,
      questions,
      vi.fn(),
    );
    await router['getQuestionQueue'](runId).onIdle();
    const questionId = (
      db
        .prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(runId) as { id: string }
    ).id;
    await router.respond(questionId, { answers: { 'Approve the plan?': answerValue } });
    await questionPromise;
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();
  }

  it('F1: selecting the explicit "Reject plan" OPTION deletes the run-created drafts', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    await answerWith(db, router, 'run-p', REJECTABLE_QUESTIONS, 'Reject plan');

    expect(rowCount(db, 'epics', epicId)).toBe(0);
    for (const id of taskIds) expect(rowCount(db, 'tasks', id)).toBe(0);
  });

  it('F1: free-text "Reject TASK-4 but keep the rest" KEEPS the drafts (not a selected reject option)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    // Free text that STARTS WITH 'reject' but is a draft-preserving negotiation
    // reply — must NOT match the presented 'Reject plan' option label (fail-safe).
    await answerWith(db, router, 'run-p', REJECTABLE_QUESTIONS, 'Reject TASK-4 but keep the rest');

    expect(rowCount(db, 'epics', epicId)).toBe(1);
    for (const id of taskIds) expect(rowCount(db, 'tasks', id)).toBe(1);
  });

  it('F1: "Request changes" KEEPS the drafts', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 1, 'run-p');

    await answerWith(db, router, 'run-p', REJECTABLE_QUESTIONS, 'Request changes');

    expect(rowCount(db, 'epics', epicId)).toBe(1);
    for (const id of taskIds) expect(rowCount(db, 'tasks', id)).toBe(1);
  });

  // -------------------------------------------------------------------------
  // F10: the approve-plan reveal COMPLETES before the agent resumes. socketReply
  // (which closes the agent's tool-call wait) must observe approved_at already
  // stamped on every run-created task — the reveal is awaited before resolve/
  // socketReply so a post-approval cyboflow_create_sprint_batch never races it.
  // -------------------------------------------------------------------------
  it('F10: the reveal completes before the agent resumes (socketReply sees approved_at already stamped)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    // Capture each task's approved_at AT THE MOMENT socketReply fires (the resume).
    let approvedAtResumeTime: (string | null)[] = [];
    const socketReply = vi.fn<(a: QuestionAnswer) => void>(() => {
      approvedAtResumeTime = taskIds.map((id) => taskApprovedAt(db, id));
    });

    const questionPromise = router.requestQuestion('run-p', 'tu-f10', PLAN_QUESTIONS, socketReply);
    await router['getQuestionQueue']('run-p').onIdle();
    const questionId = (
      db
        .prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get('run-p') as { id: string }
    ).id;
    await router.respond(questionId, { answers: { 'Approve the plan?': 'Approve' } });
    await questionPromise;

    // The reveal ran BEFORE the resume: every task was already approved_at-stamped
    // by the time the agent's tool-call wait was closed.
    expect(socketReply).toHaveBeenCalledOnce();
    expect(approvedAtResumeTime).toHaveLength(2);
    for (const at of approvedAtResumeTime) expect(at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // F3: fail-soft completion reveal. A plan-gated run that COMPLETES with
  // plan_approved_at still NULL (e.g. gate labels isApproveAnswer never matched)
  // must have its PENDING drafts REVEALED — not left hidden then silently lost on
  // a later dismiss. promotePendingDraftsForRun is the answer-less entry point.
  // -------------------------------------------------------------------------
  it('F3: promotePendingDraftsForRun reveals a plan-gated run\'s PENDING drafts when plan_approved_at is NULL', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // The step id is deliberately NOT approve-plan and no answer is supplied — the
    // completion entry point ignores both. The run is plan-gated by its 'planner'
    // workflow name (steps_snapshot_json is NULL → name fallback).
    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'execute', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-p');

    // Pre-completion: minted PENDING, run un-approved.
    for (const id of taskIds) expect(taskApprovedAt(db, id)).toBeNull();
    expect(epicApprovedAt(db, epicId)).toBeNull();
    expect(planApprovedAt(db, 'run-p')).toBeNull();

    await router.promotePendingDraftsForRun('run-p');
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();

    // Drafts revealed + the run stamped plan-approved (visible-but-unwanted beats
    // invisible-then-deleted).
    expect(planApprovedAt(db, 'run-p')).not.toBeNull();
    for (const id of taskIds) expect(taskApprovedAt(db, id)).not.toBeNull();
    expect(epicApprovedAt(db, epicId)).not.toBeNull();
  });

  // A/B REVEAL SUPPRESSION (migration 047): an experiment-arm run's drafts must
  // NOT be revealed by the completion/approve path — reveal happens exclusively via
  // experiments.decide. Both promotePendingDraftsForRun and promoteTasksOnPlanApproval
  // funnel through revealRunDrafts, which no-ops for an experiment-tagged run.
  it('experiment-tagged run: promotePendingDraftsForRun does NOT reveal (drafts stay pending)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-exp', currentStepId: 'execute', seedIdeaId: null });
    db.prepare("UPDATE workflow_runs SET experiment_id = 'exp-1' WHERE id = ?").run('run-exp');
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 2, 'run-exp');

    // Minted PENDING + tagged.
    for (const id of taskIds) expect(taskApprovedAt(db, id)).toBeNull();
    expect(epicApprovedAt(db, epicId)).toBeNull();

    await router.promotePendingDraftsForRun('run-exp');
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();

    // SUPPRESSED: still pending, run NOT plan-approved, tags intact.
    expect(planApprovedAt(db, 'run-exp')).toBeNull();
    for (const id of taskIds) expect(taskApprovedAt(db, id)).toBeNull();
    expect(epicApprovedAt(db, epicId)).toBeNull();
    const epicTag = (db.prepare('SELECT experiment_id AS v FROM epics WHERE id = ?').get(epicId) as { v: unknown }).v;
    expect(epicTag).toBe('exp-1');
  });

  it('F3: promotePendingDraftsForRun is a no-op for an ALREADY-approved run (idempotent)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-p', currentStepId: 'approve-plan', seedIdeaId: null });
    const { epicId, taskIds } = await seedRunEntities(taskRouter, 1, 'run-p');
    await answerPlanGate(db, router, 'run-p', 'Approve');

    const planFirst = planApprovedAt(db, 'run-p');
    const taskFirst = taskApprovedAt(db, taskIds[0]);
    const epicFirst = epicApprovedAt(db, epicId);
    expect(planFirst).not.toBeNull();

    // The completion reveal fires on an already-approved run — every stamp is
    // unchanged (the plan_approved_at guard returns early before any write).
    await router.promotePendingDraftsForRun('run-p');
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();

    expect(planApprovedAt(db, 'run-p')).toBe(planFirst);
    expect(taskApprovedAt(db, taskIds[0])).toBe(taskFirst);
    expect(epicApprovedAt(db, epicId)).toBe(epicFirst);
  });

  it('F3: promotePendingDraftsForRun is a no-op for a NON-plan-gated run (sprint — never stamps plan_approved_at)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // A sprint run is NOT plan-gated: its entities are created VISIBLE and it has
    // no plan to approve. The completion reveal must skip it (never stamp
    // plan_approved_at).
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-s', 1, 'sprint', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, seed_idea_id)
       VALUES ('run-s', 'wf-s', 1, 'awaiting_review', 'execute', NULL)`,
    ).run();
    const { epicId } = await seedRunEntities(taskRouter, 1, 'run-s');

    // Non-plan-gated create lands VISIBLE immediately.
    expect(epicApprovedAt(db, epicId)).not.toBeNull();

    await router.promotePendingDraftsForRun('run-s');
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();

    // The sprint run was NEVER stamped plan-approved (the guard skipped it).
    expect(planApprovedAt(db, 'run-s')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ship: answering the `approve-plan` gate with Approve retires the run's owned
// idea(s) to the terminal Decomposed stage (position 12) — ship drops planner's
// separate decompose/Archive gate, so "tasks approved" IS where the idea is
// archived. Ship-scoped by workflow name (a planner approve-plan must NOT retire
// here). Backend-deterministic; Revise/Reject and non-ship flows are no-ops.
// ---------------------------------------------------------------------------

describe('QuestionRouter approve-plan retires a SHIP run\'s idea to Decomposed', () => {
  // Same migration chain as the approve-plan promotion block.
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
    db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p-ship');
    const migDir = join(__dirname, '..', '..', 'database', 'migrations');
    for (const f of [
      '006_cyboflow_schema.sql',
      '007_add_stuck_reason.sql',
      '010_questions.sql',
      '011_workflow_step_tracking.sql',
      '014_native_tasks.sql',
      '015_entity_model_rebuild.sql',
      '016_review_items.sql',
      '017_run_seed_idea.sql',
      '024_archive_in_place.sql',
      '028_idea_attachments.sql',
    ]) {
      db.exec(readFileSync(join(migDir, f), 'utf-8'));
    }
    // Migration 042 adds the decompose/approval stamps (the columns the router
    // now reads) AND collapses the board. The board collapse (stage deletes) is
    // exercised in migration036.test.ts; here we only add the columns so the
    // 12-stage board's positions stay available for these stage assertions.
    db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
    db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
    // migration 046/047: experiment tag on runs + entity tables (reveal suppression).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
    for (const t of ['ideas', 'epics', 'tasks']) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
      db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
    }
    return db;
  }

  function stageId(position: number): string {
    return `stage-board-1-default-${position}`;
  }

  const DECOMPOSED_POSITION = 12;

  function ideaStage(db: Database.Database, ideaId: string): string {
    return (db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id;
  }

  function decomposedAt(db: Database.Database, ideaId: string): string | null {
    return (db.prepare('SELECT decomposed_at FROM ideas WHERE id = ?').get(ideaId) as { decomposed_at: string | null })
      .decomposed_at;
  }

  /** Seed a run under a named workflow (ship or planner) at the given step. */
  function seedRunForWorkflow(
    db: Database.Database,
    opts: { runId: string; workflowName: string; currentStepId: string },
  ): void {
    const wfId = `wf-${opts.workflowName}`;
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES (?, 1, ?, '{}')`,
    ).run(wfId, opts.workflowName);
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status, current_step_id, seed_idea_id)
       VALUES (?, ?, 1, 'running', ?, NULL)`,
    ).run(opts.runId, wfId, opts.currentStepId);
  }

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
       VALUES (?, ?, ?, 'created', 'agent:ship', ?, '[]', ?)`,
    ).run(entityType, entityId, seq, runId, new Date().toISOString());
  }

  /**
   * Seed an idea + N tasks attributed to the run, deliberately WITHOUT
   * originatingIdeaId on the tasks — this mirrors the real MCP `create_task`
   * path (which threads only parentEpicId), so the chokepoint's FIX-STAGE-MODEL B
   * auto-retire does NOT pre-empt the gate. The idea is left in its planning stage
   * and linked to the run only via the created-event ownership projection.
   */
  async function seedOwnedIdea(
    db: Database.Database,
    taskRouter: TaskChangeRouter,
    runId: string,
    taskCount: number,
  ): Promise<{ ideaId: string; taskIds: string[] }> {
    const idea = await taskRouter.applyChange(1, { actor: 'user', entityType: 'idea', title: 'Ship idea' });
    const taskIds: string[] = [];
    for (let i = 0; i < taskCount; i++) {
      const t = await taskRouter.applyChange(1, { actor: 'user', entityType: 'task', title: `Ship task ${i}` });
      taskIds.push(t.taskId);
    }
    await taskRouter._queueForProject(1).onIdle();
    markCreatedByRun(db, 'idea', idea.taskId, runId);
    for (const id of taskIds) markCreatedByRun(db, 'task', id, runId);
    return { ideaId: idea.taskId, taskIds };
  }

  const PLAN_QUESTIONS: QuestionPayload[] = [
    {
      question: 'Approve the plan?',
      header: 'Approve plan',
      multiSelect: false,
      options: [{ label: 'Approve' }, { label: 'Revise' }],
    },
  ];

  async function answerPlanGate(
    db: Database.Database,
    router: QuestionRouter,
    runId: string,
    chosen: string,
  ): Promise<void> {
    const questionPromise = router.requestQuestion(runId, `tu-${runId}-${Math.random().toString(36).slice(2)}`, PLAN_QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();
    const questionId = (
      db
        .prepare("SELECT id FROM questions WHERE run_id = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(runId) as { id: string }
    ).id;
    await router.respond(questionId, { answers: { 'Approve the plan?': chosen } });
    await questionPromise;
    await TaskChangeRouter.getInstance()._queueForProject(1).onIdle();
  }

  afterEach(() => {
    QuestionRouter._resetForTesting();
    TaskChangeRouter._resetForTesting();
    taskChangeEvents.removeAllListeners();
  });

  it('Approve on a SHIP approve-plan gate retires the run-owned idea (stamps decomposed_at, keeps its stage)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedRunForWorkflow(db, { runId: 'run-ship', workflowName: 'ship', currentStepId: 'approve-plan' });
    const { ideaId } = await seedOwnedIdea(db, taskRouter, 'run-ship', 2);
    const stageBefore = ideaStage(db, ideaId);
    // Precondition: the idea is NOT yet retired (decomposed_at unstamped).
    expect(decomposedAt(db, ideaId)).toBeNull();

    await answerPlanGate(db, router, 'run-ship', 'Approve');

    // Migration-042 retirement is a decomposed_at stamp, NOT a stage move (the
    // idea keeps its stage; the stamp takes it off the board).
    expect(decomposedAt(db, ideaId)).not.toBeNull();
    expect(ideaStage(db, ideaId)).toBe(stageBefore);
    // The retirement is orchestrator-attributed with the 'decomposed' action.
    const ev = db
      .prepare("SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(ideaId) as { actor: string; kind: string };
    expect(ev.actor).toBe('orchestrator');
    expect(ev.kind).toBe('decomposed');
  });

  it('Revise on a SHIP approve-plan gate does NOT retire the idea', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedRunForWorkflow(db, { runId: 'run-ship', workflowName: 'ship', currentStepId: 'approve-plan' });
    const { ideaId } = await seedOwnedIdea(db, taskRouter, 'run-ship', 1);
    const before = ideaStage(db, ideaId);

    await answerPlanGate(db, router, 'run-ship', 'Revise');

    expect(ideaStage(db, ideaId)).toBe(before);
    expect(ideaStage(db, ideaId)).not.toBe(stageId(DECOMPOSED_POSITION));
  });

  it('Approve on a PLANNER approve-plan gate retires the run-owned idea (F8 — reveal retires the seed idea)', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    // The workflow is planner. Retirement here is F8's promoteTasksOnPlanApproval
    // reveal-retire (NOT the ship-scoped retireShipIdeasOnPlanApproval): approving
    // the plan decomposes the idea, so it leaves the board immediately rather than
    // stranding on the board until the later decompose gate.
    seedRunForWorkflow(db, { runId: 'run-plan', workflowName: 'planner', currentStepId: 'approve-plan' });
    const { ideaId } = await seedOwnedIdea(db, taskRouter, 'run-plan', 1);
    const before = ideaStage(db, ideaId);
    expect(decomposedAt(db, ideaId)).toBeNull();

    await answerPlanGate(db, router, 'run-plan', 'Approve');

    // Migration-042 retirement is a decomposed_at stamp, NOT a stage move — the idea
    // keeps its stage; the stamp takes it off the board.
    expect(decomposedAt(db, ideaId)).not.toBeNull();
    expect(ideaStage(db, ideaId)).toBe(before);
    // The retirement is orchestrator-attributed with the 'decomposed' action.
    const ev = db
      .prepare("SELECT actor, kind FROM entity_events WHERE entity_type = 'idea' AND entity_id = ? ORDER BY seq DESC LIMIT 1")
      .get(ideaId) as { actor: string; kind: string };
    expect(ev.actor).toBe('orchestrator');
    expect(ev.kind).toBe('decomposed');
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
    // Migration 042 adds the decompose/approval stamps (the columns the router
    // now reads) AND collapses the board. The board collapse (stage deletes) is
    // exercised in migration036.test.ts; here we only add the columns so the
    // 12-stage board's positions stay available for these stage assertions.
    db.exec('ALTER TABLE ideas ADD COLUMN decomposed_at TEXT;');
    db.exec('ALTER TABLE epics ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE tasks ADD COLUMN approved_at TEXT;');
    db.exec('ALTER TABLE workflow_runs ADD COLUMN plan_approved_at TEXT;');
    // migration 046/047: experiment tag on runs + entity tables (reveal suppression).
    db.exec('ALTER TABLE workflow_runs ADD COLUMN experiment_id TEXT;');
    for (const t of ['ideas', 'epics', 'tasks']) {
      db.exec(`ALTER TABLE ${t} ADD COLUMN experiment_id TEXT;`);
      db.exec(`ALTER TABLE ${t} ADD COLUMN caused_by_run_id TEXT;`);
    }
    return db;
  }

  function stageId(position: number): string {
    return `stage-board-1-default-${position}`;
  }

  function ideaStage(db: Database.Database, ideaId: string): string {
    return (db.prepare('SELECT stage_id FROM ideas WHERE id = ?').get(ideaId) as { stage_id: string }).stage_id;
  }

  function decomposedAt(db: Database.Database, ideaId: string): string | null {
    return (db.prepare('SELECT decomposed_at FROM ideas WHERE id = ?').get(ideaId) as { decomposed_at: string | null })
      .decomposed_at;
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

  it('Archive on decompose retires owned ideas off the board (stamps decomposed_at, keeps stage) and completes the run', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const taskRouter = TaskChangeRouter.initialize(adapter);
    const router = QuestionRouter.initialize(adapter);

    seedPlannerRun(db, { runId: 'run-d', currentStepId: 'decompose' });
    const ideaA = await seedOwnedIdea(db, taskRouter, 'run-d');
    const ideaB = await seedOwnedIdea(db, taskRouter, 'run-d');
    // Ideas start at Idea (position 1), not yet retired.
    for (const id of [ideaA, ideaB]) {
      expect(ideaStage(db, id)).toBe(stageId(1));
      expect(decomposedAt(db, id)).toBeNull();
    }

    await answerDecomposeGate(db, router, 'run-d', 'Archive & finish');

    // Migration-042 retirement is a decomposed_at stamp, NOT a stage move: each
    // idea keeps its stage (position 1) and the stamp takes it off the board.
    for (const id of [ideaA, ideaB]) {
      expect(decomposedAt(db, id)).not.toBeNull();
      expect(ideaStage(db, id)).toBe(stageId(1));
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

// ---------------------------------------------------------------------------
// Self-healing: a dead/stale gate must not wedge the run at 'awaiting_input'
// forever. In production the SDK hook awaiting a gate can be killed by the CLI's
// 600s hook timeout — the gate promise dies but the run stays at
// 'awaiting_input' with a 'pending' questions row and a live this.pending entry,
// so every subsequent requestQuestion retry threw RunNotRunningError (status was
// awaiting_input, not running). requestQuestion now supersedes the stale gate(s)
// and opens the new one in place, WITHOUT throwing — while still refusing runs
// that genuinely moved on (awaiting_review / terminal).
// ---------------------------------------------------------------------------

describe('QuestionRouter self-heals a dead/stale gate (supersede-and-reopen)', () => {
  // review_items (016) + entity_events (015) are required so the folded decision
  // review item is written + resolved through the real synchronous helpers.
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
    db.prepare('INSERT INTO projects (id, name, path) VALUES (1, ?, ?)').run('Proj', '/tmp/p-heal');
    const migDir = join(__dirname, '..', '..', 'database', 'migrations');
    for (const f of [
      '006_cyboflow_schema.sql',
      '007_add_stuck_reason.sql',
      '010_questions.sql',
      '011_workflow_step_tracking.sql',
      '014_native_tasks.sql',
      '015_entity_model_rebuild.sql',
      '016_review_items.sql',
      '017_run_seed_idea.sql',
    ]) {
      db.exec(readFileSync(join(migDir, f), 'utf-8'));
    }
    return db;
  }

  const QUESTIONS: QuestionPayload[] = [
    {
      question: 'Which path?',
      header: 'Path',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    },
  ];

  function seedHealRun(db: Database.Database, runId: string, status: string): void {
    db.prepare(
      `INSERT OR IGNORE INTO workflows (id, project_id, name, spec_json) VALUES ('wf-h', 1, 'planner', '{}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, project_id, status) VALUES (?, 'wf-h', 1, ?)`,
    ).run(runId, status);
  }

  interface QuestionRow {
    id: string;
    status: string;
  }
  function questionByTool(db: Database.Database, toolUseId: string): QuestionRow {
    return db
      .prepare('SELECT id, status FROM questions WHERE tool_use_id = ?')
      .get(toolUseId) as QuestionRow;
  }
  function runStatus(db: Database.Database, runId: string): string {
    return (db.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId) as { status: string }).status;
  }
  interface ReviewRow {
    id: string;
    status: string;
    resolved_by: string | null;
    resolution: string | null;
  }
  function pendingDecisionReview(db: Database.Database, runId: string): ReviewRow | undefined {
    return db
      .prepare(
        `SELECT id, status, resolved_by, resolution FROM review_items
          WHERE run_id = ? AND kind = 'decision' AND source = 'question' AND status = 'pending'`,
      )
      .get(runId) as ReviewRow | undefined;
  }
  function reviewById(db: Database.Database, id: string): ReviewRow {
    return db
      .prepare('SELECT id, status, resolved_by, resolution FROM review_items WHERE id = ?')
      .get(id) as ReviewRow;
  }

  afterEach(() => {
    QuestionRouter._resetForTesting();
  });

  it('supersede-and-reopen: a second requestQuestion while awaiting_input replaces the dead gate instead of throwing', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const router = QuestionRouter.initialize(adapter);

    const runId = 'run-heal-1';
    seedHealRun(db, runId, 'running');

    // Gate #1 opens — its awaiting hook is (in production) about to be killed.
    const socket1 = vi.fn<(a: QuestionAnswer) => void>();
    const p1 = router.requestQuestion(runId, 'tool-heal-1a', QUESTIONS, socket1);
    await router['getQuestionQueue'](runId).onIdle();
    expect(runStatus(db, runId)).toBe('awaiting_input');
    const q1 = questionByTool(db, 'tool-heal-1a');
    expect(q1.status).toBe('pending');
    const review1 = pendingDecisionReview(db, runId);
    expect(review1).toBeDefined();
    const review1Id = review1!.id;

    // Gate #2 fires while the run is STILL wedged at awaiting_input (the dead
    // gate's promise was never settled). It must NOT throw.
    const socket2 = vi.fn<(a: QuestionAnswer) => void>();
    const p2 = router.requestQuestion(runId, 'tool-heal-1b', QUESTIONS, socket2);
    await router['getQuestionQueue'](runId).onIdle();

    // Gate #1's awaiting caller is resolved with a synthetic empty answer, and its
    // socketReply is never invoked (mirrors clearPendingForRun).
    const answer1 = await p1;
    expect(answer1.answers).toEqual({});
    expect(socket1).not.toHaveBeenCalled();

    // Gate #1's DB rows are superseded: question timed_out, review item resolved.
    expect(questionByTool(db, 'tool-heal-1a').status).toBe('timed_out');
    const resolvedReview1 = reviewById(db, review1Id);
    expect(resolvedReview1.status).toBe('resolved');
    expect(resolvedReview1.resolved_by).toBe('system');
    expect(resolvedReview1.resolution).toBe('superseded');

    // Gate #2 is now the live gate: pending question + a fresh pending blocking
    // decision review item; the run is still parked at awaiting_input.
    const q2 = questionByTool(db, 'tool-heal-1b');
    expect(q2.status).toBe('pending');
    const review2 = pendingDecisionReview(db, runId);
    expect(review2).toBeDefined();
    expect(review2!.id).not.toBe(review1Id);
    expect(
      (db.prepare('SELECT blocking FROM review_items WHERE id = ?').get(review2!.id) as { blocking: number }).blocking,
    ).toBe(1);
    expect(runStatus(db, runId)).toBe('awaiting_input');

    // Answering gate #2 resolves the live promise and returns the run to running.
    await router.respond(q2.id, { answers: { 'Which path?': 'B' } });
    const answer2 = await p2;
    expect(answer2.answers).toEqual({ 'Which path?': 'B' });
    expect(questionByTool(db, 'tool-heal-1b').status).toBe('answered');
    expect(runStatus(db, runId)).toBe('running');
  });

  it('still refuses a run that genuinely moved on (awaiting_review / terminal) with RunNotRunningError', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const router = QuestionRouter.initialize(adapter);

    // A run parked in awaiting_review (moved past the gate) must never have a gate
    // re-opened under it.
    seedHealRun(db, 'run-heal-2a', 'awaiting_review');
    await expect(
      router.requestQuestion('run-heal-2a', 'tool-heal-2a', QUESTIONS, vi.fn()),
    ).rejects.toBeInstanceOf(RunNotRunningError);
    // No gate materialized.
    expect(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE run_id = 'run-heal-2a'").get()).toEqual({ n: 0 });

    // A terminal run likewise refuses.
    seedHealRun(db, 'run-heal-2b', 'completed');
    await expect(
      router.requestQuestion('run-heal-2b', 'tool-heal-2b', QUESTIONS, vi.fn()),
    ).rejects.toBeInstanceOf(RunNotRunningError);
    expect(db.prepare("SELECT COUNT(*) AS n FROM questions WHERE run_id = 'run-heal-2b'").get()).toEqual({ n: 0 });
  });

  it('orphan-row sweep: an awaiting_input run with a stale pending question + review item (no in-memory entry) is healed', async () => {
    const db = buildDb();
    const adapter = dbAdapter(db);
    const router = QuestionRouter.initialize(adapter);

    const runId = 'run-heal-3';
    // Simulate a run left wedged by a PREVIOUS process: awaiting_input with an
    // orphan pending question row + folded decision review item, and NO
    // this.pending entry (a fresh QuestionRouter has an empty map).
    seedHealRun(db, runId, 'awaiting_input');
    const orphanQid = 'orphan-q-3';
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO questions (id, run_id, tool_use_id, questions_json, status, created_at)
       VALUES (?, ?, 'orphan-tool-3', '[]', 'pending', ?)`,
    ).run(orphanQid, runId, now);
    const orphanReviewId = 'rvw_orphan_3';
    db.prepare(
      `INSERT INTO review_items
         (id, project_id, run_id, entity_type, entity_id, kind, status, blocking,
          title, body, severity, source, payload_json, created_at, updated_at, resolved_by, resolution)
       VALUES (?, 1, ?, NULL, NULL, 'decision', 'pending', 1, 'Stale gate', NULL, NULL, 'question', NULL, ?, ?, NULL, NULL)`,
    ).run(orphanReviewId, runId, now, now);

    // A fresh gate request heals the orphan state (no in-memory entry to supersede).
    const p = router.requestQuestion(runId, 'tool-heal-3', QUESTIONS, vi.fn());
    await router['getQuestionQueue'](runId).onIdle();

    // The orphan rows are swept: question timed_out, review item resolved.
    expect((db.prepare('SELECT status FROM questions WHERE id = ?').get(orphanQid) as { status: string }).status).toBe(
      'timed_out',
    );
    const orphanReview = reviewById(db, orphanReviewId);
    expect(orphanReview.status).toBe('resolved');
    expect(orphanReview.resolved_by).toBe('system');
    expect(orphanReview.resolution).toBe('superseded');

    // The new gate is live: pending question + a fresh pending decision review item.
    const q = questionByTool(db, 'tool-heal-3');
    expect(q.status).toBe('pending');
    expect(pendingDecisionReview(db, runId)).toBeDefined();
    expect(runStatus(db, runId)).toBe('awaiting_input');

    // Clean up the awaiting promise.
    await router.respond(q.id, { answers: { 'Which path?': 'A' } });
    await p;
  });
});
