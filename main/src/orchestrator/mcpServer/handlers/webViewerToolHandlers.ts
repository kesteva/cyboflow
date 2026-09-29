/**
 * webViewerToolHandlers — the cyboflow_web_tabs / _read_web_tab / _open_web_tab /
 * _drive_web_tab MCP handler family (docs/proposals/native-web-viewer.md §6),
 * plus `web-open-url`, the session CLI's `$BROWSER` hand-off (openUrlShellHook).
 *
 * Thin by design. Every consent decision lives behind the `webViewerAgent` seam
 * (services/webViewer/webViewerAgentOps.ts), which this orchestrator-layer module
 * may not import. What this module owns is WHO is asking: the caller's session
 * comes from its `workflow_runs` row — never from an argument the agent could
 * set — and a finished run is refused before the seam is touched, because a
 * terminal run has already had its grants revoked.
 */

import * as net from 'net';
import type { DatabaseLike } from '../../types';
import type { McpQueryHandlerDeps, McpQueryMessage, McpQueryResponse } from '../mcpQueryMessages';
import type { AgentCaller, AgentResult } from '../../trpc/contracts/webViewerOps';

export interface WebViewerToolContext {
  readonly db: DatabaseLike;
  readonly deps: McpQueryHandlerDeps;
  writeResponse(client: net.Socket, response: McpQueryResponse): void;
}

type WebToolMessage = Extract<
  McpQueryMessage,
  { type: 'mcp-web-tabs' | 'mcp-read-web-tab' | 'mcp-open-web-tab' | 'mcp-drive-web-tab' | 'web-open-url' }
>;

/**
 * The run's session key — the key the renderer files that run's tabs under:
 * `session_id`, or the run id itself for a run with no parent session (the run
 * pane does the same). Quick-chat sentinel runs are real, non-terminal rows.
 */
export function resolveWebCaller(
  db: DatabaseLike,
  runId: string,
): { ok: true; caller: AgentCaller } | { ok: false; error: string } {
  if (runId === 'orchestrator') return { ok: false, error: 'web_tools_require_real_run' };
  const row = db.prepare('SELECT session_id AS sessionId, status FROM workflow_runs WHERE id = ?').get(runId) as
    | { sessionId?: unknown; status?: unknown }
    | undefined;
  if (!row) return { ok: false, error: 'run_not_found' };
  if (row.status === 'completed' || row.status === 'failed' || row.status === 'canceled') {
    return { ok: false, error: 'run_not_active' };
  }
  const sessionKey = typeof row.sessionId === 'string' && row.sessionId.length > 0 ? row.sessionId : runId;
  return { ok: true, caller: { runId, sessionKey } };
}

export async function handleWebViewerTool(
  ctx: WebViewerToolContext,
  msg: WebToolMessage,
  client: net.Socket,
): Promise<void> {
  const reply = (result: AgentResult<object>): void => {
    if (!result.ok) {
      ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: false, error: result.error });
      return;
    }
    const data: Record<string, unknown> = { ...result };
    delete data.ok;
    ctx.writeResponse(client, { type: 'mcp-query-response', requestId: msg.requestId, ok: true, data });
  };

  const agent = ctx.deps.webViewerAgent;
  if (!agent) return reply({ ok: false, error: 'viewer_unavailable' });
  const resolved = resolveWebCaller(ctx.db, msg.runId);
  if (!resolved.ok) return reply(resolved);
  const { caller } = resolved;

  switch (msg.type) {
    case 'mcp-web-tabs':
      return reply(await agent.listTabs(caller));
    case 'mcp-read-web-tab':
      return reply(
        await agent.readTab(caller, {
          tabId: msg.tabId,
          since: msg.since,
          include: msg.include,
          frame: msg.frame,
          reason: msg.reason,
        }),
      );
    case 'mcp-open-web-tab':
      return reply(await agent.openTab(caller, { url: msg.url, reason: msg.reason, waitForLoad: msg.waitForLoad }));
    case 'mcp-drive-web-tab':
      return reply(
        await agent.driveTab(caller, {
          tabId: msg.tabId,
          action: msg.action,
          url: msg.url,
          selector: msg.selector,
          text: msg.text,
          expression: msg.expression,
          frame: msg.frame,
          reason: msg.reason,
        }),
      );
    case 'web-open-url':
      return reply(await agent.openForUser(caller, { url: msg.url }));
  }
}
