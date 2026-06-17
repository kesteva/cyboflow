/**
 * ensureSessionForLaunch — resolve the session a workflow run will execute IN.
 *
 * Phase 3 of the session<->run restructure: every workflow launch now happens
 * INSIDE a session (the run executes in the session's worktree, and the run is
 * selected nested under that session). This helper resolves WHICH session:
 *
 *   - If a quick session is already selected (`selectedSessionId`) AND it is
 *     FREE (no active workflow run executing in it), the run launches into THAT
 *     session — the helper returns its id without creating anything.
 *   - Otherwise (no selection, OR the selected session is BUSY with a running
 *     workflow) it creates a fresh quick session (via `API.sessions.createQuick`)
 *     and bootstraps its default Claude + Terminal panels exactly as
 *     `useQuickSession` does, then returns the new session's id.
 *
 * The busy-session guard mirrors the backend's one-active-workflow-per-session
 * rule in `RunLauncher.launch` (`main/src/orchestrator/runLauncher.ts`): reusing
 * a session that already hosts a running workflow would make that guard throw
 * (`session <id> already has a running workflow`), so we fall through to a fresh
 * session instead. "Busy" is read from `useActiveRunsStore.runsByProject`, which
 * already excludes terminal runs (see `TERMINAL_RUN_STATUSES`), so every row
 * present there is a non-terminal (active) run.
 *
 * The returned id is threaded into `runs.start.mutate({ sessionId })` so the
 * RunLauncher executes the run in that session's worktree and dual-writes
 * `sessions.run_id`, which lets `useLifecycleSession` resolve close-out
 * (Merge / PR / Dismiss) back to the session.
 *
 * `forceNew` skips the reuse short-circuit entirely and ALWAYS creates a fresh
 * session. Used by the "Add a workflow" flow on an interactive (PTY) session,
 * where running a second workflow inside the live-REPL session is descoped — the
 * workflow must launch in its own separate session even though the current PTY
 * session is "free" of workflow runs.
 */
import { API } from './api';
import { panelApi } from '../services/panelApi';
import { useCyboflowStore } from '../stores/cyboflowStore';
import { useActiveRunsStore } from '../stores/activeRunsStore';

export interface EnsureSessionForLaunchOptions {
  /** Always create a fresh session, never reuse the current selection. */
  forceNew?: boolean;
}

/**
 * Resolve the session a workflow run should execute in: the currently-selected
 * quick session if one is active AND free, otherwise a freshly-created one (with
 * its default Claude + Terminal panels). Returns the session id.
 *
 * @throws Error when the quick-session create IPC fails.
 */
export async function ensureSessionForLaunch(
  projectId: number,
  opts: EnsureSessionForLaunchOptions = {},
): Promise<string> {
  // Launch into the active session if one is already selected — but ONLY when it
  // is free (and the caller hasn't forced a new session). Reusing a session that
  // already hosts a running workflow would trip the backend's
  // one-active-workflow-per-session guard in RunLauncher.launch. Active runs in
  // `runsByProject` are already terminal-filtered, so a row whose session_id
  // matches the selection means that session is busy.
  const sel = useCyboflowStore.getState().selectedSessionId;
  if (sel && !opts.forceNew) {
    const activeRuns = useActiveRunsStore.getState().runsByProject[projectId] ?? [];
    const selectionIsBusy = activeRuns.some((run) => run.session_id === sel);
    if (!selectionIsBusy) return sel;
  }

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
