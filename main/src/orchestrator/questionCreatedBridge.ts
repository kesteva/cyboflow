/**
 * questionCreatedBridge — resolves workflowName for SSE question events.
 *
 * Extracts the JOIN logic that maps a workflow_run row to its human-readable
 * workflow name so the SSE-pushed QuestionCreatedEvent carries the same
 * workflowName field that listPending returns for the same question.
 *
 * Design notes:
 *  - JOIN at bridge (not inside QuestionRouter.requestQuestion) so the
 *    in-memory QuestionRequest shape stays lean for the SDK PreToolUse hook,
 *    which never reads workflowName.
 *  - Missing-row fallback: emit with workflowName='' and log a console.warn
 *    rather than throwing, because silent-drop creates an invisible discard
 *    mode that is harder to debug than a warn.
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', or any concrete service in main/src/services/*.
 */
import type { QuestionRequest, QuestionCreatedEvent } from '../../../shared/types/questions';
import type { DatabaseLike } from './types';

/**
 * Build a QuestionCreatedEvent from an in-memory QuestionRequest by
 * resolving the human-readable workflow name via a SELECT JOIN.
 *
 * @param request - The in-process question request emitted by QuestionRouter.
 * @param db      - Narrow DatabaseLike interface (real or test).
 * @returns A QuestionCreatedEvent ready for questionEvents.emit('created', …).
 */
export function buildQuestionCreatedEvent(
  request: QuestionRequest,
  db: DatabaseLike,
): QuestionCreatedEvent {
  let workflowName = '';

  try {
    const row = db
      .prepare(
        `SELECT w.name AS name
         FROM workflow_runs r
         JOIN workflows w ON w.id = r.workflow_id
         WHERE r.id = ?`,
      )
      .get(request.runId) as { name: string } | undefined;

    if (row && typeof row.name === 'string') {
      workflowName = row.name;
    } else {
      console.warn(
        `[questionCreatedBridge] No workflow row found for runId=${request.runId}`,
      );
    }
  } catch (err) {
    console.warn(
      `[questionCreatedBridge] workflowName lookup threw for runId=${request.runId}: ${err}`,
    );
  }

  return {
    question: {
      id: request.id,
      runId: request.runId,
      workflowName,
      toolUseId: request.toolUseId,
      questions: request.questions,
      createdAt: new Date(request.timestamp).toISOString(),
      status: 'pending' as const,
      answeredAt: null,
      answerJson: null,
    },
  };
}
