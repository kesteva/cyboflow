/**
 * sessionPermissionMode — the single write chokepoint for a session's live agent
 * permission mode (permission-mode redesign §3d / Slice 5).
 *
 * `sessions.agent_permission_mode` is the sole execution authority for the
 * 4-mode permission ladder (the SDK hook + the interactive PTY both re-read it).
 * EVERY mode write must fire the SAME four side effects, so they all funnel
 * through `updateSessionAgentPermissionMode`:
 *
 *   1. persist `sessions.agent_permission_mode` (next-turn re-read for the SDK
 *      substrate);
 *   2. mutate the in-memory runtime `session.agentPermissionMode`;
 *   3. emit `session-updated` on the SessionManager so the composer permission
 *      pill (session-store-derived) refreshes with no respawn;
 *   4. re-prime the INTERACTIVE worktree's `.claude/settings.json` so the next
 *      PTY spawn picks up the new gating (relayUserTurn never re-reads the hook).
 *
 * Three callers share it: the `sessions:update-agent-permission-mode` IPC handler
 * (the composer pill), `cyboflow.runs.setPermissionMode` (the chat / flow-run
 * pill, re-routed through here), and `RunLauncher.launch` (the launch picker,
 * when an explicit mode is supplied).
 *
 * Standalone-typecheck invariant (mirrors runLauncher.ts / runs.ts): only `fs`
 * plus shared types — no 'electron', no 'better-sqlite3', no service imports. The
 * concrete InteractiveSettingsWriter is injected through `settingsWriter` so this
 * module stays free of the services/* graph.
 */
import { existsSync } from 'fs';
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
  /**
   * Read the DB session row for the interactive re-prime (substrate +
   * worktree_path). Only the two fields below are consumed.
   */
  getSession(sessionId: string): { substrate?: string | null; worktree_path?: string | null } | null | undefined;
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
 * Narrow slice of InteractiveSettingsWriter needed for the next-spawn re-prime.
 * Injected (not imported) so this module honors the standalone invariant.
 */
export interface InteractiveSettingsWriterLike {
  write(worktreePath: string, opts: { permissionMode: PermissionMode }): unknown;
  remove(worktreePath: string): void;
}

/**
 * The collaborators the chokepoint needs. The same shape is built inline by the
 * IPC handler (from its AppServices closure) and at boot in index.ts (shared by
 * runs.setPermissionMode + RunLauncher.launch).
 */
export interface SessionAgentPermissionModeDeps {
  databaseService: SessionPermissionModeDb;
  sessionManager: SessionPermissionModeRuntime;
  configManager: { isDemoMode(): boolean };
  settingsWriter: InteractiveSettingsWriterLike;
}

/**
 * `{ ok: true }` when the session was found and persisted; `{ ok: false }` with
 * `not_found` when no session row matched the id (the only failure the persist
 * surfaces — the interactive re-prime is fail-soft and never fails the write).
 */
export type UpdateSessionAgentPermissionModeResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' };

/**
 * Single write chokepoint for `sessions.agent_permission_mode`. Performs the four
 * side effects documented in the module header. `mode` is assumed already
 * validated by the caller (isPermissionMode at the IPC boundary, zod enum at the
 * tRPC boundary).
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

  // (4) INTERACTIVE substrate (sessions.substrate, migration 027): the live PTY
  // `claude` reads its gating from the worktree's .claude/settings.json at SPAWN
  // only — relayUserTurn/submitToRepl never re-read it — so the SDK next-turn
  // re-read does NOT apply. To make the change effective on the NEXT spawn
  // (terminal restart), prime the settings file now: default/acceptEdits keep the
  // wildcard PreToolUse hook; auto/dontAsk remove it (auto hands gating to native
  // Claude, dontAsk opts out). Demo mode never spawns a real REPL, so skip it.
  // Fully fail-soft: never let a settings-write failure fail the persist, and
  // guard the teardown race (a dismissed session's worktree is gone) by requiring
  // the worktree to exist.
  try {
    if (!deps.configManager.isDemoMode()) {
      const dbSession = deps.databaseService.getSession(sessionId);
      const worktreePath = dbSession?.worktree_path;
      if (
        dbSession?.substrate === 'interactive' &&
        typeof worktreePath === 'string' &&
        worktreePath.length > 0 &&
        existsSync(worktreePath)
      ) {
        if (mode === 'auto' || mode === 'dontAsk') {
          deps.settingsWriter.remove(worktreePath);
        } else {
          deps.settingsWriter.write(worktreePath, { permissionMode: mode });
        }
      }
    }
  } catch (settingsErr) {
    // Priming the interactive hook is best-effort: a failure leaves the prior
    // mode in effect for the next spawn but must not fail the persist.
    console.warn('[sessionPermissionMode] Failed to prime interactive .claude/settings.json for permission mode:', settingsErr);
  }

  return { ok: true };
}
