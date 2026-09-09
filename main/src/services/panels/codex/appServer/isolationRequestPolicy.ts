/**
 * The fail-closed server-request policy for a HERMETIC global-agent Codex spawn
 * (`ClaudeSpawnerOptions.isolation === 'agent'`).
 *
 * An isolation spawn has NO `workflow_runs` row: its identity is the synthetic
 * `agent:<threadId>`. Both ordinary bridges route through the ApprovalRouter /
 * QuestionRouter, which do a guarded `UPDATE workflow_runs … WHERE
 * status='running'` and raise `RunNotRunningError` for a run-less id — the
 * bridges catch it and answer decline/cancel, so the request is not lost loudly
 * but silently. This module replaces them for isolation spawns with a LOCAL,
 * terminal decision, mirroring the Claude manager's isolation PreToolUse hook
 * (claudeCodeManager.makeIsolationPreToolUseHook):
 *
 *   - an MCP tool-call elicitation for a `cyboflow_*` tool → ACCEPT;
 *   - every other server request (command execution, file change, permissions,
 *     any other elicitation, any user-input question) → DECLINE, at WARN.
 *
 * Nothing here consults a router, the database, or a permission mode. With
 * `sandbox: 'read-only'`, `approvalPolicy: 'never'`, `features.shell_tool` off
 * and `web_search` disabled (runConfig.ts), a request in the decline set should
 * not arise at all — this is defense in depth for the one that does.
 *
 * Pure: `decideIsolationRequest` classifies, `respondToIsolationRequest` applies.
 * Response shapes are the same ones the two bridges send (approvalBridge's
 * `finishWithDecision` / `cancelRequest`, questionBridge's empty-answers reply).
 */
import {
  approvalRequestToolName,
  isMcpToolCallApproval,
  mcpToolName,
  type ApprovalDispatch,
} from './approvalBridge';
import type { AppServerServerRequestDispatch } from './client';

/** The scoped tool family a global-agent thread is allowed to call. */
export const CYBOFLOW_MCP_TOOL_NAME_PREFIX = 'cyboflow_';

/** The user-input question dispatch — the half the question bridge owns. */
export type QuestionDispatch = Extract<
  AppServerServerRequestDispatch,
  { method: 'item/tool/requestUserInput' }
>;

export interface IsolationRequestDecision {
  /** ACCEPT is reachable only for a `cyboflow_*` MCP tool call. */
  decision: 'accept' | 'decline';
  /** The dispatch method, carried so the caller can log without re-narrowing. */
  method: AppServerServerRequestDispatch['method'];
  /** The tool label the request is about (`MCP:<server>` when unnamed). */
  toolName: string;
  /** A WARN line for a declined request; null when accepted. */
  warning: string | null;
}

/**
 * Classify one server request under global-agent isolation. Fail-closed: every
 * shape that is not an `mcp_tool_call` elicitation for a `cyboflow_*` tool is
 * declined, including an elicitation from another MCP server the user configured
 * in `~/.codex/config.toml`.
 */
export function decideIsolationRequest(
  request: AppServerServerRequestDispatch,
): IsolationRequestDecision {
  if (request.method === 'item/tool/requestUserInput') {
    return declined(request.method, 'AskUserQuestion');
  }

  const approvalRequest: ApprovalDispatch = request;
  const toolName = approvalRequestToolName(approvalRequest);

  if (
    approvalRequest.method === 'mcpServer/elicitation/request'
    && isMcpToolCallApproval(approvalRequest)
    && mcpToolName(approvalRequest).startsWith(CYBOFLOW_MCP_TOOL_NAME_PREFIX)
  ) {
    return {
      decision: 'accept',
      method: approvalRequest.method,
      toolName,
      warning: null,
    };
  }

  return declined(approvalRequest.method, toolName);
}

function declined(
  method: AppServerServerRequestDispatch['method'],
  toolName: string,
): IsolationRequestDecision {
  return {
    decision: 'decline',
    method,
    toolName,
    warning:
      `Global-agent isolation declined a Codex app-server request: method=${method} tool=${toolName}. `
      + 'Only the cyboflow global-agent MCP tool family is permitted.',
  };
}

/**
 * Send the decision back on the dispatch. The decline shapes are the bridges'
 * own: `decision: 'decline'` for command/fileChange, an EMPTY grant with
 * `strictAutoReview` for permissions, `action: 'decline'` for an elicitation,
 * and empty answers for a question.
 */
export function respondToIsolationRequest(
  request: AppServerServerRequestDispatch,
  decision: IsolationRequestDecision,
): void {
  const allow = decision.decision === 'accept';
  switch (request.method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      request.respond({ decision: allow ? 'accept' : 'decline' });
      return;
    case 'item/permissions/requestApproval':
      request.respond({ permissions: {}, scope: 'turn', strictAutoReview: true });
      return;
    case 'mcpServer/elicitation/request':
      request.respond({
        action: allow ? 'accept' : 'decline',
        content: null,
        _meta: null,
      });
      return;
    case 'item/tool/requestUserInput':
      request.respond({ answers: {} });
      return;
  }
}

/**
 * Decide + respond in one call, returning the decision so the caller can log the
 * WARN line. This is the whole isolation replacement for the two bridges.
 */
export function handleIsolationRequest(
  request: AppServerServerRequestDispatch,
): IsolationRequestDecision {
  const decision = decideIsolationRequest(request);
  respondToIsolationRequest(request, decision);
  return decision;
}
