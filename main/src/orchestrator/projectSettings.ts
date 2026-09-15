/**
 * projectSettings — the orchestrator's narrow writer for the per-PROJECT settings
 * a flow run establishes, as opposed to the per-run state everything else here
 * owns.
 *
 * Today that is exactly one column: `projects.solution_thoroughness` (migration
 * 135), stamped when a Launch run's `approve-brief` gate is approved and read
 * back by every later Sprint/Ship run and by the session wizard's tuning-level
 * default. It gets its own module rather than living inside `gateSideEffects`
 * because it is a genuine seam: a project-scoped write, issued from a run-scoped
 * event, that must also tell the renderer to refetch.
 *
 * WHY NOT DatabaseService.updateProject: this module sits under
 * main/src/orchestrator, which may not import a concrete service (see
 * standaloneInvariant.test.ts). It issues the one guarded UPDATE against the
 * narrow DatabaseLike and takes the renderer notification as an INJECTED
 * callback, which index.ts wires to the same `sessionManager.emit('project:updated')`
 * the `projects:update` IPC handler already uses. Reusing that existing channel
 * is deliberate — a new ipcMain.handle would be frozen out by the
 * noNewIpcHandlers ratchet, and the renderer already listens on this one.
 *
 * Fail-soft throughout: a settings stamp is an enrichment, never a gate. A failed
 * write is logged and swallowed, because the alternative — failing the gate
 * resolution that triggered it — would strand a run over a default value.
 */
import type { DatabaseLike, LoggerLike } from './types';
import type { SolutionThoroughness } from '../../../shared/types/thoroughness';

export interface ProjectSettingsDeps {
  db: DatabaseLike;
  /**
   * Tell the renderer this project's row changed, so open surfaces refetch.
   * index.ts wires it to `sessionManager.emit('project:updated', project)` — the
   * SAME event the projects:update IPC path emits, so the renderer needs no new
   * listener. Optional: omitted in unit tests, and a run whose stamp lands
   * without a renderer attached is still correct (the next read sees it).
   */
  emitProjectUpdated?: (projectId: number) => void;
  logger?: LoggerLike;
}

/**
 * Stamp a project's solution thoroughness.
 *
 * Returns true when the column actually CHANGED. Re-stamping the same level is a
 * no-op that returns false — the settle reconciliation re-runs this on every
 * terminal launch run, and a no-op must not spam the renderer with a refetch.
 *
 * A LATER stamp overwrites an earlier one on purpose: re-running Launch on a
 * project is how a user revises the answer, and pinning the first Launch's level
 * forever would make that revision silently inert.
 */
export function stampSolutionThoroughness(
  deps: ProjectSettingsDeps,
  args: { projectId: number; level: SolutionThoroughness },
): boolean {
  try {
    const before = deps.db
      .prepare('SELECT solution_thoroughness AS level FROM projects WHERE id = ?')
      .get(args.projectId) as { level?: string | null } | undefined;
    if (before === undefined) {
      deps.logger?.warn('[projectSettings] solution-thoroughness stamp skipped: no such project', {
        projectId: args.projectId,
      });
      return false;
    }
    if (before.level === args.level) return false;

    const info = deps.db
      .prepare(
        `UPDATE projects SET solution_thoroughness = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      )
      .run(args.level, args.projectId) as { changes: number };
    if (info.changes === 0) return false;

    deps.logger?.info('[projectSettings] solution thoroughness stamped', {
      projectId: args.projectId,
      level: args.level,
      previous: before.level ?? null,
    });
    try {
      deps.emitProjectUpdated?.(args.projectId);
    } catch (emitErr) {
      // A renderer notification failure must never undo a committed stamp.
      deps.logger?.warn('[projectSettings] project-updated emit failed (stamp already committed)', {
        projectId: args.projectId,
        error: emitErr instanceof Error ? emitErr.message : String(emitErr),
      });
    }
    return true;
  } catch (err) {
    deps.logger?.warn('[projectSettings] solution-thoroughness stamp failed (fail-soft)', {
      projectId: args.projectId,
      level: args.level,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The project's stamped solution thoroughness, or null when never established
 * (or when the column is missing on a pre-135 DB — read fail-soft so a stale
 * schema degrades to "no default" rather than breaking the caller).
 */
export function readSolutionThoroughness(
  db: DatabaseLike,
  projectId: number,
): SolutionThoroughness | null {
  try {
    const row = db
      .prepare('SELECT solution_thoroughness AS level FROM projects WHERE id = ?')
      .get(projectId) as { level?: string | null } | undefined;
    const level = row?.level;
    return level === 'prototype' || level === 'v1' || level === 'production' ? level : null;
  } catch {
    return null;
  }
}
