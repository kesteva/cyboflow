/**
 * ensureSessionForLaunch — resolve the session a workflow run will execute IN.
 *
 * Phase 3 of the session<->run restructure: every workflow launch now happens
 * INSIDE a session (the run executes in the session's worktree, and the run is
 * selected nested under that session). This helper resolves WHICH session:
 *
 *   - If a quick session is already selected (`selectedSessionId`), the run
 *     launches into THAT session — the helper returns its id without creating
 *     anything.
 *   - Otherwise it creates a fresh quick session (via `API.sessions.createQuick`)
 *     and bootstraps its default Claude + Terminal panels exactly as
 *     `useQuickSession` does, then returns the new session's id.
 *
 * The returned id is threaded into `runs.start.mutate({ sessionId })` so the
 * RunLauncher executes the run in that session's worktree and dual-writes
 * `sessions.run_id`, which lets `useLifecycleSession` resolve close-out
 * (Merge / PR / Dismiss) back to the session.
 */
import { API } from './api';
import { panelApi } from '../services/panelApi';
import { useCyboflowStore } from '../stores/cyboflowStore';

/**
 * Resolve the session a workflow run should execute in: the currently-selected
 * quick session if one is active, otherwise a freshly-created one (with its
 * default Claude + Terminal panels). Returns the session id.
 *
 * @throws Error when the quick-session create IPC fails.
 */
export async function ensureSessionForLaunch(projectId: number): Promise<string> {
  // Launch into the active session if one is already selected.
  const sel = useCyboflowStore.getState().selectedSessionId;
  if (sel) return sel;

  // Otherwise create a fresh quick session for this launch.
  const result = await API.sessions.createQuick({ prompt: '', projectId });
  if (!result.success || !result.data) {
    throw new Error(result.error ?? 'Failed to create session for launch');
  }

  const { sessionId, worktreePath, claudePanelId } = result.data;

  // Bootstrap the session's default panels, mirroring useQuickSession.ts:
  // Claude first (UNLESS the server eagerly created it — an interactive PTY
  // session, e.g. under the global PTY-only lock, spawns the REPL during
  // create-quick and returns its panel id; creating a second would orphan a
  // process-less Claude tab), then a Terminal panel rooted at the worktree.
  if (claudePanelId === undefined) {
    await panelApi.createPanel({ sessionId, type: 'claude' });
  }
  await panelApi.createPanel({
    sessionId,
    type: 'terminal',
    title: 'Terminal',
    initialState: { cwd: worktreePath },
  });

  return sessionId;
}
