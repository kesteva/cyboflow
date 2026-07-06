/**
 * sessionPermissionMode — the single write chokepoint for a session's live agent
 * permission mode (permission-mode redesign §3d / Slice 5).
 *
 * `sessions.agent_permission_mode` is the sole execution authority for the
 * 4-mode permission ladder (the SDK hook + the interactive PTY both re-read it).
 * EVERY mode write must fire the SAME three side effects, so they all funnel
 * through `updateSessionAgentPermissionMode`:
 *
 *   1. persist `sessions.agent_permission_mode` (next-turn re-read for the SDK
 *      substrate);
 *   2. mutate the in-memory runtime `session.agentPermissionMode`;
 *   3. emit `session-updated` on the SessionManager so the composer permission
 *      pill (session-store-derived) refreshes with no respawn.
 *
 * (A former 4th effect — re-priming the INTERACTIVE worktree's
 * `.claude/settings.json` for the next PTY spawn — is gone: the gating hook now
 * rides the inline `--settings` flag and is recomputed from the persisted mode
 * at every spawn (interactiveClaudeManager buildCommandArgs →
 * resolveInlineGatingHooks), so there is no on-disk state to prime.)
 *
 * Three callers share it: the `sessions:update-agent-permission-mode` IPC handler
 * (the composer pill), `cyboflow.runs.setPermissionMode` (the chat / flow-run
 * pill, re-routed through here), and `RunLauncher.launch` (the launch picker,
 * when an explicit mode is supplied).
 *
 * Standalone-typecheck invariant (mirrors runLauncher.ts / runs.ts): only shared
 * types — no 'electron', no 'better-sqlite3', no service imports.
 */
import type { PermissionMode } from '../../../shared/types/workflows';

/**
 * Persistence + DB-row reader. Structurally satisfied by the real
 * DatabaseService; the in-memory test fake supplies the same two methods.
 */
export interface SessionPermissionModeDb {
  /**
   * Persist `sessions.agent_permission_mode`. Returns a truthy session row when
   * the id matched, a falsy value (undefined) when no session exists.
   */
  updateSession(sessionId: string, updates: { agent_permission_mode: PermissionMode }): unknown;
}

/**
 * Runtime session registry. Structurally satisfied by the real SessionManager
 * (getSession returns the in-memory Session; emit comes from EventEmitter).
 */
export interface SessionPermissionModeRuntime {
  getSession(sessionId: string): { agentPermissionMode?: PermissionMode } | null | undefined;
  emit(eventName: 'session-updated', session: unknown): void;
}

/**
 * The collaborators the chokepoint needs. The same shape is built inline by the
 * IPC handler (from its AppServices closure) and at boot in index.ts (shared by
 * runs.setPermissionMode + RunLauncher.launch).
 */
export interface SessionAgentPermissionModeDeps {
  databaseService: SessionPermissionModeDb;
  sessionManager: SessionPermissionModeRuntime;
}

/**
 * `{ ok: true }` when the session was found and persisted; `{ ok: false }` with
 * `not_found` when no session row matched the id (the only failure the persist
 * surfaces).
 */
export type UpdateSessionAgentPermissionModeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

/**
 * Single write chokepoint for `sessions.agent_permission_mode`. Performs the
 * three side effects documented in the module header. `mode` is assumed already
 * validated by the caller (isPermissionMode at the IPC boundary, zod enum at the
 * tRPC boundary).
 *
 * INTERACTIVE substrate note: no spawn-side priming is needed here. The PTY
 * gating hook rides the inline `--settings` flag and is recomputed from the
 * persisted mode at every spawn, so the persist in (1) IS the next-spawn
 * re-prime.
 */
export function updateSessionAgentPermissionMode(
  deps: SessionAgentPermissionModeDeps,
  sessionId: string,
  mode: PermissionMode,
): UpdateSessionAgentPermissionModeResult {
  // (1) persist — the authoritative SoT for both substrates.
  const updated = deps.databaseService.updateSession(sessionId, { agent_permission_mode: mode });
  if (!updated) {
    return { ok: false, reason: 'not_found' };
  }

  // (2)+(3) mutate the runtime session + emit so the session-store-derived pill
  // refreshes (no respawn).
  const session = deps.sessionManager.getSession(sessionId);
  if (session) {
    session.agentPermissionMode = mode;
    deps.sessionManager.emit('session-updated', session);
  }

  return { ok: true };
}
