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
   * Explicit per-run choice from the run-launch UI. HIGHEST precedence — a
   * deliberate per-launch override beats any standing default. The per-run UI
   * is DEFERRED, so this rung is accepted now but not yet supplied by any
   * caller.
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
 *   1. explicit per-run UI choice (requestedMode) — DEFERRED, not yet supplied
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
