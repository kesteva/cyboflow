/**
 * Where a QUICK session's working tree lives.
 *
 * - 'worktree'  — a dedicated git worktree is created for the session
 *                 (`<project>/worktrees/quick-…`, branch == worktree name).
 *                 The default; preserves the isolation every other feature
 *                 assumes.
 * - 'in-place'  — no worktree is created; the session works DIRECTLY in the
 *                 project checkout (sessions.worktree_path == project.path,
 *                 sessions.in_place = 1, migration 046). Opt-in via the launch
 *                 wizard's Advanced section or the global Settings default.
 *
 * In-place sessions are SDK-only (the interactive substrate writes a PreToolUse
 * hook into `<worktree>/.claude/settings.json`, which for an in-place session
 * would mutate a potentially-tracked file in the user's real checkout) and can
 * NEVER host a workflow run (RunLauncher rejects them; the UI redirects the
 * launch into a fresh worktree-backed session after a warning modal).
 *
 * Workflow-hosting sessions always use 'worktree' regardless of the global
 * default — ensureSessionForLaunch pins the mode explicitly.
 */
export type QuickSessionWorktreeMode = 'worktree' | 'in-place';

/** Hard floor applied wherever the mode is resolved (config getter, IPC handler). */
export const DEFAULT_QUICK_SESSION_WORKTREE_MODE: QuickSessionWorktreeMode = 'worktree';

/** Validate an untyped IPC/config value before trusting it as a mode. */
export function isQuickSessionWorktreeMode(value: unknown): value is QuickSessionWorktreeMode {
  return value === 'worktree' || value === 'in-place';
}
