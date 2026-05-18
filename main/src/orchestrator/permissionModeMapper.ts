/**
 * permissionModeMapper — pure mapper from PermissionMode to a SDK HookCallback.
 *
 * Centralizes the permission policy for workflow runs:
 *  - 'dontAsk'     → no hook (SDK runs unrestricted, equivalent to --dangerously-skip-permissions)
 *  - 'default'     → every PreToolUse is routed through ApprovalRouter
 *  - 'acceptEdits' → Edit/Write/MultiEdit are auto-approved; all other tools
 *                    are routed through ApprovalRouter (same as 'default')
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*.
 */
import type { HookCallback, HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionMode } from '../../../shared/types/workflows';
import { ApprovalRouter } from './approvalRouter';
import type { LoggerLike } from './types';

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
// Internal shared deferral helper
// ---------------------------------------------------------------------------

/**
 * Routes a PreToolUse input through ApprovalRouter and translates the
 * ApprovalDecision to a SDK HookJSONOutput. Wraps in try/catch so the SDK
 * always receives a well-formed response (mirroring claudeCodeManager.ts:507-518).
 */
async function deferToApprovalRouter(
  pretool: PreToolUseHookInput,
  runId: string,
  logger?: LoggerLike,
): Promise<HookJSONOutput> {
  try {
    const decision = await ApprovalRouter.getInstance().requestApproval(
      runId,
      pretool.tool_name,
      pretool.tool_input as Record<string, unknown>,
      () => {},
    );

    if (decision.behavior === 'allow') {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'allow' as const,
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
        },
      };
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        ...(decision.message ? { permissionDecisionReason: decision.message } : {}),
      },
    };
  } catch (err) {
    logger?.error(
      `[permissionModeMapper] PreToolUse hook failed for ${pretool.tool_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: 'Internal approval-router error',
      },
    };
  }
}

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

    case 'default':
      return async (input, _toolUseId, _ctx) => {
        const pretool = input as PreToolUseHookInput;
        return deferToApprovalRouter(pretool, runId, logger);
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

        return deferToApprovalRouter(pretool, runId, logger);
      };

    default: {
      // Exhaustiveness check — TypeScript will error here if PermissionMode
      // gains a new member that is not handled above.
      const _exhaustive: never = mode;
      throw new Error(`buildPreToolUseHook: unhandled PermissionMode '${_exhaustive}'`);
    }
  }
}
