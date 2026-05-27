/**
 * Integration tests for the orchestrator tRPC questions router (TASK-759).
 *
 * Tests exercise the live questionsRouter procedures via createCaller, using
 * an in-memory SQLite database (GATE_SCHEMA + migration 010 / questions table),
 * the dbAdapter fixture, and the real QuestionRouter singleton (reset between
 * tests via _resetForTesting()).
 *
 * Tests:
 *  1. listPending: empty table returns []
 *  2. listPending: two seeded rows return oldest-first (created_at ASC)
 *  3. answer(questionId, answers): resolves the in-flight answerPromise; returns { success: true }
 *  4. answer(unknownId): throws TRPCError code='NOT_FOUND'
 *  5. onQuestionCreated subscription yields the event emitted on questionEvents.emit('created', …)
 *  6. onQuestionAnswered subscription yields the event emitted on questionEvents.emit('answered', …)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TRPCError } from '@trpc/server';
import { appRouter } from '../../router';
import { createContext } from '../../context';
import { QuestionRouter } from '../../../questionRouter';
import { RunQueueRegistry } from '../../../RunQueueRegistry';
import { questionEvents } from '../events';
import { dbAdapter } from '../../../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedQuestion } from '../../../__test_fixtures__/orchestratorTestDb';
import type { QuestionCreatedEvent, QuestionAnsweredEvent } from '../../../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

afterEach(() => {
  QuestionRouter._resetForTesting();
});

// ---------------------------------------------------------------------------
// listPending
// ---------------------------------------------------------------------------

describe('cyboflow.questions.listPending', () => {
  it('listPending returns [] when the questions table is empty', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    const result = await caller.cyboflow.questions.listPending();
    expect(result).toEqual([]);
  });

  it('listPending returns Question[] rows oldest-first (created_at ASC)', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);

    // Seed runs with the same workflowName so the JOIN works.
    seedRun(db, { id: 'run-q-1', workflowName: 'Workflow Alpha', status: 'awaiting_input' });
    seedRun(db, { id: 'run-q-2', workflowName: 'Workflow Beta', status: 'awaiting_input' });

    const olderAt = '2026-01-01T00:00:01Z';
    const newerAt = '2026-01-01T00:00:02Z';

    // Insert newer first so insertion order differs from created_at order.
    const newerQuestionsJson = JSON.stringify([{
      question: 'Which approach do you prefer?',
      header: 'Approach',
      multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    }]);
    const olderQuestionsJson = JSON.stringify([{
      question: 'What is the priority?',
      header: 'Priority',
      multiSelect: false,
      options: [{ label: 'High' }, { label: 'Low' }],
    }]);

    seedQuestion(db, { id: 'q-newer', runId: 'run-q-1', questionsJson: newerQuestionsJson, createdAt: newerAt });
    seedQuestion(db, { id: 'q-older', runId: 'run-q-2', questionsJson: olderQuestionsJson, createdAt: olderAt });

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.questions.listPending();

    expect(result).toHaveLength(2);
    // Oldest first.
    expect(result[0].id).toBe('q-older');
    expect(result[1].id).toBe('q-newer');

    // Check shaped fields on the first row.
    const first = result[0];
    expect(first.runId).toBe('run-q-2');
    expect(first.workflowName).toBe('Workflow Beta');
    expect(first.status).toBe('pending');
    expect(first.createdAt).toBe(new Date(olderAt).toISOString());
    expect(first.questions).toHaveLength(1);
    expect(first.questions[0].question).toBe('What is the priority?');
    expect(first.answeredAt).toBeNull();
    expect(first.answerJson).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// answer
// ---------------------------------------------------------------------------

describe('cyboflow.questions.answer', () => {
  it('answer(questionId, answers) resolves the in-flight answerPromise; returns { success: true }', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const registry = new RunQueueRegistry();
    QuestionRouter.initialize(adapter);
    const qr = QuestionRouter.getInstance();

    seedRun(db, { id: 'run-answer', status: 'running' });

    // Register an in-flight question.
    const answerPromise = qr.requestQuestion(
      'run-answer',
      'tool-use-id-1',
      [{ question: 'Q?', header: 'Q', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
      () => undefined,
    );

    // Retrieve the question ID from the DB.
    const row = db
      .prepare(`SELECT id FROM questions WHERE run_id = ? LIMIT 1`)
      .get('run-answer') as { id: string } | undefined;
    expect(row).toBeDefined();
    const questionId = row!.id;

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    const result = await caller.cyboflow.questions.answer({
      questionId,
      answers: { 'Q?': 'Yes' },
    });
    expect(result).toEqual({ success: true });

    // The answerPromise resolves with the submitted answers.
    const answer = await answerPromise;
    expect(answer.answers).toEqual({ 'Q?': 'Yes' });

    // DB row should reflect 'answered'.
    const dbRow = db
      .prepare(`SELECT status FROM questions WHERE id = ?`)
      .get(questionId) as { status: string };
    expect(dbRow.status).toBe('answered');
  });

  /**
   * Regression test for the "annotations don't traverse" contract (TASK-759 code-review
   * finding). The Zod input schema for `answer` accepts only `answers` (a flat
   * Record<string, string | string[]>) and deliberately omits `annotations`.
   * Any annotations the renderer might send are stripped at the Zod boundary and
   * never forwarded to QuestionRouter.respond() nor written to `questions.answer_json`.
   *
   * This test documents the current contract so that TASK-760 (which will add
   * annotations support) has a clear before/after baseline and avoids silently
   * regressing the "answers still resolve correctly without annotations" path.
   */
  it('answer: annotations field is silently dropped — answer_json contains only { answers }', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const registry = new RunQueueRegistry();
    QuestionRouter.initialize(adapter);
    const qr = QuestionRouter.getInstance();

    seedRun(db, { id: 'run-annotations', status: 'running' });

    const answerPromise = qr.requestQuestion(
      'run-annotations',
      'tool-use-id-annotations',
      [{ question: 'Pick one', header: 'Pick', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }],
      () => undefined,
    );

    const row = db
      .prepare(`SELECT id FROM questions WHERE run_id = ? LIMIT 1`)
      .get('run-annotations') as { id: string } | undefined;
    expect(row).toBeDefined();
    const questionId = row!.id;

    const caller = appRouter.createCaller(createContext({ db: adapter }));
    // The tRPC caller API only accepts `answers` — there is no `annotations` field
    // in the Zod schema. Any annotations from the renderer are stripped before this
    // call reaches the mutation handler.
    const result = await caller.cyboflow.questions.answer({
      questionId,
      answers: { 'Pick one': 'A' },
    });
    expect(result).toEqual({ success: true });

    // The answerPromise resolves with only { answers } — no annotations key.
    const resolved = await answerPromise;
    expect(resolved).toEqual({ answers: { 'Pick one': 'A' } });
    expect(Object.keys(resolved)).not.toContain('annotations');

    // The DB row's answer_json also has no annotations key.
    const dbRow = db
      .prepare(`SELECT answer_json FROM questions WHERE id = ?`)
      .get(questionId) as { answer_json: string };
    const persisted = JSON.parse(dbRow.answer_json) as Record<string, unknown>;
    expect(Object.keys(persisted)).not.toContain('annotations');
    expect(persisted).toEqual({ answers: { 'Pick one': 'A' } });
  });

  it('answer(unknownId) throws TRPCError code=NOT_FOUND', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const registry = new RunQueueRegistry();
    QuestionRouter.initialize(adapter);

    const caller = appRouter.createCaller(createContext({ db: adapter }));

    await expect(
      caller.cyboflow.questions.answer({
        questionId: 'nonexistent-question-id',
        answers: { 'Q?': 'Yes' },
      }),
    ).rejects.toSatisfy(
      (err: unknown) => err instanceof TRPCError && err.code === 'NOT_FOUND',
    );
  });
});

