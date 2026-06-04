/**
 * workflowBundleInstall — the substrate-shared seam that resolves a run's
 * co-located command/agent bundle and installs it into the run's worktree
 * (IDEA-013 rung-(ii)). Called from BOTH managers' spawn paths
 * (interactiveClaudeManager.spawnCliProcess and claudeCodeManager.spawnCliProcess)
 * so the `/cyboflow-<phase>` invokable units land for either substrate; removal is
 * each manager's own teardown (interactive: teardownRun; SDK: cleanupCliResources)
 * via `WorkflowBundleWriter.remove`.
 *
 * The bundle is keyed off the run's `workflows.workflow_path` — the SAME `.md`
 * the prompt body is read from — so any flow using a built-in's prose gets that
 * built-in's sibling bundle, and a quick session / custom flow with no sibling
 * bundle dir resolves to an empty bundle and writes nothing (fail-soft).
 *
 * Unlike the dumb `WorkflowBundleWriter` (fs-only, standalone-typecheck-safe),
 * this helper bridges DB + resolver + writer, so it MAY import better-sqlite3 and
 * the orchestrator resolver (same latitude as the managers that call it).
 */
import type Database from 'better-sqlite3';
import type { LoggerLike } from '../../../orchestrator/types';
import { resolveWorkflowBundle } from '../../../orchestrator/workflows/workflowBundle';
import type { WorkflowBundleWriter } from './workflowBundleWriter';

/**
 * Read the run's `workflow_path` (the prose `.md`) from `workflow_runs JOIN
 * workflows`. Fail-soft to `null` on a missing run row, an unresolvable join, or a
 * DB error — mirrors `interactiveClaudeManager.buildStepReportingAppendForRun`.
 */
function getRunWorkflowPath(db: Database.Database, runId: string, logger?: LoggerLike): string | null {
  try {
    const row = db
      .prepare(
        `SELECT w.workflow_path AS workflowPath
           FROM workflow_runs r
           JOIN workflows w ON w.id = r.workflow_id
          WHERE r.id = ?`,
      )
      .get(runId) as { workflowPath?: unknown } | undefined;
    return typeof row?.workflowPath === 'string' ? row.workflowPath : null;
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] workflow_path lookup failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Resolve + install the run's co-located command/agent bundle into `worktreePath`.
 * No-op (writes nothing) when the run has no resolvable `workflow_path` or no
 * sibling bundle dir. Never throws — a bundle failure must not break a spawn.
 */
export function installWorkflowBundle(
  db: Database.Database,
  writer: WorkflowBundleWriter,
  runId: string,
  worktreePath: string,
  logger?: LoggerLike,
): void {
  try {
    const workflowPath = getRunWorkflowPath(db, runId, logger);
    const bundle = resolveWorkflowBundle(workflowPath);
    writer.write(worktreePath, bundle);
  } catch (err) {
    logger?.warn(
      `[WorkflowBundleInstall] install failed for runId=${runId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
