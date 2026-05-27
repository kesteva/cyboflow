/**
 * Unit tests for buildQuestionCreatedEvent (questionCreatedBridge).
 *
 * Three cases per the test_strategy in the TASK-758 plan:
 *
 * 1. Positive resolution: bridge returns workflowName when the workflow row exists.
 *
 * 2. Missing-row fallback: bridge returns workflowName='' and logs a
 *    console.warn, does NOT throw, when no workflow_runs row matches.
 *
 * 3. Field completeness: id, runId, toolUseId, questions, createdAt, and
 *    status='pending' are all populated correctly from the request.
 *
 * All tests use an in-memory better-sqlite3 instance with migration 010 applied
 * (via includeQuestionsTable: true) so the questions table exists, though
 * buildQuestionCreatedEvent only reads from workflow_runs/workflows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { buildQuestionCreatedEvent } from '../questionCreatedBridge';
import { dbAdapter } from '../__test_fixtures__/dbAdapter';
import { createTestDb, seedRun } from '../__test_fixtures__/orchestratorTestDb';
import type { QuestionRequest, QuestionPayload } from '../../../../shared/types/questions';

// ---------------------------------------------------------------------------
// Test-database helpers
// ---------------------------------------------------------------------------

/**
 * Seed one workflow + one workflow_run via the shared fixture.
 * Returns { workflowId, runId }.
 */
function seedWorkflowAndRun(
  db: Database.Database,
  workflowName: string,
): { workflowId: string; runId: string } {
  return seedRun(db, {
    id: `run-${workflowName}`,
    workflowId: `workflow-${workflowName}`,
    workflowName,
  });
}

// Sample questions payload.
const sampleQuestions: QuestionPayload[] = [
  {
    question: 'Which library?',
    header: 'Library',
    multiSelect: false,
    options: [
      { label: 'Library A', description: 'Fast' },
      { label: 'Library B', description: 'Stable' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildQuestionCreatedEvent', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Case 1: Positive resolution — returns workflowName from DB when row exists
  // -------------------------------------------------------------------------
  it('positive resolution: returns workflowName from DB when workflow row exists', () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const { runId } = seedWorkflowAndRun(db, 'question-workflow');

    const request: QuestionRequest = {
      id: 'question-001',
      runId,
      toolUseId: 'tool-use-001',
      questions: sampleQuestions,
      timestamp: Date.now(),
    };

    const event = buildQuestionCreatedEvent(request, adapter);

    expect(event.question.workflowName).toBe('question-workflow');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Case 2: Missing-row fallback — returns '' and warns, does NOT throw
  // -------------------------------------------------------------------------
  it('missing-row fallback: returns workflowName="" with console.warn, does not throw', () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    // No workflow or run seeded — runId will not match any row.

    const request: QuestionRequest = {
      id: 'question-orphan',
      runId: 'run-nonexistent',
      toolUseId: 'tool-use-orphan',
      questions: sampleQuestions,
      timestamp: Date.now(),
    };

    let event;
    expect(() => {
      event = buildQuestionCreatedEvent(request, adapter);
    }).not.toThrow();

    expect(event!.question.workflowName).toBe('');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toMatch(/No workflow row found for runId=run-nonexistent/);
  });

  // -------------------------------------------------------------------------
  // Case 3: Field completeness — all required Question fields populated
  // -------------------------------------------------------------------------
  it('field completeness: id, runId, toolUseId, questions, createdAt, status=pending all populated', () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const adapter = dbAdapter(db);
    const { runId } = seedWorkflowAndRun(db, 'fields-test-workflow');

    const timestamp = Date.now();
    const request: QuestionRequest = {
      id: 'question-fields-test',
      runId,
      toolUseId: 'tool-use-fields',
      questions: sampleQuestions,
      timestamp,
    };

    const event = buildQuestionCreatedEvent(request, adapter);
    const question = event.question;

    expect(question.id).toBe('question-fields-test');
    expect(question.runId).toBe(runId);
    expect(question.toolUseId).toBe('tool-use-fields');
    expect(question.questions).toEqual(sampleQuestions);
    expect(question.status).toBe('pending');
    expect(question.createdAt).toBe(new Date(timestamp).toISOString());
    // workflowName should be populated
    expect(question.workflowName).toBe('fields-test-workflow');
  });

  // -------------------------------------------------------------------------
  // Case 4: DB error in the JOIN triggers fallback with console.warn, no throw
  // -------------------------------------------------------------------------
  it('DB error in workflowName lookup logs console.warn and falls back to empty string', () => {
    const db = createTestDb({ includeQuestionsTable: true });
    const { runId } = seedWorkflowAndRun(db, 'error-workflow');

    // Adapter whose prepare() throws for SELECT JOIN.
    const faultyAdapter = {
      prepare(sql: string) {
        if (sql.includes('JOIN workflows')) {
          throw new Error('simulated DB error');
        }
        return db.prepare(sql);
      },
      transaction: <T>(fn: (...args: unknown[]) => T) =>
        db.transaction(fn as (...args: unknown[]) => T) as (...args: unknown[]) => T,
    };

    const request: QuestionRequest = {
      id: 'question-error',
      runId,
      toolUseId: 'tool-use-error',
      questions: sampleQuestions,
      timestamp: Date.now(),
    };

    let event;
    expect(() => {
      event = buildQuestionCreatedEvent(request, faultyAdapter);
    }).not.toThrow();

    expect(event!.question.workflowName).toBe('');
    expect(warnSpy).toHaveBeenCalled();
  });
});