// ---------------------------------------------------------------------------
// onQuestionCreated subscription
// ---------------------------------------------------------------------------

describe('cyboflow.questions.onQuestionCreated', () => {
  it('yields QuestionCreatedEvent emitted on questionEvents', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    // Start the subscription and collect one event.
    const ac = new AbortController();
    const subscription = await caller.cyboflow.questions.onQuestionCreated();

    const eventPayload: QuestionCreatedEvent = {
      question: {
        id: 'q-sub-1',
        runId: 'run-sub-1',
        workflowName: 'Test Workflow',
        toolUseId: 'tool-1',
        questions: [{ question: 'Q?', header: 'Q', multiSelect: false, options: [{ label: 'Yes' }, { label: 'No' }] }],
        status: 'pending',
        createdAt: new Date().toISOString(),
        answeredAt: null,
        answerJson: null,
      },
    };

    // Collect first yielded value by iterating the async generator.
    const resultPromise = (async () => {
      for await (const ev of subscription as AsyncIterable<QuestionCreatedEvent>) {
        ac.abort();
        return ev;
      }
      return undefined;
    })();

    // Emit after starting the iteration.
    setImmediate(() => {
      questionEvents.emit('created', eventPayload);
    });

    const received = await resultPromise;
    expect(received).toEqual(eventPayload);
  });
});

// ---------------------------------------------------------------------------
// onQuestionAnswered subscription
// ---------------------------------------------------------------------------

describe('cyboflow.questions.onQuestionAnswered', () => {
  it('yields QuestionAnsweredEvent emitted on questionEvents', async () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const caller = appRouter.createCaller(createContext({ db: adapter }));

    const subscription = await caller.cyboflow.questions.onQuestionAnswered();

    const eventPayload: QuestionAnsweredEvent = {
      questionId: 'q-answered-1',
      status: 'answered',
    };

    const resultPromise = (async () => {
      for await (const ev of subscription as AsyncIterable<QuestionAnsweredEvent>) {
        return ev;
      }
      return undefined;
    })();

    setImmediate(() => {
      questionEvents.emit('answered', eventPayload);
    });

    const received = await resultPromise;
    expect(received).toEqual(eventPayload);
  });
});
