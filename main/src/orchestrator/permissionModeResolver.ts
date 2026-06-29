/**
 * permissionModeResolver — the SINGLE resolution point for the agent
 * permission-mode choice that governs workflow runs on BOTH CLI substrates
 * (SDK + interactive).
 *
 * Standalone-typecheck invariant: this file must NOT import from 'electron',
 * 'better-sqlite3', 'fs', or any concrete service in main/src/services/*.
 * It depends only on the renderer-safe shared workflow types.
 *
 * The resolver walks an override ladder in precedence order and floors to
 * 'default' ('ask before edits'). With no overrides set anywhere, EVERY run
 * resolves 'default' and the ask-before-edits path is preserved — the
 * zero-behavior-change floor this seam guarantees. Mirrors the structure and
 * fail-soft semantics of substrateResolver.ts.
 */
import {
  type PermissionMode,
  isPermissionMode,
} from '../../../shared/types/workflows';
import type { DatabaseLike } from './types';

/** The mode every run falls back to when nothing overrides it. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/**
 * Inputs for resolvePermissionMode. Every level is optional and untyped at the
 * boundary (string | null | undefined) because the values flow in from a
 * per-run UI choice, workflow frontmatter, and the global config — none of
 * which can be trusted to be a valid PermissionMode. Each candidate is
 * validated with isPermissionMode() and an unrecognized value is SKIPPED
 * (fail-soft), letting resolution fall through to the next level rather than
 * throwing.
 */
export interface PermissionModeResolverInputs {
  /**
   * Explicit per-run choice from the run-launch UI (WorkflowPicker). HIGHEST
   * precedence — a deliberate per-launch override beats any standing default.
   * Supplied via WorkflowPicker → runs.start → RunLauncher.launch →
   * WorkflowRegistry.createRun.
   */
  requestedMode?: string | null;
  /**
   * Workflow .md frontmatter `permission_mode:` value, or the per-row
   * `workflows.permission_mode` column. Treated as "unset" (skipped) when it is
   * `'default'` or absent so resolution falls through to the global default;
   * the built-in flows ship WITHOUT a frontmatter permission_mode (null by
   * default) and only an explicit per-agent opt-in wins here.
   */
  frontmatterMode?: string | null;
  /** ConfigManager.getDefaultAgentPermissionMode() global. */
  globalDefaultMode?: string | null;
}

/**
 * Resolve the agent permission mode for a run.
 *
 * Precedence (highest wins):
 *   1. explicit per-run UI choice (requestedMode) from WorkflowPicker
 *   2. workflow frontmatter `permission_mode:` (per-agent opt-in override)
 *   3. ConfigManager global default (globalDefaultMode)
 *   4. DEFAULT_PERMISSION_MODE ('default') — the hard floor.
 *
 * An unrecognized value at any level is ignored (never throws) and resolution
 * falls through to the next level — mirroring resolveSubstrate's
 * default-on-unknown fall-through.
 */
export function resolvePermissionMode(
  inputs: PermissionModeResolverInputs,
): PermissionMode {
  const candidates: Array<string | null | undefined> = [
    inputs.requestedMode,
    inputs.frontmatterMode,
    inputs.globalDefaultMode,
  ];

  for (const candidate of candidates) {
    if (isPermissionMode(candidate)) {
      return candidate;
    }
  }

  return DEFAULT_PERMISSION_MODE;
}

/**
 * Resolve the LIVE agent permission mode for a run from its owning session
 * (`sessions.agent_permission_mode`), keyed on the RUN id via the
 * `workflow_runs → sessions` join (permission-mode redesign §3a).
 *
 * Source of truth: the host session's mode column, which is now the single
 * execution authority (the `workflow_runs.permission_mode_snapshot` column is
 * demoted to a launch-time audit value, no longer read for execution).
 *
 * Keying on the run (not a bare sessionId) is correct for BOTH entry shapes,
 * because the gate run resolves to its host session either way:
 *   - chat turn  → gate run = a `__quick__` chat sentinel → its `session_id`
 *   - flow run   → gate run = the flow run itself → its `session_id`
 * (for flows `sessionId === runId`, so a `WHERE sessions.id = runId` lookup
 * would miss — the join is the fix). This is the same join `mcpQueryHandler`
 * adopts for the interactive shell-approval fast-path (§3c#3).
 *
 * LEFT JOIN so a run whose `session_id` never resolves (legacy SDK sentinel
 * left NULL by design, or a join-miss) yields `m = NULL`, which fails the
 * `isPermissionMode` guard and falls back to `globalDefault` — never strands a
 * run in an unrecognized mode.
 *
 * Standalone-typecheck-safe: imports only `DatabaseLike` + `isPermissionMode`.
 */
export function resolveRunAgentPermissionMode(
  db: DatabaseLike,
  runId: string,
  globalDefault: PermissionMode = 'default',
): PermissionMode {
  const row = db
    .prepare(
      `SELECT s.agent_permission_mode AS m
         FROM workflow_runs r LEFT JOIN sessions s ON s.id = r.session_id
        WHERE r.id = ?`,
    )
    .get(runId) as { m?: unknown } | undefined;
  const m: unknown = row?.m;
  return isPermissionMode(m) ? m : globalDefault;
}
