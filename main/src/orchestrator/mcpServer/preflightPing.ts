/**
 * The remote-environment preflight's link probe (spec A6 `mcp-roundtrip`): `{"type":"preflight-ping",
 * "requestId":<nonce>}` sent through a host's forwarded orch socket and answered by OrchSocketServer itself with
 * `{type:'mcp-query-response', requestId, ok:true, data:{pong:true}}`. It carries NO runId, so it is never bound
 * or authenticated, and it reads/writes no state — it only proves the forward reaches this server. It is not an
 * McpQueryMessage (no tool, no run scope), so it never reaches McpQueryHandler.
 */
export const PREFLIGHT_PING_MESSAGE_TYPE = 'preflight-ping';

/** The newline-terminated reply line for a ping with this requestId. */
export function preflightPongLine(requestId: string): string {
  return `${JSON.stringify({ type: 'mcp-query-response', requestId, ok: true, data: { pong: true } })}\n`;
}
