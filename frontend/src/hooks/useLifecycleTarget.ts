import { useCyboflowStore } from '../stores/cyboflowStore';
import { useActiveRunsStore } from '../stores/activeRunsStore';
import { useLifecycleSession } from './useLifecycleSession';
import type { Session } from '../types/session';

/**
 * The target of the SessionLifecycleActionBar + its merge / dismiss dialogs.
 *
 * Two close-out surfaces exist:
 *   - a worktree-backed SESSION (an active quick session, resolved by
 *     useLifecycleSession via sessions.run_id === activeRunId). Quick sessions
 *     own a `sessions` row, so the existing session merge/dismiss machinery
 *     applies unchanged.
 *   - a planner / workflow RUN (GAP-B). Workflow runs have NO `sessions` row
 *     (that would double-list them in the rail and their nested worktree path
 *     does not match the session worktree layout), so the close-out operates on
 *     the workflow_runs row via the `cyboflow.runs.merge` / `cyboflow.runs.dismiss`
 *     procedures instead.
 *
 * Exactly one kind is returned (sessions take precedence — a quick session and a
 * workflow run are never both active per cyboflowStore's invariant). Returns
 * null when neither resolves to a closable target.
 */
export type LifecycleTarget =
  | { kind: 'session'; session: Session }
  | { kind: 'run'; runId: string; status: string };

export function useLifecycleTarget(): LifecycleTarget | null {
  const session = useLifecycleSession();
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const runsByProject = useActiveRunsStore((s) => s.runsByProject);

  // A worktree-backed quick session wins (it owns the existing close-out path).
  if (session) {
    return { kind: 'session', session };
  }

  // Otherwise, resolve a workflow run from the active-runs store. A run only
  // appears here when it is a real workflow run (the `__quick__` sentinel runs
  // are excluded by activeRunsStore), so this never collides with the session
  // branch above.
  if (activeRunId) {
    for (const runs of Object.values(runsByProject)) {
      const run = runs.find((r) => r.id === activeRunId);
      if (run) {
        return { kind: 'run', runId: run.id, status: run.status };
      }
    }
  }

  return null;
}
