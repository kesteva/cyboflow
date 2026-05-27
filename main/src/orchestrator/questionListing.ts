/**
 * questionListing — shared SELECT JOIN helper for pending questions.
 *
 * Exports `selectPendingQuestions(db)` so the tRPC `cyboflow.questions.listPending`
 * procedure and any future parity tests share a single implementation of the
 * query. Mirrors the approvalListing.ts pattern.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only narrow interfaces and shared types.
 */
import type { Question, QuestionPayload } from '../../../shared/types/questions';
import type { DatabaseLike } from './types';

// ---------------------------------------------------------------------------
// Internal DB row shape
// ---------------------------------------------------------------------------

interface DbQuestionRow {
  id: string;
  runId: string;
  toolUseId: string;
  questionsJson: string;
  workflowName: string;
  createdAt: string;
  status: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return all pending questions ordered oldest-first, projected into the
 * shared `Question` type.
 *
 * Reads from the `questions` table where `status = 'pending'`, joined to
 * `workflow_runs` and `workflows` for the human-readable workflow name.
 *
 * @param db - Narrow DatabaseLike interface (real or test).
 * @returns Question[] sorted by created_at ASC.
 */
export function selectPendingQuestions(db: DatabaseLike): Question[] {
  const rows = db.prepare(
    `SELECT
       q.id          AS id,
       q.run_id      AS runId,
       q.tool_use_id AS toolUseId,
       q.questions_json AS questionsJson,
       w.name        AS workflowName,
       q.created_at  AS createdAt,
       q.status      AS status
     FROM questions q
     JOIN workflow_runs r ON r.id = q.run_id
     JOIN workflows     w ON w.id = r.workflow_id
     WHERE q.status = 'pending'
     ORDER BY q.created_at ASC`,
  ).all() as DbQuestionRow[];

  return rows.map((row): Question => {
    let questions: ReadonlyArray<QuestionPayload> = [];
    try {
      questions = JSON.parse(row.questionsJson) as QuestionPayload[];
    } catch {
      // Malformed JSON — return empty array; the question is still surfaced.
      console.warn(
        `[questionListing] Failed to parse questions_json for question id=${row.id}`,
      );
    }

    return {
      id: row.id,
      runId: row.runId,
      workflowName: row.workflowName,
      toolUseId: row.toolUseId,
      questions,
      status: row.status as Question['status'],
      createdAt: new Date(row.createdAt).toISOString(),
      answeredAt: null,
      answerJson: null,
    };
  });
}
