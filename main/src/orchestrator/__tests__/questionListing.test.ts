/**
 * B2 — questionListing.selectPendingQuestions.
 *
 * The shared SELECT-JOIN helper behind cyboflow.questions.listPending. Pins:
 *  - malformed questions_json surfaces the row with questions:[] (not thrown/omitted);
 *  - well-formed payload round-trips through the shared Question type;
 *  - the workflows JOIN resolves workflowName; created_at is ISO-normalized;
 *  - only status='pending' rows are returned, ordered oldest-first.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { selectPendingQuestions } from '../questionListing';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun, seedQuestion } from '../__test_fixtures__/orchestratorTestDb';
import type { QuestionPayload } from '../../../../shared/types/questions';

afterEach(() => {
  vi.restoreAllMocks();
});

const QUESTIONS: QuestionPayload[] = [
  { question: 'Pick a path forward', header: 'Path', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] },
];

function makeDb(): Database.Database {
  return createTestDb({ includeQuestionsTable: true });
}

describe('selectPendingQuestions', () => {
  it('round-trips a well-formed pending question with its workflow name + ISO createdAt', () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_input', workflowName: 'sprint' });
    // SQLite-style timestamp (space, no Z) → must be normalized to ISO.
    seedQuestion(db, {
      id: 'q-1',
      runId,
      toolUseId: 'tool-use-1',
      questionsJson: JSON.stringify(QUESTIONS),
      createdAt: '2026-01-02 03:04:05',
    });

    const rows = selectPendingQuestions(dbAdapter(db));
    expect(rows).toHaveLength(1);
    const q = rows[0];
    expect(q.id).toBe('q-1');
    expect(q.runId).toBe(runId);
    expect(q.toolUseId).toBe('tool-use-1');
    expect(q.workflowName).toBe('sprint');
    expect(q.questions).toEqual(QUESTIONS);
    expect(q.status).toBe('pending');
    // createdAt normalized to a valid ISO 8601 string.
    expect(q.createdAt).toBe(new Date('2026-01-02 03:04:05').toISOString());
    expect(q.answeredAt).toBeNull();
    expect(q.answerJson).toBeNull();
  });

  it('surfaces a malformed questions_json row with questions:[] rather than throwing or dropping it', () => {
    const db = makeDb();
    const { runId } = seedRun(db, { status: 'awaiting_input' });
    seedQuestion(db, { id: 'q-bad', runId, questionsJson: '{not valid json' });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const rows = selectPendingQuestions(dbAdapter(db));

    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('q-bad');
    expect(rows[0].questions).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns only pending rows, oldest-first', () => {
    const db = makeDb();
    const a = seedRun(db, { id: 'run-a', status: 'awaiting_input' });
    const b = seedRun(db, { id: 'run-b', status: 'awaiting_input' });
    // Two pending (out of insertion order by created_at) + one answered.
    seedQuestion(db, { id: 'q-late', runId: a.runId, createdAt: '2026-01-02T00:00:00.000Z' });
    seedQuestion(db, { id: 'q-early', runId: b.runId, createdAt: '2026-01-01T00:00:00.000Z' });
    seedQuestion(db, { id: 'q-answered', runId: a.runId, status: 'answered', createdAt: '2026-01-03T00:00:00.000Z' });

    const rows = selectPendingQuestions(dbAdapter(db));
    expect(rows.map((r) => r.id)).toEqual(['q-early', 'q-late']);
  });

  it('returns an empty array when there are no pending questions', () => {
    const db = makeDb();
    expect(selectPendingQuestions(dbAdapter(db))).toEqual([]);
  });
});
