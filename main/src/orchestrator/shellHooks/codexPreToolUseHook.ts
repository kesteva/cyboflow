#!/usr/bin/env node
/**
 * Codex PreToolUse hook bridge.
 *
 * Codex command hooks use the same stdin tool payload shape as the existing
 * Claude PTY hook (`tool_name`, `tool_input`) but a different stdout contract.
 * This wrapper reuses the long-lived Cyboflow approval socket flow and emits
 * Codex-shaped hook decisions:
 *
 *   allow -> { "decision": "allow" }
 *   deny  -> { "decision": "block", "reason": "..." }
 *
 * Standalone-typecheck invariant: only import node built-ins and the sibling
 * shell-hook module. No Electron, DB, or service imports.
 */
import {
  readStdinPayload,
  runShellHook,
  type ShellHookLogger,
  type ShellHookResult,
} from './preToolUseShellHook';

export interface CodexHookOutput {
  decision: 'allow' | 'block';
  reason?: string;
}

export interface CodexHookResult {
  output: CodexHookOutput;
  /** Codex consumes the stdout JSON decision; exit 0 avoids stderr-only block semantics. */
  exitCode: 0;
}

const DEFAULT_BLOCK_REASON = 'Denied by Cyboflow review queue';

export function codexHookResultFromShellResult(result: ShellHookResult): CodexHookResult {
  const hookOutput = result.output.hookSpecificOutput;
  if (hookOutput.permissionDecision === 'allow') {
    return { output: { decision: 'allow' }, exitCode: 0 };
  }

  return {
    output: {
      decision: 'block',
      reason: hookOutput.permissionDecisionReason ?? DEFAULT_BLOCK_REASON,
    },
    exitCode: 0,
  };
}

function codexBlockResult(reason: string): CodexHookResult {
  return { output: { decision: 'block', reason }, exitCode: 0 };
}

const stderrLogger: ShellHookLogger = {
  debug: (message: string) => process.stderr.write(message + '\n'),
  warn: (message: string) => process.stderr.write(message + '\n'),
  error: (message: string) => process.stderr.write(message + '\n'),
};

function emitAndExit(result: CodexHookResult): never {
  process.stdout.write(JSON.stringify(result.output));
  process.exit(result.exitCode);
}

export async function main(): Promise<void> {
  const socketPath = process.env.CYBOFLOW_ORCH_SOCKET;
  const runId = process.env.CYBOFLOW_RUN_ID;

  if (!socketPath || !runId) {
    stderrLogger.error(
      `[Cyboflow Codex PreToolUse hook] missing env (CYBOFLOW_ORCH_SOCKET=${socketPath ?? '(unset)'}, ` +
        `CYBOFLOW_RUN_ID=${runId ?? '(unset)'}) - blocking`,
    );
    emitAndExit(codexBlockResult('cyboflow gating not configured'));
  }

  const payload = await readStdinPayload(process.stdin);
  const shellResult = await runShellHook({ socketPath, runId, payload, logger: stderrLogger });
  emitAndExit(codexHookResultFromShellResult(shellResult));
}

if (require.main === module) {
  void main();
}
