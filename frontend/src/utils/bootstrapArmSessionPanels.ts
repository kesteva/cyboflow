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
 *     PTY REPL), then creates a Terminal panel rooted at the worktree.
 *
 * IDEMPOTENT: both the Claude AND the Terminal panel are guarded on the loaded
 * list, so a repeat call is a no-op. This matters because the helper is now also
 * called for the WINNING arm at decide time
 * (ExperimentComparisonView.handleDecide) — an arm the user had already opened
 * (handleOpenArmSession) would otherwise accrue a duplicate Terminal on decide.
 *
 * Called for: the arm the user launches into (arm A), any arm the user opens
 * from the compare view, and the winning arm at decide — so a picked winner
 * always hosts a Claude agent for post-experiment continuation (e.g. rebasing
 * the branch before merge).
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
  // Idempotent: skip the Terminal when the arm session already has one, so a
  // repeat bootstrap (e.g. an opened arm that is later picked as winner) does
  // not stack duplicate Terminal panels.
  const hasTerminalPanel = panels.some((p) => p.type === 'terminal');
  if (!hasTerminalPanel) {
    await panelApi.createPanel({
      sessionId,
      type: 'terminal',
      title: 'Terminal',
      initialState: { cwd: worktreePath },
    });
  }
}
