/**
 * globalAgentContext — the one pure helper every global-agent MCP handler
 * shares: parsing the 'agent:<threadId>' sentinel out of a CYBOFLOW_RUN_ID.
 *
 * Lives in its own module (issue #19, the god-file split) so that
 * handlers/globalAgentToolHandlers.ts and mcpQueryHandler.ts can both import
 * it without importing each other. mcpQueryHandler.ts re-exports it.
 */

import { AGENT_THREAD_SPAWN_PREFIX, isAgentThreadSpawnId } from '../../../../shared/types/agentThread';

/**
 * Parse the global-agent sentinel form 'agent:<threadId>' out of a
 * CYBOFLOW_RUN_ID. Accepts ONLY this exact shape — a bare workflow_runs id (or
 * the 'orchestrator' health-check sentinel) is rejected. The reverse also
 * holds with NO code change required on the run-scoped side:
 * resolveTaskRunContext / resolveReviewItemRunContext do a strict
 * `SELECT ... FROM workflow_runs WHERE id = ?` lookup, and an
 * 'agent:<threadId>' string never matches a real run row, so those resolvers
 * fall through to their existing 'run_not_found' branch — see
 * mcpQueryHandler.test.ts for the two-way coverage.
 *
 * A free function (not a class method): it touches no DB/state, so every
 * global-agent handler (in mcpQueryHandler.ts and handlers/globalAgentToolHandlers.ts)
 * calls it directly and every unit test can call
 * it directly too.
 */
export function resolveGlobalAgentContext(
  runId: string,
): { ok: true; threadId: string } | { ok: false; error: string } {
  if (!isAgentThreadSpawnId(runId)) {
    return { ok: false, error: 'not_a_global_agent_run' };
  }
  return { ok: true, threadId: runId.slice(AGENT_THREAD_SPAWN_PREFIX.length) };
}
