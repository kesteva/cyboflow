import { useCyboflowStore } from '../stores/cyboflowStore';
import { useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types/session';

/**
 * Resolves the session targeted by the SessionLifecycleActionBar and its dialogs.
 *
 * Two entry points map to one worktree-backed session:
 *   - an active quick session  → session.id === activeQuickSessionId
 *   - an opened workflow run    → session.runId === activeRunId (sessions.run_id, migration 009)
 *
 * Returns null for the main-repo session (no worktree to merge/dismiss) or when
 * neither selection resolves to a loaded session. Both the action bar's
 * visibility and the dialogs' target read this single resolver so they cannot
 * drift apart.
 */
export function useLifecycleSession(): Session | null {
  const activeQuickSessionId = useCyboflowStore((s) => s.activeQuickSessionId);
  const activeRunId = useCyboflowStore((s) => s.activeRunId);
  const sessions = useSessionStore((s) => s.sessions);

  let session: Session | undefined;
  if (activeQuickSessionId) {
    session = sessions.find((s) => s.id === activeQuickSessionId);
  } else if (activeRunId) {
    session = sessions.find((s) => s.runId === activeRunId);
  }

  if (!session || session.isMainRepo) return null;
  return session;
}
