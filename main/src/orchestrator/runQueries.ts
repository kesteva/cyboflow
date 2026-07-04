/**
 * Orchestrator-subtree handler for workflow-run list queries.
 *
 * Standalone-typecheck invariant: no imports from 'electron', 'better-sqlite3',
 * or main/src/services/*. Only DatabaseLike (structural interface) is used.
 */
import type { DatabaseLike } from './types';
import type { WorkflowRunListRow } from '../../../shared/types/workflows';

/**
 * Returns all workflow runs for a given project, ordered newest-first.
 *
 * The heavy snapshot column is excluded intentionally — callers that need
 * the full row should query workflow_runs directly.
 *
 * @param db        - Narrow DatabaseLike surface.
 * @param projectId - The project_id to filter by.
 * @returns Array of WorkflowRunListRow, newest first. Empty array when none exist.
 */
export function listRunsHandler(
  db: DatabaseLike,
  projectId: number,
): WorkflowRunListRow[] {
  return db
    .prepare(
      `SELECT id, workflow_id, project_id, status, worktree_path, branch_name,
              created_at, updated_at, started_at, ended_at, stuck_reason, substrate, session_id,
              batch_id, permission_mode_snapshot, model, error_message, execution_model, variant_label
         FROM workflow_runs
        WHERE project_id = ?
        ORDER BY created_at DESC`,
    )
    .all(projectId) as WorkflowRunListRow[];
}
