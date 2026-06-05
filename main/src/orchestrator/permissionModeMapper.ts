/**
 * permissionModeMapper — pure mapper from PermissionMode to a SDK HookCallback.
 *
 * Centralizes the permission policy for workflow runs:
 *  - 'dontAsk'     → no hook (SDK runs unrestricted, equivalent to --dangerously-skip-permissions)
 *  - 'default'     → every PreToolUse is routed through ApprovalRouter
 *  - 'acceptEdits' → Edit/Write/MultiEdit are auto-approved; all other tools
 *                    are routed through ApprovalRouter (same as 'default')
 *  - 'auto'        → no hook here (native Claude auto-mode owns gating via the
 *                    model classifier). The real auto wiring lives in
 *                    buildSdkOptions (`sdkOptions.permissionMode = 'auto'`) and
 *                    the interactive `--permission-mode auto` CLI flag, NOT this
 *                    mapper. A PreToolUse hook would pre-empt the native
 *                    classifier (hooks run first in the CLI permission order),
 *                    silently degrading auto to approve.
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*.
 */
import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '../../../shared/types/workflows';
import type { LoggerLike } from './types';
import { routePreToolUseThroughApprovalRouter } from './preToolUseHookHelper';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The set of tool names that 'acceptEdits' mode auto-approves without
 * routing through ApprovalRouter. Exported so callers (tests, UI) can import
 * this canonical list without hardcoding strings.
 */
export const ACCEPT_EDITS_AUTO_APPROVE_TOOLS = ['Edit', 'Write', 'MultiEdit'] as const;

type AcceptEditsTool = (typeof ACCEPT_EDITS_AUTO_APPROVE_TOOLS)[number];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a PreToolUse HookCallback for the given PermissionMode.
 *
 * @param mode   - The workflow's permission mode (from PermissionMode).
 * @param runId  - The workflow_runs.id; forwarded to ApprovalRouter.
 * @param logger - Optional structured logger for error diagnostics.
 * @returns A HookCallback to pass to the SDK, or undefined for 'dontAsk'.
 */
export function buildPreToolUseHook(
  mode: PermissionMode,
  runId: string,
  logger?: LoggerLike,
): HookCallback | undefined {
  switch (mode) {
    case 'dontAsk':
      return undefined;

    case 'auto':
      // Native Claude auto-mode owns gating (model classifier). No PreToolUse
      // hook participates here; doing so would pre-empt the native classifier
      // (hooks run first in the CLI permission order). Auto wiring lives in
      // buildSdkOptions / the interactive `--permission-mode auto` flag.
      return undefined;

    case 'default':
      return async (input, _toolUseId, _ctx) => {
        const pretool = input as PreToolUseHookInput;
        return routePreToolUseThroughApprovalRouter(pretool, runId, 'PermissionModeMapper', logger);
      };

    case 'acceptEdits':
      return async (input, _toolUseId, _ctx) => {
        const pretool = input as PreToolUseHookInput;

        if (
          ACCEPT_EDITS_AUTO_APPROVE_TOOLS.includes(pretool.tool_name as AcceptEditsTool)
        ) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'allow' as const,
            },
          };
        }

        return routePreToolUseThroughApprovalRouter(pretool, runId, 'PermissionModeMapper', logger);
      };

    default: {
      // Exhaustiveness check — TypeScript will error here if PermissionMode
      // gains a new member that is not handled above.
      const _exhaustive: never = mode;
      throw new Error(`buildPreToolUseHook: unhandled PermissionMode '${_exhaustive}'`);
    }
  }
}
