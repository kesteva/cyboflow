/**
 * bootstrapArmSessionPanels — bootstrap the renderer panels for a side-by-side
 * experiment arm's session (Slice B launch UI thin front-end).
 *
 * `experiments.startSideBySide` creates BOTH arm sessions server-side WITHOUT
 * any renderer panels (mirrors `createArmSession` in the backend router) —
 * unlike `sessions:create-quick`, its result carries only `{runId, sessionId}`
 * per arm, no `claudePanelId` short-circuit and no `worktreePath`. This helper
 * is the arm-session equivalent of {@link ensureSessionForLaunch}'s panel
 * bootstrap:
 *   - reads the session's worktreePath via `API.sessions.get` (the mutation
 *     result doesn't carry it),
 *   - loads the session's CURRENT panel list — the source-of-truth substitute
 *     for the missing `claudePanelId` field — and skips creating a Claude panel
 *     if the server already spawned one (an interactive-substrate arm's eager
 *     PTY REPL), then always creates a Terminal panel rooted at the worktree.
 *
 * Called ONLY for the arm the user is navigated to (arm A) — the other arm
 * stays headless; slice C's compare view is where it surfaces.
 */
import { API } from './api';
import { panelApi } from '../services/panelApi';

export async function bootstrapArmSessionPanels(sessionId: string): Promise<void> {
  const sessionResult = await API.sessions.get(sessionId);
  if (!sessionResult.success || !sessionResult.data) {
    throw new Error(sessionResult.error ?? 'Failed to load the experiment arm session');
  }
  const { worktreePath } = sessionResult.data;

  const panels = await panelApi.loadPanelsForSession(sessionId);
  const hasClaudePanel = panels.some((p) => p.type === 'claude');
  if (!hasClaudePanel) {
    await panelApi.createPanel({ sessionId, type: 'claude' });
  }
  await panelApi.createPanel({
    sessionId,
    type: 'terminal',
    title: 'Terminal',
    initialState: { cwd: worktreePath },
  });
}
