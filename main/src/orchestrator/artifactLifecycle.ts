/**
 * artifactLifecycle — session-close pruning of run artifacts.
 *
 * The tabbed center pane's "session-only artifacts are dropped when the run
 * closes unless committed" contract: when a session is dismissed/archived, every
 * UNCOMMITTED (session_only) artifact belonging to that session's runs is
 * dropped. Committed artifacts persist (their rows survive; templated content
 * re-derives from the still-present backlog entities).
 *
 * This resolves the session's runs and delegates the actual deletes + change
 * events to the ArtifactRouter chokepoint (single writer). It is FS-free in v1:
 * uncommitted artifacts have no on-disk bytes (disk snapshots are only written on
 * commit — a deferred follow-up), so pruning is a pure row delete. Fully
 * fail-soft — a prune failure must never block the session close-out.
 *
 * NOTE (deferred): committing an artifact does NOT yet materialize an on-disk
 * snapshot under CYBOFLOW_DIR/artifacts/runs/<runId>/ (the design's "persists the
 * snapshot into git as-is"). Committed artifacts currently persist as DB rows +
 * re-derived entity content; the on-disk freeze (durability vs later entity
 * deletion + optional git add) is a follow-up.
 */
import type { DatabaseLike } from './types';
import { ArtifactRouter } from './artifactRouter';

/** Minimal logger surface (CLAUDE.md optional-logger rule — callers pass one). */
interface LifecycleLogger {
  warn?: (message: string, meta?: unknown) => void;
  debug?: (message: string, meta?: unknown) => void;
}

/**
 * Drop all session-only (uncommitted) artifacts for a session's runs. Returns the
 * dropped artifact ids. Never throws.
 */
export async function pruneSessionOnlyArtifacts(
  db: DatabaseLike,
  sessionId: string,
  logger?: LifecycleLogger,
): Promise<{ deleted: string[] }> {
  try {
    const rows = db
      .prepare('SELECT id, project_id AS projectId FROM workflow_runs WHERE session_id = ?')
      .all(sessionId) as Array<{ id: string; projectId: number }>;
    if (rows.length === 0) return { deleted: [] };

    const projectId = rows[0].projectId;
    const runIds = rows.map((r) => r.id);

    const { deleted } = await ArtifactRouter.getInstance().pruneSessionOnly(projectId, runIds);
    if (deleted.length > 0) {
      logger?.debug?.(`[artifactLifecycle] pruned ${deleted.length} session-only artifact(s) for session ${sessionId}`);
    }
    return { deleted };
  } catch (err) {
    logger?.warn?.(
      `[artifactLifecycle] pruneSessionOnlyArtifacts failed for session ${sessionId} (non-fatal)`,
      err instanceof Error ? err.message : String(err),
    );
    return { deleted: [] };
  }
}
