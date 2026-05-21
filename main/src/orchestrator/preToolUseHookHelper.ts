/**
 * preToolUseHookHelper — shared ApprovalRouter routing logic for PreToolUse hooks.
 *
 * Extracts the common try/catch body that was duplicated in:
 *  - permissionModeMapper.deferToApprovalRouter
 *  - claudeCodeManager.makePreToolUseHook
 *
 * Both call sites delegate to routePreToolUseThroughApprovalRouter, parameterizing
 * only the caller identity (callerId for the run ID, callerLabel for the log prefix).
 *
 * Standalone-typecheck invariant: NO imports from 'electron', 'better-sqlite3',
 * or any concrete service in main/src/services/*.
 */
import type { HookJSONOutput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { ApprovalRouter } from './approvalRouter';
import type { LoggerLike } from './types';

/**
 * Routes a PreToolUse input through ApprovalRouter and translates the
 * ApprovalDecision to a SDK HookJSONOutput.
 *
 * Wraps in try/catch so the SDK always receives a well-formed response even
 * when ApprovalRouter throws (e.g. RunNotRunningError, DB error).
 *
 * @param pretool      - The PreToolUse hook input from the SDK.
 * @param callerId     - The run/panel ID forwarded to ApprovalRouter.requestApproval.
 * @param callerLabel  - A human-readable label used as the log prefix (e.g.
 *                       'PermissionModeMapper' → '[PermissionModeMapper]').
 * @param logger       - Optional structured logger for error diagnostics.
 * @returns A HookJSONOutput with permissionDecision 'allow' or 'deny'.
 */
export async function routePreToolUseThroughApprovalRouter(
  pretool: PreToolUseHookInput,
  callerId: string,
  callerLabel: string,
  logger?: LoggerLike,
): Promise<HookJSONOutput> {
  console.error('[DIAG-hook] routePreToolUseThroughApprovalRouter entry callerId=', callerId, 'tool=', pretool.tool_name);
  if (!logger) console.error('[DIAG-hook] loggerLike undefined callerId=', callerId);

  try {
    console.error('[DIAG-hook] before requestApproval callerId=', callerId);
    const decision = await ApprovalRouter.getInstance().requestApproval(
      callerId,
      pretool.tool_name,
      pretool.tool_input as Record<string, unknown>,
      () => {},
    );
    console.error('[DIAG-hook] requestApproval returned callerId=', callerId, 'behavior=', decision.behavior);

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
    console.error('[DIAG-hook] requestApproval THREW callerId=', callerId, 'tool=', pretool.tool_name, 'err=', err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err));
    logger?.error(
      `[${callerLabel}] PreToolUse hook failed for ${pretool.tool_name}: ${err instanceof Error ? err.message : String(err)}`,
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
