import { useLifecycleSession } from './useLifecycleSession';
import type { Session } from '../types/session';

/**
 * The target of the SessionLifecycleActionBar + its merge / PR / dismiss dialogs.
 *
 * The close-out (Merge / Create-PR / Dismiss) is ALWAYS session-scoped: it owns
 * the worktree + git lifecycle, and every workflow run is now session-hosted
 * (nested inside its parent session's worktree). The run-level close-out path was
 * removed in Phase 4a — a session-hosted run's Merge / PR / Dismiss MUST route to
 * the owning SESSION (the run-scoped equivalents threw PRECONDITION_FAILED on the
 * shared session worktree). The only RUN-level lifecycle action is the
 * git-neutral Cancel (RunActionBar), which is intentionally NOT part of this
 * close-out target.
 *
 * Resolves the worktree-backed session (an active quick session OR an opened
 * workflow run, both mapped to one `sessions` row by useLifecycleSession via
 * sessions.run_id). Returns null when no closable session resolves (e.g. the
 * main-repo session, or a run with no matching session row).
 */
export type LifecycleTarget = { kind: 'session'; session: Session };

export function useLifecycleTarget(): LifecycleTarget | null {
  const session = useLifecycleSession();
  if (session) {
    return { kind: 'session', session };
  }
  return null;
}
